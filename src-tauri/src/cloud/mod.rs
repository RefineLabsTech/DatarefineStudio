//! Centralized cloud infrastructure.
//!
//! * Signed endpoint discovery (bootstrap → cached last-known-good → stable).
//! * The single HTTP client every cloud request must go through.
pub mod client;
pub mod config;
pub mod discovery;
pub mod models;
