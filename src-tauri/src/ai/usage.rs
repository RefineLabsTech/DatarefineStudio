//! Server-authoritative monthly AI cleaning usage.
//!
//! The desktop never derives the active month, increments a local counter, or
//! authorizes a licensed cleaning from a wallet balance. The License Cloud
//! owns the calendar-month boundary, plan, limit, and used count.

use crate::ai::models::AiSource;
use crate::cloud::client::CloudClient;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUsage {
    pub plan: String,
    /// Server-selected calendar month, for example `2026-09`.
    pub month: String,
    pub used: u32,
    /// `null` means unlimited (Professional plans).
    pub limit: Option<u32>,
    pub unlimited: bool,
    pub allowed: bool,
    pub message: Option<String>,
    pub upgrade_url: Option<String>,
}

impl AiUsage {
    pub fn unrestricted() -> Self {
        Self {
            plan: String::new(),
            month: String::new(),
            used: 0,
            limit: None,
            unlimited: true,
            allowed: true,
            message: None,
            upgrade_url: None,
        }
    }
}

fn number_u32(v: Option<&Value>) -> u32 {
    v.and_then(|n| n.as_u64().or_else(|| n.as_f64().map(|f| f.max(0.0) as u64)))
        .unwrap_or(0)
        .min(u32::MAX as u64) as u32
}

fn string_field(data: &Value, names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| data.get(name).and_then(|v| v.as_str()).map(str::to_string))
}

fn parse(body: &Value, fallback_plan: &str) -> Option<AiUsage> {
    let data = body.get("data").unwrap_or(body);
    let has_usage_shape = ["used", "count", "month", "calendarMonth", "currentMonth", "limit", "monthlyLimit", "unlimited", "allowed"]
        .iter()
        .any(|key| data.get(key).is_some());
    if !has_usage_shape {
        return None;
    }
    let limit = data
        .get("limit")
        .or_else(|| data.get("monthlyLimit"))
        .and_then(|v| if v.is_null() { None } else { Some(number_u32(Some(v))) });
    let unlimited = data
        .get("unlimited")
        .and_then(|v| v.as_bool())
        .unwrap_or(limit.is_none());
    let allowed = data
        .get("allowed")
        .and_then(|v| v.as_bool())
        .unwrap_or(unlimited || limit.map(|n| number_u32(data.get("used").or_else(|| data.get("count"))) < n).unwrap_or(false));
    Some(AiUsage {
        plan: string_field(data, &["plan", "planName"]).unwrap_or_else(|| fallback_plan.to_string()),
        month: string_field(data, &["month", "calendarMonth", "currentMonth"]).unwrap_or_default(),
        used: number_u32(data.get("used").or_else(|| data.get("count"))),
        limit,
        unlimited,
        allowed,
        message: string_field(data, &["message", "reason"]),
        upgrade_url: string_field(data, &["upgradeUrl", "upgradeURL"]),
    })
}

fn server_error(raw: &crate::cloud::client::RawResponse, fallback: &str) -> String {
    raw.body
        .pointer("/error/message")
        .and_then(|v| v.as_str())
        .or_else(|| raw.body.get("message").and_then(|v| v.as_str()))
        .unwrap_or(fallback)
        .to_string()
}

fn call(
    cloud: &Arc<CloudClient>,
    path: &str,
    activation_token: &str,
    source: AiSource,
    operation_id: &str,
    fallback_plan: &str,
) -> Result<AiUsage, String> {
    if activation_token.trim().is_empty() {
        return Err("The active license token is unavailable.".into());
    }
    let raw = cloud
        .post(
            path,
            &json!({
                "activationToken": activation_token,
                "source": source.as_str(),
                "kind": "file_cleaning",
                "operationId": operation_id,
            }),
        )
        .map_err(|e| crate::ai::errors::describe(&e))?;
    if raw.status >= 400 {
        // Some cloud deployments return the quota code without the usage
        // object. Preserve the stable Community message and fail closed.
        if matches!(
            crate::cloud::client::envelope_code(&raw.body).as_deref(),
            Some("AI_MONTHLY_LIMIT_REACHED") | Some("MONTHLY_AI_LIMIT_REACHED")
        ) {
            return Ok(AiUsage {
                plan: fallback_plan.to_string(),
                month: String::new(),
                used: 15,
                limit: Some(15),
                unlimited: false,
                allowed: false,
                message: Some("Your Community plan includes 15 AI file cleanings per month. Your monthly limit has been reached.".into()),
                upgrade_url: None,
            });
        }
        // A quota response may legitimately use 409/429 while still carrying
        // the authoritative usage object. Preserve it for the UI.
        if let Some(usage) = parse(&raw.body, fallback_plan) {
            if usage.allowed == false && (usage.limit.is_some() || !usage.message.as_deref().unwrap_or("").is_empty()) {
                return Ok(usage);
            }
        }
        return Err(server_error(&raw, "AI usage service unavailable."));
    }
    parse(&raw.body, fallback_plan).ok_or_else(|| "AI usage response was invalid.".into())
}

pub fn check(
    cloud: &Arc<CloudClient>,
    activation_token: &str,
    source: AiSource,
    operation_id: &str,
    fallback_plan: &str,
) -> Result<AiUsage, String> {
    call(cloud, "/api/ai/usage/check", activation_token, source, operation_id, fallback_plan)
}

pub fn record(
    cloud: &Arc<CloudClient>,
    activation_token: &str,
    source: AiSource,
    operation_id: &str,
    fallback_plan: &str,
) -> Result<AiUsage, String> {
    call(cloud, "/api/ai/usage/record", activation_token, source, operation_id, fallback_plan)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_month_and_community_limit_without_a_local_clock() {
        let usage = parse(
            &json!({
                "data": {
                    "plan": "Community",
                    "month": "2026-09",
                    "used": 15,
                    "limit": 15,
                    "unlimited": false,
                    "allowed": false,
                    "upgradeUrl": "https://cloud.example/upgrade"
                }
            }),
            "fallback",
        )
        .unwrap();
        assert_eq!(usage.month, "2026-09");
        assert_eq!(usage.used, 15);
        assert_eq!(usage.limit, Some(15));
        assert!(!usage.allowed);
        assert_eq!(usage.upgrade_url.as_deref(), Some("https://cloud.example/upgrade"));
    }

    #[test]
    fn professional_null_limit_is_unlimited() {
        let usage = parse(
            &json!({"data": {"plan": "Professional Monthly", "month": "2026-10", "used": 200, "limit": null}}),
            "fallback",
        )
        .unwrap();
        assert!(usage.unlimited);
        assert!(usage.allowed);
        assert_eq!(usage.limit, None);
    }
}
