# DataRefine Studio plugins

First-party plugins for **this app only**. Not VS Code, Chrome, or npm.

## Where they live

- Bundled: `plugins/<id>/`
- Imported: `plugins/installed/<id>/`
- Manage in the **Extensions** side panel (activity bar). Import zip/file, On/Off, Unload.
- If the plugin contributes `views` (interface / options), an extra activity-bar item appears — same pattern as Explorer. Off or Unload removes it. Core-only plugins add no rail icon.

## Manifest

`datarefine.plugin.json` or a `package.json` with `"engines": { "datarefine": ">=1.0.0" }`.

```json
{
  "name": "publisher.my-plugin",
  "displayName": "My plugin",
  "version": "1.0.0",
  "description": "…",
  "engines": { "datarefine": ">=1.0.0" },
  "permissions": [],
  "contributes": {
    "commands": [{ "id": "my.run", "title": "Do work", "python": "main.py:run" }],
    "themes": [],
    "snippets": [],
    "statusBar": [],
    "views": [{
      "id": "my.panel",
      "title": "My panel",
      "icon": "blocks",
      "sidebar": true,
      "body": "Shown in the extra sidebar page.",
      "catalog": "rules",
      "fields": [
        { "id": "name", "label": "Name", "type": "text" },
        { "id": "kind", "label": "Kind", "type": "select", "default": "universal", "options": ["universal", "sql", "javascript", "python", "regex"] },
        { "id": "body", "label": "Rule body", "type": "textarea" }
      ],
      "options": [
        { "id": "save", "label": "Save to library", "action": "saveRule" },
        { "id": "apply", "label": "Apply", "action": "applyRule" }
      ]
    }],
    "rules": [],
    "hooks": { "after_ingest": "main.py:after_ingest" },
    "ingest": [{ "extensions": [".md"], "python": "io.py", "function": "load" }],
    "exporters": [{ "id": "md", "ext": "md", "python": "io.py", "function": "export" }],
    "ai": { "steps": [], "prompts": {} }
  }
}
```

View option `action` values: `saveRule`, `applyRule`, `newRule`. Fields are the form on that sidebar page.

## Levels

- **UI** — commands, themes, snippets, status, views, AI prompts. Work app-wide once On.
- **Core** — Python against the live Polars frame (rules, hooks, ingest, export, commands). Sandboxed (`pl`, `re`, `json`, `math`, `io`, `unicodedata` injected). Extra permissions require **Trust** in Settings.

Hooks: `after_ingest`, `before_pipeline`, `after_rules`, `after_sql`, `after_javascript`, `after_python`, `after_pipeline`, `before_export`, `after_export`.

Python: `def run(df, ctx): return df`.

Shipped: **Clean Kit** (core) and **Studio UI Kit** (UI). Import extra plugins (for example Rule Lab) from a zip — they are not bundled.
