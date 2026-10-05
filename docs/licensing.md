# DataRefine Studio — Licensing & Cloud Integration

This document describes the production desktop licensing/cloud architecture
shipped in `src-tauri/src/{app/policy,cloud,ai,plugins}` and its React surface.
Rust owns **all** logic, HTTP, crypto and persistence. React renders snapshots
and sends intents — it never decides entitlements, endpoints or policy.

---

## 1. Runtime enforcement mode

`GET /api/config` → `licensing.requireLicense` drives a Rust-owned
`EnforcementMode`:

| Mode            | Meaning |
|-----------------|---------|
| `licensed`      | Full license lifecycle enforced (activate/verify/grace/lock). |
| `unrestricted`  | `requireLicense=false` **or** cloud answered `403 LICENSING_DISABLED`. LicenseManager verification, CloudAI, credits and entitlement traffic are disabled at runtime; cached entitlements are purged from memory **and** from the encrypted store. `/api/config` polling and `/api/install` device registration continue. |

`basic` is a license decision inside `licensed` enforcement, not a second enforcement system: it is the user's persisted Continue with Basic choice.

The flip works in both directions without a rebuild; the next config refresh
restores `licensed` mode when the cloud re-enables licensing. Local-first work
(datasets, grid, SQL/Python, DuckDB/Polars, local AI, BYOK, and CSV export) remains
available in either mode. A missing or malformed first-run policy is handled
conservatively as licensing-required rather than being mistaken for an
unrestricted cloud response; a parseable last-known-good policy is preferred
when the app is offline.

When `requireLicense=true` and there is no valid Professional grant, the desktop
offers a persistent `basic` decision instead of locking the workspace. Basic mode
keeps local processing, CSV import, Excel imports up to the cloud-configured
ceiling (5,000 rows by default), basic cleaning, SQL/Python/Polars, and CSV
export. The cloud-controlled premium feature policy gates database connections,
push, imports above that ceiling, non-CSV export/report formats, Marketplace,
plugin installation, and Marketplace-installed plugins. Basic mode also allows
10 successful file imports in a rolling 30-day window. That small Basic quota
is stored locally in the desktop; failed imports do not consume a slot. A future
cloud feature list is normalized into stable desktop feature keys; the documented
default premium set is used only when the cloud omits a feature policy.

## 2. Endpoint discovery (signed bootstrap)

Order: **pinned bootstrap URL → last-known-good cached endpoint → stable
production domain**. Unverified remote config can never move the app's
endpoint.

Two accepted document formats, both Ed25519-verified:

1. **Canonical-JSON document (production format)**

   ```json
   {
     "keyId": "drs-main-2025",
     "version": 4,
     "issuedAt": "…", "expiresAt": "…",
     "api": { "baseUrl": "https://…", "fallbackBaseUrls": [] },
     "app": {}, "endpoints": {}, "features": {},
     "signature": "<hex ed25519>"
   }
   ```

   * Signature covers the **canonical JSON** of the document **without** the
     `signature` field: object keys sorted recursively, arrays in order, no
     insignificant whitespace, UTF-8.
   * `keyId` selects the verification key from a **pinned** key set
     (`cloud::discovery::pinned_pub`) — unknown keyIds are rejected, enabling
     key rotation without app rebuilds.
   * Policy after a good signature: HTTPS only, `version ≥ MIN_CONFIG_VERSION`,
     not expired, and **clock-rollback safe** (`now < issuedAt` → rejected, so
     a rolled-back clock never extends trust).

2. **Legacy 4-line payload** (`configVersion\napiBaseUrl\nissuedAt\nexpiresAt`)
   — kept as a fallback for already-deployed bootstrap files.

Signing tool: `services/internal/cloud-bridge/sign-bootstrap.mjs` (private key in
`services/internal/cloud-bridge/keys.json` — move to the cloud secret store in production; it
must never ship inside the desktop). Both formats were verified end-to-end
node → Rust against the embedded production key
(`f372621a…dc671`, see `cloud::config`).

## 3. License lifecycle

* **Install**: anonymous device registration (`POST /api/install`) — the only
  telemetry; no country/location analytics.
* **Activate**: `POST /api/activate` with the DRS-format key; returns
  `activationToken`, plan, expiry, entitlements.
* **Verify**: `POST /api/verify` (token + machine-bound key escrow).
  `400` is treated as *inconclusive* (grace), never as denial. Responses may
  carry `nextCheckInAt`, which overrides the interval-based schedule.
* **Scheduler**: verify runs on `nextCheckInAt` if present, else every
  `verifyIntervalHours` with **±10 % jitter** (deterministic per cycle), on
  app resume (throttled hourly) and via manual "Check now". A busy flag makes
  verifies single-flight.
* **Offline grace**: `offlineGraceDays` (currently 15 on the live cloud).
  Clock rollback never extends grace.
* Decisions: `granted | maintenance | mandatory_update | license_required |
  license_invalid | license_blocked | license_expired | device_mismatch |
  token_invalid | grace_expired`. Priority: hard maintenance → mandatory
  update → license policy → verify → grace → announcements → app.

## 4. Secrets & persistence

* `Stored` state lives in an AES-256-GCM blob keyed by a SHA-256 of a static
  KDF label + machine id (`license.bin`). Atomic tmp+rename writes.
* **activationToken**: OS credential store first (`keyring` service
  `datarefine-studio`, entry `activationToken`). The blob only keeps the token
  as a fallback where no secret service exists, and only after a *fresh-entry
  read-back* proves the backend works. Never in localStorage/JSON/React/logs.
* **License key**: kept solely inside the machine-bound escrow blob
  (`key_escrow`), sent only on verify; UI shows a masked form.
* **BYOK provider keys**: `keyring` service `datarefine-studio`, entries
  `byok:{provider}`; status is exposed masked (`abcd-…-wxyz`).

## 5. Cloud HTTP client

One client (`cloud::client::CloudClient`) for every remote call:

* Connect timeout **5 s**, total **15 s**; no `unwrap()` on network paths.
* Retries only Offline/Timeout/429/5xx with 500 ms/1 s/2 s backoff (cap 4 s),
  honoring `Retry-After`/`X-RateLimit-Reset` (cap 10 s). 4xx never retried.
* Every request carries an anonymous `X-Request-Id`; outcomes are recorded in
  a 100-entry ring (`requestId, endpoint, status, errorCode, latencyMs`) —
  no bodies, no secrets. Exposed via the `cloud_diagnostics` command and the
  Settings → Diagnostics panel.
* Envelope `{ok,data,error}` parsed tolerantly; business `error.code` is
  preserved (`LICENSING_DISABLED`, …) and mapped to typed AI errors.

## 6. Cloud AI

Path: router decision (`preferred → local → byok → cloud`) → estimate →
entitlement check → job submit → poll → preview → **explicit user accept** →
local apply. Cloud AI never mutates datasets silently; output is always a
suggestion.

Gates (all Rust-side, pre-network): license decision granted **and**
`requireLicense=true` (licensed mode) **and** `entitlements.cloudAi` (+
`aiPlugins`/capability checks for plugin & agent paths). Credits are owned by
the cloud ledger; the desktop only displays balance/reserved. The wallet is
queried only when `requireLicense=true` and the effective provider is Cloud AI;
selecting BYOK or Ollama hides the wallet even when an unused key is stored.

* `GET /api/ai/wallet` — balance/reserved wallet state. The Rust client sends
  the encrypted-storage license identity in `X-DRS-License-Key` and
  `X-DRS-Machine-Id` headers required by the current Cloud contract; React
  never sees it. It is never requested for unrestricted, BYOK, or local AI
  sessions.
* `POST /api/ai/estimate` — display-only, consumes nothing.
* `POST /api/ai/jobs` — body includes an **`idempotencyKey`** (UUIDv4) that is
  stable per logical job; timeout retries reuse the key so the cloud returns
  the existing job instead of charging twice.
* Reserve/settle/refund flow: cloud is authoritative (`reserve` →
  generate → `settle(actual)` refunds the difference).

Monthly AI file-cleaning quota is a separate server ledger from Cloud AI
Credits. In licensed mode the desktop calls the Rust-gated endpoints below
before and after every explicit AI cleaning job; the server supplies the
calendar month and plan, so the desktop clock is never used for authorization:

* `POST /api/ai/usage/check` — read-only authoritative plan/month/used/limit
  response for `source: cloud|byok|local`.
* `POST /api/ai/usage/record` — idempotently records a successful local/BYOK
  cleaning. Cloud jobs are consumed/settled by the Cloud job service and are
  not locally deducted.
* Community is free forever with 15 cleanings per server calendar month;
  Professional Monthly, 3 Months, 6 Months, and Yearly return an unlimited
  quota. The month-specific usage object keeps September and October separate.

Typed error mapping (`ai::errors`): `LICENSING_DISABLED, LICENSE_NOT_ACTIVE,
AI_CAPABILITY_NOT_ALLOWED, INSUFFICIENT_CREDITS, PLUGIN_NOT_ENTITLED,
PLUGIN_NOT_FOUND, JOB_NOT_FOUND, IDEMPOTENCY_CONFLICT, RATE_LIMITED,
AI_PROVIDER_ERROR, VALIDATION_ERROR` — each renders an honest user message;
business errors never surface as a generic "Network error".

## 7. Plugins

* Local plugins are scanned from `<root>/installed/*/manifest.json`; AI access
  requires the manifest permission + capability and source-specific runtime
  rules. Local and BYOK AI are available to any plugin type without a
  DataRefine AI entitlement; Cloud AI additionally requires `cloudAi` and
  `aiPlugins`. Plugins never call providers directly or deduct credits (only
  via the `datarefine.ai` bridge → central runtime).
* **Catalogue sync** (`plugins::sync`, licensed mode only):
  `GET /api/plugins` → per-plugin `syncAction`
  (`install/update/downgrade/disable/remove/keep`; explicit server action
  always wins; missing entitlement → disable). Applied locally via
  `.drs-disabled` markers that the registry honors on scan.
* **SHA-256 gate**: when the catalogue carries `sha256`, the local artefact
  must match before the plugin may load; mismatch ⇒ refused + diagnostic
  (`blocked-sha256`). `remove` deactivates regardless of cached entitlements.
* `POST /api/plugins/sync` reports the outcome — telemetry only, never
  changes local state. Catalogue unavailable (e.g. endpoint not deployed
  yet) ⇒ sync degrades to a diagnostic; local plugins keep working.

## 8. Maintenance, announcements, updates

* **Maintenance**: `config.maintenance.hard === true` → blocking full-screen;
  otherwise a non-blocking edge-to-edge banner (`MaintenanceBanner`). Local
  work is never blocked by soft maintenance.
* **Announcements**: priority-sorted strip (info/warning) + modal for
  critical; dismissals remembered per `(id, updatedAt)`; never block local
  work.
* **Updates**: `versions.{latest, minimum, downloadUrl, windowsDownloadUrl,
  linuxDownloadUrl, sha256, releaseNotes, updateRequired}` → `latest >
  current` soft prompt; `current < minimum` mandatory screen; platform-specific
  download URLs; sha256 verified when the updater supports it.
* **Events**: Rust emits `license-state-changed`
  `{state, plan, expiresAt, offline}` (no tokens) whenever the decision or
  enforcement changes; the React store listens and refreshes (5 s poll kept
  as a safety net).

## 9. Cloud endpoint status (verified 2026-09-19)

Live on `https://datarefine-license-cloud.vercel.app`: `/api/config`,
`/api/install`, `/api/activate`, `/api/verify`, `/api/announcements`.
Not yet deployed (desktop degrades gracefully, works as soon as they ship):
`/api/bootstrap`, `/api/plugins`, `/api/plugins/sync`, `/api/ai/estimate`,
`/api/ai/wallet`, `/api/ai/jobs`, `/api/ai/usage/check`, and
`/api/ai/usage/record`. The desktop treats missing endpoints as unavailable;
it never authorizes a licensed operation from local counters or balances.

## 10. Test matrix (67 Rust tests, `licensecheck` mirror crate)

Canonical JSON ordering • bootstrap doc valid/tampered/unknown-keyId/expired/
clock-rollback/non-HTTPS • pinned keyId map • legacy signature • endpoint
fallback tiers • policy flip `false→true→false` (entitlement purge from memory
+ disk, cloud-AI refusal, restoration) • `403 LICENSING_DISABLED` →
unrestricted + recovery • `nextCheckInAt` recording • scheduler due-logic with
jitter bounds • soft vs hard maintenance decisions • activation escrow &
verify payloads • token rotation/invalidation • grace & lock decisions •
announcement priority/dismissal • AI router matrix • credits
estimate/reserve/settle gating • idempotency-key stability across retries •
estimate hits only `/api/ai/estimate` • plugin syncAction planning • SHA-256
mismatch blocks + registry skip • remove deactivates • unrestricted mode never
fetches the catalogue • sync report call • BYOK mask • error-code mapping •
single-flight & retry policy • storage roundtrip incl. keyring fallback.

## 11. Invariants (never regress)

Local data never uploaded • no hardcoded cloud URLs outside `cloud::config` •
unsigned endpoint config never trusted • provider keys never exposed to
React/plugins/logs • no AI credit UI or wallet request without the centralized
Cloud-AI eligibility rule (license on, no BYOK/local, cloud source) • cloud failure
never destroys local data • no country/location analytics • destructive
cleaning always needs explicit user approval • all cloud networking through
the central Rust client • all AI through the central runtime.
