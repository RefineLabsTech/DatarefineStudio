//! Central AI runtime: source routing, credits, jobs.
//! Plugins and UI never touch providers directly — only this runtime.
pub mod byok;
#[cfg(feature = "tauri-cmds")]
pub mod commands;
pub mod credits;
pub mod errors;
pub mod jobs;
pub mod models;
pub mod router;
pub mod usage;
