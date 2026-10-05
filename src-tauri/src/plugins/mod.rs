//! Centralized plugin registry: manifests, permissions, AI access gating.
//! Plugins never call providers directly and never deduct credits.
#[cfg(feature = "tauri-cmds")]
pub mod commands;
pub mod manifest;
pub mod permissions;
pub mod registry;
pub mod market;
pub mod sync;
