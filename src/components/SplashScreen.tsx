export function SplashScreen({ phase, fading }: { phase: string; fading?: boolean }) {
  return (
    <div
      className={fading ? "drs-splash is-out" : "drs-splash"}
      role="status"
      aria-live="polite"
      aria-label="Loading DataRefine Studio"
    >
      <div className="drs-splash-mark">D</div>
      <div className="drs-splash-title">DataRefine Studio</div>
      <div className="drs-splash-sub">Local-first data cleaning</div>
      <div className="drs-splash-bar">
        <span className="drs-splash-bar-fill" />
      </div>
      <div className="drs-splash-phase">{phase}</div>
    </div>
  );
}
