//! Source selection: DataRefine Cloud / BYOK / Local.
//! Cloud requires the `cloudAI` entitlement; BYOK and Local never do and
//! never consume DataRefine credits.

use super::models::{AiSettings, AiSource, RouterDecision};
use crate::app::policy::model::Entitlements;

pub fn select_source(ent: &Entitlements, s: &AiSettings) -> RouterDecision {
    let available = |src: AiSource| match src {
        AiSource::Cloud => ent.cloud_ai,
        AiSource::Byok => s.byok_configured,
        AiSource::Local => s.ollama_available,
    };
    let order: Vec<AiSource> = match s.preferred.as_deref().and_then(AiSource::parse) {
        Some(p) => vec![p, AiSource::Local, AiSource::Byok, AiSource::Cloud],
        None => vec![AiSource::Local, AiSource::Byok, AiSource::Cloud],
    };
    // de-dup keeping first occurrence
    let mut seen: Vec<AiSource> = Vec::new();
    for src in order {
        if !seen.contains(&src) {
            seen.push(src);
        }
    }
    for src in seen {
        if available(src) {
            return RouterDecision {
                source: src,
                reason: match src {
                    AiSource::Cloud => "entitled cloud AI".into(),
                    AiSource::Byok => "your own provider key".into(),
                    AiSource::Local => "local Ollama".into(),
                },
            };
        }
    }
    RouterDecision {
        source: AiSource::Local,
        reason: "no AI source available (enable Ollama, add a key, or an AI Pro license)".into(),
    }
}

/// Credits UI/queries are allowed only for entitled cloud AI.
#[allow(dead_code)] // UI visibility rule, used by tests
pub fn credits_visible(ent: &Entitlements) -> bool {
    ent.cloud_ai
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ent(pro: bool) -> crate::app::policy::model::Entitlements {
        crate::app::policy::model::Entitlements { cloud_ai: pro, ai_plugins: pro, agents: pro, capabilities: vec![] }
    }

    #[test]
    fn standard_license_never_routes_to_cloud() {
        let s = crate::ai::models::AiSettings { preferred: Some("cloud".into()), byok_configured: false, ollama_available: true };
        let d = select_source(&ent(false), &s);
        assert_eq!(d.source, crate::ai::models::AiSource::Local);
    }

    #[test]
    fn ai_pro_prefers_cloud() {
        let s = crate::ai::models::AiSettings { preferred: Some("cloud".into()), byok_configured: true, ollama_available: true };
        let d = select_source(&ent(true), &s);
        assert_eq!(d.source, crate::ai::models::AiSource::Cloud);
    }

    #[test]
    fn byok_and_local_work_on_standard() {
        let s = crate::ai::models::AiSettings { preferred: Some("byok".into()), byok_configured: true, ollama_available: false };
        assert_eq!(select_source(&ent(false), &s).source, crate::ai::models::AiSource::Byok);
        let s2 = crate::ai::models::AiSettings { preferred: None, byok_configured: false, ollama_available: true };
        assert_eq!(select_source(&ent(false), &s2).source, crate::ai::models::AiSource::Local);
    }

    #[test]
    fn no_source_available_is_reported() {
        let s = crate::ai::models::AiSettings::default();
        let d = select_source(&ent(false), &s);
        assert!(d.reason.contains("no AI source available"));
        assert!(!credits_visible(&crate::app::policy::model::Entitlements::default()));
        assert!(credits_visible(&ent(true)));
    }

}
