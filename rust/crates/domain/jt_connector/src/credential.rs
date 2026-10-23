//! The credentials a connector capability is reached with. Sealed, never shown.

use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};

use crate::Masked;

/// What an adapter authenticates with, one variant per credential shape (spec §6.1: "kimlik
/// bilgileri mühürlü").
///
/// `Serialize`/`Deserialize` exist only so the value can be sealed into
/// `capabilities.connector_sealed` (and `oauth_pending.assets_sealed`) and read back: the serial
/// form carries every secret and must never be returned, logged or written to the ledger. `Debug`
/// masks every secret as `***`; [`Credential::redact_for_public`] gives what may be shown.
///
/// The sealed form is tagged by `kind` ([`Credential::kind`]) and tolerant on read: an unknown
/// field is ignored, and a missing optional field reads as `None` (or no scopes). A missing
/// secret or identifying field does not read: such a blob cannot reach the provider anyway.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum Credential {
    /// A user access token from an OAuth flow (Meta user token, Instagram login, X).
    #[serde(rename = "oauth")]
    OAuth {
        access_token: String,
        /// Missing reads as `None`.
        #[serde(default)]
        refresh_token: Option<String>,
        /// When the access token stops working, when the provider said. Missing reads as `None`.
        #[serde(default, with = "time::serde::rfc3339::option")]
        expires_at: Option<OffsetDateTime>,
        /// The scopes granted. Missing reads as none.
        #[serde(default)]
        scopes: Vec<String>,
    },
    /// A Facebook Page access token (no refresh token, does not expire on its own).
    #[serde(rename = "page_token")]
    PageToken { page_id: String, token: String },
    /// A WhatsApp Cloud API phone number and its access token.
    #[serde(rename = "whatsapp_cloud")]
    WhatsAppCloud {
        phone_number_id: String,
        token: String,
        /// The WhatsApp Business Account. Missing reads as `None`.
        #[serde(default)]
        waba_id: Option<String>,
        /// When the token stops working, when the provider said: a Facebook Login user's token
        /// (about 60 days) has one and is renewed like the user's; a system user's token has
        /// none and does not expire on its own. Missing reads as `None`.
        #[serde(default, with = "time::serde::rfc3339::option")]
        expires_at: Option<OffsetDateTime>,
    },
    /// A NetGSM SMS API sub-user and the approved sender name.
    #[serde(rename = "netgsm_sms")]
    NetgsmSms {
        usercode: String,
        password: String,
        msgheader: String,
    },
    /// A NetGSM Netsantral (PBX) user.
    #[serde(rename = "netgsm_pbx")]
    NetgsmPbx {
        username: String,
        password: String,
        /// Missing reads as `None`.
        #[serde(default)]
        trunk: Option<String>,
        /// Missing reads as `None`.
        #[serde(default)]
        pbxnum: Option<String>,
    },
    /// A NetGSM İYS (consent registry) user and the brand code.
    #[serde(rename = "netgsm_iys")]
    NetgsmIys {
        usercode: String,
        password: String,
        brand_code: String,
    },
}

impl Credential {
    /// The stable key of the variant, which is also the `kind` tag of the sealed form:
    /// `"oauth"`, `"page_token"`, `"whatsapp_cloud"`, `"netgsm_sms"`, `"netgsm_pbx"` or
    /// `"netgsm_iys"`.
    pub fn kind(&self) -> &'static str {
        match self {
            Credential::OAuth { .. } => "oauth",
            Credential::PageToken { .. } => "page_token",
            Credential::WhatsAppCloud { .. } => "whatsapp_cloud",
            Credential::NetgsmSms { .. } => "netgsm_sms",
            Credential::NetgsmPbx { .. } => "netgsm_pbx",
            Credential::NetgsmIys { .. } => "netgsm_iys",
        }
    }

    /// Whether the credential stops working within `within` of `now` (or already has): only an
    /// `OAuth` or `WhatsAppCloud` token with a known `expires_at` at or before `now + within`.
    /// Every other credential has no expiry of its own and answers `false`.
    pub fn expires_soon(&self, now: OffsetDateTime, within: Duration) -> bool {
        match self {
            Credential::OAuth {
                expires_at: Some(at),
                ..
            }
            | Credential::WhatsAppCloud {
                expires_at: Some(at),
                ..
            } => *at - now <= within,
            _ => false,
        }
    }

    /// The non-secret facts of the credential, fit for `connector_public`: its `kind`, and
    /// - `OAuth`: `expires_at` (RFC 3339, or `null`) and `scopes`;
    /// - `PageToken`: `page_id`;
    /// - `WhatsAppCloud`: `phone_number_id`, and `waba_id` and `expires_at` (RFC 3339) when known;
    /// - `NetgsmSms`: `usercode` and `msgheader`;
    /// - `NetgsmPbx`: `username`, and `trunk` and `pbxnum` when known;
    /// - `NetgsmIys`: `usercode` and `brand_code`.
    ///
    /// Never a token, a refresh token or a password.
    pub fn redact_for_public(&self) -> Value {
        let mut facts = Map::new();
        facts.insert("kind".to_owned(), json!(self.kind()));
        let mut put = |key: &str, value: Value| {
            facts.insert(key.to_owned(), value);
        };
        match self {
            Credential::OAuth {
                expires_at, scopes, ..
            } => {
                let expires_at = expires_at.and_then(|at| at.format(&Rfc3339).ok());
                put("expires_at", json!(expires_at));
                put("scopes", json!(scopes));
            }
            Credential::PageToken { page_id, .. } => put("page_id", json!(page_id)),
            Credential::WhatsAppCloud {
                phone_number_id,
                waba_id,
                expires_at,
                ..
            } => {
                put("phone_number_id", json!(phone_number_id));
                if let Some(waba_id) = waba_id {
                    put("waba_id", json!(waba_id));
                }
                if let Some(at) = expires_at.and_then(|at| at.format(&Rfc3339).ok()) {
                    put("expires_at", json!(at));
                }
            }
            Credential::NetgsmSms {
                usercode,
                msgheader,
                ..
            } => {
                put("usercode", json!(usercode));
                put("msgheader", json!(msgheader));
            }
            Credential::NetgsmPbx {
                username,
                trunk,
                pbxnum,
                ..
            } => {
                put("username", json!(username));
                if let Some(trunk) = trunk {
                    put("trunk", json!(trunk));
                }
                if let Some(pbxnum) = pbxnum {
                    put("pbxnum", json!(pbxnum));
                }
            }
            Credential::NetgsmIys {
                usercode,
                brand_code,
                ..
            } => {
                put("usercode", json!(usercode));
                put("brand_code", json!(brand_code));
            }
        }
        Value::Object(facts)
    }
}

/// `Some(***)` for a present secret, `None` for an absent one.
fn masked(secret: &Option<String>) -> Option<Masked> {
    secret.as_ref().map(|_| Masked)
}

/// Every secret field (tokens, refresh tokens, passwords) prints as `***`; the rest as is.
impl fmt::Debug for Credential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Credential::OAuth {
                access_token: _,
                refresh_token,
                expires_at,
                scopes,
            } => f
                .debug_struct("OAuth")
                .field("access_token", &Masked)
                .field("refresh_token", &masked(refresh_token))
                .field("expires_at", expires_at)
                .field("scopes", scopes)
                .finish(),
            Credential::PageToken { page_id, token: _ } => f
                .debug_struct("PageToken")
                .field("page_id", page_id)
                .field("token", &Masked)
                .finish(),
            Credential::WhatsAppCloud {
                phone_number_id,
                token: _,
                waba_id,
                expires_at,
            } => f
                .debug_struct("WhatsAppCloud")
                .field("phone_number_id", phone_number_id)
                .field("token", &Masked)
                .field("waba_id", waba_id)
                .field("expires_at", expires_at)
                .finish(),
            Credential::NetgsmSms {
                usercode,
                password: _,
                msgheader,
            } => f
                .debug_struct("NetgsmSms")
                .field("usercode", usercode)
                .field("password", &Masked)
                .field("msgheader", msgheader)
                .finish(),
            Credential::NetgsmPbx {
                username,
                password: _,
                trunk,
                pbxnum,
            } => f
                .debug_struct("NetgsmPbx")
                .field("username", username)
                .field("password", &Masked)
                .field("trunk", trunk)
                .field("pbxnum", pbxnum)
                .finish(),
            Credential::NetgsmIys {
                usercode,
                password: _,
                brand_code,
            } => f
                .debug_struct("NetgsmIys")
                .field("usercode", usercode)
                .field("password", &Masked)
                .field("brand_code", brand_code)
                .finish(),
        }
    }
}
