/* Startup splash — shown until the Rust license/core gate resolves. */

import { useEffect, useState } from "react";

const STARTUP_MESSAGES = [
  "Starting core engine…",
  "Core engine is taking a little longer…",
  "Still starting core engine — please wait…",
];

export function SplashScreen() {
  const [message, setMessage] = useState(STARTUP_MESSAGES[0]);

  useEffect(() => {
    const timers = [
      window.setTimeout(() => setMessage(STARTUP_MESSAGES[1]), 1800),
      window.setTimeout(() => setMessage(STARTUP_MESSAGES[2]), 5000),
    ];
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, []);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Starting DataRefine Studio"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        background: "var(--bg, #0b0e14)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 18,
        color: "var(--text)",
      }}
    >
      <div
        style={{
          width: 64,
          height: 64,
          borderRadius: 16,
          background: "var(--accent, #3b82f6)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 30,
          fontWeight: 800,
          color: "#fff",
          boxShadow: "0 12px 40px rgba(59,130,246,0.35)",
        }}
      >
        D
      </div>
      <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: "0.02em" }}>DataRefine Studio</div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--text-dim)", fontSize: 12 }}>
        <span
          aria-hidden="true"
          style={{
            width: 14,
            height: 14,
            borderRadius: "50%",
            border: "2px solid color-mix(in srgb, var(--accent, #3b82f6) 60%, transparent)",
            borderTopColor: "transparent",
            animation: "drs-spin 0.9s linear infinite",
          }}
        />
        <span>{message}</span>
      </div>
      <div style={{ color: "var(--text-dim)", fontSize: 11 }}>Loading workspace services…</div>
      <style>{"@keyframes drs-spin { to { transform: rotate(360deg); } }"}</style>
    </div>
  );
}
