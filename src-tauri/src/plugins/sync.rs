//! Cloud plugin catalogue sync (§35–39).
//!
//! The catalogue is only ever fetched in licensed mode, and only from the
//! discovery-resolved (verified) endpoint. Actions are applied locally with
//! disable markers; artefacts must match the catalogue SHA-256 or the plugin
//! is refused. The sync report is telemetry-only — it never changes state.

use super::{manifest::Manifest, registry};
use crate::cloud::client::CloudClient;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;
use std::sync::Arc;

pub const DISABLE_MARKER: &str = ".drs-disabled";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogPlugin {
    pub id: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub artifact_url: Option<String>,
    #[serde(default)]
    pub entitled: bool,
    /// install | update | downgrade | disable | remove | keep
    #[serde(default)]
    pub sync_action: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SyncDecision {
    pub id: String,
    pub action: String,
    pub reason: String,
}

pub fn fetch_catalog(cloud: &Arc<CloudClient>) -> Result<Vec<CatalogPlugin>, String> {
    let raw = cloud
        .get("/api/plugins")
        .map_err(|e| format!("catalog unavailable: {}", e.message))?;
    if raw.status >= 400 {
        return Err(format!("catalog HTTP {}", raw.status));
    }
    let arr = raw
        .body
        .pointer("/data/plugins")
        .and_then(|v| v.as_array())
        .or_else(|| raw.body.get("data").and_then(|v| v.as_array()))
        .ok_or_else(|| "catalog response malformed".to_string())?;
    Ok(arr.iter().filter_map(|v| serde_json::from_value(v.clone()).ok()).collect())
}

fn version_newer(a: &str, b: &str) -> bool {
    let pa: Vec<i64> = a.split('.').filter_map(|s| s.parse().ok()).collect();
    let pb: Vec<i64> = b.split('.').filter_map(|s| s.parse().ok()).collect();
    pa > pb
}

/// Map catalogue → local state into concrete actions. Explicit `syncAction`
/// always wins; cached entitlements never override a remove/disable (§38).
pub fn plan(local: &[Manifest], catalog: &[CatalogPlugin]) -> Vec<SyncDecision> {
    catalog
        .iter()
        .map(|c| {
            let m = local.iter().find(|m| m.id == c.id);
            let explicit = c.sync_action.as_deref().unwrap_or("");
            let (action, reason) = match m {
                None => match explicit {
                    "remove" | "disable" | "keep" => ("keep".to_string(), "not installed".to_string()),
                    _ => ("install".to_string(), "in catalogue but not installed".to_string()),
                },
                Some(m) => {
                    if matches!(explicit, "install" | "update" | "downgrade" | "disable" | "remove" | "keep") {
                        (explicit.to_string(), "server-directed syncAction".to_string())
                    } else if !c.entitled {
                        ("disable".to_string(), "not entitled by catalogue".to_string())
                    } else if !c.version.is_empty() && c.version != m.version {
                        if version_newer(&c.version, &m.version) {
                            ("update".to_string(), format!("{} -> {}", m.version, c.version))
                        } else {
                            ("downgrade".to_string(), format!("{} -> {}", m.version, c.version))
                        }
                    } else {
                        ("keep".to_string(), "up to date".to_string())
                    }
                }
            };
            SyncDecision { id: c.id.clone(), action, reason }
        })
        .collect()
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let d = Sha256::digest(bytes);
    d.iter().map(|b| format!("{b:02x}")).collect()
}

/// Verify the plugin artefact (largest non-manifest file) against the
/// catalogue SHA-256. Missing artefact with an expected hash = mismatch.
pub fn verify_artifact(dir: &Path, expected: &str) -> Result<bool, String> {
    let mut best: Option<(u64, std::path::PathBuf)> = None;
    let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;
    for e in entries.flatten() {
        let p = e.path();
        if !p.is_file() {
            continue;
        }
        let name = e.file_name().to_string_lossy().to_string();
        if name == "manifest.json" || name.starts_with('.') {
            continue;
        }
        let size = e.metadata().map(|m| m.len()).unwrap_or(0);
        if best.as_ref().map(|(s, _)| size > *s).unwrap_or(true) {
            best = Some((size, p));
        }
    }
    let Some((_, p)) = best else {
        return Err("artefact missing".into());
    };
    let bytes = fs::read(&p).map_err(|e| e.to_string())?;
    Ok(sha256_hex(&bytes) == expected.to_lowercase())
}

pub fn set_disabled(root: &Path, id: &str, disabled: bool, reason: &str) -> std::io::Result<()> {
    let dir = root.join("installed").join(id);
    let marker = dir.join(DISABLE_MARKER);
    if disabled {
        if dir.is_dir() {
            fs::write(&marker, reason)?;
        }
    } else if marker.exists() {
        fs::remove_file(&marker)?;
    }
    Ok(())
}

/// Apply decisions locally; returns one report entry per decision.
pub fn apply(root: &Path, decisions: &[SyncDecision], catalog: &[CatalogPlugin]) -> Vec<Value> {
    decisions
        .iter()
        .map(|d| {
            let cat = catalog.iter().find(|c| c.id == d.id);
            let dir = root.join("installed").join(&d.id);
            match d.action.as_str() {
                "disable" | "remove" => {
                    let _ = set_disabled(root, &d.id, true, &d.reason);
                    json!({ "id": d.id, "action": d.action, "status": "disabled" })
                }
                "install" | "update" | "downgrade" | "keep" => {
                    // SHA-256 gate before the plugin may load again (§37).
                    if let (Some(c), true) = (cat, dir.is_dir()) {
                        if let Some(expected) = c.sha256.as_deref().filter(|s| !s.is_empty()) {
                            match verify_artifact(&dir, expected) {
                                Ok(true) => {
                                    let _ = set_disabled(root, &d.id, false, "");
                                    json!({ "id": d.id, "action": d.action, "status": "ok" })
                                }
                                Ok(false) => {
                                    let _ = set_disabled(root, &d.id, true, "sha256 mismatch");
                                    json!({ "id": d.id, "action": d.action, "status": "blocked-sha256" })
                                }
                                Err(e) => {
                                    let _ = set_disabled(root, &d.id, true, &format!("sha256 check failed: {e}"));
                                    json!({ "id": d.id, "action": d.action, "status": "blocked-sha256", "detail": e })
                                }
                            }
                        } else {
                            let _ = set_disabled(root, &d.id, false, "");
                            json!({ "id": d.id, "action": d.action, "status": "ok" })
                        }
                    } else {
                        json!({ "id": d.id, "action": d.action, "status": "pending-download" })
                    }
                }
                other => json!({ "id": d.id, "action": other, "status": "noop" }),
            }
        })
        .collect()
}

/// Full sync cycle used by the `plugin_sync` command.
pub fn sync_once(state_cloud: &Arc<CloudClient>, root: &Path, licensed: bool) -> Value {
    if !licensed {
        return json!({ "synced": false, "reason": "unrestricted mode — catalogue not fetched" });
    }
    let local = registry::scan(root);
    let catalog = match fetch_catalog(state_cloud) {
        Ok(c) => c,
        Err(e) => return json!({ "synced": false, "error": e }),
    };
    let decisions = plan(&local, &catalog);
    let results = apply(root, &decisions, &catalog);
    // Telemetry-only report; failures never affect local state.
    let _ = state_cloud.post("/api/plugins/sync", &json!({ "plugins": results }));
    json!({ "synced": true, "decisions": decisions.iter().map(|d| json!({"id": d.id, "action": d.action, "reason": d.reason})).collect::<Vec<_>>(), "results": results })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cat(id: &str, version: &str, entitled: bool, action: Option<&str>) -> CatalogPlugin {
        CatalogPlugin {
            id: id.into(),
            version: version.into(),
            sha256: None,
            artifact_url: None,
            entitled,
            sync_action: action.map(|s| s.to_string()),
        }
    }
    fn man(id: &str, version: &str) -> Manifest {
        Manifest { id: id.into(), name: id.into(), version: version.into(), ..Default::default() }
    }

    #[test]
    fn plan_maps_sync_actions() {
        let local = vec![man("a", "1.0.0"), man("b", "2.0.0"), man("c", "1.0.0")];
        let catalog = vec![
            cat("a", "1.1.0", true, None),          // update (newer)
            cat("b", "1.0.0", true, None),          // downgrade (older)
            cat("c", "1.0.0", false, None),         // disable (not entitled)
            cat("d", "1.0.0", true, None),          // install (missing locally)
            cat("a", "1.1.0", true, Some("remove")), // explicit remove wins
        ];
        let p = plan(&local, &catalog);
        assert_eq!(p[0].action, "update");
        assert_eq!(p[1].action, "downgrade");
        assert_eq!(p[2].action, "disable");
        assert_eq!(p[3].action, "install");
        assert_eq!(p[4].action, "remove");
    }

    #[test]
    fn sha256_mismatch_blocks_and_registry_skips() {
        let tmp = std::env::temp_dir().join(format!("drs-sync-test-{}", std::process::id()));
        let dir = tmp.join("installed").join("p1");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("manifest.json"), r#"{"id":"p1","name":"P1","version":"1.0.0"}"#).unwrap();
        fs::write(dir.join("plugin.zip"), b"artefact-bytes").unwrap();
        let good = sha256_hex(b"artefact-bytes");
        assert!(verify_artifact(&dir, &good).unwrap());
        assert!(!verify_artifact(&dir, &"0".repeat(64)).unwrap());

        // registry sees the plugin…
        assert_eq!(registry::scan(&tmp).len(), 1);
        // …until the sync disables it after a mismatch.
        let decisions = vec![SyncDecision { id: "p1".into(), action: "keep".into(), reason: "test".into() }];
        let catalog = vec![CatalogPlugin { sha256: Some("0".repeat(64)), ..cat("p1", "1.0.0", true, None) }];
        let results = apply(&tmp, &decisions, &catalog);
        assert_eq!(results[0]["status"], "blocked-sha256");
        assert_eq!(registry::scan(&tmp).len(), 0);
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn remove_deactivates_regardless_of_cached_state() {
        let tmp = std::env::temp_dir().join(format!("drs-sync-rm-{}", std::process::id()));
        let dir = tmp.join("installed").join("p2");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("manifest.json"), r#"{"id":"p2","name":"P2","version":"1.0.0"}"#).unwrap();
        let decisions = vec![SyncDecision { id: "p2".into(), action: "remove".into(), reason: "server".into() }];
        apply(&tmp, &decisions, &[cat("p2", "1.0.0", true, Some("remove"))]);
        assert!(dir.join(DISABLE_MARKER).exists());
        assert_eq!(registry::scan(&tmp).len(), 0);
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn sync_once_unrestricted_never_fetches() {
        let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
        let calls2 = calls.clone();
        let cloud = CloudClient::with_transport(
            "https://cloud.example",
            Arc::new(move |m: &str, u: &str, _b: Option<&Value>| {
                calls2.lock().unwrap().push(format!("{m} {u}"));
                Ok(crate::cloud::client::RawResponse { status: 200, retry_after_secs: None, body: json!({"ok": true, "data": []}) })
            }),
        );
        let out = sync_once(&cloud, Path::new("/nonexistent"), false);
        assert_eq!(out["synced"], json!(false));
        assert!(calls.lock().unwrap().is_empty(), "no catalogue traffic in unrestricted mode");
    }

    #[test]
    fn sync_once_reports_after_apply() {
        let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
        let calls2 = calls.clone();
        let cloud = CloudClient::with_transport(
            "https://cloud.example",
            Arc::new(move |m: &str, u: &str, _b: Option<&Value>| {
                calls2.lock().unwrap().push(format!("{m} {u}"));
                let body = if u.ends_with("/api/plugins") {
                    json!({"ok": true, "data": { "plugins": [{ "id": "x", "version": "1.0.0", "entitled": true }] }})
                } else {
                    json!({"ok": true})
                };
                Ok(crate::cloud::client::RawResponse { status: 200, retry_after_secs: None, body })
            }),
        );
        let out = sync_once(&cloud, Path::new("/nonexistent"), true);
        assert_eq!(out["synced"], json!(true));
        let log = calls.lock().unwrap();
        assert!(log.iter().any(|c| c == "GET https://cloud.example/api/plugins"));
        assert!(log.iter().any(|c| c == "POST https://cloud.example/api/plugins/sync"));
    }
}
