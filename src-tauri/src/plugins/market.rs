//! Plugin marketplace: catalogue search + verified install (US-05, §35–39).
//!
//! The catalogue is fetched from the discovery-resolved (signature-verified)
//! endpoint in every license mode. Public installs require an HTTPS-or-loopback
//! artifact URL **and** a catalogue sha256; bundled first-party development
//! artifacts may be installed from `plugins/catalog`. Unverified packages are
//! refused. Archives are extracted with a zip-slip guard and must contain a valid
//! `manifest.json`.

use super::{manifest::Manifest, sync};
use crate::cloud::client::CloudClient;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

fn deserialize_optional_u64_or_string<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    match value {
        Value::Null => Ok(None),
        Value::Number(number) => number
            .as_u64()
            .map(Some)
            .ok_or_else(|| serde::de::Error::custom("expected a non-negative integer")),
        Value::String(text) => text
            .trim()
            .parse::<u64>()
            .map(Some)
            .map_err(|_| serde::de::Error::custom("expected a non-negative integer")),
        _ => Err(serde::de::Error::custom("expected a non-negative integer")),
    }
}

fn deserialize_string_or_number<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    match value {
        Value::Null => Ok(String::new()),
        Value::String(text) => Ok(text),
        Value::Number(number) => Ok(number.to_string()),
        _ => Err(serde::de::Error::custom("expected a string or number")),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketEntry {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default, deserialize_with = "deserialize_string_or_number")]
    pub version: String,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub homepage: Option<String>,
    #[serde(default)]
    pub min_app_version: Option<String>,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub artifact_url: Option<String>,
    /// Publication timestamp from the catalogue. Older catalogue payloads are
    /// normalized to publishedAt before deserialization.
    #[serde(default)]
    pub published_at: Option<serde_json::Value>,
    #[serde(default)]
    pub entitled: bool,
    #[serde(default)]
    pub sync_action: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "deserialize_optional_u64_or_string")]
    pub downloads: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketResult {
    pub available: bool,
    pub reason: Option<String>,
    pub results: Vec<MarketEntry>,
}

fn url_encode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(byte as char),
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// The publisher API uses pluginId/latestVersion/summary while the desktop
/// installer historically consumed id/version/description. Normalize aliases
/// before serde deserialization so duplicate JSON fields or a null version do
/// not silently drop a published plugin from the catalogue.
fn normalize_catalogue_entry(value: &Value) -> Value {
    let mut item = value.clone();

    // The cloud catalogue includes the selected release twice: the legacy
    // list fields (`latestVersion`, `sha256`, `downloadUrl`) and a richer
    // `version` object. The desktop model stores version as a string, so
    // flatten the richer object before deserialization instead of dropping
    // the whole plugin entry when serde sees an object where it expects text.
    if let Some(release) = item.get("version").cloned().filter(|value| value.is_object()) {
        if let Some(version) = release.get("version").cloned() {
            item["version"] = version;
        }
        for (target, source) in [
            ("sha256", "sha256"),
            ("artifactUrl", "downloadUrl"),
            ("publishedAt", "publishedAt"),
        ] {
            let missing = item.get(target).map(|value| value.is_null()).unwrap_or(true);
            if missing {
                if let Some(value) = release.get(source).cloned() {
                    item[target] = value;
                }
            }
        }
    }

    fn set_from_aliases(item: &mut Value, target: &str, aliases: &[&str]) {
        let missing = item.get(target).map(|v| v.is_null()).unwrap_or(true);
        if missing {
            let replacement = aliases.iter().find_map(|key| item.get(*key).cloned());
            if let Some(value) = replacement {
                item[target] = value;
            }
        }
        if let Some(object) = item.as_object_mut() {
            for key in aliases {
                object.remove(*key);
            }
        }
    }

    set_from_aliases(&mut item, "id", &["pluginId"]);
    set_from_aliases(&mut item, "version", &["latestVersion"]);
    let summary = item.get("summary").cloned();
    set_from_aliases(&mut item, "description", &["summary"]);
    if let Some(summary) = summary {
        item["summary"] = summary;
    }
    set_from_aliases(&mut item, "author", &["publisher"]);
    set_from_aliases(&mut item, "icon", &["iconUrl"]);
    set_from_aliases(&mut item, "artifactUrl", &["artifactURL", "downloadUrl", "download_url"]);
    set_from_aliases(
        &mut item,
        "publishedAt",
        &["published_at", "createdAt", "created_at", "releasedAt", "released_at"],
    );
    set_from_aliases(
        &mut item,
        "downloads",
        &["installs", "installCount", "downloadCount", "download_count"],
    );
    item
}

fn catalog_has_zip(root: &Path) -> bool {
    fs::read_dir(root.join("catalog"))
        .map(|files| {
            files.flatten().any(|file| {
                file.path()
                    .extension()
                    .and_then(|value| value.to_str())
                    .map(|value| value.eq_ignore_ascii_case("zip"))
                    == Some(true)
            })
        })
        .unwrap_or(false)
}

fn local_catalog_root(root: &Path) -> PathBuf {
    // In a packaged app, mutable plugin installs live below DATAREFINE_DATA,
    // while read-only first-party ZIPs live beside the executable under
    // resources/datarefine/plugins/catalog. Keep the two roots separate so a
    // release install can still use its bundled catalogue.
    if catalog_has_zip(root) {
        return root.to_path_buf();
    }
    // Only the normal production plugin root receives the resource fallback.
    // Keeping arbitrary caller/test roots isolated prevents a temporary test
    // directory (or a user-supplied import root) from unexpectedly seeing the
    // application's bundled catalogue.
    let data_plugins = crate::data_root().join("plugins");
    if root == data_plugins.as_path() {
        let bundled = crate::project_root().join("plugins");
        if catalog_has_zip(&bundled) {
            return bundled;
        }
    }
    root.to_path_buf()
}

fn catalogue_id_key(id: &str) -> String {
    id.strip_prefix("datarefine.").unwrap_or(id).to_lowercase()
}

fn zip_json(bytes: &[u8], names: &[&str]) -> Option<Value> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).ok()?;
    for name in names {
        let Ok(mut file) = archive.by_name(name) else { continue };
        let mut raw = Vec::new();
        if file.read_to_end(&mut raw).is_ok() {
            if let Ok(value) = serde_json::from_slice::<Value>(&raw) {
                return Some(value);
            }
        }
    }
    None
}

/// Read bundled first-party ZIPs as catalogue entries. This is deliberately
/// directory-driven: adding another ZIP under plugins/catalog makes it appear
/// in the marketplace without adding another plugin-specific code branch.
fn local_catalogue_entries(root: &Path) -> Vec<MarketEntry> {
    let dir = root.join("catalog");
    let Ok(files) = fs::read_dir(dir) else { return Vec::new() };
    let mut entries = Vec::new();
    for file in files.flatten() {
        let path = file.path();
        if path.extension().and_then(|v| v.to_str()).map(|v| v.eq_ignore_ascii_case("zip")) != Some(true) {
            continue;
        }
        let Ok(bytes) = fs::read(&path) else { continue };
        let Some(manifest) = zip_json(&bytes, &["manifest.json"]) else { continue };
        let plugin = zip_json(&bytes, &["datarefine.plugin.json", "datarefine.extension.json"])
            .unwrap_or_else(|| Value::Object(serde_json::Map::new()));
        let marketplace = zip_json(&bytes, &["marketplace.json"])
            .unwrap_or_else(|| Value::Object(serde_json::Map::new()));
        let stem = path.file_stem().and_then(|v| v.to_str()).unwrap_or("").trim();
        let manifest_id = manifest.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let marketplace_id = marketplace.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let id = if !marketplace_id.is_empty() {
            marketplace_id.to_string()
        } else if !manifest_id.is_empty() {
            manifest_id.to_string()
        } else if !stem.is_empty() {
            stem.to_string()
        } else {
            continue;
        };
        let name = marketplace
            .get("name")
            .and_then(|v| v.as_str())
            .or_else(|| plugin.get("displayName").and_then(|v| v.as_str()))
            .or_else(|| manifest.get("name").and_then(|v| v.as_str()))
            .map(str::to_string)
            .unwrap_or_else(|| id.clone());
        let description = manifest
            .get("description")
            .and_then(|v| v.as_str())
            .or_else(|| plugin.get("description").and_then(|v| v.as_str()))
            .unwrap_or("")
            .to_string();
        let summary = plugin
            .get("description")
            .and_then(|v| v.as_str())
            .or_else(|| manifest.get("description").and_then(|v| v.as_str()))
            .map(str::to_string);
        let sha256: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
        entries.push(MarketEntry {
            id,
            name,
            version: marketplace
                .get("version")
                .and_then(|v| v.as_str())
                .or_else(|| manifest.get("version").and_then(|v| v.as_str()))
                .or_else(|| plugin.get("version").and_then(|v| v.as_str()))
                .unwrap_or("0.0.0")
                .to_string(),
            summary,
            description,
            author: marketplace
                .get("publisher")
                .and_then(|v| v.as_str())
                .or_else(|| manifest.get("publisher").and_then(|v| v.as_str()))
                .or_else(|| plugin.get("publisher").and_then(|v| v.as_str()))
                .unwrap_or("")
                .to_string(),
            icon: marketplace
                .get("icon")
                .and_then(|v| v.as_str())
                .or_else(|| manifest.get("icon").and_then(|v| v.as_str()))
                .or_else(|| plugin.get("icon").and_then(|v| v.as_str()))
                .map(str::to_string),
            category: None,
            capabilities: manifest
                .get("capabilities")
                .and_then(|v| v.as_array())
                .map(|values| values.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                .unwrap_or_default(),
            homepage: None,
            min_app_version: None,
            sha256: Some(sha256),
            artifact_url: None,
            published_at: None,
            entitled: true,
            sync_action: Some("keep".into()),
            downloads: marketplace
                .get("downloads")
                .and_then(|v| v.as_u64()),
        });
    }
    entries
}

fn merge_local_catalogue(entries: &mut Vec<MarketEntry>, root: &Path) {
    for local in local_catalogue_entries(root) {
        if let Some(remote) = entries.iter_mut().find(|entry| catalogue_id_key(&entry.id) == catalogue_id_key(&local.id)) {
            if remote.name.is_empty() { remote.name = local.name.clone(); }
            if remote.sha256.as_deref().unwrap_or("").is_empty() { remote.sha256 = local.sha256.clone(); }
            if remote.version.is_empty() || remote.version == "0.0.0" { remote.version = local.version.clone(); }
            if remote.summary.is_none() { remote.summary = local.summary.clone(); }
            if remote.description.is_empty() { remote.description = local.description.clone(); }
            if remote.author.is_empty() { remote.author = local.author.clone(); }
            if remote.icon.is_none() { remote.icon = local.icon.clone(); }
            if remote.capabilities.is_empty() { remote.capabilities = local.capabilities.clone(); }
            if remote.downloads.is_none() { remote.downloads = local.downloads; }
        } else {
            entries.push(local);
        }
    }
}

fn local_fallback_result(root: &Path, query: &str, reason: String) -> MarketResult {
    let q = query.trim().to_lowercase();
    let local_root = local_catalog_root(root);
    let mut results = local_catalogue_entries(&local_root);
    if !q.is_empty() {
        results.retain(|entry| {
            entry.name.to_lowercase().contains(&q)
                || entry.id.to_lowercase().contains(&q)
                || entry.description.to_lowercase().contains(&q)
                || entry.summary.as_deref().unwrap_or("").to_lowercase().contains(&q)
        });
    }
    MarketResult { available: !results.is_empty(), reason: Some(reason), results }
}

/// Search the cloud catalogue. The marketplace is ALWAYS available —
/// browsing and installs do not depend on license mode. (Entitlement per
/// package still comes from the catalogue itself.)
pub fn search(cloud: &Arc<CloudClient>, root: &Path, query: &str) -> MarketResult {
    // Load the complete catalogue once. Search and sorting happen locally in
    // the desktop UI, avoiding a network request for every keystroke.
    let path = "/api/plugins".to_string();
    let raw = match cloud.get(&path) {
        Ok(r) => r,
        Err(e) => {
            return local_fallback_result(root, query, format!("Catalogue unavailable: {}", e.message));
        }
    };
    if raw.status >= 400 {
        return local_fallback_result(root, query, format!("Catalogue HTTP {}", raw.status));
    }
    let Some(arr) = raw
        .body
        .pointer("/data/plugins")
        .and_then(|v| v.as_array())
        .or_else(|| raw.body.get("data").and_then(|v| v.as_array()))
    else {
        return local_fallback_result(root, query, "Catalogue response malformed.".into());
    };
    let mut entries: Vec<MarketEntry> = arr
        .iter()
        .map(normalize_catalogue_entry)
        .filter_map(|v| serde_json::from_value(v).ok())
        .collect();
    let local_root = local_catalog_root(root);
    merge_local_catalogue(&mut entries, &local_root);
    let q = query.trim().to_lowercase();
    if !q.is_empty() {
        entries.retain(|e| {
            e.name.to_lowercase().contains(&q)
                || e.id.to_lowercase().contains(&q)
                || e.description.to_lowercase().contains(&q)
                || e.summary.as_deref().unwrap_or("").to_lowercase().contains(&q)
                || e.author.to_lowercase().contains(&q)
                || e.category.as_deref().unwrap_or("").to_lowercase().contains(&q)
        });
    }
    MarketResult { available: true, reason: None, results: entries }
}

fn value_as_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

/// The catalogue list is intentionally lightweight and the cloud keeps
/// version artefacts in the plugin detail endpoint. Resolve that detail only
/// for an install, so Marketplace opening stays fast while installs still use
/// the publisher's checksum and download URL when they are available.
fn enrich_entry_from_detail(cloud: &Arc<CloudClient>, entry: &mut MarketEntry) {
    let id = entry.id.strip_prefix("datarefine.").unwrap_or(&entry.id);
    let path = format!("/api/plugins/{}", url_encode(id));
    let Ok(raw) = cloud.get(&path) else { return };
    if raw.status >= 400 { return; }
    let Some(data) = raw.body.get("data") else { return; };

    if let Some(plugin) = data.get("plugin").and_then(|value| value.as_object()) {
        if entry.name.is_empty() {
            if let Some(value) = plugin.get("name").and_then(value_as_text) { entry.name = value; }
        }
        if entry.version.is_empty() || entry.version == "0.0.0" {
            if let Some(value) = plugin.get("latestVersion").and_then(value_as_text) { entry.version = value; }
        }
        if entry.summary.is_none() {
            entry.summary = plugin.get("summary").and_then(value_as_text);
        }
        if entry.description.is_empty() {
            if let Some(value) = plugin.get("description").and_then(value_as_text) { entry.description = value; }
        }
        if entry.author.is_empty() {
            if let Some(value) = plugin.get("author").and_then(value_as_text) { entry.author = value; }
        }
        if entry.category.is_none() {
            entry.category = plugin.get("category").and_then(value_as_text);
        }
        if entry.homepage.is_none() {
            entry.homepage = plugin.get("homepage").and_then(value_as_text);
        }
        if entry.min_app_version.is_none() {
            entry.min_app_version = plugin.get("minAppVersion").and_then(value_as_text);
        }
        if entry.icon.is_none() {
            entry.icon = plugin.get("iconUrl").and_then(value_as_text);
        }
    }

    let Some(versions) = data.get("versions").and_then(|value| value.as_array()) else { return; };
    let selected = versions
        .iter()
        .filter(|version| !version.get("yanked").and_then(|value| value.as_bool()).unwrap_or(false))
        .find(|version| {
            version
                .get("version")
                .and_then(value_as_text)
                .map(|value| value == entry.version)
                .unwrap_or(false)
        })
        .or_else(|| {
            versions
                .iter()
                .find(|version| !version.get("yanked").and_then(|value| value.as_bool()).unwrap_or(false))
        });
    let Some(version) = selected else { return; };
    if entry.version.is_empty() || entry.version == "0.0.0" {
        if let Some(value) = version.get("version").and_then(value_as_text) { entry.version = value; }
    }
    let detail_sha = version
        .get("sha256")
        .and_then(value_as_text)
        .or_else(|| version.get("checksum").and_then(value_as_text))
        .filter(|value| !value.trim().is_empty());
    let detail_url = version
        .get("downloadUrl")
        .and_then(value_as_text)
        .or_else(|| version.get("artifactUrl").and_then(value_as_text))
        .or_else(|| version.get("artifactURL").and_then(value_as_text))
        .filter(|value| !value.trim().is_empty());
    // A detail record is authoritative when it contains a downloadable
    // artifact. This prevents a locally bundled checksum from masking a newer
    // cloud upload; if the cloud has no URL, keep the local checksum for the
    // bundled-artifact fallback.
    if let Some(url) = detail_url {
        entry.artifact_url = Some(url);
        if let Some(sha) = detail_sha.clone() { entry.sha256 = Some(sha); }
    } else if entry.sha256.as_deref().unwrap_or("").is_empty() {
        entry.sha256 = detail_sha;
    }
    if entry.published_at.is_none() {
        entry.published_at = version.get("publishedAt").cloned();
    }
}

fn artifact_url_ok(url: &str) -> bool {
    url.starts_with("https://")
        || url.starts_with("http://127.0.0.1:")
        || url.starts_with("http://localhost:")
}

fn extract_zip(bytes: &[u8], dest: &Path) -> Result<(), String> {
    let mut archive =
        zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| format!("Not a valid zip archive: {e}"))?;
    for i in 0..archive.len() {
        let mut f = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = f.name().to_string();
        let rel = PathBuf::from(&name);
        if rel.is_absolute()
            || rel
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err(format!("Unsafe path inside package: {name}"));
        }
        let out = dest.join(&rel);
        if f.is_dir() {
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut buf = Vec::new();
        f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        fs::write(&out, &buf).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub type Fetcher = dyn Fn(&str, &Path) -> Result<u64, String>;

fn install_bytes(root: &Path, entry: &MarketEntry, bytes: &[u8], expected: &str) -> Result<Manifest, String> {
    let sum: String = Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect();
    if !sum.eq_ignore_ascii_case(expected) {
        return Err("Artifact checksum mismatch — install aborted.".into());
    }

    let dest = root.join("installed").join(&entry.id);
    if dest.exists() {
        fs::remove_dir_all(&dest).map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    if let Err(e) = extract_zip(bytes, &dest) {
        let _ = fs::remove_dir_all(&dest);
        return Err(e);
    }
    let Some(m) = Manifest::load(&dest) else {
        let _ = fs::remove_dir_all(&dest);
        return Err("Package contains no valid manifest.json.".into());
    };
    let record = json!({
        "id": entry.id,
        "version": entry.version,
        "sha256": expected,
        "source": "marketplace",
        "installedAt": crate::app::policy::now_ms(),
    });
    let _ = fs::write(
        dest.join(".drs-install.json"),
        serde_json::to_string_pretty(&record).unwrap_or_default(),
    );
    // A fresh install must not stay disabled from an earlier sync.
    let _ = sync::set_disabled(root, &entry.id, false, "");
    Ok(m)
}

/// Verified public marketplace install: trusted URL → sha256 → zip-slip-safe
/// extract → manifest check → install record. Marketplace visibility and
/// installation are no longer gated by a DataRefine license entitlement.
pub fn install_with(root: &Path, entry: &MarketEntry, fetch: &Fetcher) -> Result<Manifest, String> {
    let url = entry
        .artifact_url
        .as_deref()
        .filter(|u| artifact_url_ok(u))
        .ok_or_else(|| "This plugin has not uploaded a downloadable artifact yet.".to_string())?;
    let expected = entry
        .sha256
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "This plugin is missing its published checksum.".to_string())?;

    let tmp = std::env::temp_dir().join(format!("drs-market-{}-{}.zip", entry.id, entry.version));
    fetch(url, &tmp)?;
    let bytes = fs::read(&tmp).map_err(|e| e.to_string());
    let _ = fs::remove_file(&tmp);
    let bytes = bytes?;
    install_bytes(root, entry, &bytes, expected)
}

/// First-party development artifacts are bundled under plugins/catalog. This
/// keeps the marketplace installable during deployments whose portal has a
/// catalogue record but has not configured public artifact storage yet.
fn install_local_catalog_artifact(root: &Path, entry: &MarketEntry) -> Result<Manifest, String> {
    let catalog = local_catalog_root(root).join("catalog");
    let direct = catalog.join(format!("{}.zip", entry.id));
    let short_id = entry.id.strip_prefix("datarefine.").unwrap_or(&entry.id);
    let short = catalog.join(format!("{}.zip", short_id));
    let path = if direct.is_file() { direct } else { short };
    let bytes = fs::read(&path).map_err(|_| "This plugin has not uploaded a downloadable artifact yet.".to_string())?;
    // A bundled ZIP is a signed-at-build-time first-party resource. When the
    // cloud has no usable artifact URL, verify the bytes against their local
    // checksum rather than a stale remote checksum for a different upload.
    let local_sum: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
    install_bytes(root, entry, &bytes, &local_sum)
}

pub fn install(cloud: &Arc<CloudClient>, root: &Path, id: &str) -> Result<Manifest, String> {
    let res = search(cloud, root, "");
    if !res.available {
        return Err(res.reason.unwrap_or_else(|| "Marketplace unavailable.".into()));
    }
    let mut entry = res
        .results
        .into_iter()
        .find(|e| e.id == id)
        .ok_or_else(|| format!("Plugin '{id}' not found in the catalogue."))?;
    if entry.artifact_url.as_deref().unwrap_or("").is_empty()
        || entry.sha256.as_deref().unwrap_or("").is_empty()
    {
        enrich_entry_from_detail(cloud, &mut entry);
    }
    let has_remote_artifact = entry
        .artifact_url
        .as_deref()
        .map(artifact_url_ok)
        .unwrap_or(false)
        && entry.sha256.as_deref().map(|s| !s.is_empty()).unwrap_or(false);
    if !has_remote_artifact {
        let catalog = local_catalog_root(root).join("catalog");
        let short_id = entry.id.strip_prefix("datarefine.").unwrap_or(&entry.id);
        let local = catalog.join(format!("{}.zip", entry.id));
        let local_short = catalog.join(format!("{}.zip", short_id));
        if local.is_file() || local_short.is_file() {
            return install_local_catalog_artifact(root, &entry);
        }
    }
    install_with(root, &entry, &|u, p| crate::cloud::client::download_marketplace_file(u, p))
}

pub fn uninstall(root: &Path, id: &str) -> Result<(), String> {
    let dest = root.join("installed").join(id);
    if !dest.is_dir() {
        return Err(format!("Plugin '{id}' is not installed."));
    }
    fs::remove_dir_all(&dest).map_err(|e| e.to_string())
}

pub fn set_enabled(root: &Path, id: &str, enabled: bool) -> Result<(), String> {
    if !root.join("installed").join(id).is_dir() {
        return Err(format!("Plugin '{id}' is not installed."));
    }
    sync::set_disabled(root, id, !enabled, "user toggle").map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::client::RawResponse;
    use serde_json::{json, Value};

    fn tmp_root(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("drs-market-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(p.join("installed")).unwrap();
        p
    }

    fn mock_cloud(body: Value) -> Arc<CloudClient> {
        let b = body.clone();
        CloudClient::with_transport(
            "https://cloud.example",
            Arc::new(move |_m: &str, _u: &str, _body: Option<&Value>| {
                Ok(RawResponse { status: 200, retry_after_secs: None, body: b.clone() })
            }),
        )
    }

    fn entry(id: &str, sha: Option<&str>, url: Option<&str>, entitled: bool) -> MarketEntry {
        MarketEntry {
            id: id.into(),
            name: format!("{id} name"),
            version: "1.0.0".into(),
            summary: Some("test plugin".into()),
            description: "test plugin".into(),
            author: "tester".into(),
            icon: None,
            category: None,
            capabilities: vec![],
            homepage: None,
            min_app_version: None,
            sha256: sha.map(|s| s.to_string()),
            artifact_url: url.map(|s| s.to_string()),
            published_at: None,
            entitled,
            sync_action: None,
            downloads: None,
        }
    }

    fn make_zip(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let mut zw = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default();
            for (name, data) in files {
                zw.start_file(*name, opts).unwrap();
                std::io::Write::write_all(&mut zw, data).unwrap();
            }
            zw.finish().unwrap();
        }
        buf
    }

    #[test]
    fn install_detail_resolves_cloud_checksum_and_download_url() {
        let cloud = CloudClient::with_transport(
            "https://cloud.example",
            Arc::new(move |_method: &str, url: &str, _body: Option<&Value>| {
                if url.ends_with("/api/plugins/example") {
                    Ok(RawResponse {
                        status: 200,
                        retry_after_secs: None,
                        body: json!({
                            "ok": true,
                            "data": {
                                "plugin": {"pluginId": "example", "latestVersion": "2.0.0"},
                                "versions": [{
                                    "version": "2.0.0",
                                    "sha256": "abc",
                                    "downloadUrl": "https://cdn.example/example.zip",
                                    "publishedAt": "2026-09-29T00:00:00Z",
                                    "yanked": false
                                }]
                            }
                        }),
                    })
                } else {
                    Ok(RawResponse {
                        status: 200,
                        retry_after_secs: None,
                        body: json!({"ok": true, "data": {"plugins": []}}),
                    })
                }
            }),
        );
        let mut item = entry("example", None, None, true);
        item.version = "2.0.0".into();
        enrich_entry_from_detail(&cloud, &mut item);
        assert_eq!(item.sha256.as_deref(), Some("abc"));
        assert_eq!(item.artifact_url.as_deref(), Some("https://cdn.example/example.zip"));
    }

    #[test]
    fn bundled_catalogue_uses_manifest_identity_and_local_checksum() {
        let root = crate::project_root().join("plugins");
        let entries = local_catalogue_entries(&root);
        let ai = entries.iter().find(|entry| entry.id == "datarefine.ai-code-generator");
        assert!(ai.is_some());
        let ai = ai.unwrap();
        assert_eq!(ai.name, "AI Code Generator");
        assert_eq!(ai.version, "1.0.0");
        assert!(ai.sha256.as_deref().map(|s| s.len() == 64).unwrap_or(false));
        assert_eq!(ai.downloads, None);
    }

    #[test]
    fn marketplace_available_without_license_mode() {
        let calls = Arc::new(std::sync::Mutex::new(0u32));
        let c2 = calls.clone();
        let cloud = CloudClient::with_transport(
            "https://cloud.example",
            Arc::new(move |_m: &str, _u: &str, _b: Option<&Value>| {
                *c2.lock().unwrap() += 1;
                Ok(RawResponse {
                    status: 200,
                    retry_after_secs: None,
                    body: json!({"ok": true, "data": {"plugins": [{"id": "a", "name": "A", "entitled": true}]}}),
                })
            }),
        );
        // no license-mode precondition anymore: catalogue is always fetched
        let root = tmp_root("catalogue");
        let r = search(&cloud, &root, "");
        assert!(r.available);
        assert_eq!(r.results.len(), 1);
        assert!(*calls.lock().unwrap() >= 1);
    }

    #[test]
    fn catalogue_aliases_keep_version_and_install_counts_exact() {
        let value = normalize_catalogue_entry(&json!({
            "pluginId": "datarefine.example",
            "latestVersion": 2.4,
            "summary": "Example",
            "publisher": "DataRefine",
            "installCount": "42"
        }));
        let parsed: MarketEntry = serde_json::from_value(value).unwrap();
        assert_eq!(parsed.id, "datarefine.example");
        assert_eq!(parsed.version, "2.4");
        assert_eq!(parsed.downloads, Some(42));
        assert_eq!(parsed.description, "Example");
    }

    #[test]
    fn nested_cloud_release_is_flattened_for_marketplace_cards_and_install() {
        let value = normalize_catalogue_entry(&json!({
            "pluginId": "duplicate-fuzzy-matcher",
            "latestVersion": "1.0.0",
            "name": "Duplicate & Fuzzy Matcher",
            "summary": "Finds duplicate values.",
            "version": {
                "version": "1.0.0",
                "sha256": "ca1a900b92e3fba7036bc3a2dee3ccdb68a8a5da03560206a0f559563e0848c6",
                "sizeBytes": 8470,
                "downloadUrl": "https://cdn.example/duplicate-fuzzy-matcher.zip",
                "publishedAt": "2026-10-02T00:00:00Z",
                "yanked": false
            }
        }));
        let parsed: MarketEntry = serde_json::from_value(value).unwrap();
        assert_eq!(parsed.id, "duplicate-fuzzy-matcher");
        assert_eq!(parsed.version, "1.0.0");
        assert_eq!(parsed.sha256.as_deref(), Some("ca1a900b92e3fba7036bc3a2dee3ccdb68a8a5da03560206a0f559563e0848c6"));
        assert_eq!(parsed.artifact_url.as_deref(), Some("https://cdn.example/duplicate-fuzzy-matcher.zip"));
        assert_eq!(parsed.published_at, Some(json!("2026-10-02T00:00:00Z")));
    }

    #[test]
    fn search_parses_and_filters_client_side() {
        let cloud = mock_cloud(json!({"ok": true, "data": {"plugins": [
            {"id": "alpha", "name": "Alpha Cleaner", "description": "cleans columns", "author": "A", "entitled": true},
            {"id": "beta", "name": "Beta Charts", "description": "draws charts", "author": "B", "entitled": true}
        ]}}));
        let root = tmp_root("search");
        let all = search(&cloud, &root, "");
        assert!(all.available);
        assert_eq!(all.results.len(), 2);
        let hit = search(&cloud, &root, "charts");
        assert_eq!(hit.results.len(), 1);
        assert_eq!(hit.results[0].id, "beta");
    }

    #[test]
    fn bundled_first_party_install_uses_resource_catalog() {
        let root = tmp_root("bundled-install");
        fs::create_dir_all(root.join("catalog")).unwrap();
        fs::copy(
            crate::project_root().join("plugins/catalog/ai-code-generator.zip"),
            root.join("catalog/ai-code-generator.zip"),
        )
        .unwrap();
        let cloud = mock_cloud(json!({"ok": true, "data": {"plugins": [
            {"id": "datarefine.ai-code-generator", "name": "AI Code Generator", "version": "1.0.0", "entitled": true}
        ]}}));
        let manifest = install(&cloud, &root, "datarefine.ai-code-generator").unwrap();
        assert_eq!(manifest.id, "datarefine.ai-code-generator");
        assert!(root.join("installed/datarefine.ai-code-generator/manifest.json").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn install_refuses_untrusted_entries() {
        let root = tmp_root("refuse");
        let fetch: &Fetcher = &|_u, _p| Ok(0);
        // missing sha256
        assert!(install_with(&root, &entry("p", None, Some("https://x/y.zip"), true), fetch).is_err());
        // non-trusted url
        assert!(install_with(&root, &entry("p", Some(&"a".repeat(64)), Some("http://evil/x.zip"), true), fetch).is_err());
        // entitlement metadata does not block a public install; this fetcher
        // still fails because it does not write a ZIP artifact.
        assert!(install_with(&root, &entry("p", Some(&"a".repeat(64)), Some("https://x/y.zip"), false), fetch).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn install_happy_path_verifies_and_records() {
        let root = tmp_root("happy");
        let manifest = br#"{"id":"demo","name":"Demo","version":"1.0.0","type":"tool","permissions":[],"capabilities":[]}"#;
        let zip = make_zip(&[("manifest.json", manifest.as_slice()), ("plugin.js", &b"console.log(1)".as_slice())]);
        let sum: String = Sha256::digest(&zip).iter().map(|b| format!("{b:02x}")).collect();
        let z2 = zip.clone();
        let fetch: &Fetcher = &move |_u, p| {
            fs::write(p, &z2).map_err(|e| e.to_string())?;
            Ok(z2.len() as u64)
        };
        let m = install_with(&root, &entry("demo", Some(&sum), Some("https://cdn/x.zip"), false), fetch).unwrap();
        assert_eq!(m.id, "demo");
        assert!(root.join("installed/demo/.drs-install.json").exists());
        assert_eq!(super::super::registry::scan(&root).len(), 1);
        // wrong sha is refused and leaves nothing behind
        let root2 = tmp_root("happy2");
        let bad: &Fetcher = &move |_u, p| {
            fs::write(p, &zip).map_err(|e| e.to_string())?;
            Ok(zip.len() as u64)
        };
        assert!(install_with(&root2, &entry("demo", Some(&"0".repeat(64)), Some("https://cdn/x.zip"), true), bad).is_err());
        assert!(!root2.join("installed/demo").exists());
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&root2);
    }

    #[test]
    fn install_rejects_zip_slip() {
        let root = tmp_root("slip");
        let zip = make_zip(&[("../evil.txt", b"x".as_slice())]);
        let sum: String = Sha256::digest(&zip).iter().map(|b| format!("{b:02x}")).collect();
        let fetch: &Fetcher = &move |_u, p| {
            fs::write(p, &zip).map_err(|e| e.to_string())?;
            Ok(zip.len() as u64)
        };
        let res = install_with(&root, &entry("slip", Some(&sum), Some("https://cdn/x.zip"), true), fetch);
        assert!(res.is_err());
        assert!(!root.join("installed/slip").exists());
        assert!(!std::env::temp_dir().join("evil.txt").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn uninstall_and_enable_toggle() {
        let root = tmp_root("manage");
        let dir = root.join("installed").join("p1");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("manifest.json"), r#"{"id":"p1","name":"P","version":"1.0.0"}"#).unwrap();
        set_enabled(&root, "p1", false).unwrap();
        assert_eq!(super::super::registry::scan(&root).len(), 0);
        set_enabled(&root, "p1", true).unwrap();
        assert_eq!(super::super::registry::scan(&root).len(), 1);
        uninstall(&root, "p1").unwrap();
        assert!(!dir.exists());
        assert!(uninstall(&root, "p1").is_err());
        let _ = fs::remove_dir_all(&root);
    }
}
