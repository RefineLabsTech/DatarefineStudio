//! Background verification scheduler.
//!
//! Verify runs: every `verifyIntervalHours` (default 24h), on app resume and
//! on manual "Check Now" — never continuously.

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crate::app::policy::gate;
use crate::app::policy::now_ms;
use crate::app::policy::LicenseState;

static LAST_RESUME_MS: AtomicI64 = AtomicI64::new(0);
const RESUME_THROTTLE_MS: i64 = 60 * 60_000; // at most once per hour on focus

pub fn start(state: Arc<LicenseState>) {
    if state
        .started
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    std::thread::Builder::new()
        .name("drs-license-scheduler".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_secs(60));
            if due(&state) {
                gate::verify_once(&state);
            }
        })
        .ok();
}

/// True when the configured verification interval has elapsed.
pub fn due(state: &Arc<LicenseState>) -> bool {
    let now = now_ms();
    // Server-directed check-in wins over the interval (§20).
    if let Ok(g) = state.next_check_ms.lock() {
        if let Some(nc) = *g {
            if now >= nc {
                return true;
            }
        }
    }
    let snap = state.snapshot();
    let interval_h = snap
        .config
        .as_ref()
        .map(|c| c.licensing.verify_interval_hours)
        .unwrap_or(24)
        .max(1);
    let last_ms = snap
        .license
        .as_ref()
        .and_then(|l| l.last_verification.clone())
        .and_then(|s| crate::app::policy::parse_iso_ms(&s))
        .unwrap_or(0);
    let base = i64::from(interval_h) * 3_600_000;
    // ±10% jitter (§20), deterministic per verification cycle — seeded from
    // last verification time, no rand dependency, stable within a cycle.
    let step = ((last_ms / 3_600_000) % 21) - 10;
    let jittered = base + base / 100 * step;
    now - last_ms >= jittered
}

/// Window focus / app resume hook (throttled).
pub fn resume_check(state: Arc<LicenseState>) {
    let now = now_ms();
    let prev = LAST_RESUME_MS.load(Ordering::SeqCst);
    if now - prev < RESUME_THROTTLE_MS {
        return;
    }
    LAST_RESUME_MS.store(now, Ordering::SeqCst);
    std::thread::Builder::new()
        .name("drs-license-resume".into())
        .spawn(move || {
            gate::verify_once(&state);
        })
        .ok();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::policy::model::{Config, Licensing};
    use crate::app::policy::{iso, LicenseView};

    fn state_with_last_verify(minutes_ago: i64, interval_h: u32) -> Arc<LicenseState> {
        let dir = std::env::temp_dir().join(format!("drs-sched-{}-{}", std::process::id(), minutes_ago));
        let st = LicenseState::new(dir);
        st.update(|s| {
            s.config = Some(Config {
                licensing: Licensing {
                    require_license: true,
                    verify_interval_hours: interval_h,
                    offline_grace_days: 30,
                    ..Licensing::default()
                },
                ..Config::default()
            });
            s.license = Some(LicenseView {
                last_verification: Some(iso(now_ms() - minutes_ago * 60_000)),
                ..LicenseView::default()
            });
        });
        st
    }

    #[test]
    fn retry_scheduling_due_logic() {
        let fresh = state_with_last_verify(1, 24);
        assert!(!due(&fresh));
        let stale = state_with_last_verify(27 * 60, 24); // > 24h + 10% jitter bound
        assert!(due(&stale));
        let custom = state_with_last_verify(120, 1); // 2h old, 1h interval
        assert!(due(&custom));
    }
}
