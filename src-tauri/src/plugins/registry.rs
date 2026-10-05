use super::manifest::Manifest;
use std::path::Path;

/// Scan `<root>/installed/*/manifest.json`.
pub fn scan(root: &Path) -> Vec<Manifest> {
    let dir = root.join("installed");
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<Manifest> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .filter(|p| !p.join(super::sync::DISABLE_MARKER).exists())
        .filter_map(|p| Manifest::load(&p))
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

pub fn find(root: &Path, id: &str) -> Option<Manifest> {
    scan(root).into_iter().find(|m| m.id == id)
}
