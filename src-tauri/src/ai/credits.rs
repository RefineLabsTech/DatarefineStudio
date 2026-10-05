//! Credit flow: Estimate → Entitlement → Reserve → Generate → Settle (refund
//! unused). The desktop never mutates balances locally; the cloud is authoritative.

use super::models::Credits;
use crate::cloud::client::CloudClient;
use serde_json::{json, Value};
use std::sync::Arc;

const NOT_ENTITLED: &str = "Cloud AI is not part of this license.";

/// §24: estimate is display-only — it never consumes or reserves credits.
pub fn estimate(cloud: &Arc<CloudClient>, entitled: bool, request: &Value) -> Result<Value, String> {
    if !entitled {
        return Err(NOT_ENTITLED.into());
    }
    let raw = cloud.post("/api/ai/estimate", request).map_err(|e| crate::ai::errors::describe(&e))?;
    if raw.status >= 400 {
        return Err(crate::ai::errors::describe(&crate::cloud::client::ClientError {
            kind: crate::cloud::client::ErrorKind::Http(raw.status),
            message: raw.body.get("message").and_then(|v| v.as_str()).unwrap_or("estimate failed").to_string(),
            retry_after_secs: None,
            code: crate::cloud::client::envelope_code(&raw.body),
        }));
    }
    Ok(raw.body.get("data").cloned().unwrap_or_default())
}

/// Authenticated wallet read used by the Tauri command. Production accepts the
/// license key and machine ID in `X-DRS-License-Key` and `X-DRS-Machine-Id`
/// headers. Both values stay in Rust.
pub fn fetch_credits_with_identity(
    cloud: &Arc<CloudClient>,
    entitled: bool,
    license_key: Option<&str>,
    machine_id: Option<&str>,
) -> Result<Credits, String> {
    if !entitled {
        return Err(NOT_ENTITLED.into()); // Disabled wallet paths never call the endpoint
    }
    let raw = match (license_key, machine_id) {
        (Some(key), Some(machine)) if !key.trim().is_empty() && !machine.trim().is_empty() => cloud
            .get_with_headers(
                "/api/ai/wallet",
                &[("X-DRS-License-Key", key), ("X-DRS-Machine-Id", machine)],
            )
            .map_err(|e| crate::ai::errors::describe(&e))?,
        _ => cloud.get("/api/ai/wallet").map_err(|e| crate::ai::errors::describe(&e))?,
    };
    if raw.status >= 400 {
        return Err(crate::ai::errors::describe(&crate::cloud::client::ClientError {
            kind: crate::cloud::client::ErrorKind::Http(raw.status),
            message: raw.body.get("message").and_then(|v| v.as_str()).unwrap_or("credit status unavailable").to_string(),
            retry_after_secs: None,
            code: crate::cloud::client::envelope_code(&raw.body),
        }));
    }
    let data = raw.body.get("data").unwrap_or(&raw.body);
    let wallet = data.get("wallet").unwrap_or(data);
    let balance = wallet
        .get("balance")
        .or_else(|| wallet.get("credits"))
        .and_then(|v| v.as_f64())
        .ok_or_else(|| "credit status response was invalid".to_string())?;
    let reserved = wallet.get("reserved").and_then(|v| v.as_f64()).unwrap_or(0.0);
    Ok(Credits { balance, reserved })
}

#[allow(dead_code)] // credit ledger flow — activates with the cloud wallet routes
pub fn reserve(cloud: &Arc<CloudClient>, entitled: bool, estimate_credits: f64) -> Result<String, String> {
    if !entitled {
        return Err(NOT_ENTITLED.into());
    }
    let raw = cloud.post("/api/ai/credits/reserve", &json!({ "amount": estimate_credits })).map_err(|e| crate::ai::errors::describe(&e))?;
    raw.body
        .pointer("/data/reservationId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "reserve response missing reservationId".to_string())
}

/// Settle actual usage; the cloud refunds (reserved - used) automatically.
#[allow(dead_code)] // credit ledger flow — activates with the cloud wallet routes
pub fn settle(cloud: &Arc<CloudClient>, entitled: bool, reservation_id: &str, used: f64) -> Result<(), String> {
    if !entitled {
        return Err(NOT_ENTITLED.into());
    }
    let raw = cloud.post(
        "/api/ai/credits/settle",
        &json!({ "reservationId": reservation_id, "used": used }),
    ).map_err(|e| crate::ai::errors::describe(&e))?;
    if raw.status >= 400 {
        return Err(format!("settle failed: HTTP {}", raw.status));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standard_license_never_calls_credits_endpoint() {
        let t: crate::cloud::client::Transport = std::sync::Arc::new(|_m, u, _b| {
            panic!("network must not be touched: {u}");
        });
        let c = crate::cloud::client::CloudClient::with_transport("https://mock.invalid", t);
        let err = fetch_credits_with_identity(&c, false, None, None).unwrap_err();
        assert!(err.contains("not part of this license"));
        let err = reserve(&c, false, 1.0).unwrap_err();
        assert!(err.contains("not part of this license"));
    }

    #[test]
    fn entitled_credits_parse_balance() {
        let t: crate::cloud::client::Transport = std::sync::Arc::new(|_m, u, _b| {
            let body = if u.ends_with("/api/ai/wallet") {
                serde_json::json!({"ok": true, "data": {"balance": 42.5, "reserved": 1.5}})
            } else if u.ends_with("/reserve") {
                serde_json::json!({"ok": true, "data": {"reservationId": "res-1"}})
            } else {
                serde_json::json!({"ok": true, "data": {}})
            };
            Ok(crate::cloud::client::RawResponse { status: 200, retry_after_secs: None, body })
        });
        let c = crate::cloud::client::CloudClient::with_transport("https://mock.invalid", t);
        let cr = fetch_credits_with_identity(&c, true, None, None).unwrap();
        assert_eq!(cr.balance, 42.5);
        assert_eq!(reserve(&c, true, 2.0).unwrap(), "res-1");
        assert!(settle(&c, true, "res-1", 1.25).is_ok());
    }


    #[test]
    fn estimate_is_display_only_and_gated() {
        let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
        let c2 = calls.clone();
        let cloud = CloudClient::with_transport(
            "https://cloud.example",
            Arc::new(move |_m: &str, u: &str, _b: Option<&Value>| {
                c2.lock().unwrap().push(u.to_string());
                Ok(crate::cloud::client::RawResponse {
                    status: 200,
                    retry_after_secs: None,
                    body: json!({"ok": true, "data": {"credits": 14, "available": 486}}),
                })
            }),
        );
        // not entitled: refused pre-network
        assert!(estimate(&cloud, false, &json!({"operation": "clean"})).is_err());
        assert!(calls.lock().unwrap().is_empty());
        // entitled: hits /api/ai/estimate only — no reserve, no consume
        let out = estimate(&cloud, true, &json!({"operation": "clean"})).unwrap();
        assert_eq!(out["credits"], json!(14));
        let log = calls.lock().unwrap();
        assert_eq!(log.len(), 1);
        assert!(log[0].ends_with("/api/ai/estimate"));
    }
}
