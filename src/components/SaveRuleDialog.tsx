import { useEffect, useState } from "react";
import { useUI } from "../store/ui";
import { useWorkspace } from "../store/workspace";
import { useUniversal } from "../store/universal";
import { api } from "../ipc/client";

export function SaveRuleDialog() {
  const draft = useUI((s) => s.ruleDialog);
  const close = useUI((s) => s.closeRuleDialog);
  const refreshLibrary = useWorkspace((s) => s.refreshLibrary);
  const setOn = useUniversal((s) => s.setOn);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [destination, setDestination] = useState<"library" | "universal">("library");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!draft) return;
    setName(draft.name || "");
    setDescription(draft.description || "");
    setCategory(draft.category || "");
    setDestination(draft.destination || "library");
    setErr("");
  }, [draft]);

  if (!draft) return null;

  const language = draft.language;
  const body = draft.body;

  const save = async () => {
    if (!name.trim()) {
      setErr("Name is required.");
      return;
    }
    if (!body.trim()) {
      setErr("The editor is empty. Write the rule, then save.");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      if (destination === "universal") {
        const r = await api.saveRule({
          name: name.trim(),
          kind: "universal",
          body: body.trim(),
          description: description.trim(),
          category: category.trim() || "universal",
          parameters: { language },
        });
        await refreshLibrary();
        if (r?.id) await setOn(`id:${r.id}`, true);
        else await setOn(name.trim(), true);
      } else {
        await api.saveRule({
          name: name.trim(),
          kind: language,
          body: body.trim(),
          description: description.trim(),
          category: category.trim() || language,
        });
        await refreshLibrary();
      }
      close();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div role="dialog" aria-modal="true" className="drs-modal" onClick={close}>
      <div className="drs-modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="drs-modal-h">Save rule</div>
        <p className="drs-modal-lead">Name it, then choose where it lives. Code is taken from the editor.</p>

        <div className="drs-save-toggle" role="tablist" aria-label="Save destination">
          <button
            type="button"
            role="tab"
            aria-selected={destination === "library"}
            className={destination === "library" ? "is-on" : ""}
            onClick={() => setDestination("library")}
          >
            Save in library
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={destination === "universal"}
            className={destination === "universal" ? "is-on" : ""}
            onClick={() => setDestination("universal")}
          >
            Save as universal rule
          </button>
        </div>

        <label className="drs-modal-field">
          Name
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Title-case names" autoFocus />
        </label>
        <label className="drs-modal-field">
          Description
          <input className="field" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this does" />
        </label>
        <label className="drs-modal-field">
          Category
          <input
            className="field"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder={destination === "universal" ? "cleaning, contact, geo…" : "sql, javascript, python…"}
          />
        </label>

        <div className="drs-save-hint">
          {destination === "universal"
            ? "Goes to the Rules panel. Toggle it on to run on the whole sheet."
            : "Goes to Library. Insert it later into the SQL, JavaScript, or Python editor."}
        </div>

        {err ? <div className="drs-ai-err">{err}</div> : null}
        <div className="drs-modal-actions">
          <button type="button" onClick={close}>
            Cancel
          </button>
          <button type="button" className="ok" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : destination === "universal" ? "Save as universal rule" : "Save in library"}
          </button>
        </div>
      </div>
    </div>
  );
}
