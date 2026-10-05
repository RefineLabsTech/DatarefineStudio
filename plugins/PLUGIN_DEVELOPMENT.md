# DataRefine Studio Plugin Development Instructions

Version: 1.0  
Audience: programmers building plugins for DataRefine Studio  
Plugin format: DataRefine plugin packages, not VS Code extensions, Chrome extensions, or npm packages

## 1. What a DataRefine plugin is

A DataRefine plugin is a folder or ZIP package discovered by the local DataRefine plugin loader. A plugin can contribute:

- Sidebar views and declarative forms
- Commands
- Themes, snippets, status-bar entries, and AI prompt metadata
- Dataset rules and transformation hooks
- Importers and exporters

Plugins run through DataRefine's local plugin system. They do not automatically receive access to the browser, cloud services, provider APIs, credentials, or arbitrary files.

There are two plugin layers:

1. **Declarative/UI plugins** — the normal plugin format. These use a manifest and the existing plugin sidebar. They are the safest and easiest to distribute.
2. **Core-rendered first-party views** — special views implemented inside the DataRefine application core. These are needed only when a view must use privileged application APIs, such as creating a new database session. A third-party ZIP cannot add a new core-rendered component by itself.

## 2. Recommended project layout

Use a separate directory for each plugin:

```text
my-plugin/
├── datarefine.plugin.json
├── manifest.json                 # Required when publishing through Marketplace
├── README.md
├── main.py                       # Optional Python implementation
├── io.py                         # Optional importer/exporter implementation
└── assets/                       # Optional documentation assets
```

For a manual DataRefine install, `datarefine.plugin.json` is the important manifest. For marketplace installation, include both manifests at the **root of the ZIP**:

- `datarefine.plugin.json` is used by the DataRefine sidecar/plugin loader.
- `manifest.json` is used by the Rust marketplace installer and must be present at the archive root.

Do not place the files inside an extra wrapper directory in the ZIP. The marketplace installer extracts the archive directly into the installed plugin directory.

## 3. Minimal DataRefine manifest

Create `datarefine.plugin.json`:

```json
{
  "name": "acme.example-plugin",
  "displayName": "Example Plugin",
  "version": "1.0.0",
  "publisher": "Acme",
  "description": "A short description of what the plugin does.",
  "engines": {
    "datarefine": ">=1.0.0"
  },
  "permissions": [],
  "contributes": {
    "commands": [],
    "views": [],
    "themes": [],
    "snippets": [],
    "statusBar": [],
    "rules": [],
    "hooks": {},
    "ingest": [],
    "exporters": [],
    "ai": {
      "steps": [],
      "prompts": {}
    }
  }
}
```

### Manifest rules

- `name` is the plugin ID. Use letters, numbers, dots, hyphens, or underscores.
- The ID must be stable. Do not change it between releases.
- `version` should use a predictable version such as `1.0.0`.
- `permissions` should be empty unless a capability genuinely requires extra access.
- Unknown or unnecessary permissions make review and installation harder.
- Keep all user-facing text clear and short.

The loader also accepts `datarefine.extension.json` and qualifying `package.json` files, but `datarefine.plugin.json` is the preferred format.

## 4. Declarative sidebar views

A normal UI plugin contributes a view like this:

```json
{
  "id": "acme.example.panel",
  "title": "Example Tools",
  "icon": "blocks",
  "sidebar": true,
  "body": "Use this panel to run the example operation.",
  "fields": [
    {
      "id": "name",
      "label": "Name",
      "type": "text",
      "placeholder": "Column or value"
    },
    {
      "id": "mode",
      "label": "Mode",
      "type": "select",
      "default": "trim",
      "options": [
        { "value": "trim", "label": "Trim whitespace" },
        { "value": "lower", "label": "Lowercase" }
      ]
    },
    {
      "id": "notes",
      "label": "Notes",
      "type": "textarea",
      "hint": "Optional instructions.",
      "when": { "field": "mode", "equals": "trim" }
    }
  ],
  "options": [
    {
      "id": "run",
      "label": "Run operation",
      "hint": "Applies the operation to the open dataset.",
      "command": "acme.example.run"
    }
  ]
}
```

### Supported generic field behavior

The generic plugin sidebar supports:

- `text`
- `textarea`
- `select`

An unknown field type is treated like a text input. Select options can be strings or objects with `value` and `label`.

A field can be conditionally displayed with:

```json
"when": { "field": "mode", "equals": "trim" }
```

or:

```json
"when": { "field": "mode", "in": ["trim", "lower"] }
```

The generic plugin view does not execute arbitrary HTML, JavaScript, CSS, or external scripts from a plugin package. Keep a normal plugin declarative.

## 5. Commands and Python transformations

Declare a command with a Python reference:

```json
{
  "id": "acme.example.run",
  "title": "Run Example Operation",
  "python": "main.py:run"
}
```

`main.py`:

```python
def run(df, ctx):
    """Return the transformed Polars DataFrame."""
    if "name" not in df.columns:
        return df
    return df.with_columns(
        pl.col("name").cast(pl.Utf8, strict=False).str.strip_chars().alias("name")
    )
```

The plugin runtime provides the Polars namespace as `pl` and selected standard helpers including `re`, `json`, `math`, `io`, and `unicodedata`. A normal plugin should not import arbitrary modules.

The normal command contract is:

```python
def run(df, ctx):
    return df              # unchanged frame
```

or:

```python
def run(df, ctx):
    return changed_df      # new Polars frame
```

The command receives a context dictionary. It may contain values such as:

- `session_id`
- `command_id`
- `workspace`
- plugin form values passed by the view
- authenticated GitHub identity metadata where applicable

Do not assume that every context key exists. Treat context values as optional.

A Python command normally operates on the currently open dataset. It does not create a second workspace session. A command returning a Polars frame updates the active session and records a plugin operation in workspace history.

If a command returns text instead of a Polars frame, the text is shown as command output and may be written to the session log. Never include passwords, API keys, tokens, connection URIs, or private data in that output.

## 6. Rules, hooks, importers, and exporters

### Rules

Rules can be contributed under `contributes.rules`. They are intended for reusable transformations that operate on the active Polars frame.

### Hooks

Supported lifecycle hook names include:

```text
after_ingest
before_pipeline
after_rules
after_sql
after_javascript
after_python
after_pipeline
before_export
after_export
```

Declare a hook like this:

```json
"hooks": {
  "after_ingest": "main.py:after_ingest"
}
```

A hook should be deterministic, local, and safe to run in the corresponding lifecycle stage. If it changes a frame, return the new frame.

### Importers and exporters

An importer or exporter declaration identifies a Python module and function:

```json
"ingest": [
  {
    "extensions": [".example"],
    "python": "io.py",
    "function": "load"
  }
],
"exporters": [
  {
    "id": "example",
    "ext": "example",
    "python": "io.py",
    "function": "export"
  }
]
```

Keep file handling bounded and explicit. Do not silently upload local files or copy datasets to a remote service.

## 7. View actions

The built-in declarative rule view recognizes these actions:

- `newRule`
- `saveRule`
- `applyRule`

A view can also run a declared plugin command by using `command` in its option. For example:

```json
"options": [
  {
    "id": "apply",
    "label": "Apply",
    "command": "acme.example.run",
    "session": true
  }
]
```

The generic sidebar blocks dataset operations when no dataset is open. Design the option label and hint so the user understands whether it requires an active dataset.

## 8. First-party core-rendered components

A manifest may contain a view field such as:

```json
"component": "database-import"
```

This is **not** a general plugin extension mechanism. Core-rendered components are allowlisted in the DataRefine application source and are reserved for first-party features that need privileged core APIs.

For example, the first-party Database Importer uses a core-rendered component because it must:

- Reuse the core `ConnForm`, `SavedConn`, `formToConfig`, and saved-connection storage
- Call the local `api.database()` and `api.dbTest()` APIs
- Create a normal DataRefine session
- Load the session through the workspace viewport/profile/lineage path

A third-party programmer must not invent a component name and expect it to work. Adding a new core component requires a corresponding application change in `PluginSidebar` and an explicit plugin-ID allowlist. Do not expose privileged database, credential, cloud, or provider APIs to arbitrary imported plugins.

## 9. Permissions and trust

The recognized extra Python permissions are:

```text
python.import
python.fs
python.network
python.subprocess
```

Use the smallest possible permission set:

- No permissions for ordinary Polars transformations
- `python.fs` only when a plugin genuinely needs local file access
- `python.network` only for a reviewed local/network integration
- `python.subprocess` only for a reviewed process integration
- `python.import` only when a reviewed dependency/import is required

Plugins with extra permissions require explicit Trust in the DataRefine Extensions area. Do not work around the trust system.

## 10. Security and privacy requirements

Every plugin must follow these rules:

1. Keep local datasets local unless the user explicitly starts an approved operation.
2. Do not send rows, columns, file contents, credentials, or provider keys to a plugin server.
3. Do not call AI providers, cloud credit APIs, or license endpoints directly from plugin code.
4. Do not expose provider keys in a plugin UI, status message, command output, exception, or log.
5. Do not store API keys in plugin JSON, localStorage, plain settings, or source files.
6. Use the central Rust/runtime path for credential storage and cloud/provider operations.
7. Never silently mutate a dataset during a cloud operation.
8. Ask for approval before destructive or irreversible cleaning.
9. Avoid `print()` statements containing user data or connection information.
10. Redact secrets before displaying exceptions returned by database or HTTP libraries.
11. Do not use `unwrap()` or equivalent unchecked operations in network/storage paths.
12. Do not add telemetry. Anonymous device registration is controlled by the application core.

For database integrations, use the existing connection/session APIs. Do not create a second credential store.

## 11. Icons

Plugin view icons use named icons resolved by DataRefine core. Current examples include:

```text
blocks
brush
clean
database
git
help
layout
list
rules
scroll
sliders
sparkles
type
wand
```

Set the view icon like this:

```json
"icon": "database"
```

For a marketplace-distributed plugin, also put the icon name in the root `manifest.json` and any marketplace catalogue metadata:

```json
{
  "id": "acme.example-plugin",
  "name": "Example Plugin",
  "version": "1.0.0",
  "type": "tool",
  "permissions": [],
  "capabilities": [],
  "icon": "blocks"
}
```

An icon name is resolved by the application. An arbitrary image filename will not automatically become a sidebar icon. Adding a new icon glyph requires a core change in `src/lib/pluginIcons.tsx`.

## 12. Marketplace packaging

The Rust marketplace installer requires a root-level `manifest.json` with fields such as:

```json
{
  "id": "acme.example-plugin",
  "name": "Example Plugin",
  "version": "1.0.0",
  "type": "tool",
  "permissions": [],
  "capabilities": [],
  "description": "Example marketplace plugin.",
  "publisher": "Acme",
  "icon": "blocks"
}
```

The marketplace catalogue entry must provide:

- The same plugin ID
- Version and description
- A trusted `artifactUrl` using HTTPS or an approved local development URL
- A SHA-256 checksum for the exact ZIP bytes
- The marketplace entitlement metadata, when a product wants to display access information

The installer verifies URL policy, checksum, ZIP paths, and `manifest.json` before installation. Marketplace visibility and installation are public; a missing or invalid artifact is rejected. First-party development artifacts may be bundled under `plugins/catalog`.

To produce a ZIP with files at the archive root:

```bash
cd my-plugin
zip -q ../acme-example-plugin.zip \
  README.md \
  manifest.json \
  datarefine.plugin.json \
  main.py
```

Do not use a ZIP layout like this for marketplace artifacts:

```text
acme-example-plugin/
└── manifest.json
```

The root-level `manifest.json` must be directly inside the archive.

## 13. Manual installation

1. Start DataRefine Studio.
2. Open the Extensions side panel.
3. Choose **Import zip**.
4. Select the plugin ZIP.
5. Enable the plugin.
6. Trust it only if its declared permissions and code have been reviewed.
7. Confirm that its view appears in the activity bar.

For a plugin with no extra permissions, installation normally enables it automatically. The user can still turn it off or unload it.

## 14. Testing checklist

Before distributing a plugin, verify:

- The plugin ID is stable and valid.
- The version is updated for every release.
- `datarefine.plugin.json` parses as valid JSON.
- `manifest.json` is present at the ZIP root when marketplace distribution is planned.
- The ZIP contains no unsafe `../` paths or absolute paths.
- The plugin imports manually through Extensions.
- The activity-bar icon and title are correct.
- The plugin behaves correctly with no active dataset.
- Invalid form values produce useful validation messages.
- Commands do not leak secrets or row contents.
- Dataset operations preserve normal session history and workspace state.
- Extra permissions are justified and documented.
- Local data remains local.
- Marketplace checksum is calculated from the final ZIP, not from the source folder.

For application-side changes, validate with the project's normal Windows command:

```text
npm run tauri dev
```

## 15. Release checklist

Include these files in the release package:

```text
README.md
manifest.json
datarefine.plugin.json
main.py or other implementation files
```

The README should state:

- What the plugin does
- Which DataRefine version it requires
- Which permissions it requests and why
- Whether it changes the active dataset
- Whether it needs an active session
- What local data it reads or writes
- How to uninstall it
- Whether it requires a matching DataRefine core version

Keep the plugin package small, deterministic, and reviewable. A plugin should extend DataRefine rather than recreate its credential system, workspace state, AI runtime, or cloud client.
