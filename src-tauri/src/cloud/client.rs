//! The ONE cloud HTTP client. Every remote request (license, AI, credits,
//! jobs) goes through `CloudClient`.
//!
//! Retry policy: timeout / 429 / 5xx only — 500ms, 1s, 2s (cap 4s),
//! honoring `Retry-After` (cap 10s). Ordinary 4xx never retried.

use aes_gcm::aes::{
    cipher::{generic_array::GenericArray, BlockDecrypt, KeyInit},
    Aes128,
};
use serde_json::Value;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ErrorKind {
    Offline,
    Timeout,
    Http(u16),
    #[cfg(test)]
    Parse,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestLog {
    pub ts_ms: i64,
    pub request_id: String,
    pub endpoint: String,
    pub status: u16,
    pub error_code: Option<String>,
    pub latency_ms: u128,
}

#[derive(Debug, Clone)]
pub struct ClientError {
    pub kind: ErrorKind,
    pub message: String,
    pub retry_after_secs: Option<u64>,
    /// Cloud business error code (LICENSING_DISABLED, LICENSE_INVALID, …).
    pub code: Option<String>,
}

impl ClientError {
    pub fn retryable(&self) -> bool {
        matches!(
            self.kind,
            ErrorKind::Offline | ErrorKind::Timeout | ErrorKind::Http(429) | ErrorKind::Http(500..=599)
        )
    }
}

#[derive(Debug, Clone)]
pub struct RawResponse {
    pub status: u16,
    pub retry_after_secs: Option<u64>,
    pub body: Value,
}

/// `transport(method, url, body) -> response`. Default performs real HTTPS.
pub type Transport = Arc<
    dyn Fn(&str, &str, Option<&Value>) -> Result<RawResponse, ClientError> + Send + Sync + 'static,
>;

/// Header-aware transport used for Cloud contracts that authenticate through
/// request headers. The existing test transport remains body-compatible.
pub type HeaderTransport = Arc<
    dyn Fn(&str, &str, Option<&Value>, &[(&str, &str)]) -> Result<RawResponse, ClientError>
        + Send
        + Sync
        + 'static,
>;

pub const MAX_ATTEMPTS: usize = 3;
pub const MAX_RETRY_AFTER_MS: u64 = 10_000;

/// Exponential backoff schedule: 500ms, 1s, 2s, capped 4s.
pub fn backoff_ms(attempt: usize) -> u64 {
    (500u64 << attempt.min(3)).min(4000)
}

fn sleep_for(retry_after_secs: Option<u64>, attempt: usize) {
    let ms = retry_after_secs
        .map(|s| (s.saturating_mul(1000)).min(MAX_RETRY_AFTER_MS))
        .unwrap_or_else(|| backoff_ms(attempt));
    std::thread::sleep(Duration::from_millis(ms));
}

fn perform_request(
    method: &str,
    url: &str,
    body: Option<&Value>,
    headers: &[(&str, &str)],
) -> Result<RawResponse, ClientError> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .connect_timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| ClientError { kind: ErrorKind::Offline, message: e.to_string(), retry_after_secs: None, code: None })?;
    let mut req = match method {
        "POST" => client.post(url),
        _ => client.get(url),
    };
    let rid = CURRENT_RID.with(|r| r.borrow().clone());
    if !rid.is_empty() {
        req = req.header("x-request-id", rid);
    }
    for (name, value) in headers {
        req = req.header(*name, *value);
    }
    if let Some(b) = body {
        req = req.json(b);
    }
    let res = req.send().map_err(|e| ClientError {
        kind: if e.is_timeout() { ErrorKind::Timeout } else { ErrorKind::Offline },
        message: e.to_string(),
        retry_after_secs: None,
        code: None,
    })?;
    let status = res.status().as_u16();
    let retry_after_secs = res
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    let text = res.text().unwrap_or_default();
    let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    Ok(RawResponse { status, retry_after_secs, body })
}

fn default_transport() -> Transport {
    Arc::new(|method, url, body| perform_request(method, url, body, &[]))
}

fn default_header_transport() -> HeaderTransport {
    Arc::new(|method, url, body, headers| perform_request(method, url, body, headers))
}

fn hex_decode(value: &str) -> Option<Vec<u8>> {
    let value = value.trim();
    if value.is_empty() || value.len() % 2 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(value.len() / 2);
    let bytes = value.as_bytes();
    for pair in bytes.chunks_exact(2) {
        let hi = (pair[0] as char).to_digit(16)? as u8;
        let lo = (pair[1] as char).to_digit(16)? as u8;
        out.push((hi << 4) | lo);
    }
    Some(out)
}

fn challenge_hex(html: &str, marker: &str) -> Option<Vec<u8>> {
    let start = html.find(marker)? + marker.len();
    let rest = &html[start..];
    let quote_start = rest.find('"')? + 1;
    let quote_end = rest[quote_start..].find('"')? + quote_start;
    hex_decode(&rest[quote_start..quote_end])
}

/// The public uploader used by the marketplace can put a small JavaScript
/// AES challenge in front of a ZIP. A desktop HTTP client cannot execute that
/// page, so solve only this exact challenge format and then retry the same
/// publisher URL. This does not discover or construct a different artifact
/// URL; the cloud-provided URL remains authoritative.
fn uploader_cookie(html: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(html).ok()?;
    if !text.contains("slowAES.decrypt") || !text.contains("document.cookie=\"__test=") {
        return None;
    }
    let key = challenge_hex(text, "var a=toNumbers(")?;
    let iv = challenge_hex(text, "),b=toNumbers(")?;
    let ciphertext = challenge_hex(text, "),c=toNumbers(")?;
    if key.len() != 16 || iv.len() != 16 || ciphertext.len() != 16 {
        return None;
    }
    let cipher = Aes128::new_from_slice(&key).ok()?;
    let mut block = GenericArray::clone_from_slice(&ciphertext);
    // The uploader uses slowAES CBC mode (mode 2), not raw AES-ECB. The
    // single-block CBC decrypt is AES-decrypt(ciphertext) XOR IV.
    cipher.decrypt_block(&mut block);
    for (byte, iv_byte) in block.iter_mut().zip(iv.iter()) {
        *byte ^= *iv_byte;
    }
    Some(block.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn with_query(url: &str, key: &str, value: &str) -> String {
    format!("{url}{}{key}={value}", if url.contains('?') { "&" } else { "?" })
}

fn is_zip_bytes(bytes: &[u8]) -> bool {
    bytes.len() >= 4
        && bytes[0] == b'P'
        && bytes[1] == b'K'
        && matches!((bytes[2], bytes[3]), (3, 4) | (5, 6) | (7, 8))
}

/// Stream a binary artefact (installer/update) to disk. HTTPS-only, generous
/// timeout, no envelope parsing. The marketplace path also handles the
/// uploader's JavaScript challenge before verifying the downloaded bytes.
pub fn download_marketplace_file(url: &str, dest: &std::path::Path) -> Result<u64, String> {
    if !url.starts_with("https://") {
        return Err("download URL must be HTTPS".into());
    }
    const USER_AGENT: &str = "DataRefineStudio/3.4.2";
    let client = reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(900))
        .connect_timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get(url)
        .header("Accept", "application/zip, application/octet-stream, */*")
        .send()
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("download failed: HTTP {}", response.status()));
    }
    let first = response.bytes().map_err(|e| e.to_string())?;
    let bytes = if is_zip_bytes(&first) {
        first
    } else if let Some(cookie) = uploader_cookie(&first) {
        let challenged_url = with_query(url, "i", "1");
        let retry = client
            .get(challenged_url)
            .header("Accept", "application/zip, application/octet-stream, */*")
            .header("Cookie", format!("__test={cookie}"))
            .header("Referer", url)
            .send()
            .map_err(|e| e.to_string())?;
        if !retry.status().is_success() {
            return Err(format!("download failed after artifact verification challenge: HTTP {}", retry.status()));
        }
        retry.bytes().map_err(|e| e.to_string())?
    } else {
        return Err("download URL did not return a ZIP artifact".into());
    };
    if !is_zip_bytes(&bytes) {
        return Err("download URL did not return a ZIP artifact after verification challenge".into());
    }
    let mut file = std::fs::File::create(dest).map_err(|e| e.to_string())?;
    use std::io::Write;
    file.write_all(&bytes).map_err(|e| e.to_string())?;
    Ok(bytes.len() as u64)
}

/// Generic binary downloader used by update/license artifacts. Marketplace
/// installs use `download_marketplace_file`, which additionally handles the
/// uploader challenge and requires a ZIP response.
pub fn download_file(url: &str, dest: &std::path::Path) -> Result<u64, String> {
    if !url.starts_with("https://") {
        return Err("download URL must be HTTPS".into());
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(900))
        .connect_timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let mut res = client.get(url).send().map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("download failed: HTTP {}", res.status()));
    }
    let mut file = std::fs::File::create(dest).map_err(|e| e.to_string())?;
    let n = std::io::copy(&mut res, &mut file).map_err(|e| e.to_string())?;
    Ok(n)
}

/// One-shot GET without retries (bootstrap discovery must stay fast).
pub fn fetch_json_once(url: &str, timeout_ms: u64) -> Result<Value, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client.get(url).send().map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status().as_u16()));
    }
    let text = res.text().map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

pub struct CloudClient {
    base: Mutex<String>,
    transport: Transport,
    header_transport: HeaderTransport,
    /// Ring of recent cloud request outcomes (§10) — no bodies, no secrets.
    logs: Mutex<Vec<RequestLog>>,
}

thread_local! {
    static CURRENT_RID: std::cell::RefCell<String> = std::cell::RefCell::new(String::new());
}

static RID_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Anonymous correlation id: time + counter, no user data.
pub fn new_request_id() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let n = RID_COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst) % 0x1_0000;
    format!("{:x}-{:04x}", now, n)
}

/// Business error code from an envelope body (`error.code` or `code`).
pub fn envelope_code(v: &Value) -> Option<String> {
    v.get("error")
        .and_then(|e| e.get("code"))
        .and_then(|c| c.as_str())
        .or_else(|| v.get("code").and_then(|c| c.as_str()))
        .map(|s| s.to_string())
}

impl CloudClient {
    pub fn new(base: &str) -> Arc<Self> {
        Arc::new(Self {
            base: Mutex::new(base.to_string()),
            transport: default_transport(),
            header_transport: default_header_transport(),
            logs: Mutex::new(Vec::new()),
        })
    }

    #[allow(dead_code)] // used by tests (mock transports)
    pub fn with_transport(base: &str, transport: Transport) -> Arc<Self> {
        let header_transport: HeaderTransport = {
            let fallback = transport.clone();
            Arc::new(move |method, url, body, _headers| fallback(method, url, body))
        };
        Arc::new(Self {
            base: Mutex::new(base.to_string()),
            transport,
            header_transport,
            logs: Mutex::new(Vec::new()),
        })
    }

    #[cfg(test)]
    fn with_header_transport(base: &str, header_transport: HeaderTransport) -> Arc<Self> {
        let fallback: Transport = Arc::new(|_, _, _| {
            Err(ClientError {
                kind: ErrorKind::Offline,
                message: "unexpected body-only transport call".into(),
                retry_after_secs: None,
                code: None,
            })
        });
        Arc::new(Self {
            base: Mutex::new(base.to_string()),
            transport: fallback,
            header_transport,
            logs: Mutex::new(Vec::new()),
        })
    }

    /// Endpoint discovery re-points the client after a validated migration.
    pub fn set_base(&self, url: &str) {
        if let Ok(mut b) = self.base.lock() {
            *b = url.to_string();
        }
    }

    pub fn base(&self) -> String {
        self.base.lock().map(|b| b.clone()).unwrap_or_default()
    }

    /// Recent request outcomes for diagnostics (§10/§32).
    pub fn diagnostics(&self) -> Vec<RequestLog> {
        self.logs.lock().map(|g| g.clone()).unwrap_or_default()
    }

    fn log_request(&self, request_id: &str, endpoint: &str, status: u16, error_code: Option<String>, latency_ms: u128) {
        if let Ok(mut logs) = self.logs.lock() {
            logs.push(RequestLog {
                ts_ms: crate::app::policy::now_ms(),
                request_id: request_id.to_string(),
                endpoint: endpoint.to_string(),
                status,
                error_code,
                latency_ms,
            });
            while logs.len() > 100 {
                logs.remove(0);
            }
        }
    }

    /// One logical call with the retry policy. Relative paths resolve against
    /// the current (discovery-resolved) base; absolute URLs pass through.
    pub fn request(
        &self,
        method: &str,
        path_or_url: &str,
        body: Option<&Value>,
    ) -> Result<RawResponse, ClientError> {
        self.request_with_headers(method, path_or_url, body, &[])
    }

    pub fn request_with_headers(
        &self,
        method: &str,
        path_or_url: &str,
        body: Option<&Value>,
        headers: &[(&str, &str)],
    ) -> Result<RawResponse, ClientError> {
        let url = if path_or_url.starts_with("http") {
            path_or_url.to_string()
        } else {
            format!("{}{}", self.base().trim_end_matches('/'), path_or_url)
        };
        let request_id = new_request_id();
        let mut attempt = 0usize;
        loop {
            let started = std::time::Instant::now();
            CURRENT_RID.with(|r| *r.borrow_mut() = request_id.clone());
            let result = if headers.is_empty() {
                (self.transport)(method, &url, body)
            } else {
                (self.header_transport)(method, &url, body, headers)
            };
            let latency_ms = started.elapsed().as_millis();
            match &result {
                Ok(raw) => self.log_request(&request_id, &url, raw.status, envelope_code(&raw.body), latency_ms),
                Err(e) => self.log_request(&request_id, &url, 0, e.code.clone(), latency_ms),
            }
            match result {
                Ok(raw) => {
                    if raw.status >= 400 {
                        let retryable = raw.status == 429 || (500..=599).contains(&raw.status);
                        if retryable && attempt + 1 < MAX_ATTEMPTS {
                            sleep_for(raw.retry_after_secs, attempt);
                            attempt += 1;
                            continue;
                        }
                    }
                    return Ok(raw);
                }
                Err(e) => {
                    if e.retryable() && attempt + 1 < MAX_ATTEMPTS {
                        sleep_for(e.retry_after_secs, attempt);
                        attempt += 1;
                        continue;
                    }
                    return Err(e);
                }
            }
        }
    }

    pub fn get(&self, path: &str) -> Result<RawResponse, ClientError> {
        self.request("GET", path, None)
    }

    /// GET authenticated with headers. Header values stay inside Rust and are
    /// never placed in URLs, request logs, React state, or UI.
    pub fn get_with_headers(&self, path: &str, headers: &[(&str, &str)]) -> Result<RawResponse, ClientError> {
        self.request_with_headers("GET", path, None, headers)
    }

    pub fn post(&self, path: &str, body: &Value) -> Result<RawResponse, ClientError> {
        self.request("POST", path, Some(body))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};

    #[test]
    fn solves_the_uploader_aes_challenge_without_changing_the_artifact_url() {
        let html = br#"<script>var a=toNumbers("f655ba9d09a112d4968c63579db590b4"),b=toNumbers("98344c2eee86c3994890592585b49f80"),c=toNumbers("03e946cb3d2648f1117b6839e479a83a");document.cookie="__test="+toHex(slowAES.decrypt(c,2,a,b));</script>"#;
        assert_eq!(uploader_cookie(html), Some("a4ab21be42c5ca6d5fd36f5acf1e2be0".into()));
        assert_eq!(with_query("https://cdn.example/plugin.zip", "i", "1"), "https://cdn.example/plugin.zip?i=1");
        assert_eq!(with_query("https://cdn.example/plugin.zip?v=1", "i", "1"), "https://cdn.example/plugin.zip?v=1&i=1");
    }

    #[test]
    fn retries_5xx_then_succeeds_and_never_retries_4xx() {
        let hits = Arc::new(AtomicUsize::new(0));
        let h2 = Arc::clone(&hits);
        let t: Transport = Arc::new(move |_m, _u, _b| {
            let n = h2.fetch_add(1, SeqCst);
            let status = if n < 2 { 503 } else { 200 };
            Ok(RawResponse { status, retry_after_secs: None, body: json!({"ok": true}) })
        });
        let c = CloudClient::with_transport("https://mock.invalid", t);
        let raw = c.get("/x").unwrap();
        assert_eq!(raw.status, 200);
        assert_eq!(hits.load(SeqCst), 3);

        let hits4 = Arc::new(AtomicUsize::new(0));
        let h4 = Arc::clone(&hits4);
        let t4: Transport = Arc::new(move |_m, _u, _b| {
            h4.fetch_add(1, SeqCst);
            Ok(RawResponse { status: 400, retry_after_secs: None, body: json!({"ok": false}) })
        });
        let c4 = CloudClient::with_transport("https://mock.invalid", t4);
        let raw = c4.get("/x").unwrap();
        assert_eq!(raw.status, 400);
        assert_eq!(hits4.load(SeqCst), 1, "4xx must never retry");
    }

    #[test]
    fn retry_after_header_is_capped_at_10s() {
        let hits = Arc::new(AtomicUsize::new(0));
        let h2 = Arc::clone(&hits);
        let t: Transport = Arc::new(move |_m, _u, _b| {
            let n = h2.fetch_add(1, SeqCst);
            if n == 0 {
                Ok(RawResponse { status: 429, retry_after_secs: Some(999), body: json!({}) })
            } else {
                Ok(RawResponse { status: 200, retry_after_secs: None, body: json!({}) })
            }
        });
        let c = CloudClient::with_transport("https://mock.invalid", t);
        let started = std::time::Instant::now();
        let raw = c.get("/x").unwrap();
        assert_eq!(raw.status, 200);
        assert!(started.elapsed().as_millis() <= 11_000);
    }

    #[test]
    fn authenticated_get_sends_headers_without_a_body() {
        let seen = Arc::new(Mutex::new(Vec::<(String, String)>::new()));
        let copy = seen.clone();
        let transport: HeaderTransport = Arc::new(move |method, url, body, headers| {
            assert_eq!(method, "GET");
            assert!(body.is_none());
            assert!(url.ends_with("/api/ai/wallet"));
            copy.lock().unwrap().extend(headers.iter().map(|(k, v)| ((*k).to_string(), (*v).to_string())));
            Ok(RawResponse { status: 200, retry_after_secs: None, body: json!({"ok": true}) })
        });
        let client = CloudClient::with_header_transport("https://mock.invalid", transport);
        client
            .get_with_headers(
                "/api/ai/wallet",
                &[("X-DRS-License-Key", "key"), ("X-DRS-Machine-Id", "machine")],
            )
            .unwrap();
        assert_eq!(
            *seen.lock().unwrap(),
            vec![
                ("X-DRS-License-Key".into(), "key".into()),
                ("X-DRS-Machine-Id".into(), "machine".into())
            ]
        );
    }

    #[test]
    fn base_switch_follows_discovery() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let s2 = Arc::clone(&seen);
        let t: Transport = Arc::new(move |_m, u, _b| {
            s2.lock().unwrap().push(u.to_string());
            Ok(RawResponse { status: 200, retry_after_secs: None, body: json!({"ok": true}) })
        });
        let c = CloudClient::with_transport("https://old.example.com", t);
        c.get("/api/config").unwrap();
        c.set_base("https://new.example.com");
        c.get("/api/config").unwrap();
        let seen = seen.lock().unwrap();
        assert_eq!(seen[0], "https://old.example.com/api/config");
        assert_eq!(seen[1], "https://new.example.com/api/config");
    }

    #[test]
    fn gives_up_after_max_attempts_offline() {
        let hits = Arc::new(AtomicUsize::new(0));
        let h2 = Arc::clone(&hits);
        let t: Transport = Arc::new(move |_m, _u, _b| {
            h2.fetch_add(1, SeqCst);
            Err(ClientError { kind: ErrorKind::Offline, message: "offline".into(), retry_after_secs: None, code: None })
        });
        let c = CloudClient::with_transport("https://mock.invalid", t);
        let err = c.get("/x").unwrap_err();
        assert_eq!(err.kind, ErrorKind::Offline);
        assert_eq!(hits.load(SeqCst), MAX_ATTEMPTS);
    }
}
