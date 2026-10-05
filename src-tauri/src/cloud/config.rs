//! Cloud constants. The ONLY place discovery URLs and the signing key live.

/// Trusted bootstrap endpoint — the single embedded discovery URL.
pub const BOOTSTRAP_URL: &str = "https://bootstrap.datarefine.com/bootstrap.json";

/// Stable production API domain — last-resort fallback (also the current host).
pub const STABLE_API_URL: &str = "https://datarefine-license-cloud.vercel.app";

/// Ed25519 public key (hex, 32 bytes) used to verify signed endpoint configs.
/// The private signing key exists ONLY in the cloud signing service
/// (see services/internal/cloud-bridge/). Never embed private keys in the desktop.
pub const ENDPOINT_SIGNING_PUBKEY_HEX: &str =
    "f372621a55651b46423e937d7906705578a29d8f303ed9c3d80f88447d2dc671";

/// Minimum accepted configVersion from the bootstrap endpoint.
pub const MIN_CONFIG_VERSION: i64 = 1;

/// Bootstrap fetch timeout (ms) — discovery must never stall startup.
pub const BOOTSTRAP_TIMEOUT_MS: u64 = 4000;

/// Endpoint cache file name inside the license store dir.
pub const ENDPOINT_CACHE_NAME: &str = "endpoint.json";
