//! Startup gate + verification/activation flows. Orchestrates client,
//! storage and checker; publishes serialized snapshots for React.

use std::sync::Arc;

use serde_json::Value;

use crate::app::policy::checker::{self, Decision};
use crate::app::policy::machine;
use crate::app::policy::model::{ActivateOk, Config, Entitlements, Licensing, VerifyOk};
use crate::app::policy::storage::{self, Dismissed, Stored};
use crate::app::policy::{client, iso, now_ms, LicenseState, LicenseView, Snapshot, UpdateView};

fn load_stored(state: &Arc<LicenseState>) -> Stored {
    let mid = machine::machine_id_in(&state.store_dir);
    let mut st = storage::load(&state.store_dir, &mid).unwrap_or_else(|_| Stored {
        machine_id: mid.clone(),
        ..Stored::default()
    });
    if st.machine_id.is_empty() {
        st.machine_id = mid;
    }
    if st.device_id.is_empty() {
        st.device_id = machine::device_id(&state.store_dir);
        let _ = storage::save(&state.store_dir, &st);
    }
    st
}

fn persist(state: &Arc<LicenseState>, st: &Stored) {
    let _ = storage::save(&state.store_dir, st);
}

/// The raw activation token is used only by Rust-owned authenticated cloud
/// requests. It is never serialized into the license snapshot or exposed to
/// React/plugin code.
pub fn current_activation_token(state: &Arc<LicenseState>) -> Option<String> {
    let token = load_stored(state).activation_token;
    (!token.trim().is_empty()).then_some(token)
}

/// Rust-only identity for authenticated wallet reads. The license key remains
/// inside the encrypted storage path and is never serialized into Snapshot or
/// exposed to React/plugins.
pub fn current_license_identity(state: &Arc<LicenseState>) -> Option<(String, String)> {
    let stored = load_stored(state);
    if stored.key_escrow.trim().is_empty() || stored.machine_id.trim().is_empty() {
        return None;
    }
    Some((stored.key_escrow, stored.machine_id))
}

/// Remove the activation from this device. This is local removal only; it
/// never deletes the license record or local datasets from Cloud.
pub fn remove_license(state: &Arc<LicenseState>) -> Result<Snapshot, String> {
    let mut st = load_stored(state);
    storage::clear_activation_token()?;
    st.activation_token.clear();
    st.key_escrow.clear();
    st.entitlements = Entitlements::default();
    st.masked_license.clear();
    st.plan.clear();
    st.expires_at.clear();
    st.last_verification_ms = 0;
    st.last_granted_ms = 0;
    st.basic_mode = false;
    storage::save(&state.store_dir, &st).map_err(|e| format!("Could not remove the local license: {e:?}"))?;
    if let Ok(mut next) = state.next_check_ms.lock() {
        *next = None;
    }
    if let Ok(mut status) = state.verify_status.lock() {
        *status = None;
    }
    let cfg = state.snapshot().config;
    let info = machine::app_info();
    let decision = checker::decide(checker::CheckInput {
        config: cfg.as_ref(),
        stored: &st,
        now_ms: now_ms(),
        net_ok: true,
        verify_status: None,
        app_version: &info.version,
    });
    Ok(publish(state, &st, cfg.as_ref(), decision, true, Some("License removed from this device.".into())))
}

/// Accept a cloud config only when it contains an explicit licensing toggle.
/// An empty or malformed response must never silently become an unrestricted
/// deployment, because that would bypass the cloud's source-of-truth policy.
fn config_from_value(v: &Value) -> Option<Config> {
    let object = v.as_object()?;
    let has_toggle = object
        .get("requireLicense")
        .or_else(|| object.get("require_license"))
        .and_then(Value::as_bool)
        .is_some()
        || object
            .get("licensing")
            .and_then(Value::as_object)
            .and_then(|licensing| {
                licensing
                    .get("requireLicense")
                    .or_else(|| licensing.get("require_license"))
                    .and_then(Value::as_bool)
            })
            .is_some();
    if !has_toggle {
        return None;
    }
    serde_json::from_value::<Config>(v.clone()).ok()
}

/// Safe first-run/offline fallback. It deliberately requires licensing so an
/// unavailable cloud response cannot be mistaken for `requireLicense=false`.
fn unavailable_config() -> Config {
    Config {
        require_license: Some(true),
        licensing: Licensing {
            require_license: true,
            ..Licensing::default()
        },
        ..Config::default()
    }
}

/// Parse the verification response without losing entitlements when a
/// production deployment uses `cloudAI` instead of the desktop's canonical
/// `cloudAi` spelling. This is intentionally tolerant of the other legacy
/// spellings too, while still requiring the server to provide the field.
fn parse_verify_ok(data: &Value) -> VerifyOk {
    let mut parsed = serde_json::from_value::<VerifyOk>(data.clone()).unwrap_or_default();
    let raw_entitlements = data
        .get("entitlements")
        .or_else(|| data.get("entitlement"))
        .or_else(|| {
            ["cloudAi", "cloudAI", "cloud_ai", "aiPlugins", "ai_plugins", "agents", "capabilities"]
                .iter()
                .any(|key| data.get(*key).is_some())
                .then_some(data)
        });
    if let Some(raw) = raw_entitlements.and_then(Value::as_object) {
        let bool_value = |names: &[&str]| {
            names.iter().find_map(|name| raw.get(*name)).and_then(|v| match v {
                Value::Bool(b) => Some(*b),
                Value::String(s) if s.eq_ignore_ascii_case("true") => Some(true),
                Value::String(s) if s.eq_ignore_ascii_case("false") => Some(false),
                _ => None,
            })
        };
        let mut ent = Entitlements::default();
        ent.cloud_ai = bool_value(&["cloudAi", "cloudAI", "cloud_ai"]).unwrap_or(false);
        ent.ai_plugins = bool_value(&["aiPlugins", "ai_plugins"]).unwrap_or(false);
        ent.agents = bool_value(&["agents"]).unwrap_or(false);
        ent.capabilities = raw
            .get("capabilities")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        parsed.entitlements = Some(ent);
    }
    parsed
}

fn update_view(cfg: Option<&Config>, app_version: &str, decision: &Decision) -> Option<UpdateView> {
    let c = cfg?;
    let latest = c.versions.latest.clone().unwrap_or_default();
    let minimum = c.versions.minimum.clone().unwrap_or_default();
    let mandatory = !minimum.is_empty()
        && checker::version_cmp(app_version, &minimum) == std::cmp::Ordering::Less;
    let newer = !latest.is_empty()
        && checker::version_cmp(app_version, &latest) == std::cmp::Ordering::Less;
    if !mandatory && !newer {
        return None;
    }
    Some(UpdateView {
        current: app_version.to_string(),
        latest,
        minimum,
        mandatory: mandatory || *decision == Decision::MandatoryUpdate,
        download_url: c.versions.download_url.clone().unwrap_or_default(),
        windows_download_url: c.versions.windows_download_url.clone().unwrap_or_default(),
        linux_download_url: c.versions.linux_download_url.clone().unwrap_or_default(),
        sha256: c.versions.sha256.clone().unwrap_or_default(),
        release_notes: c.versions.release_notes.clone().unwrap_or_default(),
    })
}

fn publish(
    state: &Arc<LicenseState>,
    st: &Stored,
    cfg: Option<&Config>,
    decision: Decision,
    net_ok: bool,
    message: Option<String>,
) -> Snapshot {
    let now = now_ms();
    let app_version = machine::app_info().version;
    let license = if st.activation_token.is_empty() {
        None
    } else {
        Some(LicenseView {
            plan: if st.plan.is_empty() { "Pro".into() } else { st.plan.clone() },
            masked: st.masked_license.clone(),
            expires_at: st.expires_at.clone(),
            days_remaining: checker::days_remaining(&st.expires_at, now),
            last_verification: if st.last_verification_ms > 0 {
                Some(iso(st.last_verification_ms))
            } else {
                None
            },
            offline: !net_ok,
        })
    };
    // Link fallbacks are derived here (Rust owns the single base URL string).
    let mut cfg_owned = cfg.cloned();
    if let Some(c) = cfg_owned.as_mut() {
        if c.links.buy_url.as_deref().unwrap_or("").is_empty() {
            c.links.buy_url = c.buy_url.clone().filter(|url| !url.trim().is_empty());
        }
        if c.links.buy_url.as_deref().unwrap_or("").is_empty() {
            c.links.buy_url = Some(format!("{}/buy", client::CLOUD_BASE));
        }
        if c.links.github_url.as_deref().unwrap_or("").is_empty() {
            c.links.github_url = Some("https://github.com".into());
        }
    }
    let cfg = cfg_owned.as_ref();
    // §2/§22: unrestricted mode purges stale entitlements from runtime state.
    let licensed = cfg.map(|cl| cl.requires_license()).unwrap_or(false)
        && !state.lic_disabled.load(std::sync::atomic::Ordering::SeqCst);
    let feature_policy = cfg
        .map(|c| c.feature_policy())
        .unwrap_or_default();
    // A stored entitlement is useful only while a valid Professional grant is
    // open. Basic mode intentionally publishes an empty entitlement set.
    let paid_active = licensed && decision == Decision::Granted;
    let entitlements = if paid_active {
        st.entitlements.clone()
    } else {
        crate::app::policy::model::Entitlements::default()
    };
    let _prev_decision = state.snapshot().decision;
    let _prev_require = state.snapshot().require_license;
    let snap = Snapshot {
        stage: "ready".into(),
        decision: decision.as_str().to_string(),
        message,
        offline: !net_ok,
        require_license: cfg.map(|c| c.requires_license()).unwrap_or(false),
        config: cfg.cloned(),
        license,
        announcements: {
            let platform = machine::app_info().platform;
            let mut list: Vec<_> = cfg
                .map(|c| c.announcements.clone())
                .unwrap_or_default()
                .into_iter()
                .filter(|an| checker::is_live(an, now, &platform))
                .collect();
            list.sort_by(|x, y| y.priority.cmp(&x.priority));
            list
        },
        update: update_view(cfg, &app_version, &decision),
        device_id: st.device_id.clone(),
        dismissed: st.dismissed.clone(),
        entitlements: entitlements.clone(),
        feature_policy,
        basic_mode: decision == Decision::Basic,
        endpoint: state.endpoint.lock().ok().and_then(|g| g.clone()),
        enforcement: if licensed {
            crate::app::policy::model::EnforcementMode::Licensed
        } else {
            crate::app::policy::model::EnforcementMode::Unrestricted
        },
        last_check: Some(iso(now)),
        error: None,
    };
    state.update(|s| *s = snap.clone());
    #[cfg(feature = "tauri-cmds")]
    if _prev_decision != snap.decision || _prev_require != snap.require_license {
        crate::app::policy::commands::emit_state_changed(&snap);
    }
    snap
}

/// §47: 403 LICENSING_DISABLED flips runtime to unrestricted until policy
/// re-enables licensing (config refresh clears the flag).
fn note_cloud_code(state: &Arc<LicenseState>, code: Option<&str>) {
    if code == Some("LICENSING_DISABLED") {
        state.lic_disabled.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

fn mark_cfg(state: &Arc<LicenseState>) {
    *state.cfg_ms.lock().unwrap_or_else(|e| e.into_inner()) = now_ms();
}

/// Config-only refresh (announcements, maintenance, policy, versions) at most
/// once per 60s, driven by the UI's state poll — never blocks on network fail.
pub fn refresh_if_stale(state: &Arc<LicenseState>) {
    let now = now_ms();
    {
        let last = *state.cfg_ms.lock().unwrap_or_else(|e| e.into_inner());
        if now - last < 60_000 {
            return;
        }
    }
    mark_cfg(state);
    let env = match state.client.get_config() {
        Ok(env) if env.ok => env,
        _ => return,
    };
    let cfg = match config_from_value(&env.data) {
        Some(cfg) => cfg,
        None => return,
    };
    let require_now = cfg.requires_license();
    if require_now {
        state.lic_disabled.store(false, std::sync::atomic::Ordering::SeqCst);
    }
    let mut st = load_stored(state);
    if !require_now && st.entitlements != crate::app::policy::model::Entitlements::default() {
        st.entitlements = crate::app::policy::model::Entitlements::default();
        persist(state, &st);
    }
    let vs = state
        .verify_status
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let info = machine::app_info();
    let decision = checker::decide(checker::CheckInput {
        config: Some(&cfg),
        stored: &st,
        now_ms: now,
        net_ok: true,
        verify_status: vs.as_deref(),
        app_version: &info.version,
    });
    publish(state, &st, Some(&cfg), decision, true, None);
}

/// Full startup gate: storage → ids → install → config → policy → snapshot.
pub fn bootstrap(state: &Arc<LicenseState>) -> Snapshot {
    let mut st = load_stored(state);
    let now = now_ms();
    let rolled_back = checker::clock_rollback(now, st.last_wall_ms);
    if rolled_back {
        // Clock moved backwards: do not trust the offline grace window until
        // the next successful online verification.
        st.last_granted_ms = 0;
    }

    // Signed endpoint discovery: bootstrap -> cached last-good -> stable.
    let cached = crate::cloud::discovery::load_cache(&state.store_dir);
    let fetch = |u: &str| {
        crate::cloud::client::fetch_json_once(u, crate::cloud::config::BOOTSTRAP_TIMEOUT_MS)
    };
    let (ep, new_cache) = crate::cloud::discovery::resolve(&fetch, cached.as_ref(), now);
    if let Some(c) = new_cache {
        crate::cloud::discovery::save_cache(&state.store_dir, &c);
    }
    state.client.set_base(&ep.url);
    if let Ok(mut g) = state.endpoint.lock() {
        *g = Some(ep.clone());
    }

    let info = machine::app_info();
    // Anonymous install registration (best effort, never blocks startup).
    let _ = state.client.post_install(&crate::app::policy::model::InstallPayload {
        device_id: st.device_id.clone(),
        machine_id: st.machine_id.clone(),
        platform: checker::wire_platform(&info.platform).to_string(),
        app_version: info.version.clone(),
        architecture: info.arch.clone(),
        os_version: info.os_version.clone(),
    });

    let (cfg, net_ok) = match state.client.get_config() {
        Ok(env) if env.ok => match config_from_value(&env.data) {
            Some(cfg) => {
                st.cached_config = Some(env.data.clone());
                (Some(cfg), true)
            }
            None => (
                st.cached_config
                    .as_ref()
                    .and_then(config_from_value)
                    .or_else(|| Some(unavailable_config())),
                false,
            ),
        },
        Ok(env) => (
            config_from_value(&env.data)
                .or_else(|| st.cached_config.as_ref().and_then(config_from_value))
                .or_else(|| Some(unavailable_config())),
            false,
        ),
        Err(_) => (
            st.cached_config
                .as_ref()
                .and_then(config_from_value)
                .or_else(|| Some(unavailable_config())),
            false,
        ),
    };
    mark_cfg(state);
    if cfg.as_ref().map(|cl| cl.requires_license()).unwrap_or(false) {
        state.lic_disabled.store(false, std::sync::atomic::Ordering::SeqCst);
    } else if st.entitlements != crate::app::policy::model::Entitlements::default() {
        st.entitlements = crate::app::policy::model::Entitlements::default();
        persist(state, &st);
    }

    let decision = checker::decide(checker::CheckInput {
        config: cfg.as_ref(),
        stored: &st,
        now_ms: now,
        net_ok,
        verify_status: None,
        app_version: &info.version,
    });
    let message = match (&decision, cfg.as_ref()) {
        (Decision::Maintenance, Some(c)) => c.maintenance.message.clone(),
        (Decision::GraceExpired, _) => Some(
            "Offline grace period expired. Connect to the internet and retry — your projects and datasets are untouched.".into(),
        ),
        _ => None,
    };

    st.last_wall_ms = now;
    persist(state, &st);
    publish(state, &st, cfg.as_ref(), decision, net_ok, message)
}

/// One verification cycle (scheduler, resume, manual Check Now).
pub fn verify_once(state: &Arc<LicenseState>) -> Snapshot {
    if state
        .busy
        .compare_exchange(false, true, std::sync::atomic::Ordering::SeqCst, std::sync::atomic::Ordering::SeqCst)
        .is_err()
    {
        return state.snapshot();
    }
    let out = verify_inner(state);
    state.busy.store(false, std::sync::atomic::Ordering::SeqCst);
    out
}

fn verify_inner(state: &Arc<LicenseState>) -> Snapshot {
    let mut st = load_stored(state);
    let now = now_ms();
    let info = machine::app_info();

    let (cfg, net_ok) = match state.client.get_config() {
        Ok(env) if env.ok => match config_from_value(&env.data) {
            Some(cfg) => {
                st.cached_config = Some(env.data.clone());
                (Some(cfg), true)
            }
            None => (
                state
                    .snapshot()
                    .config
                    .or_else(|| st.cached_config.as_ref().and_then(config_from_value))
                    .or_else(|| Some(unavailable_config())),
                false,
            ),
        },
        Ok(env) => (
            config_from_value(&env.data)
                .or_else(|| st.cached_config.as_ref().and_then(config_from_value))
                .or_else(|| Some(unavailable_config())),
            false,
        ),
        Err(_) => (
            st.cached_config
                .as_ref()
                .and_then(config_from_value)
                .or_else(|| Some(unavailable_config())),
            false,
        ),
    };
    mark_cfg(state);

    let require = cfg.as_ref().map(|c| c.requires_license()).unwrap_or(false);
    if require {
        state.lic_disabled.store(false, std::sync::atomic::Ordering::SeqCst);
    } else if st.entitlements != crate::app::policy::model::Entitlements::default() {
        // §22: never keep stale entitlements while licensing is off.
        st.entitlements = crate::app::policy::model::Entitlements::default();
        persist(state, &st);
    }
    let mut verify_status: Option<String> = None;
    let mut message: Option<String> = None;
    let mut error_note: Option<String> = None;

    if require && net_ok && !st.activation_token.is_empty() {
        match state.client.post_verify(&crate::app::policy::model::VerifyPayload {
            license_key: (!st.key_escrow.is_empty()).then(|| st.key_escrow.clone()),
            activation_token: st.activation_token.clone(),
            device_id: st.device_id.clone(),
            machine_id: st.machine_id.clone(),
            platform: checker::wire_platform(&info.platform).to_string(),
            app_version: info.version.clone(),
        }) {
            Ok(env) if env.ok => {
                let v = parse_verify_ok(&env.data);
                verify_status = v.status.clone();
                message = v.message.clone();
                // Token rotation: replace immediately and persist.
                note_cloud_code(state, env.code.as_deref());
                if let Some(nc) = v.next_check_in_at.as_deref() {
                    if let Some(ms) = crate::app::policy::parse_iso_ms(nc) {
                        if let Ok(mut gg) = state.next_check_ms.lock() {
                            *gg = Some(ms);
                        }
                    }
                }
                if let Some(e) = v.entitlements.clone() {
                    st.entitlements = e;
                }
                if let Some(rot) = v.activation_token.clone() {
                    if !rot.is_empty() && rot != st.activation_token {
                        st.activation_token = rot;
                    }
                }
                if let Some(p) = v.plan.clone() {
                    if !p.is_empty() {
                        st.plan = p;
                    }
                }
                if let Some(e) = v.expires_at.clone() {
                    if !e.is_empty() {
                        st.expires_at = e;
                    }
                }
                // Some production deployments return HTTP 200 with a null
                // plan/expiry for an unknown or deleted license instead of a
                // token_invalid status. Treat that response as a revocation;
                // otherwise checker.rs would incorrectly preserve the cached
                // grant because the network request itself succeeded.
                if v.status.is_none() && v.plan.is_none() && v.expires_at.is_none() && v.activation_token.is_none() {
                    verify_status = Some("token_invalid".into());
                    message = Some("The license is no longer active on License Cloud.".into());
                    st.entitlements = crate::app::policy::model::Entitlements::default();
                }
                if verify_status.as_deref() == Some("token_invalid") {
                    // Clear the token once; the next decision shows activation.
                    st.activation_token.clear();
                    st.masked_license.clear();
                } else if verify_status.as_deref() == Some("granted") || verify_status.is_none() {
                    st.last_granted_ms = now;
                }
                st.last_verification_ms = now;
            }
            Ok(env) => {
                message = env.message;
                verify_status = Some("invalid".into());
            }
            Err(e) => {
                note_cloud_code(state, e.code.as_deref());
                if matches!(e.kind, crate::app::policy::client::ErrorKind::Http(400)) {
                    // Contract mismatch (cloud asks for fields we deliberately
                    // do not store): inconclusive — keep the cached entitlement
                    // and surface the note; never clear a good token for this.
                    error_note = Some(format!("Verify inconclusive: {}", e.message));
                }
                /* otherwise network failure: fall through to offline grace */
            }
        }
    }

    let decision = checker::decide(checker::CheckInput {
        config: cfg.as_ref(),
        stored: &st,
        now_ms: now,
        net_ok,
        verify_status: verify_status.as_deref(),
        app_version: &info.version,
    });
    let msg = match (&decision, cfg.as_ref()) {
        (Decision::Maintenance, Some(c)) => c.maintenance.message.clone(),
        (Decision::GraceExpired, _) => Some(
            "Offline grace period expired. Connect to the internet and retry — your projects and datasets are untouched.".into(),
        ),
        _ => message,
    };
    st.last_wall_ms = now;
    persist(state, &st);
    *state
        .verify_status
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = verify_status.clone();
    publish(state, &st, cfg.as_ref(), decision, net_ok, msg);
    if let Some(note) = error_note {
        state.update(|s| s.error = Some(note));
    }
    state.snapshot()
}

/// Activation flow. Stores only token/mask/expiry — never the plain key.
pub fn activate(state: &Arc<LicenseState>, key: &str) -> Result<Snapshot, String> {
    let wire = checker::canonical_key(key);
    if wire.is_empty() {
        return Err("Enter your license key.".into());
    }
    let mut st = load_stored(state);
    let info = machine::app_info();
    let env = state
        .client
        .post_activate(&crate::app::policy::model::ActivatePayload {
            license_key: wire.clone(),
            device_id: st.device_id.clone(),
            machine_id: st.machine_id.clone(),
            platform: checker::wire_platform(&info.platform).to_string(),
            app_version: info.version.clone(),
        })
        .map_err(|e| e.message)?;
    if !env.ok {
        return Err(env.message.unwrap_or_else(|| "Activation failed.".into()));
    }
    let ok = serde_json::from_value::<ActivateOk>(env.data).unwrap_or_default();
    let token = ok
        .activation_token
        .clone()
        .filter(|t| !t.is_empty())
        .ok_or_else(|| "Activation response missing token.".to_string())?;
    let now = now_ms();
    st.key_escrow = wire.clone(); // encrypted-at-rest; verify resends it per cloud contract
    st.entitlements = ok.entitlements.clone().unwrap_or_default();
    st.activation_token = token;
    st.masked_license = client::mask_key(&wire);
    st.expires_at = ok.expires_at.clone().unwrap_or_default();
    st.plan = ok.plan.clone().unwrap_or_else(|| "Pro".into());
    st.basic_mode = false;
    st.last_verification_ms = now;
    st.last_granted_ms = now;
    st.last_wall_ms = now;
    persist(state, &st);

    let mut cfg = state.snapshot().config;
    if let Some(c) = cfg.as_mut() {
        // Activation response can carry policy overrides — apply at once.
        if let Some(h) = ok.verify_interval_hours {
            if h > 0 {
                c.licensing.verify_interval_hours = h;
            }
        }
        if let Some(g) = ok.offline_grace_days {
            if g > 0 {
                c.licensing.offline_grace_days = g;
            }
        }
    }
    let decision = checker::decide(checker::CheckInput {
        config: cfg.as_ref(),
        stored: &st,
        now_ms: now,
        net_ok: true,
        verify_status: Some("granted"),
        app_version: &info.version,
    });
    Ok(publish(state, &st, cfg.as_ref(), decision, true, None))
}

/// Persist the user's non-blocking Basic choice. This never changes the
/// server's requireLicense flag; it only selects the locally available core
/// feature set until the user activates a valid license.
pub fn continue_basic(state: &Arc<LicenseState>) -> Result<Snapshot, String> {
    let mut st = load_stored(state);
    let cfg = state.snapshot().config;
    if !cfg.as_ref().map(|c| c.requires_license()).unwrap_or(false) {
        return Ok(state.snapshot());
    }
    st.basic_mode = true;
    persist(state, &st);
    Ok(publish(
        state,
        &st,
        cfg.as_ref(),
        Decision::Basic,
        !state.snapshot().offline,
        Some("Basic mode enabled. Local cleaning remains available; Professional features are disabled.".into()),
    ))
}

/// Announcement dismissal (id + updatedAt so edited notices re-appear).
pub fn dismiss(state: &Arc<LicenseState>, id: &str, updated_at: &str) -> Snapshot {
    let mut st = load_stored(state);
    st.dismissed.retain(|d| d.id != id);
    st.dismissed.push(Dismissed {
        id: id.to_string(),
        updated_at: updated_at.to_string(),
    });
    persist(state, &st);
    let snap = state.snapshot();
    state.update(|s| s.dismissed = st.dismissed.clone());
    snap
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
    use crate::app::policy::client::{Client, RawResponse, Transport};
    use serde_json::json;

    #[test]
    fn malformed_config_is_not_treated_as_unrestricted() {
        assert!(config_from_value(&json!({})).is_none());
        assert!(config_from_value(&json!({ "licensing": { "requireLicense": "false" } })).is_none());
        assert!(unavailable_config().requires_license());
    }

    fn mock_state(dir_suffix: &str, verify_body: Value) -> Arc<LicenseState> {
        let dir = std::env::temp_dir().join(format!("drs-gate-{dir_suffix}"));
        let _ = std::fs::remove_dir_all(&dir);
        let mut st = LicenseState::new(dir.clone());
        let vb = verify_body.clone();
        let transport: Transport = Arc::new(move |_method, url, _body| {
            let body = if url.ends_with("/api/config") {
                json!({"ok": true, "data": {"licensing": {"requireLicense": true, "verifyIntervalHours": 24, "offlineGraceDays": 30}}})
            } else if url.ends_with("/api/verify") {
                vb.clone()
            } else {
                json!({"ok": true, "data": {}})
            };
            Ok(RawResponse { status: 200, retry_after_secs: None, body })
        });
        Arc::get_mut(&mut st).expect("fresh state").client =
            Client::with_transport("https://mock.invalid", transport);
        // seed a stored license
        let mid = machine::machine_id_in(&dir);
        let stored = Stored {
            device_id: "dev".into(),
            machine_id: mid,
            activation_token: "OLD-TOKEN".into(),
            masked_license: "OLDT-…-OKEN".into(),
            plan: "Pro".into(),
            expires_at: "2030-01-01T00:00:00Z".into(),
            last_granted_ms: now_ms(),
            ..Stored::default()
        };
        storage::save(&dir, &stored).expect("seed store");
        st
    }

    #[test]
    fn production_uppercase_cloud_ai_entitlement_is_preserved() {
        let parsed = parse_verify_ok(&json!({
            "status": "granted",
            "plan": "professional_3_month",
            "entitlements": {
                "cloudAI": true,
                "aiPlugins": true,
                "agents": true,
                "capabilities": ["data_cleaning", "data_profiling"]
            }
        }));
        let ent = parsed.entitlements.expect("entitlements");
        assert!(ent.cloud_ai);
        assert!(ent.ai_plugins);
        assert!(ent.agents);
        assert_eq!(ent.capabilities.len(), 2);
    }

    #[test]
    fn token_rotation_is_persisted_immediately() {
        let st = mock_state(
            "rot",
            json!({"ok": true, "data": {"status": "granted", "activationToken": "ROT-NEW-9", "plan": "Pro", "expiresAt": "2031-05-05T00:00:00Z"}}),
        );
        let snap = gate_verify(&st);
        assert_eq!(snap.decision, "granted");
        let back = storage::load(&st.store_dir, &machine::machine_id_in(&st.store_dir)).expect("load");
        assert_eq!(back.activation_token, "ROT-NEW-9");
        assert_eq!(back.expires_at, "2031-05-05T00:00:00Z");
        let _ = std::fs::remove_dir_all(&st.store_dir);
    }

    #[test]
    fn token_invalid_clears_once_then_activation() {
        let st = mock_state(
            "inv",
            json!({"ok": true, "data": {"status": "token_invalid", "message": "token revoked"}}),
        );
        let snap = gate_verify(&st);
        assert_eq!(snap.decision, "license_required");
        let back = storage::load(&st.store_dir, &machine::machine_id_in(&st.store_dir)).expect("load");
        assert!(back.activation_token.is_empty());
        let _ = std::fs::remove_dir_all(&st.store_dir);
    }

    #[test]
    fn verify_validation_400_is_inconclusive_not_denial() {
        let dir = std::env::temp_dir().join("drs-gate-400");
        let _ = std::fs::remove_dir_all(&dir);
        let mut st = LicenseState::new(dir.clone());
        let transport: crate::app::policy::client::Transport = Arc::new(move |_m, url, _body| {
            let body = if url.ends_with("/api/config") {
                json!({"ok": true, "data": {"licensing": {"requireLicense": true}}})
            } else if url.ends_with("/api/verify") {
                json!({"ok": false, "error": {"code": "VALIDATION_ERROR", "message": "Verification payload failed validation."}})
            } else {
                json!({"ok": true, "data": {}})
            };
            // verify validation error => HTTP 400
            let status = if url.ends_with("/api/verify") { 400 } else { 200 };
            Ok(crate::app::policy::client::RawResponse { status, retry_after_secs: None, body })
        });
        Arc::get_mut(&mut st).expect("fresh").client =
            crate::app::policy::client::Client::with_transport("https://mock.invalid", transport);
        let mid = machine::machine_id_in(&dir);
        storage::save(&dir, &Stored {
            device_id: "dev".into(),
            machine_id: mid,
            activation_token: "GOOD-TOKEN-20-CHARS-OK".into(),
            expires_at: "2030-01-01T00:00:00Z".into(),
            last_granted_ms: now_ms(),
            ..Stored::default()
        }).expect("seed");
        let snap = verify_once(&st);
        assert_eq!(snap.decision, "granted"); // cached entitlement kept
        assert!(snap.error.as_deref().unwrap_or("").contains("inconclusive"));
        let back = storage::load(&dir, &machine::machine_id_in(&dir)).expect("load");
        assert_eq!(back.activation_token, "GOOD-TOKEN-20-CHARS-OK"); // not cleared
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bootstrap_records_resolved_endpoint() {
        let dir = std::env::temp_dir().join("drs-gate-ep");
        let _ = std::fs::remove_dir_all(&dir);
        let mut st = LicenseState::new(dir.clone());
        let transport: crate::app::policy::client::Transport = Arc::new(move |_m, url, _body| {
            let body = if url.ends_with("/api/config") {
                json!({"ok": true, "data": {"licensing": {"requireLicense": false}}})
            } else {
                json!({"ok": true, "data": {}})
            };
            Ok(crate::app::policy::client::RawResponse { status: 200, retry_after_secs: None, body })
        });
        Arc::get_mut(&mut st).expect("fresh").client =
            crate::app::policy::client::Client::with_transport("https://mock.invalid", transport);
        let snap = bootstrap(&st);
        let ep = snap.endpoint.expect("endpoint recorded");
        // bootstrap URL unreachable in tests -> stable fallback
        assert_eq!(ep.source, crate::cloud::models::EndpointSource::Stable);
        assert!(ep.url.starts_with("https://"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn verify_entitlements_reach_snapshot() {
        let dir = std::env::temp_dir().join("drs-gate-ent");
        let _ = std::fs::remove_dir_all(&dir);
        let mut st = LicenseState::new(dir.clone());
        let transport: crate::app::policy::client::Transport = Arc::new(move |_m, url, _body| {
            let body = if url.ends_with("/api/config") {
                json!({"ok": true, "data": {"licensing": {"requireLicense": true}}})
            } else if url.ends_with("/api/verify") {
                json!({"ok": true, "data": {"status": "granted", "expiresAt": "2030-01-01T00:00:00Z", "entitlements": {"cloudAi": true, "aiPlugins": true, "agents": false, "capabilities": ["data_cleaning"]}}})
            } else {
                json!({"ok": true, "data": {}})
            };
            Ok(crate::app::policy::client::RawResponse { status: 200, retry_after_secs: None, body })
        });
        Arc::get_mut(&mut st).expect("fresh").client =
            crate::app::policy::client::Client::with_transport("https://mock.invalid", transport);
        storage::save(&dir, &Stored {
            device_id: "dev".into(),
            machine_id: machine::machine_id_in(&dir),
            activation_token: "TOKEN-20-CHARS-LONG-OK".into(),
            expires_at: "2030-01-01T00:00:00Z".into(),
            last_granted_ms: now_ms(),
            ..Stored::default()
        }).expect("seed");
        let snap = verify_once(&st);
        assert!(snap.entitlements.cloud_ai);
        assert!(snap.entitlements.ai_plugins);
        assert!(!snap.entitlements.agents);
        assert_eq!(snap.entitlements.capabilities, vec!["data_cleaning".to_string()]);
        // persisted for offline entitlement cache
        let back = storage::load(&dir, &machine::machine_id_in(&dir)).expect("load");
        assert!(back.entitlements.cloud_ai);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn config_refresh_picks_up_new_announcement() {
        let dir = std::env::temp_dir().join("drs-gate-refresh");
        let _ = std::fs::remove_dir_all(&dir);
        let mut st = LicenseState::new(dir.clone());
        let flip = Arc::new(AtomicBool::new(false));
        let flip2 = Arc::clone(&flip);
        let transport: crate::app::policy::client::Transport = Arc::new(move |_m, url, _body| {
            let ann = if flip2.load(SeqCst) {
                json!([{"id": "ann-1", "enabled": true, "type": "warning", "title": "Maintenance", "message": "soon", "audience": "all", "startDate": null, "endDate": null, "dismissible": true, "priority": 0, "updatedAt": "2026-09-17T00:00:00Z"}])
            } else {
                json!([])
            };
            let body = if url.ends_with("/api/config") {
                json!({"ok": true, "data": {"licensing": {"requireLicense": false}, "announcements": ann}})
            } else {
                json!({"ok": true, "data": {}})
            };
            Ok(crate::app::policy::client::RawResponse { status: 200, retry_after_secs: None, body })
        });
        Arc::get_mut(&mut st).expect("fresh").client =
            crate::app::policy::client::Client::with_transport("https://mock.invalid", transport);
        let snap = bootstrap(&st);
        assert_eq!(snap.announcements.len(), 0);
        // within throttle: nothing changes
        flip.store(true, SeqCst);
        refresh_if_stale(&st);
        assert_eq!(st.snapshot().announcements.len(), 0);
        // after throttle window: picked up without restart
        *st.cfg_ms.lock().unwrap_or_else(|e| e.into_inner()) = now_ms() - 61_000;
        refresh_if_stale(&st);
        let snap = st.snapshot();
        assert_eq!(snap.announcements.len(), 1);
        assert_eq!(snap.announcements[0].id, "ann-1");
        assert_eq!(snap.announcements[0].updated_at.as_deref(), Some("2026-09-17T00:00:00Z"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn activation_escrows_key_and_verify_sends_it() {
        let dir = std::env::temp_dir().join("drs-gate-escrow");
        let _ = std::fs::remove_dir_all(&dir);
        let mut st = LicenseState::new(dir.clone());
        let calls: Arc<std::sync::Mutex<Vec<(String, Option<serde_json::Value>)>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
        let calls2 = Arc::clone(&calls);
        let transport: crate::app::policy::client::Transport = Arc::new(move |_m, url, body| {
            calls2.lock().unwrap().push((url.to_string(), body.cloned()));
            let body = if url.ends_with("/api/config") {
                json!({"ok": true, "data": {"licensing": {"requireLicense": true, "verifyIntervalHours": 24, "offlineGraceDays": 30}}})
            } else if url.ends_with("/api/activate") {
                json!({"ok": true, "data": {"activationToken": "NEWTOKEN-20-CHARS-LONG", "expiresAt": "2030-01-01T00:00:00Z", "verifyIntervalHours": 12, "offlineGraceDays": 20}})
            } else if url.ends_with("/api/verify") {
                json!({"ok": true, "data": {"status": "granted", "expiresAt": "2030-01-01T00:00:00Z"}})
            } else {
                json!({"ok": true, "data": {}})
            };
            Ok(crate::app::policy::client::RawResponse { status: 200, retry_after_secs: None, body })
        });
        Arc::get_mut(&mut st).expect("fresh").client =
            crate::app::policy::client::Client::with_transport("https://mock.invalid", transport);

        let _ = bootstrap(&st); // real flow always bootstraps (install+config) first
        let snap = activate(&st, "drs-ab23-cd67-ef89").expect("activate ok");
        assert_eq!(snap.decision, "granted");
        let cfg = snap.config.expect("config");
        assert_eq!(cfg.licensing.verify_interval_hours, 12);
        assert_eq!(cfg.licensing.offline_grace_days, 20);

        let mid = machine::machine_id_in(&dir);
        let saved = storage::load(&dir, &mid).expect("load");
        assert_eq!(saved.key_escrow, "DRS-AB23-CD67-EF89");
        let raw = std::fs::read(dir.join(crate::app::policy::storage::STORE_NAME)).expect("blob bytes");
        for needle in [b"DRS-AB23-CD67-EF89".to_vec(), b"DRSAB23CD67EF89".to_vec()] {
            assert!(!raw.windows(needle.len()).any(|w| w == needle.as_slice()), "plaintext key on disk!");
        }

        let vsnap = verify_once(&st);
        assert_eq!(vsnap.decision, "granted");
        assert!(vsnap.error.is_none());
        let calls = calls.lock().unwrap();
        let v = calls.iter().find(|(u, _)| u.ends_with("/api/verify"))
            .and_then(|(_, b)| b.clone()).expect("verify call happened");
        assert_eq!(v["licenseKey"], "DRS-AB23-CD67-EF89");
        assert_eq!(v["activationToken"], "NEWTOKEN-20-CHARS-LONG");
        drop(calls);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn blocked_license_locks_immediately() {
        let st = mock_state("blk", json!({"ok": true, "data": {"status": "blocked"}}));
        let snap = gate_verify(&st);
        assert_eq!(snap.decision, "license_blocked");
        let _ = std::fs::remove_dir_all(&st.store_dir);
    }

    fn flex_state(dir_suffix: &str, require: Arc<AtomicBool>, verify_body: Value) -> Arc<LicenseState> {
        let dir = std::env::temp_dir().join(format!("drs-gate-{dir_suffix}"));
        let _ = std::fs::remove_dir_all(&dir);
        let mut st = LicenseState::new(dir.clone());
        let vb = verify_body.clone();
        let r = require.clone();
        let transport: Transport = Arc::new(move |_method, url, _body| {
            if url.ends_with("/api/config") {
                return Ok(RawResponse {
                    status: 200,
                    retry_after_secs: None,
                    body: json!({"ok": true, "data": {"licensing": {"requireLicense": r.load(SeqCst), "verifyIntervalHours": 24, "offlineGraceDays": 30}}}),
                });
            }
            if url.ends_with("/api/verify") && vb.get("status403").is_some() {
                return Ok(RawResponse {
                    status: 403,
                    retry_after_secs: None,
                    body: json!({"ok": false, "error": {"code": "LICENSING_DISABLED", "message": "licensing disabled"}}),
                });
            }
            Ok(RawResponse { status: 200, retry_after_secs: None, body: vb.clone() })
        });
        Arc::get_mut(&mut st).expect("fresh state").client =
            Client::with_transport("https://mock.invalid", transport);
        let mid = machine::machine_id_in(&dir);
        let stored = Stored {
            device_id: "dev".into(),
            machine_id: mid,
            activation_token: "OLD-TOKEN".into(),
            masked_license: "OLDT-…-OKEN".into(),
            plan: "Pro".into(),
            expires_at: "2030-01-01T00:00:00Z".into(),
            last_granted_ms: now_ms(),
            ..Stored::default()
        };
        storage::save(&dir, &stored).expect("seed store");
        st
    }

    #[test]
    fn policy_flip_enforcement_and_purge() {
        let require = Arc::new(AtomicBool::new(true));
        let st = flex_state(
            "flip",
            require.clone(),
            json!({"ok": true, "data": {"status": "granted", "plan": "Pro", "expiresAt": "2031-01-01T00:00:00Z", "entitlements": {"cloudAi": true, "aiPlugins": true, "capabilities": ["clean"]}}}),
        );
        let snap = gate_verify(&st);
        assert_eq!(snap.decision, "granted");
        assert!(snap.require_license);
        assert!(snap.entitlements.cloud_ai);
        assert_eq!(snap.enforcement, crate::app::policy::model::EnforcementMode::Licensed);

        // flip OFF: unrestricted runtime, entitlements purged, cloud AI refused
        require.store(false, SeqCst);
        let snap2 = gate_verify(&st);
        assert_eq!(snap2.decision, "granted"); // local work never blocked
        assert!(!snap2.require_license);
        assert_eq!(snap2.enforcement, crate::app::policy::model::EnforcementMode::Unrestricted);
        assert!(!snap2.entitlements.cloud_ai);
        // (require_ai_entitlement lives in the tauri-cmds module; the purge
        // above is exactly the condition it enforces.)
        let back = storage::load(&st.store_dir, &machine::machine_id_in(&st.store_dir)).expect("load");
        assert!(!back.entitlements.cloud_ai, "stale entitlements purged from disk");

        // flip ON again: licensed mode + entitlements restored by verify
        require.store(true, SeqCst);
        let snap3 = gate_verify(&st);
        assert!(snap3.require_license);
        assert!(snap3.entitlements.cloud_ai);
        assert_eq!(snap3.enforcement, crate::app::policy::model::EnforcementMode::Licensed);
        let _ = std::fs::remove_dir_all(&st.store_dir);
    }

    #[test]
    fn licensing_disabled_403_forces_unrestricted() {
        let require = Arc::new(AtomicBool::new(true));
        let st = flex_state(
            "licdis",
            require.clone(),
            json!({"ok": true, "status403": true}),
        );
        let snap = gate_verify(&st);
        assert!(st.lic_disabled.load(SeqCst));
        assert_eq!(snap.enforcement, crate::app::policy::model::EnforcementMode::Unrestricted);
        assert!(!snap.entitlements.cloud_ai);
        // config polling continues: flipping policy back clears on next cycle
        require.store(false, SeqCst);
        let st2 = flex_state(
            "licdis2",
            require.clone(),
            json!({"ok": true, "data": {"status": "granted"}}),
        );
        let _ = gate_verify(&st2);
        require.store(true, SeqCst);
        let snap2 = gate_verify(&st2);
        assert!(!st2.lic_disabled.load(SeqCst));
        assert_eq!(snap2.enforcement, crate::app::policy::model::EnforcementMode::Licensed);
        let _ = std::fs::remove_dir_all(&st.store_dir);
        let _ = std::fs::remove_dir_all(&st2.store_dir);
    }

    #[test]
    fn next_check_in_at_is_recorded() {
        let st = mock_state(
            "nextcheck",
            json!({"ok": true, "data": {"status": "granted", "plan": "Pro", "expiresAt": "2031-01-01T00:00:00Z", "nextCheckInAt": "2030-06-01T00:00:00Z"}}),
        );
        let _ = gate_verify(&st);
        let nc = st.next_check_ms.lock().ok().and_then(|g| *g).expect("next check recorded");
        let expected = crate::app::policy::parse_iso_ms("2030-06-01T00:00:00Z").unwrap();
        assert_eq!(nc, expected);
        let _ = std::fs::remove_dir_all(&st.store_dir);
    }

    fn gate_verify(st: &Arc<LicenseState>) -> Snapshot {
        // bootstrap first so config/cache exist, then a verify cycle
        let _ = bootstrap(st);
        verify_once(st)
    }
}
