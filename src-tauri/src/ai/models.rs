use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AiSource {
    Cloud,
    Byok,
    Local,
}

impl AiSource {
    #[allow(dead_code)] // used by router tests / serialization helpers
    pub fn as_str(&self) -> &'static str {
        match self {
            AiSource::Cloud => "cloud",
            AiSource::Byok => "byok",
            AiSource::Local => "local",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "cloud" => Some(Self::Cloud),
            "byok" => Some(Self::Byok),
            "local" => Some(Self::Local),
            _ => None,
        }
    }
}

/// Router inputs (from Settings + environment probes + entitlements).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettings {
    /// User preference: "cloud" | "byok" | "local" (empty = auto).
    #[serde(default)]
    pub preferred: Option<String>,
    /// A BYOK key for the selected provider exists in OS credential storage.
    #[serde(default)]
    pub byok_configured: bool,
    /// Local Ollama responded to a probe.
    #[serde(default)]
    pub ollama_available: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouterDecision {
    pub source: AiSource,
    pub reason: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credits {
    pub balance: f64,
    pub reserved: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum JobStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
    Expired,
}

impl JobStatus {
    pub fn parse(s: &str) -> Self {
        match s {
            "running" => Self::Running,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            "expired" => Self::Expired,
            _ => Self::Queued,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub status: JobStatus,
    #[serde(default)]
    pub error: Option<String>,
}
