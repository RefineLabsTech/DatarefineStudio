use super::manifest::Manifest;

/// The only permissions the runtime understands. Undeclared = denied.
pub const KNOWN: [&str; 9] = [
    "dataset.read",
    "dataset.write",
    "dataset.export",
    "filesystem.read",
    "filesystem.write",
    "network",
    "ai.inference",
    "ai.agent",
    "settings.read",
];

pub fn known(p: &str) -> bool {
    KNOWN.contains(&p)
}

pub fn declares(m: &Manifest, p: &str) -> bool {
    m.permissions.iter().any(|x| x == p)
}
