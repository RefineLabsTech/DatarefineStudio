//! DataRefine Studio — License Cloud subsystem.
//!
//! Rust owns HTTP, device identity, secure storage, verification, scheduling
//! and feature gating. React only renders serialized snapshots of
//! [`LicenseState`] — it never talks to the network for licensing.
//!
//! Local-first guarantee: user datasets, SQL, Python scripts and projects are
//! NEVER uploaded. The cloud is used only for licensing and remote config.

pub mod checker;
pub mod client;
pub mod gate;
pub mod machine;
pub mod model;
pub mod scheduler;
pub mod storage;

#[cfg(feature = "tauri-cmds")]
pub mod commands;

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, RwLock};

use serde::{Deserialize, Serialize};

/// Serialized view handed to React. Everything the UI needs, nothing more.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// booting | ready
    pub stage: String,
    /// granted | basic | maintenance | license_required | license_invalid |
    /// license_blocked | license_expired | device_mismatch | grace_expired |
    /// mandatory_update
    pub decision: String,
    pub message: Option<String>,
    pub offline: bool,
    pub require_license: bool,
    pub config: Option<model::Config>,
    pub license: Option<LicenseView>,
    pub announcements: Vec<model::Announcement>,
    pub update: Option<UpdateView>,
    pub device_id: String,
    pub last_check: Option<String>,
    pub error: Option<String>,
    #[serde(default)]
    pub dismissed: Vec<storage::Dismissed>,
    /// Server-provided AI/plugin entitlements (empty = Standard).
    #[serde(default)]
    pub entitlements: model::Entitlements,
    /// Cloud-controlled premium feature keys and the Basic import ceiling.
    #[serde(default)]
    pub feature_policy: model::FeaturePolicy,
    /// Whether the user explicitly chose Continue with Basic while licensing
    /// is required. This is local preference, not a cloud entitlement.
    #[serde(default)]
    pub basic_mode: bool,
    /// Endpoint chosen by discovery (bootstrap / cached / stable).
    #[serde(default)]
    pub endpoint: Option<crate::cloud::models::ResolvedEndpoint>,
    /// unrestricted | licensed — Rust-owned, never derived in React.
    #[serde(default)]
    pub enforcement: model::EnforcementMode,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LicenseView {
    pub plan: String,
    pub masked: String,
    pub expires_at: String,
    pub days_remaining: i64,
    pub last_verification: Option<String>,
    pub offline: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateView {
    pub current: String,
    pub latest: String,
    pub minimum: String,
    pub mandatory: bool,
    pub download_url: String,
    #[serde(default)]
    pub windows_download_url: String,
    #[serde(default)]
    pub linux_download_url: String,
    #[serde(default)]
    pub sha256: String,
    pub release_notes: String,
}

/// Shared license state (RwLock per spec). Created once, cloned as Arc.
pub struct LicenseState {
    pub snap: RwLock<Snapshot>,
    pub client: client::Client,
    pub store_dir: std::path::PathBuf,
    pub busy: AtomicBool,
    pub started: AtomicBool,
    /// Last successful/attempted /api/config fetch (ms) — 60s refresh throttle.
    pub cfg_ms: std::sync::Mutex<i64>,
    /// Most recent verify outcome, reused by config-only refreshes.
    pub verify_status: std::sync::Mutex<Option<String>>,
    /// Endpoint chosen by discovery (diagnostics).
    pub endpoint: std::sync::Mutex<Option<crate::cloud::models::ResolvedEndpoint>>,
    /// 403 LICENSING_DISABLED seen — paid traffic stops until policy re-enables.
    pub lic_disabled: std::sync::atomic::AtomicBool,
    /// Server-directed next verification timestamp (ms).
    pub next_check_ms: std::sync::Mutex<Option<i64>>,
}

impl LicenseState {
    pub fn new(store_dir: std::path::PathBuf) -> Arc<Self> {
        Arc::new(Self {
            snap: RwLock::new(Snapshot {
                stage: "booting".into(),
                ..Snapshot::default()
            }),
            client: client::Client::new(),
            store_dir,
            busy: AtomicBool::new(false),
            started: AtomicBool::new(false),
            cfg_ms: std::sync::Mutex::new(0),
            verify_status: std::sync::Mutex::new(None),
            endpoint: std::sync::Mutex::new(None),
            lic_disabled: std::sync::atomic::AtomicBool::new(false),
            next_check_ms: std::sync::Mutex::new(None),
        })
    }

    pub fn snapshot(&self) -> Snapshot {
        self.snap.read().map(|s| s.clone()).unwrap_or_default()
    }

    pub fn update<F: FnOnce(&mut Snapshot)>(&self, f: F) {
        if let Ok(mut s) = self.snap.write() {
            f(&mut s);
        }
    }
}

/// Wall-clock milliseconds since epoch (no unwrap).
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// ISO-8601 (seconds, UTC) for UI display.
pub fn iso(ms: i64) -> String {
    use std::time::{Duration, UNIX_EPOCH};
    let secs = (ms.max(0) / 1000) as u64;
    let t = UNIX_EPOCH + Duration::from_secs(secs);
    let d = t
        .duration_since(UNIX_EPOCH)
        .map(|x| x.as_secs())
        .unwrap_or(secs);
    // civil-from-days algorithm (Howard Hinnant), UTC
    let days = (d / 86_400) as i64;
    let sod = d % 86_400;
    let (h, m, s) = (sod / 3600, (sod % 3600) / 60, sod % 60);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let mon = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if mon <= 2 { y + 1 } else { y };
    format!("{year:04}-{mon:02}-{day:02}T{h:02}:{m:02}:{s:02}Z")
}

/// Parse ISO-8601 (as returned by the cloud) into epoch millis (best effort).
pub fn parse_iso_ms(s: &str) -> Option<i64> {
    let t = s.trim();
    if t.len() < 10 {
        return None;
    }
    let y: i64 = t.get(0..4)?.parse().ok()?;
    let mo: i64 = t.get(5..7)?.parse().ok()?;
    let d: i64 = t.get(8..10)?.parse().ok()?;
    let (h, mi, se) = if t.len() >= 19 {
        (
            t.get(11..13)?.parse().unwrap_or(0),
            t.get(14..16)?.parse().unwrap_or(0),
            t.get(17..19)?.parse().unwrap_or(0),
        )
    } else {
        (0, 0, 0)
    };
    // days-from-civil
    let yr = if mo <= 2 { y - 1 } else { y };
    let era = if yr >= 0 { yr } else { yr - 399 } / 400;
    let yoe = yr - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some((days * 86_400 + h * 3600 + mi * 60 + se) * 1000)
}
