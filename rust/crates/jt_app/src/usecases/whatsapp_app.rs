//! A WhatsApp number onboarded beside the WhatsApp Business app ("coexistence", spec
//! `docs/superpowers/specs/2026-11-03-whatsapp-coexistence-design.md`): where the one-time
//! sharing of the app's contacts and history stands, in the capability's
//! `connector_public.business_app` (a key only the system writes,
//! `jt_capability::RESERVED_PUBLIC_KEYS`).
//!
//! Meta's page
//! <https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users>
//! says each of the two may be asked for once, within 24 hours of the onboarding. So the state
//! is started over when the coexistence flow's asset is confirmed ([`onboarded`]: a new
//! onboarding, a new window), and each request then moves once, by the scheduled job
//! (`super::jobs::run_whatsapp_app_sync`), through:
//!
//! | `state` | meaning |
//! |---|---|
//! | `due` | not asked yet (or asked while the provider was busy or unreachable: asked again on the next run, `retry_reason` saying why) |
//! | `requesting` | being asked now; found by a later run, the answer was never written, so it is `unknown` |
//! | `requested` | the provider took it (`request_id`); the data arrives by webhook, and only if the business agrees |
//! | `refused` | the provider refused it (`reason`, its redacted failure line); not asked again |
//! | `unknown` | the request may have reached the provider but its answer was lost; never asked again blindly |
//! | `expired` | the window closed before it could be asked |
//!
//! ```json
//! { "onboarded_at": "...", "sync_until": "...",
//!   "contacts": { "state": "requested", "at": "...", "request_id": "..." },
//!   "history":  { "state": "refused", "at": "...", "reason": "permanent: meta: ..." } }
//! ```

use serde_json::{Value, json};
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};

use super::connector::object;
use crate::error::AppError;
use crate::ports::connectors::{AppSync, OAuthFlow};

/// The `connector_public` key of the sharing's state.
pub const BUSINESS_APP: &str = "business_app";

/// How long after the onboarding the app's contacts and history may be asked for (Meta: 24
/// hours).
pub const SYNC_WINDOW: Duration = Duration::hours(24);

/// The requests, in the order they are asked: contacts first, so the people exist when their
/// history arrives.
pub const SYNCS: [AppSync; 2] = [AppSync::Contacts, AppSync::History];

/// A request's states (see the module docs).
pub const DUE: &str = "due";
pub const REQUESTING: &str = "requesting";
pub const REQUESTED: &str = "requested";
pub const REFUSED: &str = "refused";
pub const UNKNOWN: &str = "unknown";
pub const EXPIRED: &str = "expired";

/// `public` (a capability's `connector_public`) with the sharing started over at `now`, when the
/// asset of kind `kind_key` was found through the coexistence flow (`flow`); else `public` as it
/// is.
pub(crate) fn onboarded(
    public: Value,
    flow: Option<OAuthFlow>,
    kind_key: &str,
    now: OffsetDateTime,
) -> Result<Value, AppError> {
    let Some(flow) = flow.filter(|f| *f == OAuthFlow::WhatsappBusinessApp) else {
        return Ok(public);
    };
    if flow.kind_key() != kind_key {
        return Ok(public);
    }
    let mut out = object(&public);
    out.insert(
        BUSINESS_APP.to_owned(),
        json!({
            "onboarded_at": rfc3339(now)?,
            "sync_until": rfc3339(now + SYNC_WINDOW)?,
            "contacts": { "state": DUE },
            "history": { "state": DUE },
        }),
    );
    Ok(Value::Object(out))
}

/// The state of request `sync` in `public` (a capability's `connector_public`), if the
/// capability has a sharing at all.
pub fn state_of(public: &Value, sync: AppSync) -> Option<&str> {
    public[BUSINESS_APP][sync.key()]["state"].as_str()
}

/// Until when the sharing of `public` may be asked for.
pub fn sync_until(public: &Value) -> Option<OffsetDateTime> {
    public[BUSINESS_APP]["sync_until"]
        .as_str()
        .and_then(|at| OffsetDateTime::parse(at, &Rfc3339).ok())
}

/// `public` with request `sync` set to `entry` (an object holding at least `state`), the rest
/// of the sharing kept.
pub(crate) fn with_entry(public: &Value, sync: AppSync, entry: Value) -> Value {
    let mut out = object(public);
    let mut sharing = object(out.get(BUSINESS_APP).unwrap_or(&Value::Null));
    sharing.insert(sync.key().to_owned(), entry);
    out.insert(BUSINESS_APP.to_owned(), Value::Object(sharing));
    Value::Object(out)
}

fn rfc3339(at: OffsetDateTime) -> Result<String, AppError> {
    at.format(&Rfc3339)
        .map_err(|_| AppError::internal("a time cannot be written"))
}

#[cfg(test)]
mod tests {
    use time::macros::datetime;

    use super::*;

    #[test]
    fn only_the_coexistence_flow_starts_a_sharing() {
        let now = datetime!(2026-11-03 10:00:00 UTC);
        let public = json!({ "provider": "meta" });
        let started = onboarded(
            public.clone(),
            Some(OAuthFlow::WhatsappBusinessApp),
            "whatsapp_cloud",
            now,
        )
        .unwrap();
        assert_eq!(started["provider"], "meta");
        assert_eq!(
            started[BUSINESS_APP]["onboarded_at"],
            "2026-11-03T10:00:00Z"
        );
        assert_eq!(started[BUSINESS_APP]["sync_until"], "2026-11-04T10:00:00Z");
        assert_eq!(state_of(&started, AppSync::Contacts), Some(DUE));
        assert_eq!(state_of(&started, AppSync::History), Some(DUE));
        assert_eq!(
            sync_until(&started),
            Some(datetime!(2026-11-04 10:00:00 UTC))
        );
        // Another flow, or another kind, leaves the public fields as they are.
        assert_eq!(
            onboarded(public.clone(), None, "whatsapp_cloud", now).unwrap(),
            public
        );
        assert_eq!(
            onboarded(
                public.clone(),
                Some(OAuthFlow::WhatsappBusinessApp),
                "messenger",
                now
            )
            .unwrap(),
            public
        );
        assert_eq!(state_of(&public, AppSync::Contacts), None);
        // An entry replaces its own request only.
        let moved = with_entry(
            &started,
            AppSync::Contacts,
            json!({ "state": REQUESTED, "request_id": "r-1" }),
        );
        assert_eq!(state_of(&moved, AppSync::Contacts), Some(REQUESTED));
        assert_eq!(state_of(&moved, AppSync::History), Some(DUE));
        assert_eq!(moved[BUSINESS_APP]["onboarded_at"], "2026-11-03T10:00:00Z");
    }
}
