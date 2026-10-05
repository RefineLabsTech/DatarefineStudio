//! Plugin commands + the AI access gate used by the `datarefine.ai` bridge.

use super::{manifest::Manifest, permissions, registry};
use crate::ai::models::AiSource;
use crate::app::policy::model::Entitlements;
use crate::app::policy::LicenseState;
use std::path::{Path, PathBuf};
use std::sync::Arc;

fn resolve_plugin_root(root: &str) -> PathBuf {
    let path = Path::new(root);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        crate::data_root().join(path)
    }
}

/// Plugin AI access = manifest permission + capability + source-specific
/// entitlement rules. BYOK/local use the user's own runtime source and do not
/// require a DataRefine AI entitlement; Cloud remains entitlement-gated.
/// Credits are never plugin-controlled.
pub fn ai_access(
    m: &Manifest,
    need: &str,
    capability: &str,
    ent: &Entitlements,
    source: AiSource,
) -> Result<(), String> {
    if !permissions::known(need) {
        return Err(format!("unknown permission '{need}'"));
    }
    if !permissions::declares(m, need) {
        return Err(format!("plugin '{}' does not declare '{need}'", m.id));
    }
    if !capability.is_empty() && !m.capabilities.iter().any(|c| c == capability) {
        return Err(format!("plugin '{}' does not declare capability '{capability}'", m.id));
    }
    match source {
        AiSource::Cloud => {
            if !ent.cloud_ai {
                return Err("Cloud AI requires an AI Pro license.".into());
            }
            if !ent.ai_plugins {
                return Err("AI plugins are not part of this license.".into());
            }
        }
        AiSource::Byok | AiSource::Local => {
            // A user's own key, or a local model, is independent of the
            // DataRefine license. Permission and capability checks above still
            // apply; no DataRefine credits are involved.
        }
    }
    Ok(())
}

#[tauri::command]
pub fn plugin_list(
    state: tauri::State<'_, Arc<LicenseState>>,
    root: String,
) -> Result<Vec<Manifest>, String> {
    crate::app::policy::commands::require_feature(state.inner(), "installed_plugins")?;
    let root = resolve_plugin_root(&root);
    Ok(registry::scan(&root))
}

#[tauri::command]
pub fn plugin_ai_check(
    state: tauri::State<'_, Arc<LicenseState>>,
    root: String,
    plugin_id: String,
    need: String,
    capability: String,
    source: String,
) -> Result<(), String> {
    let root = resolve_plugin_root(&root);
    let m = registry::find(&root, &plugin_id)
        .ok_or_else(|| format!("plugin '{plugin_id}' not installed"))?;
    let src = AiSource::parse(&source).unwrap_or(AiSource::Local);
    let ent = state.inner().snapshot().entitlements;
    ai_access(&m, &need, &capability, &ent, src)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(perms: &[&str], caps: &[&str], ty: &str) -> Manifest {
        Manifest { id: "p1".into(), name: "P".into(), version: "1".into(), plugin_type: ty.into(), permissions: perms.iter().map(|s| s.to_string()).collect(), capabilities: caps.iter().map(|s| s.to_string()).collect() }
    }
    fn ent(pro: bool) -> crate::app::policy::model::Entitlements {
        crate::app::policy::model::Entitlements { cloud_ai: pro, ai_plugins: pro, agents: pro, capabilities: vec![] }
    }

    #[test]
    fn undeclared_permission_is_rejected() {
        let m = manifest(&["dataset.read"], &[], "ui");
        let err = ai_access(&m, "ai.inference", "", &ent(false), crate::ai::models::AiSource::Local).unwrap_err();
        assert!(err.contains("does not declare"));
    }

    #[test]
    fn unknown_permission_is_rejected() {
        let m = manifest(&["dataset.read"], &[], "ui");
        assert!(ai_access(&m, "satellite.uplink", "", &ent(true), crate::ai::models::AiSource::Cloud).is_err());
    }

    #[test]
    fn capability_must_be_declared() {
        let m = manifest(&["ai.inference"], &["data_profiling"], "ai");
        assert!(ai_access(&m, "ai.inference", "data_cleaning", &ent(true), crate::ai::models::AiSource::Local).is_err());
        assert!(ai_access(&m, "ai.inference", "data_profiling", &ent(true), crate::ai::models::AiSource::Local).is_ok());
    }

    #[test]
    fn cloud_source_requires_cloud_ai_and_ai_plugins() {
        let m = manifest(&["ai.inference"], &[], "ui");
        assert!(ai_access(&m, "ai.inference", "", &ent(false), crate::ai::models::AiSource::Cloud).is_err());
        let partial = crate::app::policy::model::Entitlements { cloud_ai: true, ai_plugins: false, agents: false, capabilities: vec![] };
        assert!(ai_access(&m, "ai.inference", "", &partial, crate::ai::models::AiSource::Cloud).is_err());
        assert!(ai_access(&m, "ai.inference", "", &ent(true), crate::ai::models::AiSource::Cloud).is_ok());
    }

    #[test]
    fn standard_license_keeps_local_and_byok_ai_for_all_plugin_types() {
        for plugin_type in ["ui", "tool", "ai"] {
            let m = manifest(&["ai.inference"], &[], plugin_type);
            assert!(ai_access(&m, "ai.inference", "", &ent(false), crate::ai::models::AiSource::Local).is_ok());
            assert!(ai_access(&m, "ai.inference", "", &ent(false), crate::ai::models::AiSource::Byok).is_ok());
        }
    }

}

#[cfg(feature = "tauri-cmds")]
#[tauri::command]
/// Cloud catalogue sync (§35–39). Licensed mode only; degrades to a
/// diagnostic when the catalogue endpoint is unavailable.
pub fn plugin_sync(state: tauri::State<'_, Arc<LicenseState>>, root: String) -> serde_json::Value {
    if let Err(error) = crate::app::policy::commands::require_feature(state.inner(), "marketplace") {
        return serde_json::json!({ "ok": false, "reason": error });
    }
    let snap = state.inner().snapshot();
    let licensed = snap.require_license
        && matches!(
            snap.enforcement,
            crate::app::policy::model::EnforcementMode::Licensed
        )
        && snap.decision == "granted";
    let root = resolve_plugin_root(&root);
    super::sync::sync_once(&state.inner().client.cloud(), &root, licensed)
}

#[cfg(feature = "tauri-cmds")]
#[tauri::command]
/// Marketplace catalogue search, gated by the cloud-controlled marketplace feature.
pub fn plugin_marketplace_search(
    state: tauri::State<'_, Arc<LicenseState>>,
    query: String,
) -> serde_json::Value {
    if let Err(error) = crate::app::policy::commands::require_feature(state.inner(), "marketplace") {
        return serde_json::json!({ "available": false, "reason": error, "results": [] });
    }
    let root = resolve_plugin_root("plugins");
    serde_json::to_value(super::market::search(&state.inner().client.cloud(), &root, &query))
        .unwrap_or(serde_json::Value::Null)
}

#[cfg(feature = "tauri-cmds")]
#[tauri::command]
/// Public marketplace install (HTTPS/loopback + sha256 + zip-slip guard),
/// with bundled first-party catalog artifacts as a development fallback.
pub fn plugin_install(
    state: tauri::State<'_, Arc<LicenseState>>,
    root: String,
    id: String,
) -> Result<serde_json::Value, String> {
    crate::app::policy::commands::require_feature(state.inner(), "plugin_install")?;
    crate::app::policy::commands::require_feature(state.inner(), "marketplace")?;
    let root = resolve_plugin_root(&root);
    let m = super::market::install(
        &state.inner().client.cloud(),
        &root,
        &id,
    )?;
    serde_json::to_value(m).map_err(|e| e.to_string())
}

#[cfg(feature = "tauri-cmds")]
#[tauri::command]
pub fn plugin_uninstall(
    state: tauri::State<'_, Arc<LicenseState>>,
    root: String,
    id: String,
) -> Result<serde_json::Value, String> {
    crate::app::policy::commands::require_feature(state.inner(), "installed_plugins")?;
    let root = resolve_plugin_root(&root);
    super::market::uninstall(&root, &id)?;
    Ok(serde_json::json!({ "ok": true }))
}

#[cfg(feature = "tauri-cmds")]
#[tauri::command]
pub fn plugin_set_enabled(
    state: tauri::State<'_, Arc<LicenseState>>,
    root: String,
    id: String,
    enabled: bool,
) -> Result<serde_json::Value, String> {
    crate::app::policy::commands::require_feature(state.inner(), "installed_plugins")?;
    let root = resolve_plugin_root(&root);
    super::market::set_enabled(&root, &id, enabled)?;
    Ok(serde_json::json!({ "ok": true }))
}
