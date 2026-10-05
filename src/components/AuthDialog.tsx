import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Check, Copy, Github, LogOut, Plus, UserRound } from "lucide-react";
import { useAuth } from "../store/auth";
import { openUrl, type GithubUser } from "../ipc/client";

const DESC =
  "Connect a GitHub identity for git clone, fetch, pull, and push — in the Git plugin and in Terminal. DataRefine Studio remains fully usable offline. Tokens stay on this computer and are never sent to a remote DataRefine service. Use a classic PAT with repo scope, or a fine-grained token with Contents read/write.";

export function AuthDialog() {
  const { authOpen, setAuthOpen, account, startDevice, pollDevice, signInToken, signOut, switchAccount, saveClientId, refresh } = useAuth(
    useShallow((s) => ({
      authOpen: s.authOpen,
      setAuthOpen: s.setAuthOpen,
      account: s.account,
      startDevice: s.startDevice,
      pollDevice: s.pollDevice,
      signInToken: s.signInToken,
      signOut: s.signOut,
      switchAccount: s.switchAccount,
      saveClientId: s.saveClientId,
      refresh: s.refresh,
    })),
  );
  const [pat, setPat] = useState("");
  const [clientId, setClientId] = useState(account.client_id);
  const [userCode, setUserCode] = useState("");
  const [verifyUrl, setVerifyUrl] = useState("https://github.com/login/device");
  const [deviceId, setDeviceId] = useState("");
  const [intervalSec, setIntervalSec] = useState(5);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);

  const accounts = account.accounts?.length ? account.accounts : account.user ? [{ ...account.user, account_id: account.active_id, active: true }] : [];
  const signed = Boolean(account.signed_in && accounts.length);
  const showForm = !signed || adding;

  useEffect(() => {
    if (authOpen) {
      void refresh();
      setClientId(account.client_id);
      setMsg("");
      setAdding(false);
      setPat("");
      setUserCode("");
      setDeviceId("");
    }
  }, [authOpen]);

  useEffect(() => {
    if (!deviceId) return;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      try {
        const r = await pollDevice(deviceId);
        if (r.status === "ok") {
          setDeviceId("");
          setUserCode("");
          setAdding(false);
          setMsg("Signed in.");
          await refresh();
          return;
        }
        if (r.status === "pending") {
          if (r.interval) setIntervalSec(r.interval);
        } else {
          setDeviceId("");
          setMsg(r.message || r.status);
        }
      } catch (e) {
        setMsg(String(e));
      }
    };
    const id = window.setInterval(() => void tick(), Math.max(3, intervalSec) * 1000);
    void tick();
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [deviceId, intervalSec]);

  if (!authOpen) return null;

  const startGithub = async () => {
    setBusy(true);
    setMsg("");
    try {
      const r = await startDevice();
      setDeviceId(r.device_id);
      setUserCode(r.user_code);
      setVerifyUrl(r.verification_uri_complete || r.verification_uri);
      setIntervalSec(r.interval || 5);
      void openUrl(r.verification_uri_complete || r.verification_uri);
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{ position: "absolute", inset: 0, zIndex: 50, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
      onClick={() => setAuthOpen(false)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 440,
          maxWidth: "100%",
          borderRadius: 16,
          border: "1px solid var(--border)",
          background: "var(--bg-elev)",
          color: "var(--text)",
          padding: 22,
          display: "grid",
          gap: 14,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Github size={18} />
          <div style={{ fontSize: 16, fontWeight: 700, flex: 1 }}>GitHub</div>
          <button type="button" onClick={() => setAuthOpen(false)} style={{ border: "none", background: "none", color: "var(--text-dim)", fontSize: 12 }}>
            Close
          </button>
        </div>
        <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.55 }}>{DESC}</div>

        {signed ? (
          <div style={{ display: "grid", gap: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 650, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-dim)" }}>Accounts on this machine</div>
            {accounts.map((u) => (
              <AccountRow
                key={u.account_id || u.login}
                user={u}
                busy={busy}
                onSwitch={async () => {
                  const id = u.account_id || String(u.id || u.login);
                  if (u.active) return;
                  setBusy(true);
                  setMsg("");
                  try {
                    await switchAccount(id);
                    setMsg(`Switched to @${u.login}.`);
                  } catch (e) {
                    setMsg(String(e));
                  } finally {
                    setBusy(false);
                  }
                }}
                onRemove={async () => {
                  const id = u.account_id || String(u.id || u.login);
                  setBusy(true);
                  setMsg("");
                  try {
                    await signOut(id);
                    setMsg(`Removed @${u.login}.`);
                  } catch (e) {
                    setMsg(String(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              />
            ))}
            {!adding && (
              <button
                type="button"
                onClick={() => {
                  setAdding(true);
                  setMsg("");
                }}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                  padding: "8px 12px",
                  borderRadius: 10,
                  border: "1px dashed var(--border)",
                  background: "transparent",
                  color: "var(--text)",
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                <Plus size={14} /> Add another account
              </button>
            )}
          </div>
        ) : null}

        {showForm ? (
          <>
            {userCode ? (
              <div style={{ display: "grid", gap: 10, padding: 12, borderRadius: 12, border: "1px solid var(--border)", background: "var(--bg)" }}>
                <div style={{ fontSize: 11, color: "var(--text-dim)" }}>Enter this code on GitHub</div>
                <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 22, letterSpacing: "0.12em", fontWeight: 700 }}>{userCode}</div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    onClick={() => void navigator.clipboard.writeText(userCode)}
                    style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "transparent", color: "var(--text)", fontSize: 12 }}
                  >
                    <Copy size={13} /> Copy
                  </button>
                  <button
                    type="button"
                    onClick={() => void openUrl(verifyUrl)}
                    style={{ padding: "7px 12px", borderRadius: 8, border: "none", background: "var(--accent)", color: "#fff", fontSize: 12, fontWeight: 600 }}
                  >
                    Open GitHub
                  </button>
                </div>
                <div style={{ fontSize: 11, color: "var(--text-dim)" }}>Waiting for authorization…</div>
              </div>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => void startGithub()}
                style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "10px 12px", borderRadius: 10, border: "none", background: "#f4f4f5", color: "#111", fontWeight: 700, fontSize: 13 }}
              >
                <Github size={16} /> Sign in with GitHub
              </button>
            )}

            <div style={{ height: 1, background: "var(--border)" }} />
            <div style={{ fontSize: 12, fontWeight: 650 }}>Or use a personal access token</div>
            <input className="field" type="password" placeholder="ghp_…" value={pat} onChange={(e) => setPat(e.target.value)} autoComplete="off" />
            <button
              type="button"
              disabled={busy || !pat.trim()}
              onClick={async () => {
                setBusy(true);
                setMsg("");
                try {
                  await signInToken(pat.trim());
                  setPat("");
                  setAdding(false);
                  setMsg("Signed in.");
                } catch (e) {
                  setMsg(String(e));
                } finally {
                  setBusy(false);
                }
              }}
              style={{ padding: "8px 12px", borderRadius: 8, border: "none", background: "var(--accent)", color: "#fff", fontSize: 12, fontWeight: 600, opacity: !pat.trim() ? 0.4 : 1 }}
            >
              Sign in with token
            </button>
            {adding && (
              <button
                type="button"
                onClick={() => {
                  setAdding(false);
                  setUserCode("");
                  setDeviceId("");
                  setPat("");
                }}
                style={{ border: "none", background: "none", color: "var(--text-dim)", fontSize: 12, justifySelf: "start" }}
              >
                Cancel
              </button>
            )}
            <details>
              <summary style={{ fontSize: 12, color: "var(--text-dim)", cursor: "pointer" }}>OAuth Client ID (device flow)</summary>
              <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
                <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.45 }}>
                  GitHub → Settings → Developer settings → OAuth Apps. Enable Device Authorization Flow. No client secret is stored.
                </div>
                <input className="field" placeholder="Ov23li…" value={clientId} onChange={(e) => setClientId(e.target.value)} />
                <button
                  type="button"
                  onClick={async () => {
                    await saveClientId(clientId.trim());
                    setMsg("Client ID saved.");
                  }}
                  style={{ padding: "7px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "transparent", color: "var(--text)", fontSize: 12, width: "fit-content" }}
                >
                  Save client ID
                </button>
              </div>
            </details>
          </>
        ) : null}

        {msg && <div style={{ fontSize: 12, color: msg.toLowerCase().includes("fail") || msg.toLowerCase().includes("error") ? "var(--danger)" : "var(--ok)" }}>{msg}</div>}
      </div>
    </div>
  );
}

function AccountRow({
  user,
  busy,
  onSwitch,
  onRemove,
}: {
  user: GithubUser;
  busy: boolean;
  onSwitch: () => void;
  onRemove: () => void;
}) {
  const active = Boolean(user.active);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: 12,
        borderRadius: 12,
        border: active ? "1px solid color-mix(in srgb, var(--accent) 45%, var(--border))" : "1px solid var(--border)",
        background: active ? "color-mix(in srgb, var(--accent) 10%, var(--bg))" : "var(--bg)",
      }}
    >
      {user.avatar_url ? (
        <img src={user.avatar_url} alt="" width={40} height={40} style={{ borderRadius: 99 }} />
      ) : (
        <div style={{ width: 40, height: 40, borderRadius: 99, background: "var(--bg-input)", display: "grid", placeItems: "center", color: "var(--text-dim)" }}>
          <UserRound size={18} />
        </div>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 650, display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user.name || user.login}</span>
          {active && (
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--accent)", display: "inline-flex", alignItems: "center", gap: 3 }}>
              <Check size={11} /> Active
            </span>
          )}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-dim)" }}>@{user.login}</div>
      </div>
      {!active && (
        <button
          type="button"
          disabled={busy}
          onClick={onSwitch}
          style={{ padding: "7px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "transparent", color: "var(--text)", fontSize: 12 }}
        >
          Switch
        </button>
      )}
      <button
        type="button"
        disabled={busy}
        title="Sign out"
        onClick={onRemove}
        style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "transparent", color: "var(--text)", fontSize: 12 }}
      >
        <LogOut size={13} />
        {active ? "Sign out" : "Remove"}
      </button>
    </div>
  );
}
