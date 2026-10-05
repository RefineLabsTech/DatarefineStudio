# Cloud-side tools for desktop endpoint discovery

The desktop embeds ONLY:
- the bootstrap URL (`cloud/config.rs` → BOOTSTRAP_URL)
- the Ed25519 **public** key (ENDPOINT_SIGNING_PUBKEY_HEX)

## Publish a signed endpoint config
```
node services/internal/cloud-bridge/sign-bootstrap.mjs https://your-new-api.example.com 4 90
```
→ writes `bootstrap.json`; serve it verbatim at the bootstrap URL.
When your infrastructure moves (Vercel → Railway etc.), sign a new config;
desktops migrate on next launch with **no reinstall**.

## Key handling
`keys.json` holds the test/production keypair used to sign. In production keep
the private half in your cloud's secret store (Vercel env var etc.) and sign
from CI — the desktop must never contain it.

## Cloud routes the desktop is ready for (graceful until you add them)
- `GET  /bootstrap.json`            signed endpoint config (this tool)
- `GET  /api/ai/credits`            balance/reserved (AI Pro only)
- `POST /api/ai/credits/reserve`    { amount } → { reservationId }
- `POST /api/ai/credits/settle`     { reservationId, used } → refunds unused
- `POST /api/ai/jobs`               submit cloud AI job
- `GET  /api/ai/jobs/:id`           job status
- `POST /api/ai/jobs/:id/cancel`    cancel
- verify/activate `entitlements`    { cloudAi, aiPlugins, agents, capabilities }

Until these exist, the desktop degrades gracefully: Standard-license behavior,
local/BYOK AI via the sidecar, and credits/jobs UI hidden.

## Production document format (default)

`node services/internal/cloud-bridge/sign-bootstrap.mjs <apiBaseUrl> [version] [validDays]` now
emits the canonical-JSON bootstrap document:

```json
{ "keyId": "drs-main-2025", "version": 4, "issuedAt": "…", "expiresAt": "…",
  "api": { "baseUrl": "https://…", "fallbackBaseUrls": [] },
  "app": {}, "endpoints": {}, "features": {}, "signature": "…" }
```

The Ed25519 signature covers the canonical JSON of the document WITHOUT the
`signature` field (keys sorted recursively, arrays in order, no whitespace,
UTF-8). The desktop resolves `keyId` against a pinned key set, so you can
rotate keys by shipping a new keyId+pubkey pair in an app update while old
documents keep verifying. Pass `--legacy` to emit the previous 4-line-payload
format (still accepted as a fallback).

Serve the document at `GET /api/bootstrap` on the bootstrap host (currently
NOT deployed on datarefine-license-cloud.vercel.app — the desktop falls back
to the cached/stable endpoint until it ships; same for `/api/plugins`,
`/api/plugins/sync`, `/api/ai/estimate`, `/api/ai/credits`, `/api/ai/jobs`).
