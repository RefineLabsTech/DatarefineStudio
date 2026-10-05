use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub version: String,
    /// "ai" | "ui" | "tool"
    #[serde(default, rename = "type")]
    pub plugin_type: String,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

impl Manifest {
    pub fn load(dir: &Path) -> Option<Self> {
        let raw = std::fs::read_to_string(dir.join("manifest.json")).ok()?;
        let mut m: Manifest = serde_json::from_str(&raw).ok()?;
        if m.id.is_empty() {
            m.id = dir.file_name()?.to_string_lossy().into_owned();
        }
        Some(m)
    }
}
