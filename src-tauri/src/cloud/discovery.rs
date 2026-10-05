//! Signed endpoint discovery with three-tier fallback.
//!
//! 1. Bootstrap endpoint (signature + https + expiry + version validated)
//! 2. Last known good endpoint (only if it previously passed validation)
//! 3. Stable production domain
//!
//! A remote server can never inject an arbitrary endpoint: unsigned,
//! expired, down-version or non-HTTPS configurations are rejected.

use super::{
    config,
    models::{canonical_payload, BootstrapConfig, CachedEndpoint, EndpointSource, ResolvedEndpoint},
};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};

pub fn hex_decode(s: &str) -> Option<Vec<u8>> {
    let s = s.trim();
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

#[allow(dead_code)] // used by tests / signing tooling checks
pub fn hex_encode(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Ed25519 check over the canonical payload. Any malformed input = false.
pub fn verify_signature_with(cfg: &BootstrapConfig, pub_hex: &str) -> bool {
    let pub_bytes = match hex_decode(pub_hex) {
        Some(b) if b.len() == 32 => b,
        _ => return false,
    };
    let sig_bytes = match hex_decode(&cfg.signature) {
        Some(b) if b.len() == 64 => b,
        _ => return false,
    };
    let Ok(vk) = VerifyingKey::from_bytes(pub_bytes.as_slice().try_into().unwrap_or(&[0u8; 32]))
    else {
        return false;
    };
    let Ok(sig) = Signature::from_slice(&sig_bytes) else {
        return false;
    };
    vk.verify(&canonical_payload(cfg), &sig).is_ok()
}

#[allow(dead_code)] // convenience wrapper used by tests/tools
pub fn verify_signature(cfg: &BootstrapConfig) -> bool {
    verify_signature_with(cfg, config::ENDPOINT_SIGNING_PUBKEY_HEX)
}

/// Canonical JSON: recursively sorted object keys, arrays in order, no
/// insignificant whitespace, UTF-8 (§4).
pub fn canonical_json(v: &serde_json::Value) -> String {
    use serde_json::Value;
    match v {
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            let parts: Vec<String> = keys
                .iter()
                .map(|k| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(k.as_str()).unwrap_or_default(),
                        canonical_json(&m[*k])
                    )
                })
                .collect();
            format!("{{{}}}", parts.join(","))
        }
        Value::Array(a) => {
            let parts: Vec<String> = a.iter().map(canonical_json).collect();
            format!("[{}]", parts.join(","))
        }
        Value::String(s) => serde_json::to_string(s).unwrap_or_default(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".to_string(),
    }
}

/// Pinned signing keys by keyId (§4 rotation support).
pub fn pinned_pub(key_id: &str) -> Option<String> {
    match key_id {
        "drs-main-2025" | "main" => Some(config::ENDPOINT_SIGNING_PUBKEY_HEX.to_string()),
        _ => None,
    }
}

/// Verify a canonical-JSON bootstrap document
/// `{keyId,version,issuedAt,expiresAt,api,app,endpoints,features,signature}`
/// and convert it to the internal BootstrapConfig. The signature covers the
/// canonical JSON of the document WITHOUT the `signature` field.
pub fn doc_to_config(
    raw: &serde_json::Value,
    now_ms: i64,
    resolve_key: &dyn Fn(&str) -> Option<String>,
) -> Result<BootstrapConfig, String> {
    let key_id = raw.get("keyId").and_then(|v| v.as_str()).unwrap_or_default();
    let Some(pub_hex) = resolve_key(key_id) else {
        return Err(format!("unknown bootstrap keyId: {key_id}"));
    };
    let sig_hex = raw
        .get("signature")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let mut payload_doc = raw.clone();
    if let Some(obj) = payload_doc.as_object_mut() {
        obj.remove("signature");
    }
    let payload = canonical_json(&payload_doc).into_bytes();
    let pub_bytes = hex_decode(&pub_hex)
        .filter(|b| b.len() == 32)
        .ok_or_else(|| "bad pinned key".to_string())?;
    let sig_bytes = hex_decode(&sig_hex)
        .filter(|b| b.len() == 64)
        .ok_or_else(|| "bad document signature encoding".to_string())?;
    let vk = VerifyingKey::from_bytes(pub_bytes.as_slice().try_into().unwrap_or(&[0u8; 32]))
        .map_err(|e| e.to_string())?;
    let sig = Signature::from_slice(&sig_bytes).map_err(|e| e.to_string())?;
    vk.verify(&payload, &sig)
        .map_err(|_| "bootstrap document signature invalid".to_string())?;
    let issued_at = raw.get("issuedAt").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let expires_at = raw.get("expiresAt").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    // §19: clock rollback never extends trust — a clock before issuedAt fails.
    if let Some(issued_ms) = crate::app::policy::parse_iso_ms(&issued_at) {
        if now_ms < issued_ms {
            return Err("system clock precedes issuedAt".into());
        }
    }
    let version = raw.get("version").and_then(|v| v.as_i64()).unwrap_or(1).max(1);
    let api_base_url = raw
        .get("api")
        .and_then(|a| a.get("baseUrl"))
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();
    let cfg = BootstrapConfig {
        config_version: version,
        api_base_url,
        issued_at,
        expires_at,
        signature: sig_hex,
    };
    validate(&cfg, now_ms)?;
    Ok(cfg)
}

/// Policy validation AFTER a good signature: version, scheme, expiry.
pub fn validate(cfg: &BootstrapConfig, now_ms: i64) -> Result<(), String> {
    if cfg.config_version < config::MIN_CONFIG_VERSION {
        return Err(format!(
            "config version {} below minimum {}",
            cfg.config_version,
            config::MIN_CONFIG_VERSION
        ));
    }
    if !cfg.api_base_url.starts_with("https://") {
        return Err("endpoint must be HTTPS".into());
    }
    if let Some(exp) = crate::app::policy::parse_iso_ms(&cfg.expires_at) {
        if now_ms > exp {
            return Err("endpoint configuration expired".into());
        }
    }
    Ok(())
}

/// Fetch + parse + verify + validate the bootstrap configuration.
pub fn try_bootstrap_with(
    fetch: &dyn Fn(&str) -> Result<serde_json::Value, String>,
    now_ms: i64,
    pub_hex: &str,
) -> Result<BootstrapConfig, String> {
    let raw = fetch(config::BOOTSTRAP_URL)?;
    // New canonical-JSON document format takes precedence when present.
    if raw.get("keyId").is_some() && raw.get("configVersion").is_none() {
        let pinned = pub_hex.to_string();
        let is_prod = pinned == config::ENDPOINT_SIGNING_PUBKEY_HEX;
        return doc_to_config(&raw, now_ms, &|key_id: &str| {
            if is_prod {
                pinned_pub(key_id)
            } else {
                // test/override path: caller-pinned key, keyId recorded only
                Some(pinned.clone())
            }
        });
    }
    let cfg: BootstrapConfig =
        serde_json::from_value(raw).map_err(|e| format!("bad bootstrap payload: {e}"))?;
    if !verify_signature_with(&cfg, pub_hex) {
        return Err("bootstrap signature invalid".into());
    }
    validate(&cfg, now_ms)?;
    Ok(cfg)
}

#[allow(dead_code)] // prod-key convenience wrapper (gate uses resolve_with)
pub fn try_bootstrap(
    fetch: &dyn Fn(&str) -> Result<serde_json::Value, String>,
    now_ms: i64,
) -> Result<BootstrapConfig, String> {
    try_bootstrap_with(fetch, now_ms, config::ENDPOINT_SIGNING_PUBKEY_HEX)
}

/// Resolve the API endpoint. Returns the chosen endpoint plus the cache value
/// to persist (Some when bootstrap succeeded and must be remembered).
pub fn resolve_with(
    fetch: &dyn Fn(&str) -> Result<serde_json::Value, String>,
    cached: Option<&CachedEndpoint>,
    now_ms: i64,
    pub_hex: &str,
) -> (ResolvedEndpoint, Option<CachedEndpoint>) {
    match try_bootstrap_with(fetch, now_ms, pub_hex) {
        Ok(cfg) => {
            let ep = ResolvedEndpoint {
                url: cfg.api_base_url.clone(),
                source: EndpointSource::Bootstrap,
                config_version: cfg.config_version,
            };
            (ep, Some(CachedEndpoint::from_config(&cfg)))
        }
        Err(_) => {
            if let Some(c) = cached {
                if c.verified && c.url.starts_with("https://") {
                    return (
                        ResolvedEndpoint {
                            url: c.url.clone(),
                            source: EndpointSource::Cached,
                            config_version: c.config_version,
                        },
                        None,
                    );
                }
            }
            (
                ResolvedEndpoint {
                    url: config::STABLE_API_URL.to_string(),
                    source: EndpointSource::Stable,
                    config_version: 0,
                },
                None,
            )
        }
    }
}

pub fn resolve(
    fetch: &dyn Fn(&str) -> Result<serde_json::Value, String>,
    cached: Option<&CachedEndpoint>,
    now_ms: i64,
) -> (ResolvedEndpoint, Option<CachedEndpoint>) {
    resolve_with(fetch, cached, now_ms, config::ENDPOINT_SIGNING_PUBKEY_HEX)
}

/// Cache file path inside the license store directory.
pub fn cache_path(store_dir: &std::path::Path) -> std::path::PathBuf {
    store_dir.join(config::ENDPOINT_CACHE_NAME)
}

pub fn load_cache(store_dir: &std::path::Path) -> Option<CachedEndpoint> {
    let raw = std::fs::read_to_string(cache_path(store_dir)).ok()?;
    serde_json::from_str::<CachedEndpoint>(&raw).ok()
}

pub fn save_cache(store_dir: &std::path::Path, c: &CachedEndpoint) {
    if let Ok(json) = serde_json::to_string_pretty(c) {
        let _ = std::fs::create_dir_all(store_dir);
        let _ = std::fs::write(cache_path(store_dir), json);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Dedicated test keypair (never shipped; production key lives in config.rs).
    const TEST_PUB: &str = "5652775ef18a81471be851c949be7e3d1687f147cfc280b827fde59fb7b6dd99";
    const TEST_PRIV: &str = "a18d4d6214c227b69666a8a856e16d0a4f14b1b4a52a81f00682f654766c2bdf";

    fn sign(cfg: &BootstrapConfig) -> String {
        use ed25519_dalek::{Signer, SigningKey};
        let seed = hex_decode(TEST_PRIV).unwrap();
        let sk = SigningKey::from_bytes(seed.as_slice().try_into().unwrap());
        hex_encode(&sk.sign(&canonical_payload(cfg)).to_bytes())
    }

    fn signed(url: &str) -> BootstrapConfig {
        let mut c = BootstrapConfig {
            config_version: 4,
            api_base_url: url.into(),
            issued_at: "2026-01-01T00:00:00Z".into(),
            expires_at: "2030-01-01T00:00:00Z".into(),
            signature: String::new(),
        };
        c.signature = sign(&c);
        c
    }

    fn fetcher(cfg: Option<BootstrapConfig>) -> Box<dyn Fn(&str) -> Result<serde_json::Value, String>> {
        Box::new(move |_| match &cfg {
            Some(c) => Ok(serde_json::to_value(c).unwrap()),
            None => Err("offline".into()),
        })
    }

    const NOW: i64 = 1_700_000_000_000;

    #[test]
    fn signed_bootstrap_is_accepted_and_cached() {
        let c = signed("https://api.datarefine.com");
        assert!(verify_signature_with(&c, TEST_PUB));
        let (ep, cache) = resolve_with(&fetcher(Some(c)), None, NOW, TEST_PUB);
        assert_eq!(ep.source, EndpointSource::Bootstrap);
        assert_eq!(ep.url, "https://api.datarefine.com");
        assert!(cache.unwrap().verified);
    }

    #[test]
    fn tampered_url_fails_signature() {
        let mut c = signed("https://api.datarefine.com");
        c.api_base_url = "https://evil.example.com".into();
        assert!(!verify_signature_with(&c, TEST_PUB));
        let (ep, cache) = resolve_with(&fetcher(Some(c)), None, NOW, TEST_PUB);
        assert_eq!(ep.source, EndpointSource::Stable);
        assert!(cache.is_none());
    }

    #[test]
    fn wrong_key_fails_signature() {
        let c = signed("https://api.datarefine.com");
        // production key must reject a test-key signature and vice versa
        assert!(!verify_signature_with(&c, config::ENDPOINT_SIGNING_PUBKEY_HEX));
    }

    #[test]
    fn expired_and_downversion_and_http_rejected() {
        let mut c = signed("https://api.datarefine.com");
        c.expires_at = "2020-01-01T00:00:00Z".into();
        assert!(validate(&c, NOW).is_err());
        let mut c = signed("https://api.datarefine.com");
        c.config_version = 0;
        assert!(validate(&c, NOW).is_err());
        let c = signed("http://api.datarefine.com");
        assert!(validate(&c, NOW).is_err());
    }

    #[test]
    fn fallback_order_cached_then_stable() {
        let off = fetcher(None);
        let good = CachedEndpoint {
            url: "https://last-good.example.com".into(),
            config_version: 3,
            signature: "aa".into(),
            verified: true,
        };
        let (ep, _) = resolve_with(&off, Some(&good), NOW, TEST_PUB);
        assert_eq!(ep.source, EndpointSource::Cached);
        assert_eq!(ep.url, "https://last-good.example.com");
        let bad = CachedEndpoint { verified: false, ..good.clone() };
        let (ep, _) = resolve_with(&off, Some(&bad), NOW, TEST_PUB);
        assert_eq!(ep.source, EndpointSource::Stable);
        let (ep, _) = resolve_with(&off, None, NOW, TEST_PUB);
        assert_eq!(ep.source, EndpointSource::Stable);
        assert_eq!(ep.url, config::STABLE_API_URL);
    }

    #[test]
    fn endpoint_migration_without_reinstall() {
        let old = fetcher(Some(signed("https://datarefine-license-cloud.vercel.app")));
        let (ep1, cache1) = resolve_with(&old, None, NOW, TEST_PUB);
        assert_eq!(ep1.url, "https://datarefine-license-cloud.vercel.app");
        let new = fetcher(Some(signed("https://datarefine-production.up.railway.app")));
        let (ep2, cache2) = resolve_with(&new, cache1.as_ref(), NOW, TEST_PUB);
        assert_eq!(ep2.source, EndpointSource::Bootstrap);
        assert_eq!(ep2.url, "https://datarefine-production.up.railway.app");
        // Bootstrap gone → last known good (Railway) reused, no reinstall.
        let (ep3, _) = resolve_with(&fetcher(None), cache2.as_ref(), NOW, TEST_PUB);
        assert_eq!(ep3.source, EndpointSource::Cached);
        assert_eq!(ep3.url, "https://datarefine-production.up.railway.app");
    }

    #[test]
    fn unsigned_json_is_rejected() {
        let raw = serde_json::json!({"configVersion": 4, "apiBaseUrl": "https://evil.example.com", "issuedAt": "2026-01-01T00:00:00Z", "expiresAt": "2030-01-01T00:00:00Z", "signature": "00".repeat(64)});
        let f: Box<dyn Fn(&str) -> Result<serde_json::Value, String>> = Box::new(move |_u: &str| Ok(raw.clone()));
        let (ep, cache) = resolve_with(&f, None, NOW, TEST_PUB);
        assert_eq!(ep.source, EndpointSource::Stable);
        assert!(cache.is_none());
    }

    #[test]
    fn canonical_json_sorts_recursively_and_is_compact() {
        let v = serde_json::json!({"b": 1, "a": {"d": [3, {"z": 1, "y": 2}], "c": "x"}});
        assert_eq!(canonical_json(&v), r#"{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}"#);
    }

    fn signed_doc(key_id: &str, base_url: &str, issued: &str, expires: &str, tamper: bool) -> serde_json::Value {
        use ed25519_dalek::{Signer, SigningKey};
        let mut doc = serde_json::json!({
            "keyId": key_id,
            "version": 1,
            "issuedAt": issued,
            "expiresAt": expires,
            "api": { "baseUrl": base_url, "fallbackBaseUrls": [] },
            "app": {},
            "endpoints": {},
            "features": {}
        });
        let payload = canonical_json(&doc).into_bytes();
        let seed = hex_decode(TEST_PRIV).unwrap();
        let sk = SigningKey::from_bytes(seed.as_slice().try_into().unwrap());
        let sig = sk.sign(&payload);
        if tamper {
            doc["api"]["baseUrl"] = serde_json::json!("https://evil.example");
        }
        doc["signature"] = serde_json::json!(hex_encode(&sig.to_bytes()));
        doc
    }

    fn test_resolver(key_id: &str) -> Option<String> {
        if key_id == "test-key" { Some(TEST_PUB.to_string()) } else { None }
    }

    #[test]
    fn bootstrap_document_verifies_and_converts() {
        let doc = signed_doc("test-key", "https://api.example", "2020-01-01T00:00:00Z", "2999-01-01T00:00:00Z", false);
        let cfg = doc_to_config(&doc, crate::app::policy::now_ms(), &test_resolver).expect("valid doc");
        assert_eq!(cfg.api_base_url, "https://api.example");
        assert_eq!(cfg.config_version, 1);
    }

    #[test]
    fn bootstrap_document_rejects_tamper_wrong_key_expiry_rollback() {
        let now = crate::app::policy::now_ms();
        // tampered after signing
        let doc = signed_doc("test-key", "https://api.example", "2020-01-01T00:00:00Z", "2999-01-01T00:00:00Z", true);
        assert!(doc_to_config(&doc, now, &test_resolver).is_err());
        // unknown keyId (resolver refuses)
        let doc = signed_doc("unknown-key", "https://api.example", "2020-01-01T00:00:00Z", "2999-01-01T00:00:00Z", false);
        assert!(doc_to_config(&doc, now, &test_resolver).is_err());
        // expired
        let doc = signed_doc("test-key", "https://api.example", "2020-01-01T00:00:00Z", "2020-01-02T00:00:00Z", false);
        assert!(doc_to_config(&doc, now, &test_resolver).is_err());
        // clock rollback: now < issuedAt
        let doc = signed_doc("test-key", "https://api.example", "2999-01-01T00:00:00Z", "2999-01-02T00:00:00Z", false);
        assert!(doc_to_config(&doc, now, &test_resolver).is_err());
        // non-HTTPS base url rejected even with a good signature
        let doc = signed_doc("test-key", "http://api.example", "2020-01-01T00:00:00Z", "2999-01-01T00:00:00Z", false);
        assert!(doc_to_config(&doc, now, &test_resolver).is_err());
    }

    #[test]
    fn pinned_pub_only_known_key_ids() {
        assert!(pinned_pub("drs-main-2025").is_some());
        assert!(pinned_pub("main").is_some());
        assert!(pinned_pub("attacker-key").is_none());
    }
}
