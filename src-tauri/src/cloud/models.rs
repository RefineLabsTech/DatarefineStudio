//! Cloud discovery + endpoint models.

use serde::{Deserialize, Serialize};

/// Signed configuration published by the bootstrap endpoint.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapConfig {
    pub config_version: i64,
    pub api_base_url: String,
    pub issued_at: String,
    pub expires_at: String,
    /// Hex-encoded Ed25519 signature over [`canonical_payload`].
    pub signature: String,
}

/// The exact bytes covered by the Ed25519 signature.
pub fn canonical_payload(c: &BootstrapConfig) -> Vec<u8> {
    format!(
        "{}\n{}\n{}\n{}",
        c.config_version, c.api_base_url, c.issued_at, c.expires_at
    )
    .into_bytes()
}

/// Where a resolved endpoint came from (audit + diagnostics).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EndpointSource {
    Bootstrap,
    Cached,
    Stable,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedEndpoint {
    pub url: String,
    pub source: EndpointSource,
    pub config_version: i64,
}

/// Persisted last-known-good endpoint. Only ever written after a signature
/// validation pass, and only ever reused while that flag is true.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedEndpoint {
    pub url: String,
    pub config_version: i64,
    pub signature: String,
    pub verified: bool,
}

impl CachedEndpoint {
    pub fn from_config(c: &BootstrapConfig) -> Self {
        Self {
            url: c.api_base_url.clone(),
            config_version: c.config_version,
            signature: c.signature.clone(),
            verified: true,
        }
    }
}
