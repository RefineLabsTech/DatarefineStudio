//! Cloud AI jobs: submit / poll / cancel. Transport retries (5xx/429/timeout)
//! are handled by the centralized cloud client.

use super::models::{Job, JobStatus};
use crate::cloud::client::CloudClient;
use serde_json::{json, Value};
use std::sync::Arc;

fn parse_job(body: &Value) -> Option<Job> {
    let d = body.get("data")?;
    Some(Job {
        id: d.get("id").and_then(|v| v.as_str())?.to_string(),
        status: d
            .get("status")
            .and_then(|v| v.as_str())
            .map(JobStatus::parse)
            .unwrap_or(JobStatus::Queued),
        error: d.get("error").and_then(|v| v.as_str()).map(|s| s.to_string()),
    })
}

/// Stable idempotency key per logical job (§25/§28): generated once, reused
/// across retries so the cloud returns the existing job instead of a second
/// charge.
pub fn new_idem_key() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn submit(cloud: &Arc<CloudClient>, entitled: bool, request: &Value) -> Result<Job, String> {
    submit_with_key(cloud, entitled, request, &new_idem_key())
}

pub fn submit_with_key(
    cloud: &Arc<CloudClient>,
    entitled: bool,
    request: &Value,
    idempotency_key: &str,
) -> Result<Job, String> {
    if !entitled {
        return Err("Cloud AI is not part of this license.".into());
    }
    let mut body = request.clone();
    if let Some(obj) = body.as_object_mut() {
        obj.insert("idempotencyKey".to_string(), serde_json::Value::String(idempotency_key.to_string()));
    }
    let raw = cloud.post("/api/ai/jobs", &body).map_err(|e| crate::ai::errors::describe(&e))?;
    if raw.status >= 400 {
        return Err(crate::ai::errors::describe(&crate::cloud::client::ClientError {
            kind: crate::cloud::client::ErrorKind::Http(raw.status),
            message: raw.body.get("message").and_then(|v| v.as_str()).unwrap_or("submit failed").to_string(),
            retry_after_secs: None,
            code: crate::cloud::client::envelope_code(&raw.body),
        }));
    }
    parse_job(&raw.body).ok_or_else(|| "job response missing id".to_string())
}

pub fn get(cloud: &Arc<CloudClient>, id: &str) -> Result<Job, String> {
    let raw = cloud.get(&format!("/api/ai/jobs/{id}")).map_err(|e| crate::ai::errors::describe(&e))?;
    parse_job(&raw.body).ok_or_else(|| "job response missing id".to_string())
}

pub fn cancel(cloud: &Arc<CloudClient>, id: &str) -> Result<Job, String> {
    let raw = cloud.post(&format!("/api/ai/jobs/{id}/cancel"), &json!({})).map_err(|e| crate::ai::errors::describe(&e))?;
    parse_job(&raw.body).ok_or_else(|| "job response missing id".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn job_submit_retries_5xx_then_parses() {
        let hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let h2 = std::sync::Arc::clone(&hits);
        let t: crate::cloud::client::Transport = std::sync::Arc::new(move |_m, _u, _b| {
            let n = h2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if n < 2 {
                return Ok(crate::cloud::client::RawResponse { status: 503, retry_after_secs: None, body: serde_json::json!({}) });
            }
            Ok(crate::cloud::client::RawResponse { status: 200, retry_after_secs: None, body: serde_json::json!({"ok": true, "data": {"id": "job-9", "status": "queued"}}) })
        });
        let c = crate::cloud::client::CloudClient::with_transport("https://mock.invalid", t);
        let job = submit(&c, true, &serde_json::json!({"model": "x"})).unwrap();
        assert_eq!(job.id, "job-9");
        assert_eq!(job.status, crate::ai::models::JobStatus::Queued);
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 3);
    }

    #[test]
    fn job_status_parsing_and_gate() {
        assert_eq!(crate::ai::models::JobStatus::parse("cancelled"), crate::ai::models::JobStatus::Cancelled);
        assert_eq!(crate::ai::models::JobStatus::parse("expired"), crate::ai::models::JobStatus::Expired);
        let t: crate::cloud::client::Transport = std::sync::Arc::new(|_m, _u, _b| panic!("no network"));
        let c = crate::cloud::client::CloudClient::with_transport("https://mock.invalid", t);
        assert!(submit(&c, false, &serde_json::json!({})).is_err());
    }


    #[test]
    fn idempotency_key_is_stable_across_retries() {
        let bodies = Arc::new(std::sync::Mutex::new(Vec::new()));
        let b2 = bodies.clone();
        let cloud = CloudClient::with_transport(
            "https://cloud.example",
            Arc::new(move |_m: &str, _u: &str, body: Option<&Value>| {
                b2.lock().unwrap().push(body.cloned().unwrap_or(Value::Null));
                Ok(crate::cloud::client::RawResponse {
                    status: 200,
                    retry_after_secs: None,
                    body: json!({"ok": true, "data": {"id": "job-77", "status": "queued"}}),
                })
            }),
        );
        let req = json!({"operation": "clean", "rows": 100});
        let key = new_idem_key();
        let j1 = submit_with_key(&cloud, true, &req, &key).unwrap();
        let j2 = submit_with_key(&cloud, true, &req, &key).unwrap(); // retry reuses key
        assert_eq!(j1.id, "job-77");
        assert_eq!(j2.id, j1.id, "replayed submit returns the same job");
        let sent = bodies.lock().unwrap();
        assert_eq!(sent[0]["idempotencyKey"], json!(key));
        assert_eq!(sent[1]["idempotencyKey"], json!(key));
        assert_ne!(new_idem_key(), key, "keys are unique per logical job");
    }
}
