# DataRefine Studio — license admin

Remote control plane for the desktop app. **Require License** can be turned on without shipping a new desktop build. Clients read `GET /api/config` on launch and about every 60 seconds.

## Run

```bash
py -3.12 services/internal/policy-engine/server.py
```

- Admin UI: `http://127.0.0.1:8788/admin`
- Public config: `http://127.0.0.1:8788/api/config`

Environment:

| Variable | Default |
| --- | --- |
| `LICENSE_PORT` | `8788` |
| `LICENSE_HOST` | `0.0.0.0` |
| `LICENSE_ADMIN_PASSWORD` | `change-me` |
| `LICENSE_SECRET` | HMAC secret for tokens |
| `LICENSE_DB` | `services/internal/policy-engine/data.db` |

Put this origin (HTTPS in production) in the desktop app:

- `config/license-api.txt` — one URL, no trailing slash
- or env `DATAREFINE_LICENSE_API`

Leave the file blank to run **without** licensing.

## API

`GET /api/config` → `{ requireLicense, maintenance, buyUrl, githubUrl, supportEmail, latestVersion, minimumVersion }`

`POST /api/activate` → `{ licenseKey, machineId, appVersion, platform }` → an envelope with `{ success, activationToken, plan, expiresAt, entitlements }`. Community keys are free forever; Professional Monthly, 3 Months, 6 Months, and Yearly keys carry their corresponding term.

`POST /api/verify` (or `GET /api/verify?token=`) → an envelope with `{ status, plan, expiresAt, entitlements }`.

`POST /api/ai/usage/check` and `POST /api/ai/usage/record` accept `{ activationToken, source, kind: "file_cleaning", operationId }`. The server owns the calendar-month boundary and returns `{ plan, month, used, limit, unlimited, allowed, upgradeUrl }`. Community has 15 file cleanings per month across local, BYOK, and Cloud; Professional plans are unlimited. The usage ledger is separate from the Cloud AI wallet.

Default `requireLicense` is **false**. Desktop apps stay fully usable until you flip the toggle.
