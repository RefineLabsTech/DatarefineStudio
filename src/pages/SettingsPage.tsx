import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Github, Pencil, Plus, Trash2 } from "lucide-react";
import { PromptStudio } from "../components/PromptStudio";
import { useLicense } from "../store/license";
import { LicenseStatusPanel } from "../components/license/LicenseStatusPanel";
import { AiSection, UpdatesSection } from "./SettingsExtras";
import { api } from "../ipc/client";
import { THEMES, THEME_IDS, extraThemes, themeDef } from "../theme/themes";
import { useUI } from "../store/ui";
import { useWorkspace } from "../store/workspace";
import { useAuth } from "../store/auth";
import {
  COLORS,
  EMPTY_FORM,
  KINDS,
  loadConnections,
  saveConnections,
  type ConnForm,
  type SavedConn,
} from "../lib/db";

function LicenseSection() {
  const requireLicense = useLicense((s) => s.snap?.requireLicense ?? false);
  if (!requireLicense) return null;
  return (
    <section style={{ borderRadius: 12, padding: 14, border: "1px solid var(--border)", background: "var(--bg)", display: "grid", gap: 10 }}>
      <h2 style={{ fontSize: 13, fontWeight: 650, margin: 0 }}>License</h2>
      <LicenseStatusPanel />
    </section>
  );
}

export function SettingsPage() {
  const { theme, setTheme, terminalEnabled, setTerminalEnabled } = useUI(
    useShallow((s) => ({
      theme: s.theme,
      setTheme: s.setTheme,
      terminalEnabled: s.terminalEnabled,
      setTerminalEnabled: s.setTerminalEnabled,
    })),
  );
  const [s, setS] = useState<Record<string, unknown>>({});
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    let alive = true;
    api
      .settings()
      .then((next) => {
        if (!alive) return;
        setS(next);
        setSettingsLoaded(true);
      })
      .catch(() => {
        if (alive) setSettingsLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, []);
  const ai = (s.ai as Record<string, unknown>) || {};
  const prompts = (ai.prompts as Record<string, string>) || {};

  const patchAi = (patch: Record<string, unknown>) =>
    setS((current) => {
      const currentAi = (current.ai as Record<string, unknown>) || {};
      return { ...current, ai: { ...currentAi, ...patch } };
    });

  const patchPrompts = (next: Record<string, string>) => {
    setMsg("");
    patchAi({ prompts: next });
  };

  const savePrompts = async () => {
    setMsg("Saving prompt configuration…");
    try {
      const live = (await api.settings()) as Record<string, unknown>;
      const liveAi = (live.ai as Record<string, unknown>) || {};
      const nextAi = { ...liveAi, ...ai, prompts };
      await api.saveSettings({ ...live, theme, ai: nextAi });
      setS({ ...live, theme, ai: nextAi });
      setMsg("Prompt configuration saved.");
    } catch (e) {
      setMsg(String((e as Error)?.message || e));
    }
  };

  return (
    <div style={{ padding: 16, fontSize: 13, color: "var(--text)", display: "grid", gap: 16 }}>
      <h1 style={{ fontSize: 16, fontWeight: 650, margin: 0 }}>Settings</h1>
      <LicenseSection />
      <AiSection />
      <UpdatesSection />
      <section style={{ borderRadius: 12, padding: 14, border: "1px solid var(--border)", background: "var(--bg)", display: "grid", gap: 10 }}>
        <h2 style={{ fontSize: 13, fontWeight: 650, margin: 0 }}>Color theme</h2>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          {THEME_IDS.map((id) => (
            <button
              key={id}
              onClick={() => setTheme(id)}
              style={{
                textAlign: "left",
                borderRadius: 10,
                padding: 10,
                border: id === theme ? "2px solid var(--accent)" : "1px solid var(--border)",
                background: "var(--bg-elev)",
                color: "var(--text)",
              }}
            >
              <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
                {THEMES[id].swatches.map((c) => (
                  <span key={c} style={{ width: 22, height: 22, borderRadius: 6, background: c }} />
                ))}
              </div>
              <div style={{ fontWeight: 600 }}>{THEMES[id].label}</div>
              <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{THEMES[id].hint}</div>
            </button>
          ))}
          {extraThemes().map((t) => (
            <button
              key={t.id}
              onClick={() => setTheme(t.id)}
              style={{
                textAlign: "left",
                borderRadius: 10,
                padding: 10,
                border: t.id === theme ? "2px solid var(--accent)" : "1px solid var(--border)",
                background: "var(--bg-elev)",
                color: "var(--text)",
              }}
            >
              <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
                {(t.swatches || themeDef(t.id).swatches).map((c) => (
                  <span key={c} style={{ width: 22, height: 22, borderRadius: 6, background: c }} />
                ))}
              </div>
              <div style={{ fontWeight: 600 }}>{t.label}</div>
              <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t.hint}</div>
            </button>
          ))}
        </div>
      </section>

      <section style={{ borderRadius: 12, padding: 14, border: "1px solid var(--border)", background: "var(--bg)", display: "grid", gap: 10 }}>
        <h2 style={{ fontSize: 13, fontWeight: 650, margin: 0 }}>Terminal</h2>
        <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.45 }}>
          Run shell commands on this machine from a panel next to SQL / JavaScript / Python. PowerShell on Windows, sh elsewhere.
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
          <input type="checkbox" checked={terminalEnabled} onChange={(e) => setTerminalEnabled(e.target.checked)} />
          Show terminal panel
        </label>
      </section>

      <ConnectionsSection />

      <GithubSection />

      <PromptStudio
        prompts={prompts}
        onChange={patchPrompts}
        onSave={savePrompts}
        message={msg}
        loading={!settingsLoaded}
      />
    </div>
  );
}

function blankConn(): SavedConn {
  return {
    id: crypto.randomUUID?.() || String(Date.now()),
    name: "",
    color: COLORS[0],
    savePassword: true,
    form: { ...EMPTY_FORM, ssh: { ...EMPTY_FORM.ssh } },
  };
}

function ConnectionsSection() {
  const setConnectOpen = useWorkspace((s) => s.setConnectOpen);
  const setPushOpen = useWorkspace((s) => s.setPushOpen);
  const askConfirm = useUI((s) => s.askConfirm);
  const [rows, setRows] = useState<SavedConn[]>([]);
  const [edit, setEdit] = useState<SavedConn | null>(null);
  const [msg, setMsg] = useState("");

  const reload = () => loadConnections().then(setRows).catch(() => undefined);
  useEffect(() => {
    void reload();
  }, []);

  const persist = async (next: SavedConn[]) => {
    await saveConnections(next);
    setRows(next);
  };

  const saveEdit = async () => {
    if (!edit) return;
    const name = edit.name.trim() || `${edit.form.kind}-${edit.form.host || edit.form.path || "db"}`;
    const item: SavedConn = {
      ...edit,
      name,
      form: edit.savePassword ? edit.form : { ...edit.form, password: "", ssh: { ...edit.form.ssh, password: "" } },
    };
    const exists = rows.some((r) => r.id === item.id);
    const next = exists ? rows.map((r) => (r.id === item.id ? item : r)) : [item, ...rows];
    try {
      await persist(next);
      setEdit(null);
      setMsg(`Saved “${item.name}”`);
    } catch (e) {
      setMsg(String(e));
    }
  };

  const remove = async (id: string, name: string) => {
    try {
      await persist(rows.filter((r) => r.id !== id));
      if (edit?.id === id) setEdit(null);
      setMsg(`Deleted “${name}”`);
    } catch (e) {
      setMsg(String(e));
    }
  };

  const patchForm = (p: Partial<ConnForm>) => {
    if (!edit) return;
    setEdit({ ...edit, form: { ...edit.form, ...p } });
  };

  const fileKind = edit && (edit.form.kind === "sqlite" || edit.form.kind === "duckdb");

  return (
    <section style={{ borderRadius: 12, padding: 14, border: "1px solid var(--border)", background: "var(--bg)", display: "grid", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <h2 style={{ fontSize: 13, fontWeight: 650, margin: 0, flex: 1 }}>Saved connections</h2>
        <button
          type="button"
          onClick={() => {
            setEdit(blankConn());
            setMsg("");
          }}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "5px 10px",
            borderRadius: 8,
            border: "none",
            background: "var(--accent)",
            color: "#fff",
            fontSize: 11,
            fontWeight: 600,
          }}
        >
          <Plus size={12} /> Add
        </button>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.45 }}>
        Edit or delete connections saved from Connect. Used by Push and Connect.
      </div>

      {!rows.length && !edit && <div style={{ fontSize: 12, color: "var(--text-dim)" }}>No saved connections yet.</div>}

      {rows.map((c) => {
        const host = c.form.mode === "file" || c.form.kind === "sqlite" || c.form.kind === "duckdb" ? c.form.path : c.form.host;
        const open = edit?.id === c.id;
        return (
          <div key={c.id} style={{ borderRadius: 10, border: "1px solid var(--border)", background: "var(--bg-elev)", overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px" }}>
              <span style={{ width: 10, height: 10, borderRadius: 99, background: c.color, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</div>
                <div style={{ fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {c.form.kind}
                  {host ? ` · ${host}` : ""}
                  {c.form.port && c.form.mode !== "file" ? `:${c.form.port}` : ""}
                  {c.form.database ? ` / ${c.form.database}` : ""}
                </div>
              </div>
              <button
                type="button"
                title="Edit"
                className="ws-icon"
                onClick={() => {
                  setEdit(
                    open
                      ? null
                      : {
                          ...c,
                          form: {
                            ...EMPTY_FORM,
                            ...c.form,
                            ssh: { ...EMPTY_FORM.ssh, ...(c.form.ssh || {}) },
                          },
                        },
                  );
                  setMsg("");
                }}
                style={{ width: 28, height: 28, border: "none", borderRadius: 8, background: "transparent", color: "var(--text-dim)", display: "grid", placeItems: "center" }}
              >
                <Pencil size={13} />
              </button>
              <button
                type="button"
                title="Delete"
                className="ws-icon"
                onClick={() => {
                  void (async () => {
                    const ok = await askConfirm({
                      title: `Delete “${c.name}”?`,
                      message: "This connection is removed from Settings. Saved passwords for it are deleted on this machine.",
                      detail: "You can add it again from Connect.",
                      confirmLabel: "Delete",
                      danger: true,
                    });
                    if (ok) await remove(c.id, c.name);
                  })();
                }}
                style={{ width: 28, height: 28, border: "none", borderRadius: 8, background: "transparent", color: "var(--danger)", display: "grid", placeItems: "center" }}
              >
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        );
      })}

      {edit && (
        <div style={{ display: "grid", gap: 8, padding: 12, borderRadius: 10, border: "1px solid var(--border)", background: "var(--bg-elev)" }}>
          <div style={{ fontWeight: 600, fontSize: 12 }}>{rows.some((r) => r.id === edit.id) ? "Edit connection" : "New connection"}</div>
          <label style={{ display: "grid", gap: 6, fontSize: 11, color: "var(--text-dim)" }}>
            Name
            <input className="field" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="Production Postgres" />
          </label>
          <label style={{ display: "grid", gap: 6, fontSize: 11, color: "var(--text-dim)" }}>
            Type
            <select
              className="field"
              value={edit.form.kind}
              onChange={(e) => {
                const id = e.target.value as ConnForm["kind"];
                const spec = KINDS.find((k) => k.id === id);
                patchForm({
                  kind: id,
                  port: spec?.port || edit.form.port,
                  mode: id === "sqlite" || id === "duckdb" ? "file" : edit.form.mode === "file" ? "host" : edit.form.mode,
                });
              }}
            >
              {KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
          {fileKind ? (
            <label style={{ display: "grid", gap: 6, fontSize: 11, color: "var(--text-dim)" }}>
              File path
              <input className="field" value={edit.form.path} onChange={(e) => patchForm({ path: e.target.value })} />
            </label>
          ) : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 90px", gap: 8 }}>
                <input className="field" placeholder="Host" value={edit.form.host} onChange={(e) => patchForm({ host: e.target.value })} />
                <input className="field" placeholder="Port" value={edit.form.port} onChange={(e) => patchForm({ port: e.target.value })} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <input className="field" placeholder="User" value={edit.form.user} onChange={(e) => patchForm({ user: e.target.value })} autoComplete="off" />
                <input className="field" type="password" placeholder="Password" value={edit.form.password} onChange={(e) => patchForm({ password: e.target.value })} autoComplete="new-password" />
              </div>
              <input className="field" placeholder="Database" value={edit.form.database} onChange={(e) => patchForm({ database: e.target.value })} />
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                <input type="checkbox" checked={edit.form.ssl} onChange={(e) => patchForm({ ssl: e.target.checked })} />
                SSL
              </label>
            </>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, flex: 1 }}>
              <input type="checkbox" checked={edit.savePassword} onChange={(e) => setEdit({ ...edit, savePassword: e.target.checked })} />
              Save password
            </label>
            <div style={{ display: "flex", gap: 6 }}>
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setEdit({ ...edit, color: c })}
                  title={c}
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: 99,
                    border: edit.color === c ? "2px solid #fff" : "1px solid transparent",
                    background: c,
                    padding: 0,
                    boxShadow: edit.color === c ? "0 0 0 1px var(--border)" : "none",
                  }}
                />
              ))}
            </div>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <button type="button" onClick={() => void saveEdit()} style={{ padding: "7px 12px", borderRadius: 8, border: "none", background: "var(--accent)", color: "#fff", fontSize: 12, fontWeight: 600 }}>
              Save connection
            </button>
            <button type="button" onClick={() => setEdit(null)} style={{ padding: "7px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "transparent", color: "var(--text)", fontSize: 12 }}>
              Cancel
            </button>
            <button type="button" onClick={() => setConnectOpen(true)} style={{ padding: "7px 12px", borderRadius: 8, border: "none", background: "none", color: "var(--accent)", fontSize: 12 }}>
              Open Connect
            </button>
            <button type="button" onClick={() => setPushOpen(true)} style={{ padding: "7px 12px", borderRadius: 8, border: "none", background: "none", color: "var(--accent)", fontSize: 12 }}>
              Push…
            </button>
          </div>
        </div>
      )}
      {msg && <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{msg}</div>}
    </section>
  );
}

function GithubSection() {
  const { account, setAuthOpen, switchAccount } = useAuth(
    useShallow((s) => ({ account: s.account, setAuthOpen: s.setAuthOpen, switchAccount: s.switchAccount })),
  );
  const accounts = account.accounts?.length ? account.accounts : account.user ? [account.user] : [];
  return (
    <section style={{ borderRadius: 12, padding: 14, border: "1px solid var(--border)", background: "var(--bg)", display: "grid", gap: 10 }}>
      <h2 style={{ fontSize: 13, fontWeight: 650, margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
        <Github size={14} /> GitHub
      </h2>
      <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.45 }}>
        Used by the Git plugin and Terminal git push / pull. The app works fully offline. Tokens stay on this computer. Classic PAT needs repo scope.
      </div>
      {accounts.map((user) => {
        const active = Boolean(user.active || (account.user && account.user.login === user.login));
        const id = user.account_id || String(user.id || user.login);
        return (
          <div key={id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {user.avatar_url ? <img src={user.avatar_url} alt="" width={32} height={32} style={{ borderRadius: 99 }} /> : null}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 650 }}>
                {user.name || user.login}
                {active ? <span style={{ marginLeft: 8, fontSize: 10, color: "var(--accent)", fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase" }}>Active</span> : null}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-dim)" }}>@{user.login}</div>
            </div>
            {!active && (
              <button type="button" onClick={() => void switchAccount(id)} style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "transparent", color: "var(--text)", fontSize: 12 }}>
                Switch
              </button>
            )}
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => setAuthOpen(true)}
        style={{ padding: "8px 12px", borderRadius: 8, border: "none", background: "var(--accent)", color: "#fff", fontSize: 12, fontWeight: 600, width: "fit-content" }}
      >
        {accounts.length ? "Manage accounts" : "Sign in with GitHub"}
      </button>
    </section>
  );
}
