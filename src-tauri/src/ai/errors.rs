//! Typed cloud AI error mapping (§29). Business errors surface as stable
//! codes with honest user-facing messages — never a generic "Network error".

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AiErrorCode {
    LicensingDisabled,
    LicenseNotActive,
    AiCapabilityNotAllowed,
    InsufficientCredits,
    PluginNotEntitled,
    PluginNotFound,
    JobNotFound,
    IdempotencyConflict,
    RateLimited,
    AiProviderError,
    ValidationError,
    Unknown,
}

pub fn from_code(code: &str) -> AiErrorCode {
    match code {
        "LICENSING_DISABLED" => AiErrorCode::LicensingDisabled,
        "LICENSE_NOT_ACTIVE" | "LICENSE_INVALID" | "LICENSE_EXPIRED" => AiErrorCode::LicenseNotActive,
        "AI_CAPABILITY_NOT_ALLOWED" => AiErrorCode::AiCapabilityNotAllowed,
        "INSUFFICIENT_CREDITS" => AiErrorCode::InsufficientCredits,
        "PLUGIN_NOT_ENTITLED" => AiErrorCode::PluginNotEntitled,
        "PLUGIN_NOT_FOUND" => AiErrorCode::PluginNotFound,
        "JOB_NOT_FOUND" => AiErrorCode::JobNotFound,
        "IDEMPOTENCY_CONFLICT" => AiErrorCode::IdempotencyConflict,
        "RATE_LIMITED" => AiErrorCode::RateLimited,
        "AI_PROVIDER_ERROR" => AiErrorCode::AiProviderError,
        "VALIDATION_ERROR" => AiErrorCode::ValidationError,
        _ => AiErrorCode::Unknown,
    }
}

pub fn user_message(code: AiErrorCode) -> &'static str {
    match code {
        AiErrorCode::LicensingDisabled => "Licensing is disabled — cloud AI is unavailable by policy.",
        AiErrorCode::LicenseNotActive => "Your license is not active. Open Settings → License to resolve.",
        AiErrorCode::AiCapabilityNotAllowed => "This AI capability is not allowed by your license.",
        AiErrorCode::InsufficientCredits => "Your Cloud AI credits are exhausted.",
        AiErrorCode::PluginNotEntitled => "This plugin is not part of your license.",
        AiErrorCode::PluginNotFound => "The requested plugin was not found.",
        AiErrorCode::JobNotFound => "This AI job no longer exists.",
        AiErrorCode::IdempotencyConflict => "A different request already used this idempotency key.",
        AiErrorCode::RateLimited => "The AI service is busy — please retry in a moment.",
        AiErrorCode::AiProviderError => "The AI provider reported an error. Your data was not changed.",
        AiErrorCode::ValidationError => "The request was rejected as invalid.",
        AiErrorCode::Unknown => "The cloud AI request failed.",
    }
}

/// Render a ClientError as an honest, code-aware message.
pub fn describe(e: &crate::cloud::client::ClientError) -> String {
    if let Some(code) = e.code.as_deref() {
        let mapped = from_code(code);
        if mapped != AiErrorCode::Unknown {
            return user_message(mapped).to_string();
        }
        return format!("{code}: {}", e.message);
    }
    e.message.clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_codes_map_and_render() {
        for code in [
            "LICENSING_DISABLED",
            "LICENSE_NOT_ACTIVE",
            "AI_CAPABILITY_NOT_ALLOWED",
            "INSUFFICIENT_CREDITS",
            "PLUGIN_NOT_ENTITLED",
            "PLUGIN_NOT_FOUND",
            "JOB_NOT_FOUND",
            "IDEMPOTENCY_CONFLICT",
            "RATE_LIMITED",
            "AI_PROVIDER_ERROR",
            "VALIDATION_ERROR",
        ] {
            assert_ne!(from_code(code), AiErrorCode::Unknown, "{code}");
            assert!(!user_message(from_code(code)).is_empty());
        }
        assert_eq!(from_code("WHATEVER"), AiErrorCode::Unknown);
    }

    #[test]
    fn describe_prefers_business_code() {
        let e = crate::cloud::client::ClientError {
            kind: crate::cloud::client::ErrorKind::Http(402),
            message: "raw server text".into(),
            retry_after_secs: None,
            code: Some("INSUFFICIENT_CREDITS".into()),
        };
        assert_eq!(describe(&e), user_message(AiErrorCode::InsufficientCredits));
        let e2 = crate::cloud::client::ClientError {
            kind: crate::cloud::client::ErrorKind::Offline,
            message: "offline".into(),
            retry_after_secs: None,
            code: None,
        };
        assert_eq!(describe(&e2), "offline");
    }
}
