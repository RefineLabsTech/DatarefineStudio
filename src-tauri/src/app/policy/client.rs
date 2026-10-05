//! HTTPS client for the License Cloud — a thin envelope layer over the
//! centralized [`crate::cloud::client::CloudClient`] (single HTTP
//! implementation, single retry policy). The base URL lives ONLY in
//! cloud::config; secrets are masked in every error string. Tests inject a
//! mock transport — the live server is never contacted from unit tests.

use serde_json::{json, Value};
use std::sync::Arc;

#[allow(unused_imports)] // re-exports consumed by tests and the app crate
pub use crate::cloud::client::{
    backoff_ms, ClientError, CloudClient, ErrorKind, RawResponse, Transport, MAX_ATTEMPTS,
};
use crate::app::policy::model::Envelope;

/// Single source of truth for the cloud origin (re-exported for call sites).
pub use crate::cloud::config::STABLE_API_URL as CLOUD_BASE;

pub struct Client {
    pub cloud: Arc<CloudClient>,
}

impl Default for Client {
    fn default() -> Self {
        Self::new()
    }
}

impl Client {
    pub fn new() -> Self {
        Self { cloud: CloudClient::new(CLOUD_BASE) }
    }

    /// Test/override constructor — never used in production paths.
    #[cfg(test)]
    pub fn with_transport(base: &str, transport: Transport) -> Self {
        Self { cloud: CloudClient::with_transport(base, transport) }
    }

    /// Shared centralized client (AI credits/jobs reuse the same HTTP stack).
    pub fn cloud(&self) -> Arc<CloudClient> {
        self.cloud.clone()
    }

    /// Endpoint discovery re-points all cloud traffic.
    pub fn set_base(&self, url: &str) {
        self.cloud.set_base(url);
    }

    #[allow(dead_code)] // used by the retry-policy tests
    pub fn backoff_ms(attempt: usize) -> u64 {
        crate::cloud::client::backoff_ms(attempt)
    }

    /// One logical call: centralized request + envelope/error mapping.
    pub fn call(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Envelope, ClientError> {
        let raw = self.cloud.request(method, path, body)?;
        if raw.status >= 400 {
            let env = Envelope::parse(&raw.body);
            return Err(ClientError {
                kind: ErrorKind::Http(raw.status),
                message: env
                    .message
                    .clone()
                    .unwrap_or_else(|| format!("HTTP {}", raw.status)),
                retry_after_secs: raw.retry_after_secs,
                code: env.code.clone(),
            });
        }
        Ok(Envelope::parse(&raw.body))
    }

    pub fn get_config(&self) -> Result<Envelope, ClientError> {
        self.call("GET", "/api/config", None)
    }

    /// Cloud contract endpoint (GET /api/version); reserved — policy flow
    /// reads versions from /api/config, so this stays intentionally uncalled.
    #[allow(dead_code)]
    pub fn get_version(&self) -> Result<Envelope, ClientError> {
        self.call("GET", "/api/version", None)
    }

    pub fn post_install(&self, p: &crate::app::policy::model::InstallPayload) -> Result<Envelope, ClientError> {
        self.call("POST", "/api/install", Some(&json!(p)))
    }

    pub fn post_activate(&self, p: &crate::app::policy::model::ActivatePayload) -> Result<Envelope, ClientError> {
        self.call("POST", "/api/activate", Some(&json!(p)))
    }

    pub fn post_verify(&self, p: &crate::app::policy::model::VerifyPayload) -> Result<Envelope, ClientError> {
        self.call("POST", "/api/verify", Some(&json!(p)))
    }
}

pub fn mask_key(key: &str) -> String {
    let compact: String = key
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect::<String>()
        .to_uppercase();
    if compact.len() <= 8 {
        return "••••".to_string();
    }
    format!(
        "{}-…-{}",
        &compact[..4],
        &compact[compact.len() - 4..]
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    fn mock(responses: Vec<Result<RawResponse, ClientError>>) -> (Transport, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let log = Arc::new(Mutex::new(responses));
        let c = calls.clone();
        let t: Transport = Arc::new(move |_m, _u, _b| {
            let i = c.fetch_add(1, Ordering::SeqCst);
            let guard = log.lock().map_err(|_| ClientError {
                kind: ErrorKind::Parse,
                message: "mock lock".into(),
                retry_after_secs: None,
                code: None,
            })?;
            if i < guard.len() {
                guard[i].clone()
            } else if let Some(last) = guard.last() {
                last.clone()
            } else {
                Ok(RawResponse {
                    status: 200,
                    retry_after_secs: None,
                    body: json!({"ok": true, "data": {}}),
                })
            }
        });
        (t, calls)
    }

    #[test]
    fn envelope_parsing_variants() {
        let e = Envelope::parse(&json!({"ok": true, "data": {"a": 1}}));
        assert!(e.ok && e.data["a"] == 1);
        let e = Envelope::parse(&json!({"success": false, "message": "nope"}));
        assert!(!e.ok && e.message.as_deref() == Some("nope"));
        let e = Envelope::parse(&json!({"requireLicense": true}));
        assert!(e.ok && e.data["requireLicense"] == true); // bare payload = data
        let e = Envelope::parse(&json!({"ok": false, "detail": "bad key"}));
        assert!(!e.ok && e.message.as_deref() == Some("bad key"));
    }

    #[test]
    fn retry_schedule_backoff() {
        assert_eq!(Client::backoff_ms(0), 500);
        assert_eq!(Client::backoff_ms(1), 1000);
        assert_eq!(Client::backoff_ms(2), 2000);
        assert_eq!(Client::backoff_ms(9), 4000); // capped
    }

    #[test]
    fn retries_on_5xx_then_succeeds() {
        let (t, calls) = mock(vec![
            Ok(RawResponse {
                status: 503,
                retry_after_secs: Some(0),
                body: json!({"ok": false, "message": "unavailable"}),
            }),
            Ok(RawResponse {
                status: 429,
                retry_after_secs: Some(0),
                body: json!({"ok": false}),
            }),
            Ok(RawResponse {
                status: 200,
                retry_after_secs: None,
                body: json!({"ok": true, "data": {"requireLicense": false}}),
            }),
        ]);
        let c = Client::with_transport("https://x.invalid", t);
        let env = c.get_config().expect("ok after retries");
        assert!(env.ok);
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn gives_up_after_max_attempts_offline() {
        let (t, calls) = mock(vec![Err(ClientError {
            kind: ErrorKind::Offline,
            message: "offline".into(),
            retry_after_secs: None,
            code: None,
        })]);
        let c = Client::with_transport("https://x.invalid", t);
        let err = c.get_config().unwrap_err();
        assert_eq!(err.kind, ErrorKind::Offline);
        assert_eq!(calls.load(Ordering::SeqCst), MAX_ATTEMPTS);
    }

    #[test]
    fn no_retry_on_4xx() {
        let (t, calls) = mock(vec![Ok(RawResponse {
            status: 400,
            retry_after_secs: None,
            body: json!({"ok": false, "message": "invalid key"}),
        })]);
        let c = Client::with_transport("https://x.invalid", t);
        let err = c.post_activate(&crate::app::policy::model::ActivatePayload {
            license_key: "A".into(),
            device_id: "d".into(),
            machine_id: "m".into(),
            platform: "p".into(),
            app_version: "1".into(),
        })
        .unwrap_err();
        assert_eq!(err.kind, ErrorKind::Http(400));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn nested_validation_error_is_surfaced() {
        let env = crate::app::policy::model::Envelope::parse(&json!({
            "ok": false,
            "error": {
                "code": "VALIDATION_ERROR",
                "message": "Activation payload failed validation.",
                "details": { "platform": "Invalid enum value. Expected 'win32' | 'linux' | 'darwin'" }
            }
        }));
        assert!(!env.ok);
        let m = env.message.unwrap_or_default();
        assert!(m.contains("Activation payload failed validation."), "{}", m);
        assert!(m.contains("platform:"), "{}", m);
    }

    #[test]
    fn key_masking() {
        assert_eq!(mask_key("abcd-1234-efgh-5678"), "ABCD-…-5678");
        assert_eq!(mask_key("short"), "••••");
    }
}
