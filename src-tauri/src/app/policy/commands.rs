//! Tauri command surface. React calls ONLY these; all licensing HTTP, crypto
//! and policy live in Rust. Premium/protected commands call
//! [`require_entitlement`] before doing any work.

use std::sync::Arc;

use crate::app::policy::machine::AppInfo;
use crate::app::policy::{gate, machine, scheduler, LicenseState, Snapshot};

static GLOBAL: std::sync::OnceLock<Arc<LicenseState>> = std::sync::OnceLock::new();

/// Registered once at app setup so protected commands with legacy signatures
/// can still enforce entitlement without changing their wire format.
pub fn set_global(state: Arc<LicenseState>) {
    let _ = GLOBAL.set(state);
}

pub fn entitlement_ok() -> Result<(), String> {
    match GLOBAL.get() {
        Some(s) => require_entitlement(s),
        None => Ok(()),
    }
}

/// Rust-owned premium feature gate. The feature vocabulary and the premium
/// list come from License Cloud; React only uses this for presentation.
pub fn require_feature(state: &Arc<LicenseState>, feature: &str) -> Result<(), String> {
    let snap = state.snapshot();
    if !snap.require_license || !snap.feature_policy.is_premium(feature) {
        return Ok(());
    }
    if snap.enforcement == crate::app::policy::model::EnforcementMode::Licensed
        && snap.decision == "granted"
    {
        return Ok(());
    }
    Err(format!(
        "{} requires a Professional license. Choose Activate or continue using Basic mode.",
        feature.replace('_', " ")
    ))
}

/// App handle for Tauri events (set once during startup).
#[cfg(feature = "tauri-cmds")]
static APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

#[cfg(feature = "tauri-cmds")]
pub fn set_app_handle(h: tauri::AppHandle) {
    let _ = APP.set(h);
}

/// license-state-changed {state, plan, expiresAt, offline} — no secrets (§44).
#[cfg(feature = "tauri-cmds")]
pub fn emit_state_changed(snap: &crate::app::policy::Snapshot) {
    use tauri::Emitter;
    if let Some(app) = APP.get() {
        let payload = serde_json::json!({
            "state": snap.decision,
            "plan": snap.license.as_ref().map(|l| l.plan.clone()).unwrap_or_default(),
            "expiresAt": snap
                .license
                .as_ref()
                .map(|l| (!l.expires_at.is_empty()).then(|| l.expires_at.clone()))
                .flatten(),
            "offline": snap.offline,
        });
        let _ = app.emit("license-state-changed", payload);
    }
}

/// Server-side (Rust) feature gating. React is never trusted for security.
pub fn require_entitlement(state: &Arc<LicenseState>) -> Result<(), String> {
    let d = state.snapshot().decision;
    match d.as_str() {
        // booting is transient (splash covers the UI); Basic keeps the local
        // workspace, terminal, and other non-premium commands usable.
        "granted" | "basic" | "maintenance" | "booting" => Ok(()),
        other => Err(format!("License required ({other}).")),
    }
}

/// Gate for Cloud-AI-backed commands: license OK AND server says cloudAI.
pub fn require_ai_entitlement(state: &Arc<LicenseState>, cloud_ai: bool) -> Result<(), String> {
    require_entitlement(state)?;
    // §22: cloud AI only when licensing enforcement is active.
    if !state.snapshot().require_license {
        return Err("Licensing is disabled — cloud AI is unavailable by policy.".into());
    }
    if cloud_ai && !state.snapshot().entitlements.cloud_ai {
        return Err("Cloud AI is not enabled for this license.".into());
    }
    Ok(())
}

#[tauri::command]
pub fn license_bootstrap(state: tauri::State<'_, Arc<LicenseState>>) -> Snapshot {
    let st = state.inner();
    if st.snapshot().stage != "ready" {
        gate::bootstrap(st);
        scheduler::start(st.clone());
    }
    st.snapshot()
}

#[tauri::command]
pub fn license_state(state: tauri::State<'_, Arc<LicenseState>>) -> Snapshot {
    gate::refresh_if_stale(state.inner());
    state.inner().snapshot()
}

#[tauri::command]
pub fn license_activate(
    state: tauri::State<'_, Arc<LicenseState>>,
    key: String,
) -> Result<Snapshot, String> {
    gate::activate(state.inner(), &key)
}

#[tauri::command]
pub fn license_continue_basic(state: tauri::State<'_, Arc<LicenseState>>) -> Result<Snapshot, String> {
    gate::continue_basic(state.inner())
}

#[tauri::command]
pub fn license_require_feature(
    state: tauri::State<'_, Arc<LicenseState>>,
    feature: String,
) -> Result<(), String> {
    require_feature(state.inner(), &feature)
}

#[tauri::command]
pub fn license_check_now(state: tauri::State<'_, Arc<LicenseState>>) -> Snapshot {
    gate::verify_once(state.inner())
}

#[tauri::command]
pub fn license_remove(state: tauri::State<'_, Arc<LicenseState>>) -> Result<Snapshot, String> {
    gate::remove_license(state.inner())
}

#[tauri::command]
pub fn license_resume(state: tauri::State<'_, Arc<LicenseState>>) -> Snapshot {
    let st = state.inner().clone();
    scheduler::resume_check(st.clone());
    st.snapshot()
}

#[tauri::command]
pub fn license_dismiss(
    state: tauri::State<'_, Arc<LicenseState>>,
    id: String,
    updated_at: String,
) -> Snapshot {
    gate::dismiss(state.inner(), &id, &updated_at)
}

#[tauri::command]
pub fn license_machine_id(state: tauri::State<'_, Arc<LicenseState>>) -> String {
    machine::machine_id_in(&state.inner().store_dir)
}

#[tauri::command]
pub fn license_app_info() -> AppInfo {
    machine::app_info()
}

/// Open an external URL (buy/github/support) in the default browser.
#[tauri::command]
pub fn license_open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("Only https links can be opened.".into());
    }
    #[cfg(target_os = "windows")]
    {
        let mut command = std::process::Command::new("cmd");
        command.args(["/C", "start", "", &url]);
        // `cmd /C start` is only a launcher. Keep that helper process from
        // flashing a console while the real browser opens.
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
        command.spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(feature = "tauri-cmds")]
#[tauri::command]
/// Active announcements (already priority-sorted).
pub async fn license_announcements(state: tauri::State<'_, Arc<LicenseState>>) -> Result<serde_json::Value, String> {
    let snap = state.inner().snapshot();
    Ok(serde_json::to_value(snap.announcements).map_err(|e| e.to_string())?)
}

#[cfg(feature = "tauri-cmds")]
#[tauri::command]
/// Narrow update check (versions + download URLs only, §43).
pub async fn check_for_update(state: tauri::State<'_, Arc<LicenseState>>) -> Result<serde_json::Value, String> {
    crate::app::policy::gate::refresh_if_stale(state.inner());
    let snap = state.inner().snapshot();
    Ok(serde_json::to_value(snap.update).map_err(|e| e.to_string())?)
}

#[cfg(feature = "tauri-cmds")]
#[tauri::command]
/// Recent cloud request log (requestId/endpoint/status/errorCode/latency).
pub async fn cloud_diagnostics(state: tauri::State<'_, Arc<LicenseState>>) -> Result<serde_json::Value, String> {
    let logs = state.inner().client.cloud().diagnostics();
    Ok(serde_json::to_value(logs).map_err(|e| e.to_string())?)
}

#[cfg(feature = "tauri-cmds")]
#[tauri::command]
/// Download the platform installer for the published update, verify sha256
/// when the cloud provides one, then launch it. No browser redirect.
pub fn update_download(state: tauri::State<'_, Arc<LicenseState>>) -> Result<String, String> {
    let snap = state.inner().snapshot();
    let u = snap.update.ok_or_else(|| "No update is published for this app.".to_string())?;
    let info = machine::app_info();
    let url = match info.platform.as_str() {
        "windows" => {
            if u.windows_download_url.is_empty() { &u.download_url } else { &u.windows_download_url }
        }
        "linux" => {
            if u.linux_download_url.is_empty() { &u.download_url } else { &u.linux_download_url }
        }
        _ => &u.download_url,
    };
    if !url.starts_with("https://") {
        return Err("Update URL must be HTTPS.".into());
    }
    let ext = match info.platform.as_str() {
        "windows" => "exe",
        "macos" => "dmg",
        _ => "AppImage",
    };
    let dest = std::env::temp_dir().join(format!("DataRefineStudio-update-{}.{}", u.latest, ext));
    crate::cloud::client::download_file(url, &dest)?;
    if !u.sha256.is_empty() {
        use sha2::{Digest, Sha256};
        let bytes = std::fs::read(&dest).map_err(|e| e.to_string())?;
        let sum: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
        if !sum.eq_ignore_ascii_case(&u.sha256) {
            let _ = std::fs::remove_file(&dest);
            return Err("Installer checksum mismatch — update aborted.".into());
        }
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new(&dest).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(&dest).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755));
        std::process::Command::new(&dest).spawn().map_err(|e| e.to_string())?;
    }
    Ok(dest.display().to_string())
}
