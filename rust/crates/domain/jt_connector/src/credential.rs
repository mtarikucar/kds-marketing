//! The credentials a connector capability is reached with. Sealed, never shown.

use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};

use crate::Masked;

/// Mandatory mailbox encryption mode; there is no plaintext variant.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MailTls {
    Implicit,
    StartTls,
}

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
    /// SMTP/IMAP credentials, sealed together. The login and password are private.
    #[serde(rename = "mailbox")]
    Mailbox {
        smtp_host: String,
        smtp_port: u16,
        imap_host: String,
        imap_port: u16,
        username: String,
        password: String,
        from_address: String,
        tls: MailTls,
    },
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
    /// A Trendyol seller's own API key and secret (Basic auth), and the seller id they are
    /// bound to. The key and the secret are private.
    #[serde(rename = "trendyol_seller")]
    TrendyolSeller {
        seller_id: String,
        api_key: String,
        api_secret: String,
    },
    /// A Hepsiburada merchant's id (sent as the `merchantId` header) and the service key the
    /// seller copied for Jeeta as its integrator (seller panel: Bilgilerim → Entegrasyon →
    /// Entegratör Bilgileri → Servis Anahtarı; task H0). The service key is private. The Basic
    /// auth user is the platform's integrator user, not the seller's; which value goes where is
    /// VERIFY V-H1 (spec 2026-10-30-inbox-comments-marketplace-design.md §8.3, §12).
    #[serde(rename = "hepsiburada_merchant")]
    HepsiburadaMerchant {
        merchant_id: String,
        service_key: String,
    },
}

impl Credential {
    /// The stable key of the variant, which is also the `kind` tag of the sealed form:
    /// `"mailbox"`, `"oauth"`, `"page_token"`, `"whatsapp_cloud"`, `"netgsm_sms"`,
    /// `"netgsm_pbx"`, `"netgsm_iys"`, `"trendyol_seller"` or `"hepsiburada_merchant"`.
    pub fn kind(&self) -> &'static str {
        match self {
            Credential::Mailbox { .. } => "mailbox",
            Credential::OAuth { .. } => "oauth",
            Credential::PageToken { .. } => "page_token",
            Credential::WhatsAppCloud { .. } => "whatsapp_cloud",
            Credential::NetgsmSms { .. } => "netgsm_sms",
            Credential::NetgsmPbx { .. } => "netgsm_pbx",
            Credential::NetgsmIys { .. } => "netgsm_iys",
            Credential::TrendyolSeller { .. } => "trendyol_seller",
            Credential::HepsiburadaMerchant { .. } => "hepsiburada_merchant",
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
    /// - `NetgsmIys`: `usercode` and `brand_code`;
    /// - `TrendyolSeller`: `seller_id`;
    /// - `HepsiburadaMerchant`: `merchant_id`.
    ///
    /// Never a token, a refresh token, an API key, secret or service key, a login or a password.
    pub fn redact_for_public(&self) -> Value {
        let mut facts = Map::new();
        facts.insert("kind".to_owned(), json!(self.kind()));
        let mut put = |key: &str, value: Value| {
            facts.insert(key.to_owned(), value);
        };
        match self {
            Credential::Mailbox {
                smtp_host,
                smtp_port,
                imap_host,
                imap_port,
                from_address,
                ..
            } => {
                put("smtp_host", json!(smtp_host));
                put("smtp_port", json!(smtp_port));
                put("imap_host", json!(imap_host));
                put("imap_port", json!(imap_port));
                put("from_address", json!(from_address));
            }
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
            Credential::TrendyolSeller { seller_id, .. } => put("seller_id", json!(seller_id)),
            Credential::HepsiburadaMerchant { merchant_id, .. } => {
                put("merchant_id", json!(merchant_id));
            }
        }
        Value::Object(facts)
    }
}

/// `Some(***)` for a present secret, `None` for an absent one.
fn masked(secret: &Option<String>) -> Option<Masked> {
    secret.as_ref().map(|_| Masked)
}

/// Every secret field (tokens, refresh tokens, API keys, secrets and service keys, logins,
/// passwords) prints as `***`; the rest as is.
impl fmt::Debug for Credential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Credential::Mailbox {
                smtp_host,
                smtp_port,
                imap_host,
                imap_port,
                from_address,
                tls,
                ..
            } => f
                .debug_struct("Mailbox")
                .field("smtp_host", smtp_host)
                .field("smtp_port", smtp_port)
                .field("imap_host", imap_host)
                .field("imap_port", imap_port)
                .field("username", &Masked)
                .field("password", &Masked)
                .field("from_address", from_address)
                .field("tls", tls)
                .finish(),
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
            Credential::TrendyolSeller {
                seller_id,
                api_key: _,
                api_secret: _,
            } => f
                .debug_struct("TrendyolSeller")
                .field("seller_id", seller_id)
                .field("api_key", &Masked)
                .field("api_secret", &Masked)
                .finish(),
            Credential::HepsiburadaMerchant {
                merchant_id,
                service_key: _,
            } => f
                .debug_struct("HepsiburadaMerchant")
                .field("merchant_id", merchant_id)
                .field("service_key", &Masked)
                .finish(),
        }
    }
}
