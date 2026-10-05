# DataRefine Studio — UI Specification

Living document for UI rules that apply app-wide. Each rule states the trigger,
the required behavior, and where it is implemented.

---

## US-01 — Side-panel option overflow (activity rail)

**Trigger.** The left activity rail lists the workspace's side-panel options:
the built-in views (Explorer, Search, Library, Rules, AI, Lineage, Versions,
Sessions, Marketplace, Extensions) plus one entry per installed plugin that
contributes a sidebar view.

**Rule.**

| Option count | Behavior |
|--------------|----------|
| ≤ 15 | Rail is static — no scrolling at all (`overflow-y: hidden`). |
| > 15 | Rail becomes vertically scrollable **and the scrollbar is hidden** (`scrollbar-width: none`, `::-webkit-scrollbar { display: none }`). Mouse wheel, trackpad, touch drag and keyboard focus traversal continue to work. |

**Constraints.**

- The bottom rail group (collapse-sidebar, GitHub account, Settings) is
  pinned and never scrolls.
- Hiding the scrollbar must not hide the affordance entirely: option tooltips
  (`title`) and `aria-label`s remain, and the focused option is always scrolled
  into view by the browser.
- The threshold is evaluated live — installing/removing plugin views crosses
  it without a restart.

**Implementation.** `src/components/ActivityBar.tsx` computes
`optionCount = ITEMS.length + pluginItems.length` and applies
`drs-scroll-hidden` to `.activity-rail-top` when it exceeds 15; the CSS for
both states lives in `src/index.css`.

---

## US-02 — Remote notices never block local work

Announcements render as an edge-to-edge aligned bar (info/warning) or a modal
(critical only); maintenance renders as a non-blocking banner unless the cloud
explicitly sets `maintenance.hard = true`. See `docs/licensing.md` §8.

---

## US-03 — Confidential diagnostics stay out of the UI

Endpoint, device-ID and machine-ID are Rust-internal; Settings shows no
diagnostics card. Cloud request logs are available to developers only via the
`cloud_diagnostics` command.

---

## US-04 — Update surface appears only on publication

The Settings update card renders only when the cloud publishes a version newer
than the running build (or a mandatory minimum). The action downloads the
platform installer in-app (checksum-verified) and launches it — no browser
redirect.

## US-05 — Plugin marketplace (dedicated Marketplace side panel)

**Surface.** The dedicated Marketplace side-panel option (Store icon in the
activity rail) hosts browsing and installation: a search box with debounced
queries, catalogue result cards (name, author, version, description, install
count), and one-click Install. Local management (enable/disable, trust,
unload, manual zip/path import) lives in the separate Extensions side panel
and keeps its previous behavior.

**Trust rules (enforced in Rust, `plugins/market.rs`).**

1. The marketplace is **always available** — browsing and installing do not
   depend on license mode. The catalogue (`GET /api/plugins`) is fetched from
   the discovery-resolved, signature-verified endpoint; if it cannot be
   reached the panel shows "Marketplace unavailable" with the reason + Retry.
   (Entitlement sync, §35–39, remains licensed-mode only.)
2. Install requires: catalogue `entitled = true`, an artifact URL that is
   HTTPS (or loopback for local dev clouds), and a catalogue `sha256`.
   Missing checksum ⇒ refused ("refusing unverified install").
3. The downloaded archive's SHA-256 must equal the catalogue checksum;
   mismatch ⇒ aborted, nothing left on disk.
4. Archives are extracted with a zip-slip guard (no absolute paths, no
   `..` components) and must contain a valid `manifest.json`; otherwise the
   partial install is deleted.
5. A successful install writes `.drs-install.json` (id, version, sha256,
   source, timestamp) and clears any stale disable marker. Uninstall deletes
   only `<root>/installed/<id>`.
6. Installed plugins remain subject to the existing permission gate, source-
   specific AI capability gate and sync rules (§35–39); Local/BYOK AI does not
   require a DataRefine AI entitlement, while Cloud AI requires `cloudAi` and
   `aiPlugins`. A marketplace install grants no extra rights.

**Cloud contract.** `{ ok, data: { plugins: [ { id, name, version,
description, author, downloads, sha256, artifactUrl, entitled } ] } }`.
Reference implementation: `services/internal/policy-engine/server.py` (`/api/plugins` +
`/api/plugins/artifact/<id>.zip`, sha256 computed live). The deployed Vercel
cloud must serve the same contract for the marketplace to appear there.

## US-06 — Responsive AI settings card

The AI card is a CSS size container (`container-type: inline-size`). Its field
grids (`.ai-kv`, `.ai-eng`) render single-column in narrow sidebars and expand
to two columns at ≥400px container width via `@container` queries, so the card
stays usable at any sidebar width and in the wide Settings page. Browsers
without container-query support fall back to the single-column layout.

## US-07 — Cloud AI credit visibility

The AI Credits card, wallet refresh, purchase action, credit indicators and
zero-balance dialog share the centralized `getAiCreditVisibility` rule. They
appear only when `requireLicense=true`, the runtime is using DataRefine Cloud
AI, no BYOK/local provider is configured, and the cloud provides the
`cloudAi` entitlement. The latest `enableAiCreditPurchase` and
`aiCreditPurchaseUrl` values come from `/api/config`; React never embeds a
purchase URL or license key.
