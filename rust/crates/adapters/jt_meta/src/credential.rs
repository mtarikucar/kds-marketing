//! The Meta credentials, by what they authenticate as.

use jt_connector::{ConnectorError, Credential};
use serde_json::Value;

use crate::graph::wrong_credential;
use crate::oauth::is_instagram_login;

/// A Meta credential, by what it authenticates as.
#[derive(Clone, Copy, Debug)]
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

/// The capability's kind, as the use cases hand it in `public["kind_key"]`.
pub(crate) fn kind_of(public: &Value) -> Option<&str> {
    public["kind_key"].as_str()
}

/// The capability's account, as the use cases hand it in `public["external_id"]`.
pub(crate) fn account_of(public: &Value) -> Option<&str> {
    public["external_id"]
        .as_str()
        .map(str::trim)
        .filter(|a| !a.is_empty())
}
