//! Device identity: stable machine fingerprint (SHA-256) + per-install UUID.
//! Nothing personal is ever collected: no hostname, username, paths, IP or
//! location leaves the machine — only the hashed fingerprint and a random
//! device UUID (anonymous install registration).

use std::fs;
use std::path::Path;

use sha2::{Digest, Sha256};
use uuid::Uuid;

/// Best-effort stable raw machine identifier per platform.
fn raw_fingerprint() -> String {
    #[cfg(windows)]
    {
        // `reg.exe` is a console subsystem process. A GUI Tauri parent can
        // otherwise flash a separate console window during license bootstrap.
        let mut reg = std::process::Command::new("reg");
        use std::os::windows::process::CommandExt;
        reg.creation_flags(0x0800_0000);
        if let Ok(out) = reg
            .args([
                "query",
                r"HKLM\SOFTWARE\Microsoft\Cryptography",
                "/v",
                "MachineGuid",
            ])
            .output()
        {
            if out.status.success() {
                let s = String::from_utf8_lossy(&out.stdout);
                for line in s.lines() {
                    if line.contains("MachineGuid") {
                        if let Some(id) = line.split_whitespace().last() {
                            if id.len() >= 8 {
                                return id.to_string();
                            }
                        }
                    }
                }
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(out) = std::process::Command::new("ioreg")
            .args(["-rd1", "-c", "IOPlatformExpertDevice"])
            .output()
        {
            let s = String::from_utf8_lossy(&out.stdout);
            for line in s.lines() {
                if line.contains("IOPlatformUUID") {
                    if let Some(q) = line.split('"').nth(3) {
                        if q.len() >= 8 {
                            return q.to_string();
                        }
                    }
                }
            }
        }
    }
    #[cfg(unix)]
    {
        for p in ["/etc/machine-id", "/var/lib/dbus/machine-id"] {
            if let Ok(s) = fs::read_to_string(p) {
                let t = s.trim().to_string();
                if t.len() >= 8 {
                    return t;
                }
            }
        }
    }
    String::new()
}

/// Stable SHA-256 machine id (hex), with a persisted seed fallback so the
/// value never changes for the same install even on exotic platforms.
pub fn machine_id_in(dir: &Path) -> String {
    let raw = raw_fingerprint();
    let base = if raw.is_empty() {
        format!(
            "{}|{}|{}",
            std::env::consts::OS,
            std::env::consts::ARCH,
            seed_uuid(dir)
        )
    } else {
        raw
    };
    let digest = Sha256::digest(base.as_bytes());
    crate::app::policy::storage::hex(&digest)
}

fn seed_uuid(dir: &Path) -> String {
    let path = dir.join("machine.seed");
    if let Ok(s) = fs::read_to_string(&path) {
        let t = s.trim().to_string();
        if !t.is_empty() {
            return t;
        }
    }
    let id = Uuid::new_v4().to_string();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(&path, &id);
    id
}

/// Load or create the per-install device UUID (v4) in `dir/device.id`.
pub fn device_id(dir: &Path) -> String {
    let path = crate::app::policy::storage::device_seed_path(dir);
    if let Ok(s) = fs::read_to_string(&path) {
        let t = s.trim().to_string();
        if !t.is_empty() {
            return t;
        }
    }
    let id = Uuid::new_v4().to_string();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(&path, &id);
    id
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub platform: String,
    pub arch: String,
    pub os_version: String,
}

pub fn app_info() -> AppInfo {
    let info = os_info::get();
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        os_version: info.version().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn machine_id_stable_and_hex64() {
        let dir = std::env::temp_dir().join(format!("drs-mid-{}", std::process::id()));
        let a = machine_id_in(&dir);
        let b = machine_id_in(&dir);
        assert_eq!(a, b);
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn device_id_persists() {
        let dir = std::env::temp_dir().join(format!("drs-dev-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let a = device_id(&dir);
        let b = device_id(&dir);
        assert_eq!(a, b);
        assert!(Uuid::parse_str(&a).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
