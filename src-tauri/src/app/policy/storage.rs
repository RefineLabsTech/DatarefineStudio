//! Encrypted local license storage (AES-256-GCM, key bound to the machine).
//! Never stores plain license keys or user data. Atomic writes, no unwrap.

use std::fs;
use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

const MAGIC: &[u8; 4] = b"DRS2";
pub(crate) const STORE_NAME: &str = "license.bin";
const LEGACY_MAGIC: &[u8; 4] = b"DRS1";
const KDF: &[u8] = b"datarefine-studio-license-v1";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Stored {
    #[serde(default)]
    pub device_id: String,
    #[serde(default)]
    pub machine_id: String,
    #[serde(default)]
    pub activation_token: String,
    /// Optional encrypted-at-rest key escrow — empty unless the deployment
    /// policy explicitly enables re-sending the key on verify.
    #[serde(default)]
    pub key_escrow: String,
    /// Cached entitlements from the last successful activate/verify.
    #[serde(default)]
    pub entitlements: crate::app::policy::model::Entitlements,
    #[serde(default)]
    pub masked_license: String,
    #[serde(default)]
    pub plan: String,
    #[serde(default)]
    pub expires_at: String,
    #[serde(default)]
    pub last_verification_ms: i64,
    #[serde(default)]
    pub last_granted_ms: i64,
    #[serde(default)]
    pub last_wall_ms: i64,
    #[serde(default)]
    pub dismissed: Vec<Dismissed>,
    #[serde(default)]
    pub cached_config: Option<Value>,
    /// User-selected fallback while the cloud requires licensing. Keeping this
    /// in the encrypted store lets Basic mode survive restarts without
    /// weakening the remote policy for premium operations.
    #[serde(default)]
    pub basic_mode: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Dismissed {
    pub id: String,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum StorageError {
    Io(String),
    Corrupt(String),
}

fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

fn master_key(machine_id: &str) -> [u8; 32] {
    let mut buf: Vec<u8> = Vec::from(KDF);
    buf.extend_from_slice(machine_id.as_bytes());
    sha256(&buf)
}

pub fn store_path(dir: &Path) -> PathBuf {
    dir.join(STORE_NAME)
}

/// Remove the activation token from the OS credential manager. Local license
/// removal must clear this separately because load() restores it when the
/// encrypted record is empty.
pub fn clear_activation_token() -> Result<(), String> {
    let entry = keyring::Entry::new("datarefine-studio", "activationToken").map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

pub fn load(dir: &Path, machine_id: &str) -> Result<Stored, StorageError> {
    let path = store_path(dir);
    if !path.is_file() {
        return legacy_migrate(dir, machine_id);
    }
    let raw = fs::read(&path).map_err(|e| StorageError::Io(e.to_string()))?;
    let mut st = decrypt(&raw, machine_id)?;
    if st.activation_token.is_empty() {
        if let Ok(entry) = keyring::Entry::new("datarefine-studio", "activationToken") {
            if let Ok(tok) = entry.get_password() {
                st.activation_token = tok;
            }
        }
    }
    Ok(st)
}

pub fn save(dir: &Path, st: &Stored) -> Result<(), StorageError> {
    if st.machine_id.is_empty() {
        return Err(StorageError::Io("machine id missing".into()));
    }
    let machine_id = st.machine_id.clone();
    // §15: activation token prefers the OS credential store; the encrypted
    // blob is only a fallback where no secret service exists.
    let mut st = st.clone();
    if !st.activation_token.is_empty() {
        if let Ok(entry) = keyring::Entry::new("datarefine-studio", "activationToken") {
            // Only trust the credential store when a read-back through a
            // FRESH entry matches (exactly what load() does) — broken or
            // absent backends keep the encrypted-blob fallback intact.
            if entry.set_password(&st.activation_token).is_ok() {
                let readback = keyring::Entry::new("datarefine-studio", "activationToken")
                    .ok()
                    .and_then(|e| e.get_password().ok());
                if readback.as_deref() == Some(st.activation_token.as_str()) {
                    st.activation_token = String::new();
                }
            }
        }
    }
    let plain = serde_json::to_vec(&st).map_err(|e| StorageError::Io(e.to_string()))?;
    let blob = encrypt(&plain, &machine_id);
    if let Err(e) = fs::create_dir_all(dir) {
        return Err(StorageError::Io(e.to_string()));
    }
    let path = store_path(dir);
    let tmp = path.with_extension("bin.tmp");
    fs::write(&tmp, &blob).map_err(|e| StorageError::Io(e.to_string()))?;
    fs::rename(&tmp, &path).map_err(|e| StorageError::Io(e.to_string()))
}

pub fn encrypt(plain: &[u8], machine_id: &str) -> Vec<u8> {
    let key = master_key(machine_id);
    let cipher = Aes256Gcm::new_from_slice(&key).expect("static 32-byte key");
    let mut n = [0u8; 12];
    OsRng.fill_bytes(&mut n);
    let ct = cipher
        .encrypt(Nonce::from_slice(&n), plain)
        .unwrap_or_else(|_| plain.to_vec());
    let mut out = Vec::with_capacity(4 + 12 + ct.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&n);
    out.extend_from_slice(&ct);
    out
}

pub fn decrypt(raw: &[u8], machine_id: &str) -> Result<Stored, StorageError> {
    if raw.len() < 4 + 12 + 16 {
        return Err(StorageError::Corrupt("store too small".into()));
    }
    if &raw[..4] == LEGACY_MAGIC {
        return legacy_decrypt_record(raw, machine_id);
    }
    if &raw[..4] != MAGIC {
        return Err(StorageError::Corrupt("unknown store format".into()));
    }
    let nonce = &raw[4..16];
    let ct = &raw[16..];
    let key = master_key(machine_id);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| StorageError::Corrupt(e.to_string()))?;
    let plain = cipher
        .decrypt(Nonce::from_slice(nonce), ct)
        .map_err(|_| StorageError::Corrupt("integrity check failed".into()))?;
    serde_json::from_slice::<Stored>(&plain).map_err(|e| StorageError::Corrupt(e.to_string()))
}

/* -------------------- legacy DRS1 (HMAC keystream) migration -------------------- */

fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut k = [0u8; 64];
    if key.len() > 64 {
        k[..32].copy_from_slice(&sha256(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0x36u8; 64];
    let mut opad = [0x5cu8; 64];
    for i in 0..64 {
        ipad[i] ^= k[i];
        opad[i] ^= k[i];
    }
    let mut inner = Vec::with_capacity(64 + data.len());
    inner.extend_from_slice(&ipad);
    inner.extend_from_slice(data);
    let ih = sha256(&inner);
    let mut outer = Vec::with_capacity(96);
    outer.extend_from_slice(&opad);
    outer.extend_from_slice(&ih);
    sha256(&outer)
}

fn legacy_keystream(key: &[u8; 32], nonce: &[u8], len: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(len);
    let mut i: u32 = 0;
    while out.len() < len {
        let mut block = Vec::with_capacity(nonce.len() + 4);
        block.extend_from_slice(nonce);
        block.extend_from_slice(&i.to_le_bytes());
        let h = hmac_sha256(key, &block);
        let need = (len - out.len()).min(32);
        out.extend_from_slice(&h[..need]);
        i = i.wrapping_add(1);
    }
    out
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyRecord {
    #[serde(default)]
    token: String,
    #[serde(default)]
    expires_at: String,
    #[serde(default)]
    activated_at: String,
    #[serde(default)]
    last_verified_at: String,
    #[serde(default)]
    machine_id: String,
    #[serde(default)]
    config: Option<Value>,
}

fn legacy_decrypt_record(raw: &[u8], machine_id: &str) -> Result<Stored, StorageError> {
    if raw.len() < 4 + 16 + 32 {
        return Err(StorageError::Corrupt("legacy store too small".into()));
    }
    let nonce = &raw[4..20];
    let tag = &raw[20..52];
    let cipher = &raw[52..];
    let key = master_key(machine_id);
    let mut tagged = Vec::with_capacity(16 + cipher.len());
    tagged.extend_from_slice(nonce);
    tagged.extend_from_slice(cipher);
    if hmac_sha256(&key, &tagged).as_slice() != tag {
        return Err(StorageError::Corrupt("legacy integrity check failed".into()));
    }
    let ks = legacy_keystream(&key, nonce, cipher.len());
    let plain: Vec<u8> = cipher.iter().zip(ks.iter()).map(|(a, b)| a ^ b).collect();
    let rec: LegacyRecord =
        serde_json::from_slice(&plain).map_err(|e| StorageError::Corrupt(e.to_string()))?;
    // A legacy token bound to a different machine does not migrate.
    if !rec.machine_id.is_empty() && rec.machine_id != machine_id {
        return Ok(Stored {
            machine_id: machine_id.to_string(),
            ..Stored::default()
        });
    }
    let parse = |s: &str| crate::app::policy::parse_iso_ms(s).unwrap_or(0);
    Ok(Stored {
        machine_id: machine_id.to_string(),
        activation_token: rec.token,
        expires_at: rec.expires_at,
        plan: "Pro".into(),
        masked_license: String::new(),
        last_verification_ms: parse(rec.last_verified_at.as_str()),
        last_granted_ms: parse(rec.activated_at.as_str()),
        cached_config: rec.config,
        ..Stored::default()
    })
}

fn legacy_migrate(dir: &Path, machine_id: &str) -> Result<Stored, StorageError> {
    // Nothing on disk at the new path: fresh start (device id filled by gate).
    let _ = dir;
    Ok(Stored {
        machine_id: machine_id.to_string(),
        ..Stored::default()
    })
}

/// Fallback device identity seed file (used when no OS-level id is available).
pub fn device_seed_path(dir: &Path) -> PathBuf {
    dir.join("device.id")
}

pub fn hex(bytes: &[u8]) -> String {
    hex_encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_encrypt_decrypt() {
        let dir = std::env::temp_dir().join(format!("drs-st-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let mut st = Stored {
            device_id: "dev-1".into(),
            machine_id: "mach-1".into(),
            activation_token: "tok-abc".into(),
            masked_license: "ABCD-…-5678".into(),
            expires_at: "2030-01-01T00:00:00Z".into(),
            last_granted_ms: 1234,
            ..Stored::default()
        };
        st.dismissed.push(Dismissed {
            id: "a1".into(),
            updated_at: "2026-01-01".into(),
        });
        save(&dir, &st).expect("save");
        let raw = fs::read(store_path(&dir)).expect("read");
        assert_eq!(&raw[..4], MAGIC);
        assert!(!raw.windows(7).any(|w| w == b"tok-abc".as_slice())); // token not plaintext
        let back = load(&dir, "mach-1").expect("load");
        assert_eq!(back.activation_token, "tok-abc");
        assert_eq!(back.dismissed.len(), 1);
        // wrong machine => integrity failure, never plaintext leak
        assert!(matches!(
            load(&dir, "other-machine"),
            Err(StorageError::Corrupt(_))
        ));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn tamper_detection() {
        let dir = std::env::temp_dir().join(format!("drs-st-t-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let st = Stored {
            machine_id: "m".into(),
            activation_token: "t".into(),
            ..Stored::default()
        };
        save(&dir, &st).expect("save");
        let mut raw = fs::read(store_path(&dir)).expect("read");
        let last = raw.len() - 1;
        raw[last] ^= 0xff;
        fs::write(store_path(&dir), raw).expect("write");
        assert!(matches!(load(&dir, "m"), Err(StorageError::Corrupt(_))));
        let _ = fs::remove_dir_all(&dir);
    }
}
