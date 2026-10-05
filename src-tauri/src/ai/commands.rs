//! Tauri commands for the central AI runtime. Everything is gated:
//! license OK first, then server-provided entitlements for cloud paths.

use super::{
    credits, jobs,
    models::{AiSettings, AiSource, Credits, Job, RouterDecision},
    router, usage,
};
use crate::app::policy::commands::{require_ai_entitlement, require_entitlement};
use crate::app::policy::LicenseState;
use serde_json::Value;
use std::sync::Arc;

#[tauri::command]
pub fn ai_router(state: tauri::State<'_, Arc<LicenseState>>, settings: AiSettings) -> RouterDecision {
    let ent = state.inner().snapshot().entitlements;
    router::select_source(&ent, &settings)
}

#[tauri::command]
pub fn ai_credits(
    state: tauri::State<'_, Arc<LicenseState>>,
    source: Option<String>,
    byok_configured: Option<bool>,
) -> Result<Credits, String> {
    let selected = source.as_deref().unwrap_or("");
    if selected != "cloud" || byok_configured.unwrap_or(false) {
        return Err("AI credits are available only for active Cloud AI.".into());
    }
    require_ai_entitlement(state.inner(), true)?;
    let (license_key, machine_id) = crate::app::policy::gate::current_license_identity(state.inner())
        .ok_or_else(|| "License wallet identity is unavailable. Reactivate the license to refresh Cloud AI Credits.".to_string())?;
    credits::fetch_credits_with_identity(
        &state.inner().client.cloud(),
        true,
        Some(&license_key),
        Some(&machine_id),
    )
}

fn usage_source(source: &str) -> Result<AiSource, String> {
    AiSource::parse(source).ok_or_else(|| "Unknown AI provider source.".into())
}

fn check_usage_gate(
    state: &Arc<LicenseState>,
    source: AiSource,
) -> Result<Option<String>, String> {
    let snap = state.snapshot();
    // Unrestricted mode deliberately has no quota, license, or credit network
    // dependency. This is the normal path when /api/config says so.
    if !snap.require_license || snap.enforcement == crate::app::policy::model::EnforcementMode::Unrestricted {
        return Ok(None);
    }
    if source == AiSource::Cloud {
        require_ai_entitlement(state, true)?;
        return crate::app::policy::gate::current_activation_token(state)
            .ok_or_else(|| "The active license token is unavailable.".to_string())
            .map(Some);
    }
    // Local Ollama and BYOK are non-premium providers. They remain available
    // after Continue with Basic and do not need a cloud usage token; only the
    // cloud provider is part of the Professional entitlement flow.
    if snap.decision == "basic" {
        return Ok(None);
    }
    require_entitlement(state)?;
    crate::app::policy::gate::current_activation_token(state)
        .ok_or_else(|| "The active license token is unavailable.".to_string())
        .map(Some)
}

#[tauri::command]
pub fn ai_usage_check(
    state: tauri::State<'_, Arc<LicenseState>>,
    source: String,
    operation_id: String,
) -> Result<usage::AiUsage, String> {
    let selected = usage_source(&source)?;
    let token = match check_usage_gate(state.inner(), selected)? {
        Some(token) => token,
        None => return Ok(usage::AiUsage::unrestricted()),
    };
    let snap = state.inner().snapshot();
    let plan = snap.license.as_ref().map(|l| l.plan.as_str()).unwrap_or("");
    usage::check(
        &state.inner().client.cloud(),
        &token,
        selected,
        &operation_id,
        plan,
    )
}

#[tauri::command]
pub fn ai_usage_record(
    state: tauri::State<'_, Arc<LicenseState>>,
    source: String,
    operation_id: String,
) -> Result<usage::AiUsage, String> {
    let selected = usage_source(&source)?;
    let token = match check_usage_gate(state.inner(), selected)? {
        Some(token) => token,
        None => return Ok(usage::AiUsage::unrestricted()),
    };
    let snap = state.inner().snapshot();
    let plan = snap.license.as_ref().map(|l| l.plan.as_str()).unwrap_or("");
    usage::record(
        &state.inner().client.cloud(),
        &token,
        selected,
        &operation_id,
        plan,
    )
}

fn query_encode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Open the purchase page from the latest signed cloud configuration. The
/// license identifier is masked; the raw license key never enters React,
/// logs, or a browser URL.
#[tauri::command]
pub fn ai_credit_purchase(
    state: tauri::State<'_, Arc<LicenseState>>,
    source: Option<String>,
    byok_configured: Option<bool>,
) -> Result<(), String> {
    let selected = source.as_deref().unwrap_or("");
    if selected != "cloud" || byok_configured.unwrap_or(false) {
        return Err("AI credit purchases are available only for active Cloud AI.".into());
    }
    require_ai_entitlement(state.inner(), true)?;
    let snap = state.inner().snapshot();
    let config = snap.config.as_ref().ok_or_else(|| "AI credit purchase is unavailable.".to_string())?;
    if !config.ai_credit_purchase_enabled() {
        return Err("AI credit purchases are disabled by cloud configuration.".into());
    }
    let base = config
        .ai_credit_purchase_url()
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .ok_or_else(|| "AI credit purchase URL is not configured.".to_string())?;
    if !base.starts_with("https://") {
        return Err("AI credit purchase URL must be HTTPS.".into());
    }
    let license = snap
        .license
        .as_ref()
        .map(|v| v.masked.trim())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "An active license is required to purchase AI credits.".to_string())?;
    let separator = if base.contains('?') {
        if base.ends_with('?') || base.ends_with('&') { "" } else { "&" }
    } else {
        "?"
    };
    let url = format!("{base}{separator}license={}", query_encode(license));
    crate::app::policy::commands::license_open_url(url)
}

#[tauri::command]
pub fn ai_jobs_submit(
    state: tauri::State<'_, Arc<LicenseState>>,
    request: Value,
    idempotency_key: Option<String>,
) -> Result<Job, String> {
    require_ai_entitlement(state.inner(), true)?;
    match idempotency_key {
        Some(k) if !k.is_empty() => jobs::submit_with_key(&state.inner().client.cloud(), true, &request, &k),
        _ => jobs::submit(&state.inner().client.cloud(), true, &request),
    }
}

/// §24: pre-operation cost estimate — display only, consumes nothing.
#[tauri::command]
pub fn ai_estimate(
    state: tauri::State<'_, Arc<LicenseState>>,
    request: Value,
) -> Result<Value, String> {
    require_ai_entitlement(state.inner(), true)?;
    credits::estimate(&state.inner().client.cloud(), true, &request)
}

#[tauri::command]
pub fn ai_jobs_get(state: tauri::State<'_, Arc<LicenseState>>, id: String) -> Result<Job, String> {
    require_ai_entitlement(state.inner(), true)?;
    jobs::get(&state.inner().client.cloud(), &id)
}

#[tauri::command]
pub fn ai_jobs_cancel(state: tauri::State<'_, Arc<LicenseState>>, id: String) -> Result<Job, String> {
    require_ai_entitlement(state.inner(), true)?;
    jobs::cancel(&state.inner().client.cloud(), &id)
}

#[tauri::command]
pub fn ai_byok_save(provider: String, key: String) -> Result<(), String> {
    super::byok::set_key(&provider, &key)
}

#[tauri::command]
pub fn ai_byok_delete(provider: String) -> Result<(), String> {
    super::byok::delete_key(&provider)
}

#[tauri::command]
pub fn ai_byok_status(provider: String) -> bool {
    super::byok::has_key(&provider)
}

/// Local Ollama probe (127.0.0.1 only — never a cloud call).
#[tauri::command]
pub fn ai_local_status() -> bool {
    crate::cloud::client::fetch_json_once("http://127.0.0.1:11434/api/tags", 1200).is_ok()
}

/// Which endpoint discovery chose (bootstrap / cached / stable).
#[tauri::command]
pub fn ai_endpoint(state: tauri::State<'_, Arc<LicenseState>>) -> Option<crate::cloud::models::ResolvedEndpoint> {
    state.inner().endpoint.lock().ok().and_then(|g| g.clone())
}

/// Local/BYOK AI runs through this proxy: Rust injects the provider key from
/// the OS credential manager into the sidecar request body. The key never
/// enters React state, settings files or logs (§45: never expose provider
/// keys; all AI via the central runtime).
#[tauri::command]
pub fn ai_run(
    sidecar: tauri::State<'_, crate::Sidecar>,
    sid: String,
    step: String,
    settings: Value,
    extra: Value,
) -> Result<Value, String> {
    let port = sidecar.port.lock().map(|g| *g).unwrap_or(17831);
    let mut s = settings.clone();
    if let Some(obj) = s.as_object_mut() {
        let provider = obj
            .get("provider")
            .and_then(|v| v.as_str())
            .unwrap_or("ollama")
            .to_string();
        if provider != "ollama" {
            match super::byok::get_key(&provider) {
                Ok(key) => {
                    obj.insert("api_key".to_string(), Value::String(key));
                }
                Err(_) => {
                    return Err(format!(
                        "No stored key for provider '{provider}'. Save one in Settings → AI."
                    ));
                }
            }
        }
    }
    let mut body = match extra.clone() {
        Value::Object(o) => Value::Object(o),
        _ => serde_json::json!({}),
    };
    if let Some(obj) = body.as_object_mut() {
        obj.insert("step".to_string(), Value::String(step));
        obj.insert("settings".to_string(), s);
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .connect_timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .post(format!("http://127.0.0.1:{port}/session/{sid}/ai"))
        .json(&body)
        .send()
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().unwrap_or_default();
    let parsed: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if !status.is_success() {
        let msg = parsed
            .get("error")
            .and_then(|v| v.as_str())
            .or_else(|| parsed.get("detail").and_then(|v| v.as_str()))
            .unwrap_or("AI engine error")
            .to_string();
        return Err(msg);
    }
    Ok(parsed)
}
