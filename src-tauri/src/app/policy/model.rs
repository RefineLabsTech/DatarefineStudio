//! Wire models for the License Cloud API (envelope + config + payloads).

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// `{ ok, data, message|error|detail }` envelope used by every endpoint.
#[derive(Debug, Clone)]
pub struct Envelope {
    pub ok: bool,
    pub data: Value,
    pub message: Option<String>,
    /// Business error code from `error.code` or top-level `code`.
    pub code: Option<String>,
}

impl Envelope {
    /// Tolerant parser: accepts `ok`/`success`, `data` payload and any of the
    /// common error-message keys. Never panics.
    pub fn parse(raw: &Value) -> Envelope {
        let obj = raw.as_object();
        let get = |k: &str| obj.and_then(|o| o.get(k));
        let ok = get("ok")
            .or_else(|| get("success"))
            .map(|v| match v {
                Value::Bool(b) => *b,
                Value::String(s) => s == "true" || s == "1",
                Value::Number(n) => n.as_i64() == Some(1),
                _ => false,
            })
            .unwrap_or(true);
        let data = get("data").cloned().unwrap_or_else(|| raw.clone());
        let message = get("message")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .or_else(|| Self::error_text(get("error")))
            .or_else(|| get("detail").and_then(|v| v.as_str()).map(|s| s.to_string()));
        let code = get("code")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .or_else(|| {
                get("error")
                    .and_then(|e| e.get("code"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            });
        Envelope { ok, data, message, code }
    }

    /// Cloud failures nest the reason: {"error": {"code", "message", "details"}}.
    fn error_text(v: Option<&Value>) -> Option<String> {
        let e = v?;
        if let Some(s) = e.as_str() {
            return Some(s.to_string());
        }
        let m = e
            .get("message")
            .and_then(|x| x.as_str())
            .unwrap_or("Request failed.")
            .to_string();
        let details = e.get("details").and_then(|d| d.as_object()).map(|d| {
            d.iter()
                .map(|(k, val)| {
                    let val = val
                        .as_str()
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| val.to_string());
                    format!("{}: {}", k, val)
                })
                .collect::<Vec<_>>()
                .join("; ")
        });
        match details {
            Some(d) if !d.is_empty() => Some(format!("{} ({})", m, d)),
            _ => Some(m),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    /// Cloud sends an object ({name, vendor, docsUrl}); keep it opaque.
    #[serde(default)]
    pub product: Option<serde_json::Value>,
    /// Newer /api/config deployments may expose these at the top level.
    #[serde(default, alias = "require_license")]
    pub require_license: Option<bool>,
    #[serde(default, alias = "enable_ai_credit_purchase")]
    pub enable_ai_credit_purchase: bool,
    #[serde(default, alias = "ai_credit_purchase_url")]
    pub ai_credit_purchase_url: Option<String>,
    /// Legacy/reference deployments may expose the upgrade URL at the top
    /// level; publish() normalizes it into links.buyUrl for React.
    #[serde(default, alias = "buy_url", alias = "purchaseUrl", alias = "purchase_url")]
    pub buy_url: Option<String>,
    #[serde(default)]
    pub licensing: Licensing,
    #[serde(default)]
    pub maintenance: Maintenance,
    #[serde(default)]
    pub links: Links,
    #[serde(default)]
    pub versions: Versions,
    #[serde(default)]
    pub announcements: Vec<Announcement>,
    /// Flexible feature configuration. License Cloud deployments can publish
    /// either `features`, `premiumFeatures`, or nested `licensing.features`
    /// without breaking older desktop builds.
    #[serde(default)]
    pub features: Value,
    #[serde(default, alias = "premium_features")]
    pub premium_features: Value,
    #[serde(default)]
    pub limits: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Licensing {
    #[serde(default, alias = "require_license")]
    pub require_license: bool,
    #[serde(default = "default_interval", alias = "verify_interval_hours")]
    pub verify_interval_hours: u32,
    #[serde(default = "default_grace", alias = "offline_grace_days")]
    pub offline_grace_days: u32,
    #[serde(default, alias = "enable_ai_credit_purchase")]
    pub enable_ai_credit_purchase: bool,
    #[serde(default, alias = "ai_credit_purchase_url")]
    pub ai_credit_purchase_url: Option<String>,
    #[serde(default)]
    pub features: Value,
    #[serde(default, alias = "premium_features")]
    pub premium_features: Value,
    #[serde(default)]
    pub limits: Value,
}
fn default_interval() -> u32 {
    24
}
fn default_grace() -> u32 {
    30
}
impl Default for Licensing {
    fn default() -> Self {
        Self {
            require_license: false,
            verify_interval_hours: default_interval(),
            offline_grace_days: default_grace(),
            enable_ai_credit_purchase: false,
            ai_credit_purchase_url: None,
            features: Value::Null,
            premium_features: Value::Null,
            limits: Value::Null,
        }
    }
}

/// Stable feature keys understood by the desktop. Cloud may publish aliases
/// such as `connectDb` or `premium_features`; they are normalized here so the
/// renderer and Rust commands use one policy vocabulary.
pub const BASIC_IMPORT_ROW_LIMIT: u64 = 5_000;
pub const DEFAULT_PREMIUM_FEATURES: &[&str] = &[
    "connect_db",
    "push",
    "import_large",
    "export_non_csv",
    "marketplace",
    "plugin_install",
    "installed_plugins",
    "premium_data_workflows",
];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeaturePolicy {
    pub premium_features: Vec<String>,
    pub basic_import_row_limit: u64,
}

impl Default for FeaturePolicy {
    fn default() -> Self {
        Self {
            premium_features: DEFAULT_PREMIUM_FEATURES.iter().map(|s| (*s).to_string()).collect(),
            basic_import_row_limit: BASIC_IMPORT_ROW_LIMIT,
        }
    }
}

pub fn canonical_feature(raw: &str) -> String {
    let compact: String = raw
        .trim()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect();
    match compact.as_str() {
        "connectdb" | "databaseconnect" | "databaseconnection" => "connect_db".into(),
        "push" | "datapush" | "pushdatabase" => "push".into(),
        "importlarge" | "largeimport" | "importover5000" | "rowsabove5000" => "import_large".into(),
        "exportnoncsv" | "noncsvexport" | "exportformats" | "export" => "export_non_csv".into(),
        "marketplace" | "pluginmarketplace" => "marketplace".into(),
        "plugininstall" | "installplugins" => "plugin_install".into(),
        "installedplugins" | "marketplaceplugins" | "plugins" => "installed_plugins".into(),
        "premiumdataworkflows" | "premiumworkflows" => "premium_data_workflows".into(),
        _ => raw
            .trim()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '_' })
            .collect::<String>()
            .split('_')
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("_"),
    }
}

fn collect_feature_value(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(s) => {
            let key = canonical_feature(s);
            if !key.is_empty() && !out.contains(&key) { out.push(key); }
        }
        Value::Array(items) => {
            for item in items { collect_feature_value(item, out); }
        }
        Value::Object(map) => {
            let wrappers = ["premium", "premiumFeatures", "premium_features", "paid", "pro", "required"];
            let found_wrapper = map
                .keys()
                .any(|key| wrappers.iter().any(|wrapper| wrapper.eq_ignore_ascii_case(key)));
            for (key, value) in map {
                if wrappers.iter().any(|wrapper| wrapper.eq_ignore_ascii_case(key)) {
                    if value.as_bool() == Some(true) {
                        if !out.iter().any(|feature| feature == "all") {
                            out.push("all".into());
                        }
                    } else {
                        collect_feature_value(value, out);
                    }
                    continue;
                }
                let premium = value.as_bool() == Some(true)
                    || value
                        .as_str()
                        .map(|s| matches!(s.to_ascii_lowercase().as_str(), "premium" | "pro" | "paid" | "required"))
                        .unwrap_or(false)
                    || value.get("premium").and_then(|v| v.as_bool()) == Some(true)
                    || value.get("required").and_then(|v| v.as_bool()) == Some(true);
                if premium || !found_wrapper && value.is_string() {
                    let feature = canonical_feature(key);
                    if !feature.is_empty() && !out.contains(&feature) {
                        out.push(feature);
                    }
                }
            }
        }
        _ => {}
    }
}

fn is_basic_limit_key(key: &str) -> bool {
    [
        "basicImportRowLimit",
        "basic_import_row_limit",
        "maxBasicRows",
        "max_basic_rows",
        "basicMaxRows",
        "basic_max_rows",
        "maxRowsBasic",
        "max_rows_basic",
        "basicImportLimit",
        "basic_import_limit",
    ]
    .iter()
    .any(|candidate| candidate.eq_ignore_ascii_case(key))
}

/// Whether a value contains an explicit premium-feature policy. Limits-only
/// objects are not feature policies and must retain the conservative defaults.
fn has_feature_policy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::String(_) | Value::Array(_) => true,
        Value::Object(map) => {
            let wrappers = ["premium", "premiumFeatures", "premium_features", "paid", "pro", "required"];
            if map.iter().any(|(key, value)| {
                wrappers.iter().any(|wrapper| wrapper.eq_ignore_ascii_case(key)) && !value.is_null()
            }) {
                return true;
            }
            map.iter().any(|(key, value)| {
                if key.eq_ignore_ascii_case("limits") || is_basic_limit_key(key) {
                    return false;
                }
                value.is_boolean()
                    || value.is_string()
                    || value
                        .as_object()
                        .map(|nested| {
                            nested.keys().any(|nested_key| {
                                nested_key.eq_ignore_ascii_case("premium")
                                    || nested_key.eq_ignore_ascii_case("required")
                            })
                        })
                        .unwrap_or(false)
            })
        }
        _ => false,
    }
}

fn find_basic_limit(value: &Value) -> Option<u64> {
    match value {
        Value::Object(map) => {
            for key in [
                "basicImportRowLimit",
                "basic_import_row_limit",
                "maxBasicRows",
                "max_basic_rows",
                "basicMaxRows",
                "basic_max_rows",
                "maxRowsBasic",
                "max_rows_basic",
                "basicImportLimit",
                "basic_import_limit",
            ] {
                if let Some(v) = map.get(key).and_then(|v| v.as_u64()) { return Some(v.max(1)); }
            }
            for nested in map.values() {
                if let Some(v) = find_basic_limit(nested) { return Some(v); }
            }
            None
        }
        Value::Array(items) => items.iter().find_map(find_basic_limit),
        _ => None,
    }
}

impl FeaturePolicy {
    pub fn is_premium(&self, feature: &str) -> bool {
        let key = canonical_feature(feature);
        self.premium_features.iter().any(|v| v == "all" || v == &key)
    }
}

impl Config {
    pub fn feature_policy(&self) -> FeaturePolicy {
        let mut premium = Vec::new();
        collect_feature_value(&self.features, &mut premium);
        collect_feature_value(&self.premium_features, &mut premium);
        collect_feature_value(&self.licensing.features, &mut premium);
        collect_feature_value(&self.licensing.premium_features, &mut premium);
        let policy_present = has_feature_policy(&self.features)
            || has_feature_policy(&self.premium_features)
            || has_feature_policy(&self.licensing.features)
            || has_feature_policy(&self.licensing.premium_features);
        if premium.is_empty() && !policy_present {
            premium = FeaturePolicy::default().premium_features;
        }
        let limit = find_basic_limit(&self.limits)
            .or_else(|| find_basic_limit(&self.features))
            .or_else(|| find_basic_limit(&self.premium_features))
            .or_else(|| find_basic_limit(&self.licensing.limits))
            .or_else(|| find_basic_limit(&self.licensing.features))
            .or_else(|| find_basic_limit(&self.licensing.premium_features))
            .unwrap_or(BASIC_IMPORT_ROW_LIMIT)
            .max(1);
        FeaturePolicy { premium_features: premium, basic_import_row_limit: limit }
    }

    pub fn requires_license(&self) -> bool {
        self.require_license.unwrap_or(self.licensing.require_license)
    }

    pub fn ai_credit_purchase_enabled(&self) -> bool {
        self.enable_ai_credit_purchase || self.licensing.enable_ai_credit_purchase
    }

    pub fn ai_credit_purchase_url(&self) -> Option<&str> {
        self.ai_credit_purchase_url
            .as_deref()
            .or(self.licensing.ai_credit_purchase_url.as_deref())
    }
}

/// Runtime enforcement posture (§2): unrestricted = paid cloud workflows off.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum EnforcementMode {
    #[default]
    Unrestricted,
    Licensed,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Maintenance {
    #[serde(default)]
    pub enabled: bool,
    /// Only an explicit hard state blocks; soft = non-blocking banner.
    #[serde(default)]
    pub hard: bool,
    #[serde(default)]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Links {
    #[serde(default, alias = "buy_url", alias = "purchaseUrl", alias = "purchase_url")]
    pub buy_url: Option<String>,
    #[serde(default, alias = "github_url")]
    pub github_url: Option<String>,
    #[serde(default, alias = "support_email")]
    pub support_email: Option<String>,
    #[serde(default, alias = "docs_url")]
    pub docs_url: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Versions {
    #[serde(default)]
    pub latest: Option<String>,
    #[serde(default)]
    pub minimum: Option<String>,
    #[serde(default, alias = "download_url")]
    pub download_url: Option<String>,
    #[serde(default, alias = "windows_download_url")]
    pub windows_download_url: Option<String>,
    #[serde(default, alias = "linux_download_url")]
    pub linux_download_url: Option<String>,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default, alias = "release_notes")]
    pub release_notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Announcement {
    pub id: String,
    /// info | warning | critical
    #[serde(default, rename = "type", alias = "kind")]
    pub kind: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default, rename = "updatedAt", alias = "updated_at")]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub link: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// "all" | platform string | array of platforms
    #[serde(default)]
    pub audience: Option<serde_json::Value>,
    #[serde(default, rename = "startDate")]
    pub start_date: Option<String>,
    #[serde(default, rename = "endDate")]
    pub end_date: Option<String>,
    #[serde(default = "default_true")]
    pub dismissible: bool,
    #[serde(default)]
    pub priority: i64,
    #[serde(default, rename = "buttonText")]
    pub button_text: Option<String>,
    #[serde(default, rename = "buttonUrl")]
    pub button_url: Option<String>,
}

fn default_true() -> bool {
    true
}

/* ----------------------------- payloads ----------------------------- */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallPayload {
    pub device_id: String,
    pub machine_id: String,
    pub platform: String,
    pub app_version: String,
    pub architecture: String,
    pub os_version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivatePayload {
    pub license_key: String,
    pub device_id: String,
    pub machine_id: String,
    pub platform: String,
    pub app_version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub license_key: Option<String>,
    pub activation_token: String,
    pub device_id: String,
    pub machine_id: String,
    pub platform: String,
    pub app_version: String,
}

/// Server-provided entitlements. NEVER infer these from the plan name.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entitlements {
    /// Production Cloud currently spells this `cloudAI`; the desktop's
    /// canonical camelCase output remains `cloudAi`.
    #[serde(default, alias = "cloudAI", alias = "cloud_ai")]
    pub cloud_ai: bool,
    #[serde(default, alias = "ai_plugins")]
    pub ai_plugins: bool,
    #[serde(default)]
    pub agents: bool,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivateOk {
    #[serde(default, alias = "token")]
    pub activation_token: Option<String>,
    #[serde(default)]
    pub plan: Option<String>,
    #[serde(default, alias = "expires")]
    pub expires_at: Option<String>,
    #[serde(default)]
    pub verify_interval_hours: Option<u32>,
    #[serde(default)]
    pub offline_grace_days: Option<u32>,
    #[serde(default)]
    pub entitlements: Option<Entitlements>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyOk {
    /// granted | blocked | expired | device_mismatch | token_invalid
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default, alias = "token")]
    pub activation_token: Option<String>,
    #[serde(default)]
    pub plan: Option<String>,
    #[serde(default)]
    pub expires_at: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub entitlements: Option<Entitlements>,
    /// Server-directed next verification time (overrides interval).
    #[serde(default)]
    pub next_check_in_at: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn omitted_feature_policy_uses_conservative_defaults() {
        let config: Config = serde_json::from_value(json!({
            "licensing": { "requireLicense": true }
        }))
        .expect("config");
        let policy = config.feature_policy();
        assert!(policy.is_premium("connectDb"));
        assert!(policy.is_premium("export_non_csv"));
        assert_eq!(policy.basic_import_row_limit, BASIC_IMPORT_ROW_LIMIT);
    }

    #[test]
    fn explicit_empty_cloud_policy_stays_empty() {
        let config: Config = serde_json::from_value(json!({
            "licensing": {
                "requireLicense": true,
                "premiumFeatures": []
            }
        }))
        .expect("config");
        assert!(!config.feature_policy().is_premium("connectDb"));
    }

    #[test]
    fn limits_only_do_not_clear_default_premium_features() {
        let config: Config = serde_json::from_value(json!({
            "licensing": { "requireLicense": true },
            "features": { "basicImportRowLimit": 10000 }
        }))
        .expect("config");
        let policy = config.feature_policy();
        assert!(policy.is_premium("connectDb"));
        assert_eq!(policy.basic_import_row_limit, 10000);
    }

    #[test]
    fn nested_feature_policy_and_basic_limit_are_normalized() {
        let config: Config = serde_json::from_value(json!({
            "licensing": {
                "requireLicense": true,
                "features": {
                    "premiumFeatures": ["connectDb", "nonCsvExport"],
                    "limits": { "basicImportRowLimit": 2500 }
                }
            }
        }))
        .expect("config");
        let policy = config.feature_policy();
        assert!(policy.is_premium("connect_db"));
        assert!(policy.is_premium("export_non_csv"));
        assert!(!policy.is_premium("push"));
        assert_eq!(policy.basic_import_row_limit, 2500);
    }
}
