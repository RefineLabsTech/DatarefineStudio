//! BYOK provider keys live in the OS credential manager — never in settings
//! files, never in logs, never sent to DataRefine Cloud.

pub fn service() -> &'static str {
    "datarefine-studio"
}

fn entry(provider: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(service(), &format!("byok:{provider}")).map_err(|e| e.to_string())
}

pub fn set_key(provider: &str, key: &str) -> Result<(), String> {
    if key.trim().is_empty() {
        return Err("Empty key.".into());
    }
    entry(provider)?.set_password(key.trim()).map_err(|e| e.to_string())
}

/// Read the stored key (Rust-internal only — never serialized to React).
pub fn get_key(provider: &str) -> Result<String, String> {
    entry(provider)?.get_password().map_err(|e| e.to_string())
}

pub fn has_key(provider: &str) -> bool {
    entry(provider)
        .and_then(|e| e.get_password().map_err(|x| x.to_string()))
        .map(|s| !s.is_empty())
        .unwrap_or(false)
}

pub fn delete_key(provider: &str) -> Result<(), String> {
    match entry(provider)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Diagnostics-safe masking: first4-…-last4, never the full key.
#[allow(dead_code)] // diagnostics-safe masking, used by tests/UI helpers
pub fn mask(key: &str) -> String {
    let k: String = key.chars().filter(|c| !c.is_whitespace()).collect();
    if k.len() < 8 {
        return "••••".into();
    }
    format!("{}-…-{}", &k[..4], &k[k.len() - 4..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_key_without_entry_is_graceful() {
        // No key stored for this provider in a fresh environment → clean Err,
        // never a panic and never a partial value.
        assert!(get_key("provider-with-no-key-xyz").is_err());
        assert!(!has_key("provider-with-no-key-xyz"));
    }

    #[test]
    fn masking_never_leaks_full_key() {
        assert_eq!(mask("sk-abc123xyz9999"), "sk-a-…-9999");
        assert_eq!(mask("short"), "••••");
        assert_eq!(mask("12345678"), "1234-…-5678");
    }
}
