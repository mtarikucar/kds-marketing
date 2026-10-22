//! The connector ports: the platform's own provider apps ([`PlatformAppConfig`]), the provider
//! adapters ([`Connector`] and the operation traits beside it), their OAuth flows
//! ([`OAuthProvider`]) and the registry that hands them out ([`ConnectorRegistry`]).
//!
//! An adapter never holds an HTTP client of its own: every call goes through the egress client
//! (`jt_outbound`), so these traits say nothing about transport. Every failure is a
//! [`ConnectorError`], whose reasons are redacted when built; a credential travels only as a
//! [`Credential`] argument, never inside a result.
//!
//! The operation traits are consumed by later milestones (messages, posts, measurements, ads);
//! their request and result types here are minimal and may grow fields there.

use std::collections::BTreeMap;
use std::fmt;
use std::sync::Arc;

use async_trait::async_trait;
use jt_connector::{ConnectorError, Credential, ProbeResult, Provider};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::{Date, OffsetDateTime};
pub use url::Url;

use super::Masked;

// ---------------------------------------------------------------------------------------------
// The platform's provider apps
// ---------------------------------------------------------------------------------------------

/// The platform's Meta app (Facebook Login, the Graph API and the Meta webhooks). Platform
/// configuration from the environment, never per tenant: tenants connect their own accounts to
/// this app. `Debug` masks the app secret and the webhook verify token.
#[derive(Clone, PartialEq, Eq)]
pub struct MetaApp {
    pub app_id: String,
    pub app_secret: String,
    /// The token Meta echoes when it verifies the webhook URL (`hub.verify_token`).
    pub verify_token: String,
    /// The Facebook Login for Business configuration, when the app uses one instead of scopes.
    pub login_config_id: Option<String>,
    /// The configuration of WhatsApp embedded signup, when set.
    pub whatsapp_config_id: Option<String>,
    /// The Graph API version, e.g. `"v19.0"`; `None` lets the adapter use its default.
    pub graph_version: Option<String>,
}

impl fmt::Debug for MetaApp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MetaApp")
            .field("app_id", &self.app_id)
            .field("app_secret", &Masked)
            .field("verify_token", &Masked)
            .field("login_config_id", &self.login_config_id)
            .field("whatsapp_config_id", &self.whatsapp_config_id)
            .field("graph_version", &self.graph_version)
            .finish()
    }
}

/// The platform's Instagram app (Instagram Login, for a tenant that connects Instagram alone).
/// `Debug` masks the app secret.
#[derive(Clone, PartialEq, Eq)]
pub struct InstagramApp {
    pub app_id: String,
    pub app_secret: String,
}

impl fmt::Debug for InstagramApp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("InstagramApp")
            .field("app_id", &self.app_id)
            .field("app_secret", &Masked)
            .finish()
    }
}

/// The platform's X app (OAuth 2.0 confidential client). `Debug` masks the client secret.
#[derive(Clone, PartialEq, Eq)]
pub struct XApp {
    pub client_id: String,
    pub client_secret: String,
}

impl fmt::Debug for XApp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("XApp")
            .field("client_id", &self.client_id)
            .field("client_secret", &Masked)
            .finish()
    }
}

/// The platform's provider apps and its public address, read-only. The binary implements it from
/// the environment; an app that is not configured is `None`, and the kinds it serves cannot be
/// connected by OAuth.
pub trait PlatformAppConfig: Send + Sync {
    fn meta_app(&self) -> Option<MetaApp>;
    fn instagram_app(&self) -> Option<InstagramApp>;
    fn x_app(&self) -> Option<XApp>;
    /// Where the panel is reached from outside, for OAuth redirect URIs and webhook URLs.
    fn public_base_url(&self) -> Url;
}

/// The app an OAuth flow runs under. Meta serves two login flows: Facebook Login with the Meta
/// app, and Instagram Login with the Instagram app; the variant tells the adapter which.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OAuthApp {
    Meta(MetaApp),
    Instagram(InstagramApp),
    X(XApp),
}

impl OAuthApp {
    /// The public client id: the Meta or Instagram app id, or the X client id.
    pub fn client_id(&self) -> &str {
        match self {
            OAuthApp::Meta(app) => &app.app_id,
            OAuthApp::Instagram(app) => &app.app_id,
            OAuthApp::X(app) => &app.client_id,
        }
    }

    /// The client secret, for the token exchange only.
    pub fn client_secret(&self) -> &str {
        match self {
            OAuthApp::Meta(app) => &app.app_secret,
            OAuthApp::Instagram(app) => &app.app_secret,
            OAuthApp::X(app) => &app.client_secret,
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Requests and results
// ---------------------------------------------------------------------------------------------

/// The provider's id for something sent or started: an SMS job id, a message id, a call's
/// correlation id, a consent request's id.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SendReceipt {
    pub provider_id: String,
}

/// A post to publish: its text, the media to attach (public URLs the adapter fetches or hands to
/// the provider) and an optional link.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublishRequest {
    pub text: String,
    pub media_urls: Vec<Url>,
    pub link: Option<Url>,
}

/// A published post: the provider's id and, when it gives one, its public URL.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublishReceipt {
    pub external_id: String,
    pub url: Option<Url>,
}

/// One post's counters, by the provider's metric name (e.g. `"impressions"`, `"likes"`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PostMetrics {
    pub metrics: BTreeMap<String, i64>,
}

/// An account's counters, by the provider's metric name (e.g. `"followers"`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountMetrics {
    pub metrics: BTreeMap<String, i64>,
}

/// An ad set and its budget, in the ad account's currency's minor units.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdSet {
    pub id: String,
    pub name: String,
    /// The provider's status, e.g. `"ACTIVE"` or `"PAUSED"`.
    pub status: String,
    pub campaign_id: Option<String>,
    pub daily_budget_minor: Option<i64>,
    pub lifetime_budget_minor: Option<i64>,
}

/// One campaign's results on one day, spend in the ad account's currency's minor units.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdInsights {
    pub campaign_id: String,
    pub campaign_name: Option<String>,
    pub date: Date,
    pub spend_minor: i64,
    pub impressions: i64,
    pub clicks: i64,
}

/// A lead-gen form submission: where it came from and the answers, by field name (a field may
/// carry several values).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LeadGenRecord {
    pub leadgen_id: String,
    pub form_id: Option<String>,
    pub ad_id: Option<String>,
    pub campaign_id: Option<String>,
    pub campaign_name: Option<String>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub created_time: Option<OffsetDateTime>,
    pub fields: BTreeMap<String, Vec<String>>,
}

/// One consent change for the consent registry (İYS): who, through which channel (the
/// registry's type: `"MESAJ"`, `"ARAMA"` or `"EPOSTA"`), granted or withdrawn, from which source
/// (the registry's source code, e.g. `"HS_WEB"`), and when.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConsentRow {
    /// A phone number in international form or an email address.
    pub recipient: String,
    pub channel: String,
    pub granted: bool,
    pub source: String,
    #[serde(with = "time::serde::rfc3339")]
    pub at: OffsetDateTime,
}

/// Something an OAuth-connected account can reach and the owner may connect as a capability: a
/// Facebook Page, an Instagram account, an ad account, a WhatsApp number, an X account.
///
/// `credential` is what the capability will be reached with, so an asset is never returned,
/// logged or written to the ledger: it is neither `Serialize` nor `Deserialize`, and its `Debug`
/// prints the credential as `***`. What may be shown or stored in the clear is
/// [`Asset::public_facts`]; a use case that seals assets with their pending flow does so through
/// a sealing form of its own. `public` holds the non-secret facts to show and to store in
/// `connector_public`.
///
/// ```compile_fail
/// fn shown<T: serde::Serialize>(_: &T) {}
/// fn refused(asset: &jt_app::ports::connectors::Asset) {
///     shown(asset); // an asset carries a live credential: it cannot be serialised
/// }
/// ```
///
/// ```compile_fail
/// fn read<T: serde::de::DeserializeOwned>() {}
/// read::<jt_app::ports::connectors::Asset>(); // nor read back from text
/// ```
#[derive(Clone, PartialEq, Eq)]
pub struct Asset {
    /// The capability kind it becomes, e.g. `"facebook_page"`.
    pub kind_key: String,
    /// The provider's id of it (a page id, an ad account id, a phone number id).
    pub external_id: String,
    pub name: String,
    pub credential: Credential,
    pub public: Value,
}

impl Asset {
    /// What may be shown of the asset: everything but its credential.
    pub fn public_facts(&self) -> AssetPublic {
        AssetPublic {
            kind_key: self.kind_key.clone(),
            external_id: self.external_id.clone(),
            name: self.name.clone(),
            public: self.public.clone(),
        }
    }
}

impl fmt::Debug for Asset {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Asset")
            .field("kind_key", &self.kind_key)
            .field("external_id", &self.external_id)
            .field("name", &self.name)
            .field("credential", &Masked)
            .field("public", &self.public)
            .finish()
    }
}

/// The public facts of an [`Asset`]: what the owner chooses from and what may be stored in the
/// clear (`oauth_pending.assets_public`, `connector_public`). Never a credential.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssetPublic {
    pub kind_key: String,
    pub external_id: String,
    pub name: String,
    pub public: Value,
}

// ---------------------------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------------------------

/// A provider adapter: what every provider supports, whatever it is used for. The credential is
/// the opened sealed one of a capability; `public` is the capability's `connector_public`.
#[async_trait]
pub trait Connector: Send + Sync {
    fn provider(&self) -> Provider;
    /// A cheap authenticated call that says whether the capability can be reached. Never fails:
    /// a failure is a [`ProbeResult`] with `ok == false` and its error.
    async fn probe(&self, cred: &Credential, public: &Value) -> ProbeResult;
    /// A fresh credential when this one can and should be renewed (an expiring or rotating
    /// token), `None` when it needs no renewal.
    async fn refresh(&self, cred: &Credential) -> Result<Option<Credential>, ConnectorError>;
}

/// Sends SMS.
#[async_trait]
pub trait SmsSender: Send + Sync {
    /// Sends `text` to `to` (a phone number), with the caller's `reference` for correlating
    /// delivery reports when given.
    async fn send(
        &self,
        cred: &Credential,
        to: &str,
        text: &str,
        reference: Option<&str>,
    ) -> Result<SendReceipt, ConnectorError>;
}

/// Publishes posts.
#[async_trait]
pub trait Publisher: Send + Sync {
    async fn publish(
        &self,
        cred: &Credential,
        public: &Value,
        request: &PublishRequest,
    ) -> Result<PublishReceipt, ConnectorError>;
}

/// Reads the counters of posts and accounts.
#[async_trait]
pub trait InsightsReader: Send + Sync {
    /// The counters of the post with the provider's id `post_id`.
    async fn post_metrics(
        &self,
        cred: &Credential,
        public: &Value,
        post_id: &str,
    ) -> Result<PostMetrics, ConnectorError>;
    /// The counters of the account itself.
    async fn account_metrics(
        &self,
        cred: &Credential,
        public: &Value,
    ) -> Result<AccountMetrics, ConnectorError>;
}

/// Sends direct messages (Messenger, Instagram, WhatsApp).
#[async_trait]
pub trait MessagingSender: Send + Sync {
    /// Sends `text` to `recipient_id`, the provider's id of the person.
    async fn send_text(
        &self,
        cred: &Credential,
        public: &Value,
        recipient_id: &str,
        text: &str,
    ) -> Result<SendReceipt, ConnectorError>;
}

/// Reads and changes ad budgets.
#[async_trait]
pub trait AdBudgetWriter: Send + Sync {
    /// Sets the daily budget of the ad set or campaign `entity_id`, in the ad account's
    /// currency's minor units.
    async fn set_daily_budget(
        &self,
        cred: &Credential,
        entity_id: &str,
        minor: i64,
    ) -> Result<(), ConnectorError>;
    /// The ad account's ad sets.
    async fn list_adsets(
        &self,
        cred: &Credential,
        public: &Value,
    ) -> Result<Vec<AdSet>, ConnectorError>;
    /// The ad account's results per campaign and day, from `since` to `until` inclusive.
    async fn insights(
        &self,
        cred: &Credential,
        public: &Value,
        since: Date,
        until: Date,
    ) -> Result<Vec<AdInsights>, ConnectorError>;
}

/// Fetches lead-gen form submissions announced by a webhook.
#[async_trait]
pub trait LeadGenFetcher: Send + Sync {
    async fn fetch(
        &self,
        cred: &Credential,
        leadgen_id: &str,
    ) -> Result<LeadGenRecord, ConnectorError>;
}

/// Places and ends calls through a PBX.
#[async_trait]
pub trait Telephony: Send + Sync {
    /// Rings extension `from_ext` and connects it to `to`; the receipt carries the call's
    /// correlation id.
    async fn click_to_call(
        &self,
        cred: &Credential,
        from_ext: &str,
        to: &str,
    ) -> Result<SendReceipt, ConnectorError>;
    /// Ends the call with the correlation id `call_id`.
    async fn hangup(&self, cred: &Credential, call_id: &str) -> Result<(), ConnectorError>;
}

/// Records consent changes in the consent registry (İYS).
#[async_trait]
pub trait ConsentSync: Send + Sync {
    /// Adds `rows`; the receipt carries the registry's request id.
    async fn add(
        &self,
        cred: &Credential,
        rows: &[ConsentRow],
    ) -> Result<SendReceipt, ConnectorError>;
}

/// A provider's OAuth flow (authorization code, with PKCE where the provider takes it).
#[async_trait]
pub trait OAuthProvider: Send + Sync {
    /// Where to send the owner's browser: the provider's authorize URL for `app`, returning to
    /// `redirect` with `state`, and with the S256 `pkce_challenge` when given. Holds no secret.
    fn authorize_url(
        &self,
        app: &OAuthApp,
        redirect: &Url,
        state: &str,
        pkce_challenge: Option<&str>,
    ) -> Url;
    /// The credential the authorization `code` is exchanged for (long-lived where the provider
    /// offers one), sending the PKCE `pkce_verifier` when the flow used one.
    async fn exchange(
        &self,
        app: &OAuthApp,
        redirect: &Url,
        code: &str,
        pkce_verifier: Option<&str>,
    ) -> Result<Credential, ConnectorError>;
    /// What the account behind `cred` can reach, each with the credential to reach it with.
    async fn list_assets(&self, cred: &Credential) -> Result<Vec<Asset>, ConnectorError>;
}

/// The provider adapters this process has. Every getter answers `None` for a provider without
/// that adapter or operation (or while no adapters are wired at all).
pub trait ConnectorRegistry: Send + Sync {
    fn connector(&self, provider: Provider) -> Option<Arc<dyn Connector>>;
    fn oauth(&self, provider: Provider) -> Option<Arc<dyn OAuthProvider>>;
    fn sms(&self, provider: Provider) -> Option<Arc<dyn SmsSender>>;
    fn publisher(&self, provider: Provider) -> Option<Arc<dyn Publisher>>;
    fn insights(&self, provider: Provider) -> Option<Arc<dyn InsightsReader>>;
    fn messaging(&self, provider: Provider) -> Option<Arc<dyn MessagingSender>>;
    fn ads(&self, provider: Provider) -> Option<Arc<dyn AdBudgetWriter>>;
    fn leadgen(&self, provider: Provider) -> Option<Arc<dyn LeadGenFetcher>>;
    fn telephony(&self, provider: Provider) -> Option<Arc<dyn Telephony>>;
    fn consent(&self, provider: Provider) -> Option<Arc<dyn ConsentSync>>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_secrets_are_masked_in_debug() {
        let meta = MetaApp {
            app_id: "meta-id".into(),
            app_secret: "meta-secret-value".into(),
            verify_token: "verify-token-value".into(),
            login_config_id: Some("cfg-1".into()),
            whatsapp_config_id: None,
            graph_version: Some("v19.0".into()),
        };
        let instagram = InstagramApp {
            app_id: "ig-id".into(),
            app_secret: "ig-secret-value".into(),
        };
        let x = XApp {
            client_id: "x-id".into(),
            client_secret: "x-secret-value".into(),
        };
        let printed = format!(
            "{meta:?} {instagram:?} {x:?} {:?}",
            OAuthApp::Meta(meta.clone())
        );
        for secret in [
            "meta-secret-value",
            "verify-token-value",
            "ig-secret-value",
            "x-secret-value",
        ] {
            assert!(!printed.contains(secret), "{printed}");
        }
        for public in ["meta-id", "cfg-1", "v19.0", "ig-id", "x-id"] {
            assert!(printed.contains(public), "{printed}");
        }
        assert_eq!(OAuthApp::X(x).client_id(), "x-id");
        assert_eq!(
            OAuthApp::Instagram(instagram).client_secret(),
            "ig-secret-value"
        );
        assert_eq!(OAuthApp::Meta(meta).client_id(), "meta-id");
    }

    #[test]
    fn an_asset_debug_masks_its_credential() {
        let asset = Asset {
            kind_key: "facebook_page".into(),
            external_id: "page-1".into(),
            name: "Kahve".into(),
            credential: Credential::PageToken {
                page_id: "page-1".into(),
                token: "EAAB-page-token".into(),
            },
            public: serde_json::json!({ "name": "Kahve" }),
        };
        let printed = format!("{asset:?}");
        assert!(!printed.contains("EAAB-page-token"), "{printed}");
        assert!(printed.contains("page-1"), "{printed}");
        assert!(printed.contains("credential: ***"), "{printed}");
    }

    #[test]
    fn an_asset_is_shown_only_through_its_public_facts() {
        let asset = Asset {
            kind_key: "facebook_page".into(),
            external_id: "page-1".into(),
            name: "Kahve".into(),
            credential: Credential::PageToken {
                page_id: "page-1".into(),
                token: "EAAB-page-token".into(),
            },
            public: serde_json::json!({ "category": "Cafe" }),
        };
        let public = asset.public_facts();
        assert_eq!(
            public,
            AssetPublic {
                kind_key: "facebook_page".into(),
                external_id: "page-1".into(),
                name: "Kahve".into(),
                public: serde_json::json!({ "category": "Cafe" }),
            }
        );
        let json = serde_json::to_value(&public).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "kind_key": "facebook_page",
                "external_id": "page-1",
                "name": "Kahve",
                "public": { "category": "Cafe" },
            })
        );
        assert!(!json.to_string().contains("EAAB"), "{json}");
        let back: AssetPublic = serde_json::from_value(json).unwrap();
        assert_eq!(back, public);
    }
}
