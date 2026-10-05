# DataRefine JSON/API Importer

A local-first DataRefine Studio plugin for importing JSON records from a GET API into the active DataRefine sheet.

**Requires:** DataRefine Studio `>=1.0.0`. The **Import into active sheet** action requires an open dataset. Preview can run before a dataset is open.

## Workflow

1. Open the **JSON/API Importer** view.
2. Enter an HTTPS API URL.
3. Optionally enter a records path such as `data.items`.
4. Add JSON headers or choose Bearer/API-key authentication.
5. Configure page, offset/limit, or next-link pagination when needed.
6. Press **Preview API response**.
7. Review the flattened columns and sample values.
8. Open a dataset and press **Import into active sheet**.

The import replaces the active frame with the fetched, flattened result as one normal DataRefine operation. Workspace history and undo are preserved. It does not silently append or delete records.

## Supported behavior

- GET requests only
- HTTPS URLs; HTTP is allowed only for localhost development
- Custom JSON headers
- Bearer tokens
- API keys in a named header
- Records paths such as `data.items` or `response.results`
- One-shot requests
- Page-number pagination
- Offset/limit pagination
- Follow-a-next-link pagination
- Nested-object flattening into columns
- Array conversion by joining values, retaining JSON text, or choosing the first value
- Bounded response size of 16 MB per page and a maximum of 100 pages
- Preview without changing the active sheet

For a response like:

```json
{
  "data": [
    {"id": 1, "name": "A", "address": {"city": "Dhaka"}, "tags": ["vip", "trial"]}
  ]
}
```

The default output columns include:

```text
id
name
address.city
tags
```

## Security and privacy

This plugin requests `python.network` and `python.import`, so it starts disabled until the user explicitly chooses **Trust & enable** in Extensions. Review the package before granting Trust.

- Only an explicit user command performs a network request.
- HTTPS is required for remote APIs.
- Redirects are checked with the same HTTPS/localhost policy.
- Credentials are entered for the operation and are not saved by the plugin.
- Credentials are never included in preview output or error messages.
- The plugin does not send data to DataRefine Cloud or an intermediate service.
- Response bodies are kept local and are limited to 16 MB per page.
- Do not put secrets in the URL or in logs.

## Uninstall

Open the DataRefine Extensions panel, choose **JSON/API Importer**, and select **Unload**. Files on disk are removed; the active dataset and its history are not deleted.
