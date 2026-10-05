//! Pure policy engine: maps (config, stored state, clock, network, verify
//! status) onto a [`Decision`]. No I/O — fully unit-testable.

use crate::app::policy::model::Config;
use crate::app::policy::storage::Stored;

pub const DAY_MS: i64 = 86_400_000;
/// Tolerance for clock rollback detection (10 minutes).
pub const CLOCK_TOLERANCE_MS: i64 = 10 * 60_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Granted,
    /// Core local product mode selected by the user when licensing is active.
    Basic,
    Maintenance,
    MandatoryUpdate,
    LicenseRequired,
    LicenseInvalid,
    LicenseBlocked,
    LicenseExpired,
    DeviceMismatch,
    TokenInvalid,
    GraceExpired,
}

impl Decision {
    pub fn as_str(&self) -> &'static str {
        match self {
            Decision::Granted => "granted",
            Decision::Basic => "basic",
            Decision::Maintenance => "maintenance",
            Decision::MandatoryUpdate => "mandatory_update",
            Decision::LicenseRequired => "license_required",
            Decision::LicenseInvalid => "license_invalid",
            Decision::LicenseBlocked => "license_blocked",
            Decision::LicenseExpired => "license_expired",
            Decision::DeviceMismatch => "device_mismatch",
            Decision::TokenInvalid => "token_invalid",
            Decision::GraceExpired => "grace_expired",
        }
    }
}

pub struct CheckInput<'a> {
    pub config: Option<&'a Config>,
    pub stored: &'a Stored,
    pub now_ms: i64,
    pub net_ok: bool,
    /// status field of the last /api/verify response, if this check included one
    pub verify_status: Option<&'a str>,
    pub app_version: &'a str,
}

/// True when the wall clock moved backwards beyond tolerance.
pub fn clock_rollback(now_ms: i64, last_wall_ms: i64) -> bool {
    last_wall_ms > 0 && now_ms + CLOCK_TOLERANCE_MS < last_wall_ms
}

/// Offline grace: cached entitlement stays valid for `grace_days` after the
/// last successful grant.
pub fn offline_grace_ok(stored: &Stored, now_ms: i64, grace_days: u32) -> bool {
    if stored.last_granted_ms <= 0 {
        return false;
    }
    let grace = i64::from(grace_days.max(1)) * DAY_MS;
    now_ms - stored.last_granted_ms <= grace
}

/// Whole days remaining until expiry (negative when past).
pub fn days_remaining(expires_at: &str, now_ms: i64) -> i64 {
    let Some(exp) = crate::app::policy::parse_iso_ms(expires_at) else {
        return i64::MAX / 2; // unknown expiry = treated as non-expiring locally
    };
    (exp - now_ms) / DAY_MS
}

pub fn is_expired(expires_at: &str, now_ms: i64) -> bool {
    let Some(exp) = crate::app::policy::parse_iso_ms(expires_at) else {
        return false;
    };
    exp <= now_ms
}

/// Numeric dotted-version compare: 1.2.10 > 1.2.9.
pub fn version_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let pa: Vec<u64> = a.split(|c| c == '.' || c == '-').filter_map(|x| x.parse().ok()).collect();
    let pb: Vec<u64> = b.split(|c| c == '.' || c == '-').filter_map(|x| x.parse().ok()).collect();
    for i in 0..pa.len().max(pb.len()) {
        let va = pa.get(i).copied().unwrap_or(0);
        let vb = pb.get(i).copied().unwrap_or(0);
        match va.cmp(&vb) {
            std::cmp::Ordering::Equal => continue,
            other => return other,
        }
    }
    std::cmp::Ordering::Equal
}

/// The cloud validates `platform` as a Node-style enum: win32 | linux | darwin.
pub fn wire_platform(p: &str) -> &str {
    match p {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    }
}

/// An announcement is live when enabled, inside its start/end window, and
/// targeted at this platform ("all", missing, or a list containing us).
pub fn is_live(a: &crate::app::policy::model::Announcement, now_ms: i64, platform: &str) -> bool {
    if !a.enabled {
        return false;
    }
    if let Some(s) = a.start_date.as_deref() {
        if let Some(ms) = crate::app::policy::parse_iso_ms(s) {
            if now_ms < ms {
                return false;
            }
        }
    }
    if let Some(e) = a.end_date.as_deref() {
        if let Some(ms) = crate::app::policy::parse_iso_ms(e) {
            if now_ms > ms {
                return false;
            }
        }
    }
    let plat = wire_platform(platform);
    let hit = |v: &str| v == "all" || wire_platform(v).eq_ignore_ascii_case(plat);
    match a.audience.as_ref() {
        None => true,
        Some(serde_json::Value::String(s)) => hit(s),
        Some(serde_json::Value::Array(arr)) => arr.iter().any(|x| x.as_str().map(hit).unwrap_or(false)),
        Some(_) => true,
    }
}

/// Canonical wire form expected by the cloud: `DRS-XXXX-XXXX-XXXX`
/// (letters/digits excluding I, O, 0, 1). Accepts any user typing style
/// (case, spaces, dashes) and re-groups; unknown shapes pass through so the
/// server can return its friendly validation message.
pub fn canonical_key(raw: &str) -> String {
    let compact: String = raw
        .chars()
        .filter(|c| c.is_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect();
    if compact.len() == 15 && compact.starts_with("DRS") {
        format!(
            "{}-{}-{}-{}",
            &compact[0..3],
            &compact[3..7],
            &compact[7..11],
            &compact[11..15]
        )
    } else {
        compact
    }
}

/// Display grouping (verified by unit tests).
#[cfg(test)]
pub fn normalize_key(raw: &str) -> String {
    let compact: String = raw
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect::<String>()
        .to_uppercase();
    compact
        .as_bytes()
        .chunks(4)
        .map(|c| String::from_utf8_lossy(c).into_owned())
        .collect::<Vec<_>>()
        .join("-")
}

/// Priority: maintenance → mandatory update → license policy → grace.
pub fn decide(inp: CheckInput) -> Decision {
    let cfg = inp.config;

    // 1. Maintenance always wins (it is not a license denial).
    if cfg.map(|c| c.maintenance.enabled && c.maintenance.hard).unwrap_or(false) {
        return Decision::Maintenance;
    }

    // 2. Mandatory update (below remote minimum).
    if let Some(c) = cfg {
        if let Some(min) = c.versions.minimum.as_deref().filter(|s| !s.is_empty()) {
            if version_cmp(inp.app_version, min) == std::cmp::Ordering::Less {
                return Decision::MandatoryUpdate;
            }
        }
    }

    let require = cfg.map(|c| c.requires_license()).unwrap_or(false);
    // 3. Remote toggle OFF = fully free app: ignore everything license-related.
    if !require {
        return Decision::Granted;
    }

    // 4. Licensing active. Basic is an explicit, persistent user choice and
    // therefore remains usable even when an old token has expired or verify
    // reports a blocked device. Premium commands still reject Decision::Basic.
    if inp.stored.basic_mode {
        return Decision::Basic;
    }

    let has_token = !inp.stored.activation_token.is_empty();
    if !has_token {
        return Decision::LicenseRequired;
    }

    // Local expiry first (authoritative even offline).
    if is_expired(&inp.stored.expires_at, inp.now_ms) {
        return Decision::LicenseExpired;
    }

    // Remote verify result, when we have one this cycle.
    if let Some(status) = inp.verify_status {
        return match status {
            "granted" | "ok" | "valid" => Decision::Granted,
            "blocked" => Decision::LicenseBlocked,
            "expired" => Decision::LicenseExpired,
            "device_mismatch" => Decision::DeviceMismatch,
            "token_invalid" => Decision::TokenInvalid,
            _ => Decision::LicenseInvalid,
        };
    }

    // No fresh verify (offline / boot without network): cached entitlement
    // within the offline grace window keeps the app open.
    let grace_days = cfg.map(|c| c.licensing.offline_grace_days).unwrap_or(30);
    if inp.net_ok {
        // Network was fine but no verify ran (e.g. boot): allow, scheduler verifies.
        return Decision::Granted;
    }
    if offline_grace_ok(inp.stored, inp.now_ms, grace_days) {
        Decision::Granted
    } else {
        Decision::GraceExpired
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use super::*;
    use crate::app::policy::model::{Licensing, Maintenance, Versions};

    fn cfg(require: bool) -> Config {
        Config {
            licensing: Licensing {
                require_license: require,
                verify_interval_hours: 24,
                offline_grace_days: 30,
                ..Licensing::default()
            },
            ..Config::default()
        }
    }

    fn stored_with(token: &str, granted_days_ago: i64, now: i64) -> Stored {
        Stored {
            activation_token: token.into(),
            expires_at: "2030-01-01T00:00:00Z".into(),
            last_granted_ms: now - granted_days_ago * DAY_MS,
            ..Stored::default()
        }
    }

    #[test]
    fn decision_mapping_table() {
        let now = 1_750_000_000_000i64;
        let c = cfg(true);
        let s = stored_with("tok", 0, now);
        let cases: Vec<(Option<&str>, bool, Decision)> = vec![
            (Some("granted"), true, Decision::Granted),
            (Some("blocked"), true, Decision::LicenseBlocked),
            (Some("expired"), true, Decision::LicenseExpired),
            (Some("device_mismatch"), true, Decision::DeviceMismatch),
            (Some("token_invalid"), true, Decision::TokenInvalid),
            (None, false, Decision::Granted),   // offline inside grace
            (None, true, Decision::Granted),    // online, scheduler verifies later
        ];
        for (status, net, want) in cases {
            let d = decide(CheckInput {
                config: Some(&c),
                stored: &s,
                now_ms: now,
                net_ok: net,
                verify_status: status,
                app_version: "1.0.0",
            });
            assert_eq!(d, want, "status={status:?} net={net}");
        }
        // no token
        let empty = Stored::default();
        let d = decide(CheckInput {
            config: Some(&c),
            stored: &empty,
            now_ms: now,
            net_ok: true,
            verify_status: None,
            app_version: "1.0.0",
        });
        assert_eq!(d, Decision::LicenseRequired);
    }

    #[test]
    fn basic_choice_keeps_local_mode_without_license() {
        let now = 1_750_000_000_000i64;
        let c = cfg(true);
        let s = Stored {
            basic_mode: true,
            activation_token: "".into(),
            ..Stored::default()
        };
        let d = decide(CheckInput {
            config: Some(&c),
            stored: &s,
            now_ms: now,
            net_ok: false,
            verify_status: Some("blocked"),
            app_version: "1.0.0",
        });
        assert_eq!(d, Decision::Basic);
    }

    #[test]
    fn remote_toggle_off_is_free_app() {
        let now = 1_750_000_000_000i64;
        let c = cfg(false);
        let s = Stored {
            activation_token: "old".into(),
            expires_at: "2020-01-01T00:00:00Z".into(), // expired + ignored
            ..Stored::default()
        };
        let d = decide(CheckInput {
            config: Some(&c),
            stored: &s,
            now_ms: now,
            net_ok: false,
            verify_status: Some("blocked"), // ignored
            app_version: "1.0.0",
        });
        assert_eq!(d, Decision::Granted);
    }

    #[test]
    fn maintenance_beats_everything() {
        let now = 1_750_000_000_000i64;
        let mut c = cfg(false);
        c.maintenance = Maintenance {
            enabled: true,
            hard: true,
            message: Some("back soon".into()),
        };
        let d = decide(CheckInput {
            config: Some(&c),
            stored: &Stored::default(),
            now_ms: now,
            net_ok: true,
            verify_status: None,
            app_version: "1.0.0",
        });
        assert_eq!(d, Decision::Maintenance);
    }

    #[test]
    fn mandatory_update_below_minimum() {
        let now = 1_750_000_000_000i64;
        let mut c = cfg(false);
        c.versions = Versions {
            latest: Some("2.0.0".into()),
            minimum: Some("1.5.0".into()),
            download_url: Some("https://x".into()),
            release_notes: Some("notes".into()),
            ..Default::default()
        };
        let d = decide(CheckInput {
            config: Some(&c),
            stored: &Stored::default(),
            now_ms: now,
            net_ok: true,
            verify_status: None,
            app_version: "1.4.2",
        });
        assert_eq!(d, Decision::MandatoryUpdate);
        let d2 = decide(CheckInput {
            config: Some(&c),
            stored: &Stored::default(),
            now_ms: now,
            net_ok: true,
            verify_status: None,
            app_version: "1.5.0",
        });
        assert_eq!(d2, Decision::Granted);
    }

    #[test]
    fn offline_grace_window() {
        let now = 1_750_000_000_000i64;
        let c = cfg(true);
        let fresh = stored_with("tok", 5, now);
        let stale = stored_with("tok", 31, now);
        let d1 = decide(CheckInput {
            config: Some(&c),
            stored: &fresh,
            now_ms: now,
            net_ok: false,
            verify_status: None,
            app_version: "1.0.0",
        });
        let d2 = decide(CheckInput {
            config: Some(&c),
            stored: &stale,
            now_ms: now,
            net_ok: false,
            verify_status: None,
            app_version: "1.0.0",
        });
        assert_eq!(d1, Decision::Granted);
        assert_eq!(d2, Decision::GraceExpired);
    }

    #[test]
    fn clock_rollback_detection() {
        let now = 1_750_000_000_000i64;
        assert!(clock_rollback(now - 2 * 3600_000, now)); // 2h back
        assert!(!clock_rollback(now - 60_000, now)); // 1m back = tolerance
        assert!(!clock_rollback(now + 1000, now));
        assert!(!clock_rollback(now, 0)); // never seen a clock
    }

    #[test]
    fn key_normalization() {
        assert_eq!(normalize_key(" abcd 1234-efgh_5678 "), "ABCD-1234-EFGH-5678");
        assert_eq!(canonical_key("ab-cd 12"), "ABCD12"); // compaction pass-through
        assert_eq!(normalize_key("xyz"), "XYZ");
    }

    #[test]
    fn announcement_live_window_audience() {
        use crate::app::policy::model::Announcement;
        let mk = |start: Option<&str>, end: Option<&str>, enabled: bool, aud: Option<serde_json::Value>| Announcement {
            id: "a".into(),
            kind: "info".into(),
            title: None,
            message: None,
            updated_at: None,
            link: None,
            enabled,
            audience: aud,
            start_date: start.map(|s| s.into()),
            end_date: end.map(|s| s.into()),
            dismissible: true,
            priority: 0,
            button_text: None,
            button_url: None,
        };
        let now = 1_700_000_000_000i64;
        assert!(is_live(&mk(None, None, true, None), now, "windows"));
        assert!(!is_live(&mk(None, None, false, None), now, "windows"));
        assert!(!is_live(&mk(Some("2030-01-01T00:00:00Z"), None, true, None), now, "windows")); // scheduled
        assert!(!is_live(&mk(None, Some("2020-01-01T00:00:00Z"), true, None), now, "windows")); // ended
        assert!(is_live(&mk(None, None, true, Some(json!("all"))), now, "windows"));
        assert!(!is_live(&mk(None, None, true, Some(json!("macos"))), now, "windows"));
        assert!(is_live(&mk(None, None, true, Some(json!(["windows", "macos"]))), now, "windows"));
        assert!(is_live(&mk(None, None, true, Some(json!("win32"))), now, "windows"));
        assert_eq!(wire_platform("windows"), "win32");
        assert_eq!(wire_platform("macos"), "darwin");
        assert_eq!(wire_platform("linux"), "linux");
    }

    #[test]
    fn canonical_drs_format() {
        assert_eq!(canonical_key("drs-ab23-cd67-ef89"), "DRS-AB23-CD67-EF89");
        assert_eq!(canonical_key("DRS AB23 CD67 EF89"), "DRS-AB23-CD67-EF89");
        assert_eq!(canonical_key("short"), "SHORT"); // passes through for server message
    }

    #[test]
    fn version_ordering() {
        assert!(version_cmp("1.2.10", "1.2.9") == std::cmp::Ordering::Greater);
        assert!(version_cmp("1.0.0", "1.0.0") == std::cmp::Ordering::Equal);
        assert!(version_cmp("0.9.9", "1.0.0") == std::cmp::Ordering::Less);
    }

    #[test]
    fn expiry_and_days() {
        let now = crate::app::policy::parse_iso_ms("2026-01-01T00:00:00Z").unwrap();
        assert!(is_expired("2025-12-31T00:00:00Z", now));
        assert!(!is_expired("2026-01-02T00:00:00Z", now));
        assert_eq!(days_remaining("2026-01-31T00:00:00Z", now), 30);
    }

    #[test]
    fn maintenance_soft_banners_hard_blocks() {
        let now = crate::app::policy::now_ms();
        let mut c = Config::default();
        c.licensing.require_license = false;
        c.maintenance = Maintenance { enabled: true, hard: false, ..Default::default() };
        let input = CheckInput { config: Some(&c), stored: &Stored::default(), now_ms: now, net_ok: true, verify_status: None, app_version: "3.4.2" };
        assert_ne!(decide(input), Decision::Maintenance, "soft maintenance must not block");
        c.maintenance.hard = true;
        let input = CheckInput { config: Some(&c), stored: &Stored::default(), now_ms: now, net_ok: true, verify_status: None, app_version: "3.4.2" };
        assert_eq!(decide(input), Decision::Maintenance, "hard maintenance blocks");
    }
}
