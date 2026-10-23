//! The Meta credentials, by what they authenticate as, and the capability's kind and account as
//! the use cases hand them in `public`.

use std::fmt;

use jt_connector::{ConnectorError, Credential, Provider};
use serde_json::Value;

use crate::graph::wrong_credential;
use crate::oauth::is_instagram_login;

/// A Meta credential, by what it authenticates as. `Debug` masks every token.
#[derive(Clone, Copy)]
pub(crate) enum MetaCred<'a> {
    /// A Page token, its page's id as recorded with it.
    Page { page_id: &'a str, token: &'a str },
    /// A Facebook Login user token, or a pasted token of unknown kind (Graph `/me` says what it
    /// is: a pasted Page token's `/me` is its page).
    User { token: &'a str },
    /// An Instagram Login token (see the crate docs), for `graph.instagram.com`.
    Instagram { token: &'a str },
    /// A WhatsApp Cloud number and the token it is reached with.
    WhatsApp {
        phone_number_id: &'a str,
        token: &'a str,
        waba_id: Option<&'a str>,
    },
}

impl<'a> MetaCred<'a> {
    /// `cred` as a Meta credential; `Permanent` for a NetGSM one (it cannot `what` on Meta).
    pub(crate) fn of(cred: &'a Credential, what: &str) -> Result<MetaCred<'a>, ConnectorError> {
        match cred {
            Credential::PageToken { page_id, token } => Ok(MetaCred::Page { page_id, token }),
            Credential::OAuth {
                access_token,
                scopes,
                ..
            } if is_instagram_login(access_token, scopes) => Ok(MetaCred::Instagram {
                token: access_token,
            }),
            Credential::OAuth { access_token, .. } => Ok(MetaCred::User {
                token: access_token,
            }),
            Credential::WhatsAppCloud {
                phone_number_id,
                token,
                waba_id,
                ..
            } => Ok(MetaCred::WhatsApp {
                phone_number_id,
                token,
                waba_id: waba_id.as_deref(),
            }),
            other => Err(wrong_credential(other, what)),
        }
    }

    /// The token, whatever the variant.
    pub(crate) fn token(&self) -> &'a str {
        match self {
            MetaCred::Page { token, .. }
            | MetaCred::User { token }
            | MetaCred::Instagram { token }
            | MetaCred::WhatsApp { token, .. } => token,
        }
    }
}

/// Prints the variant and the ids, every token as `***`.
impl fmt::Debug for MetaCred<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MetaCred::Page { page_id, .. } => f
                .debug_struct("Page")
                .field("page_id", page_id)
                .field("token", &crate::Masked)
                .finish(),
            MetaCred::User { .. } => f
                .debug_struct("User")
                .field("token", &crate::Masked)
                .finish(),
            MetaCred::Instagram { .. } => f
                .debug_struct("Instagram")
                .field("token", &crate::Masked)
                .finish(),
            MetaCred::WhatsApp {
                phone_number_id,
                waba_id,
                ..
            } => f
                .debug_struct("WhatsApp")
                .field("phone_number_id", phone_number_id)
                .field("token", &crate::Masked)
                .field("waba_id", waba_id)
                .finish(),
        }
    }
}

/// The reason every operation that depends on the kind refuses a `public` without a Meta kind.
pub(crate) const KIND_MISSING: &str = "kind_key missing";

/// The capability's kind, as the use cases hand it in `public["kind_key"]`: one of the kinds Meta
/// serves, else `Permanent` ([`KIND_MISSING`]). Never guessed from the credential: a Page token
/// reaches a page and its Instagram account alike, and a guess would act on the wrong one.
pub(crate) fn kind_of(public: &Value) -> Result<&str, ConnectorError> {
    public["kind_key"]
        .as_str()
        .filter(|kind| Provider::Meta.kinds().contains(kind))
        .ok_or_else(|| ConnectorError::permanent(KIND_MISSING))
}

/// The capability's account, as the use cases hand it in `public["external_id"]`.
pub(crate) fn account_of(public: &Value) -> Option<&str> {
    public["external_id"]
        .as_str()
        .map(str::trim)
        .filter(|a| !a.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_masks_every_token() {
        let creds = [
            Credential::PageToken {
                page_id: "1234567890".into(),
                token: "EAAB-page-SECRET".into(),
            },
            Credential::OAuth {
                access_token: "EAAB-user-SECRET".into(),
                refresh_token: None,
                expires_at: None,
                scopes: vec![],
            },
            Credential::OAuth {
                access_token: "IGAA-login-SECRET".into(),
                refresh_token: None,
                expires_at: None,
                scopes: vec!["instagram_business_basic".into()],
            },
            Credential::WhatsAppCloud {
                phone_number_id: "5555555555".into(),
                token: "EAAB-wa-SECRET".into(),
                waba_id: Some("4444444444".into()),
                expires_at: None,
            },
        ];
        let mut variants = Vec::new();
        for cred in &creds {
            let meta = MetaCred::of(cred, "test").unwrap();
            for printed in [format!("{meta:?}"), format!("{meta:#?}")] {
                assert!(!printed.contains("SECRET"), "{printed}");
                assert!(printed.contains("***"), "{printed}");
            }
            variants.push(
                format!("{meta:?}")
                    .split([' ', '{'])
                    .next()
                    .unwrap()
                    .to_owned(),
            );
        }
        assert_eq!(variants, ["Page", "User", "Instagram", "WhatsApp"]);
        assert!(format!("{:?}", MetaCred::of(&creds[0], "t").unwrap()).contains("1234567890"));
        assert!(format!("{:?}", MetaCred::of(&creds[3], "t").unwrap()).contains("5555555555"));
    }

    #[test]
    fn the_kind_is_one_meta_serves() {
        assert_eq!(
            kind_of(&serde_json::json!({ "kind_key": "messenger" })).unwrap(),
            "messenger"
        );
        for public in [
            serde_json::json!({}),
            serde_json::json!({ "kind_key": null }),
            serde_json::json!({ "kind_key": 3 }),
            serde_json::json!({ "kind_key": "sms_line" }),
            serde_json::json!({ "kind_key": "Messenger" }),
            serde_json::json!(null),
        ] {
            let e = kind_of(&public).unwrap_err();
            assert_eq!(
                (e.kind(), e.reason()),
                ("permanent", Some(KIND_MISSING)),
                "{public}"
            );
        }
    }
}
