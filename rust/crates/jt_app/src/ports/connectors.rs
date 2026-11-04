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
use jt_connector::{ConnectorError, Credential, EventKind, ProbeResult, Provider};
/// The kinds a [`PublicEnvelope`] names, for the adapters that build one.
pub use jt_inbox::{PublicKind, SubjectKind};
use jt_tenancy::WorkspaceId;
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
    /// Whether Facebook Login flows ask for the comment scopes (`JEETA_META_COMMENT_SCOPES`,
    /// default off): set by the operator once Meta's App Review granted them, since the live
    /// app's scopes, login configuration and webhook fields stay exactly as submitted until then
    /// (spec 2026-10-30-inbox-comments-marketplace-design.md D11). Off, every Meta request is
    /// what it was before comments.
    pub comment_scopes: bool,
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
            .field("comment_scopes", &self.comment_scopes)
            .finish()
    }
}

/// The platform's Instagram app (Instagram Login, for a tenant that connects Instagram alone).
/// `Debug` masks the app secret.
#[derive(Clone, PartialEq, Eq)]
pub struct InstagramApp {
    pub app_id: String,
    pub app_secret: String,
    /// Whether Instagram Login flows ask for the comment scopes
    /// (`JEETA_INSTAGRAM_COMMENT_SCOPES`, default off), as [`MetaApp::comment_scopes`] for
    /// Facebook Login.
    pub comment_scopes: bool,
}

impl fmt::Debug for InstagramApp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("InstagramApp")
            .field("app_id", &self.app_id)
            .field("app_secret", &Masked)
            .field("comment_scopes", &self.comment_scopes)
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

/// The platform's TikTok app (Login Kit and the Content Posting API). TikTok names its client id
/// the client key. `Debug` masks the client secret.
#[derive(Clone, PartialEq, Eq)]
pub struct TiktokApp {
    pub client_key: String,
    pub client_secret: String,
}

impl fmt::Debug for TiktokApp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TiktokApp")
            .field("client_key", &self.client_key)
            .field("client_secret", &Masked)
            .finish()
    }
}

/// The platform's LinkedIn app (Sign In with LinkedIn using OpenID Connect, Share on LinkedIn
/// and, once LinkedIn approves it, the Community Management API). `Debug` masks the client
/// secret.
#[derive(Clone, PartialEq, Eq)]
pub struct LinkedinApp {
    pub client_id: String,
    pub client_secret: String,
    /// Whether flows may ask for the organization scopes (`r_organization_social`,
    /// `w_organization_social`, `rw_organization_admin`): set by the operator once LinkedIn has
    /// approved the Community Management API for the app (`JEETA_LINKEDIN_ORG_SCOPES`), since
    /// LinkedIn refuses a whole authorize request that names a scope the app was not granted.
    /// Every LinkedIn flow then asks for them (LinkedIn invalidates a member's earlier tokens
    /// when a flow asks for another set of scopes); without them, `linkedin_page` flows are
    /// refused.
    pub organization_scopes: bool,
    /// The `LinkedIn-Version` of the REST API calls, `YYYYMM` (`JEETA_LINKEDIN_API_VERSION`);
    /// `None` lets the adapter use its pinned default.
    pub api_version: Option<String>,
}

impl fmt::Debug for LinkedinApp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LinkedinApp")
            .field("client_id", &self.client_id)
            .field("client_secret", &Masked)
            .field("organization_scopes", &self.organization_scopes)
            .field("api_version", &self.api_version)
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
    /// The TikTok app; `None` (the default) while it is not configured.
    fn tiktok_app(&self) -> Option<TiktokApp> {
        None
    }
    /// The LinkedIn app; `None` (the default) while it is not configured.
    fn linkedin_app(&self) -> Option<LinkedinApp> {
        None
    }
    /// The platform's Hepsiburada integrator user (`JEETA_HEPSIBURADA_INTEGRATOR_USER`), the
    /// Basic auth user of the Hepsiburada calls made with a seller's service key; `None` (the
    /// default) while it is not configured, and the merchant id stands in for it then. Which
    /// value goes where is VERIFY V-H1 (spec 2026-10-30-inbox-comments-marketplace-design.md
    /// §8.3, §12). Not a secret: the seller's service key is.
    fn hepsiburada_integrator_user(&self) -> Option<String> {
        None
    }
    /// Where the panel is reached from outside, for OAuth redirect URIs and webhook URLs; `None`
    /// while it is not configured, and then no flow starts and no webhook URL is shown (the
    /// binary requires it whenever a provider app is configured).
    fn public_base_url(&self) -> Option<Url>;
}

/// The app an OAuth flow signs in with, as the last segment of its redirect URI names it
/// (`{public base URL}/oauth/callback/{key}`): each provider app registers its own redirect URI.
/// A flow keeps its app from start to completion (`OAuthPendingRow::app`), and a credential an
/// OAuth flow issued records it (`connector_public.access.app`; a pasted Meta token records
/// `meta`), so a reconnection signs in with the app that issued the credential.
///
/// | callback | app | a new connection of | a reconnection of |
/// |---|---|---|---|
/// | `meta` | the Meta app (Facebook Login) | every Meta kind but `instagram` | every Meta capability the Meta app issued, `instagram` ones included (through their Page) |
/// | `instagram` | the Instagram app (Instagram Login) | `instagram` | an `instagram` capability the Instagram app issued |
/// | `x` | the X app | `x` | `x` |
/// | `tiktok` | the TikTok app | `tiktok` | `tiktok` |
/// | `linkedin` | the LinkedIn app | `linkedin_member`, `linkedin_page` (the latter only with the organization scopes) | the same |
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OAuthCallback {
    Meta,
    Instagram,
    X,
    Tiktok,
    Linkedin,
}

impl OAuthCallback {
    /// Every callback, in a fixed order.
    pub fn all() -> &'static [OAuthCallback] {
        &[
            OAuthCallback::Meta,
            OAuthCallback::Instagram,
            OAuthCallback::X,
            OAuthCallback::Tiktok,
            OAuthCallback::Linkedin,
        ]
    }

    /// The redirect URI's last segment, also what is stored: `meta`, `instagram`, `x`, `tiktok`
    /// or `linkedin`.
    pub fn key(self) -> &'static str {
        match self {
            OAuthCallback::Meta => "meta",
            OAuthCallback::Instagram => "instagram",
            OAuthCallback::X => "x",
            OAuthCallback::Tiktok => "tiktok",
            OAuthCallback::Linkedin => "linkedin",
        }
    }

    /// The callback whose key is `key`, if one is.
    pub fn parse(key: &str) -> Option<OAuthCallback> {
        OAuthCallback::all()
            .iter()
            .copied()
            .find(|c| c.key() == key)
    }

    /// The provider whose flows come back here: Instagram Login is a Meta flow.
    pub fn provider(self) -> Provider {
        match self {
            OAuthCallback::Meta | OAuthCallback::Instagram => Provider::Meta,
            OAuthCallback::X => Provider::X,
            OAuthCallback::Tiktok => Provider::Tiktok,
            OAuthCallback::Linkedin => Provider::Linkedin,
        }
    }

    /// The app a new connection of `kind_key` with `provider` signs in with (see the table
    /// above); `None` for a provider without OAuth (NetGSM).
    pub fn of_flow(provider: Provider, kind_key: &str) -> Option<OAuthCallback> {
        match provider {
            Provider::Meta if kind_key == "instagram" => Some(OAuthCallback::Instagram),
            Provider::Meta => Some(OAuthCallback::Meta),
            Provider::X => Some(OAuthCallback::X),
            Provider::Tiktok => Some(OAuthCallback::Tiktok),
            Provider::Linkedin => Some(OAuthCallback::Linkedin),
            Provider::Netgsm | Provider::Mail | Provider::Trendyol | Provider::Hepsiburada => None,
        }
    }
}

/// The app an OAuth flow runs under. Meta serves two login flows: Facebook Login with the Meta
/// app, and Instagram Login with the Instagram app; the variant tells the adapter which. A
/// LinkedIn flow's app says whether the flow asks for the organization scopes
/// ([`LinkedinApp::organization_scopes`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OAuthApp {
    Meta(MetaApp),
    Instagram(InstagramApp),
    X(XApp),
    Tiktok(TiktokApp),
    Linkedin(LinkedinApp),
}

impl OAuthApp {
    /// The public client id: the Meta or Instagram app id, the X or LinkedIn client id, or the
    /// TikTok client key.
    pub fn client_id(&self) -> &str {
        match self {
            OAuthApp::Meta(app) => &app.app_id,
            OAuthApp::Instagram(app) => &app.app_id,
            OAuthApp::X(app) => &app.client_id,
            OAuthApp::Tiktok(app) => &app.client_key,
            OAuthApp::Linkedin(app) => &app.client_id,
        }
    }

    /// The client secret, for the token exchange only.
    pub fn client_secret(&self) -> &str {
        match self {
            OAuthApp::Meta(app) => &app.app_secret,
            OAuthApp::Instagram(app) => &app.app_secret,
            OAuthApp::X(app) => &app.client_secret,
            OAuthApp::Tiktok(app) => &app.client_secret,
            OAuthApp::Linkedin(app) => &app.client_secret,
        }
    }
}

/// A variant of a provider's sign-in, chosen when a flow starts and kept with it to its
/// completion (`OAuthPendingRow::flow`): the authorize URL, the code exchange and the asset
/// listing each follow it ([`OAuthProvider::authorize_url_for`],
/// [`OAuthProvider::exchange_for`], [`OAuthProvider::list_assets_for`]). A flow without one is the
/// provider's own sign-in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OAuthFlow {
    /// Meta's WhatsApp Embedded Signup for a number the business already uses in the WhatsApp
    /// Business app, which keeps working beside the Cloud API ("coexistence",
    /// <https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users>):
    /// signed in with the Meta app's WhatsApp configuration (`MetaApp::whatsapp_config_id`), it
    /// connects `whatsapp_cloud` only.
    WhatsappBusinessApp,
}

impl OAuthFlow {
    /// Every flow, in a fixed order.
    pub fn all() -> &'static [OAuthFlow] {
        &[OAuthFlow::WhatsappBusinessApp]
    }

    /// Its key, also what is stored: `whatsapp_business_app`.
    pub fn key(self) -> &'static str {
        match self {
            OAuthFlow::WhatsappBusinessApp => "whatsapp_business_app",
        }
    }

    /// The flow whose key is `key`, if one is.
    pub fn parse(key: &str) -> Option<OAuthFlow> {
        OAuthFlow::all().iter().copied().find(|f| f.key() == key)
    }

    /// The one capability kind the flow connects.
    pub fn kind_key(self) -> &'static str {
        match self {
            OAuthFlow::WhatsappBusinessApp => "whatsapp_cloud",
        }
    }
}

/// What a WhatsApp Business app shares once, when its number has been onboarded beside it
/// ([`MessagingSender::request_app_sync`]): its contacts, or its chat history.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AppSync {
    /// The app's contacts (Meta's `sync_type: smb_app_state_sync`).
    Contacts,
    /// The app's one-to-one chat history (Meta's `sync_type: history`).
    History,
}

impl AppSync {
    /// Its key, as stored: `contacts` or `history`.
    pub fn key(self) -> &'static str {
        match self {
            AppSync::Contacts => "contacts",
            AppSync::History => "history",
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
    /// Cost in minor currency units when reported by the provider; unknown stays `None`.
    #[serde(default)]
    pub cost_minor: Option<i64>,
}

/// A mail attachment. Bytes are transport-only: never log or write them to the ledger.
/// `Debug` exposes only the filename, MIME type and byte count.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Attachment {
    pub filename: String,
    pub mime: String,
    pub bytes: Vec<u8>,
}

impl fmt::Debug for Attachment {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Attachment")
            .field("filename", &self.filename)
            .field("mime", &self.mime)
            .field("bytes", &format_args!("<{} bytes>", self.bytes.len()))
            .finish()
    }
}

/// A typed outgoing mail, with credentials supplied separately. The caller persists metadata
/// and the stable Message-ID before sending; attachment bytes never enter logs or the ledger.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MailMessage {
    pub to: String,
    pub subject: String,
    pub text: String,
    pub message_id: String,
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
    pub attachments: Vec<Attachment>,
}

/// The last seen UID within one mailbox's UIDVALIDITY generation.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MailboxPosition {
    pub uidvalidity: u32,
    pub last_uid: u32,
}

/// Independent positions for mailbox names (INBOX and Sent). The caller persists the returned
/// cursor atomically with the inbound drafts, so a failed transaction can safely poll again.
///
/// A mailbox the cursor holds no position for (a newly connected mailbox, a Sent folder found
/// later) or whose UIDVALIDITY changed (renumbering every message) starts at its current end: the
/// poll records its position and ingests only mail that arrives afterwards, never the history
/// already in it, which would otherwise land in the reply-owed queue as if it were new.
/// `read_history` reads such a mailbox from its first message instead; it is a call-time option
/// (an explicit import, the adapter tests) that is never persisted, so no connected mailbox sets it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MailboxCursor {
    pub mailboxes: BTreeMap<String, MailboxPosition>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub read_history: bool,
}

impl MailboxCursor {
    /// An empty cursor that reads every mailbox from its first message.
    pub fn reading_history() -> MailboxCursor {
        MailboxCursor {
            read_history: true,
            ..MailboxCursor::default()
        }
    }
}

/// A post to publish: its text, the media to attach and an optional link.
///
/// Media come in one of two forms, as the provider takes them: `media_urls`, public URLs an
/// adapter hands to a provider that fetches them itself (Meta), or `media`, the files' bytes for a
/// provider that takes uploads only (X). The caller (M3) supplies the bytes, read from the asset
/// store through the egress client; an adapter never fetches a URL itself. An adapter that hands
/// URLs over ignores `media`; one that uploads refuses `media_urls` without `media`.
///
/// `media` is never serialised: a request written out carries no bytes, and one read back has
/// none (`media` empty), so the bytes are supplied again where they are needed.
///
/// `privacy` is who may see the post, by the provider's own name (TikTok's `privacy_level`:
/// `PUBLIC_TO_EVERYONE`, `MUTUAL_FOLLOW_FRIENDS`, `FOLLOWER_OF_CREATOR` or `SELF_ONLY`); `None`
/// lets the adapter post publicly. An adapter that cannot honour it refuses the post rather than
/// posting to another audience; one without such a setting ignores it.
///
/// `tiktok` is what a human chose on the TikTok posting screen (`jt_studio::TiktokPost`): the
/// caption (then `text`, with no `link`), the privacy (then also `privacy`), the interactions and
/// the commercial content disclosure. The TikTok adapter posts nothing without it and never
/// picks a privacy itself; every other adapter ignores it.
///
/// `format` is the planned post's (`jt_studio::PostFormat`, spec 2026-11-03 D20), `None` for a
/// slot of the weekly quotas. Instagram publishes a `story` as a `STORIES` container (one medium,
/// no caption) and refuses a story it cannot post as one; every other format, and every other
/// adapter, goes by the media as before.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublishRequest {
    pub text: String,
    pub media_urls: Vec<Url>,
    pub link: Option<Url>,
    /// The files to upload, in the order they are attached. Never serialised.
    #[serde(skip)]
    pub media: Vec<MediaUpload>,
    /// Who may see the post (see above); `None`: public.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub privacy: Option<String>,
    /// The TikTok posting screen's choice (see above).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tiktok: Option<TiktokPost>,
    /// The planned post's format, when the slot carries one (see above).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<PostFormat>,
}

// Shared pure transport records; existing Publisher and FileStore signatures are unchanged.
pub use jt_studio::{
    MediaUpload, PostFormat, PublishReceipt, TiktokCreator, TiktokMedia, TiktokPost,
    TiktokPostFlags, TiktokPostMode, TiktokPostRefusal,
};

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

/// One of an account's recent public posts, as its provider lists them
/// ([`InsightsReader::recent_posts`]): its id, title, cover image and page (browser URLs, never
/// fetched), when it was posted, and its counters by the provider's metric name.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecentPost {
    pub id: String,
    pub title: Option<String>,
    pub cover_image_url: Option<Url>,
    pub share_url: Option<Url>,
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub created_at: Option<OffsetDateTime>,
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

/// Account metadata used to interpret provider money and daily reporting buckets.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdAccountContext {
    pub account_id: String,
    pub currency: String,
    pub minor_unit_exponent: u8,
    pub timezone: String,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum AdStatus {
    Paused,
    Active,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdSetInsights {
    pub account_id: String,
    pub adset_id: String,
    pub campaign_id: Option<String>,
    pub date: Date,
    pub spend_minor: Option<i64>,
    pub impressions: Option<i64>,
    pub clicks: Option<i64>,
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

/// Where a message sent earlier stands, as a provider's delivery report says.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryState {
    /// It reached the recipient's handset (final).
    Delivered,
    /// It will not be delivered (final): refused, expired, a wrong number, no consent.
    Failed,
    /// Not final yet: ask again later.
    Pending,
    /// A status the adapter does not know, by the provider's code; not final.
    Unknown(String),
}

/// One job's delivery report: the job (the provider id of a [`SendReceipt`]), its recipient,
/// where it stands, when that happened when the provider says, and the provider's own status
/// code (each adapter documents its form).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeliveryStatus {
    pub job_id: String,
    pub recipient: String,
    pub status: DeliveryState,
    #[serde(with = "time::serde::rfc3339::option")]
    pub at: Option<OffsetDateTime>,
    pub raw_code: String,
}

/// An inbound event as a provider gives it (an item of a webhook body, a polled message), before
/// it is routed to a workspace and stored as a [`jt_connector::InboundEvent`].
#[derive(Clone, Debug, PartialEq)]
pub struct InboundEventDraft {
    /// The provider's id of the event, unique per provider within a workspace: the dedupe key.
    /// A webhook delivery and a poll that find the same event give it the same id.
    pub external_id: String,
    pub kind: EventKind,
    /// The provider's item, under a key naming its family (each adapter documents its own).
    pub payload: Value,
    /// When it happened, by the provider's clock, when the item says.
    pub occurred_at: Option<OffsetDateTime>,
}

// ---------------------------------------------------------------------------------------------
// Public items: comments and marketplace questions
// ---------------------------------------------------------------------------------------------

/// One comment or marketplace question as every adapter writes it into an inbound event of kind
/// `Comment` or `Question` (spec 2026-10-30-inbox-comments-marketplace-design.md §6.3): the
/// payload is `{"public": <envelope>, "provider_item": <the provider's item as sent>}`
/// ([`PublicEnvelope::into_payload`]), and the inbox's one provider-agnostic intake reads it back
/// ([`PublicEnvelope::from_payload`]). Provider knowledge stays in the adapters.
///
/// Read tolerantly: an unknown field is ignored and an optional part left out reads as absent;
/// the identity fields (`kind`, `account_id`, `external_id`, `root_external_id`, `status`,
/// `author`, `text`, `created_at`) are required, and an external id must be 1 to
/// [`jt_inbox::public::MAX_EXTERNAL_ID_CHARS`] characters, not blank.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PublicEnvelope {
    /// A comment or a question.
    pub kind: PublicKind,
    /// The capability's external id: the Instagram account, the Page, the seller, the merchant.
    pub account_id: String,
    /// The provider's comment or question id: the reply target.
    pub external_id: String,
    /// The comment it answers; `None` at the top level.
    #[serde(default)]
    pub parent_external_id: Option<String>,
    /// The thread's top-level comment: itself at the top level.
    pub root_external_id: String,
    /// What the provider says of it now.
    pub status: EnvelopeStatus,
    /// Who wrote it.
    pub author: EnvelopeAuthor,
    /// What it says (personal data: never logged).
    pub text: String,
    /// When the provider says it was written.
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    /// The provider's answer deadline, when it gives one (Hepsiburada's `expireDate`).
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub deadline: Option<OffsetDateTime>,
    /// Whether it is a live video's comment.
    #[serde(default)]
    pub live: bool,
    /// The post or product it is about, as much as the provider's item tells.
    #[serde(default)]
    pub subject: Option<EnvelopeSubject>,
    /// The answer the provider shows, when it shows one (ours or another's).
    #[serde(default)]
    pub answer: Option<EnvelopeAnswer>,
    /// The provider's refusal of an answer, when it refused one.
    #[serde(default)]
    pub rejection: Option<EnvelopeRejection>,
}

impl PublicEnvelope {
    /// The inbound event payload: `{"public": <self>, "provider_item": provider_item}`.
    pub fn into_payload(self, provider_item: Value) -> Value {
        let mut payload = serde_json::Map::new();
        payload.insert(
            "public".to_owned(),
            serde_json::to_value(self).unwrap_or(Value::Null),
        );
        payload.insert("provider_item".to_owned(), provider_item);
        Value::Object(payload)
    }

    /// The envelope of an inbound event payload, `None` when it holds none or one without its
    /// identity fields (see the type's docs).
    pub fn from_payload(payload: &Value) -> Option<PublicEnvelope> {
        let envelope: PublicEnvelope =
            serde_json::from_value(payload.get("public")?.clone()).ok()?;
        let id_ok = |id: &str| {
            !id.trim().is_empty() && id.chars().count() <= jt_inbox::public::MAX_EXTERNAL_ID_CHARS
        };
        let ok = id_ok(&envelope.account_id)
            && id_ok(&envelope.external_id)
            && id_ok(&envelope.root_external_id)
            && envelope.parent_external_id.as_deref().is_none_or(id_ok);
        ok.then_some(envelope)
    }
}

/// What a provider says of a public item now. Each new provider state is a new inbound event
/// (its own external id), a replayed one a duplicate.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvelopeStatus {
    /// Written, waiting for an answer.
    Open,
    /// Edited by its author (a new revision of its text).
    Edited,
    /// Removed by its author or the platform.
    Removed,
    /// Answered: the envelope's `answer` is the text the provider shows.
    Answered,
    /// An answer is in the platform's review (Trendyol).
    Pending,
    /// The platform refused the answer: the envelope's `rejection` says why.
    Rejected,
    /// Its answer deadline passed, as the provider says.
    Expired,
    /// Reported to the marketplace.
    Reported,
}

/// Who wrote a public item: the provider's id and display name of the author, when it gives
/// them, and whether it is the account itself (our own comment).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnvelopeAuthor {
    /// The provider's id of the author; `None` when it gives none (a one-off person then).
    #[serde(default)]
    pub id: Option<String>,
    /// The name the provider shows, when it may be shown (personal data: never logged).
    #[serde(default)]
    pub name: Option<String>,
    /// Whether the author is the account itself.
    #[serde(default)]
    pub is_self: bool,
}

/// The post or product a public item is about, as the provider's item tells it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EnvelopeSubject {
    /// A post or a product.
    pub kind: SubjectKind,
    /// The provider's post (media) or product id.
    pub external_id: String,
    /// A caption excerpt or the product's name; empty when the item does not tell.
    #[serde(default)]
    pub title: String,
    /// Its permalink.
    #[serde(default)]
    pub url: Option<String>,
    /// A thumbnail on the provider's CDN.
    #[serde(default)]
    pub image_url: Option<String>,
    /// Further provider facts (media product type, barcode, ...).
    #[serde(default)]
    pub facts: Value,
}

/// The answer a provider shows for a public item.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnvelopeAnswer {
    /// Its text.
    pub text: String,
    /// When it was given, when the provider says.
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub at: Option<OffsetDateTime>,
}

/// A provider's refusal of an answer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnvelopeRejection {
    /// The provider's reason, as it gives it.
    pub reason: String,
    /// When it refused, when the provider says.
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub at: Option<OffsetDateTime>,
}

/// What a reply or a moderation call on a public item addresses: the item's kind and external
/// id, its parent's, and its subject's when known. Stored in an outbox intent
/// (`intent.public.target`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublicTarget {
    pub kind: PublicKind,
    pub external_id: String,
    #[serde(default)]
    pub parent_external_id: Option<String>,
    #[serde(default)]
    pub subject_external_id: Option<String>,
}

/// A private reply's receipt: the provider's id of the message sent, and the recipient's
/// messaging id when the provider tells it (VERIFY V-M5), which links the commenter to their
/// direct-message identity.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrivateReceipt {
    pub provider_id: String,
    #[serde(default)]
    pub recipient_id: Option<String>,
}

/// A moderation call on a public item.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum ModerationAction {
    /// Hides a comment (reversible).
    Hide,
    /// Shows a hidden comment again.
    Unhide,
    /// Deletes a comment.
    Delete,
    /// Reports a marketplace question.
    Report { reason: ReportReason },
}

/// Why a question is reported.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportReason {
    Spam,
    Offensive,
    PersonalData,
    Irrelevant,
    Other,
}

/// What a provider tells of a post or product when asked ([`PublicSurface::subject`]).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SubjectFacts {
    pub kind: SubjectKind,
    /// A caption excerpt or the product's name.
    pub title: String,
    pub url: Option<String>,
    pub image_url: Option<String>,
    /// Further provider facts, an object.
    pub facts: Value,
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
/// the opened sealed one of a capability; `public` is the capability's `connector_public` as the
/// use cases hand it to adapters: with `workspace_id` (the capability's workspace),
/// `kind_key` (the capability's kind) and, when the capability
/// holds one, `external_id` (its account) set from the capability itself, whatever the stored
/// fields say (these authoritative values are supplied at call time). The kind tells an adapter serving
/// several kinds which call to make (a Meta Page token reaches a page, its Messenger inbox and its
/// Instagram account).
#[async_trait]
pub trait Connector: Send + Sync {
    fn provider(&self) -> Provider;
    /// The hosts the adapter reaches (`host` or `host:port`), as the egress allowlist's fixed
    /// tier names them for its provider. A capability connected through it names them in
    /// `connector_public.hosts`, and the workspace's tenant tier is given them.
    fn hosts(&self) -> &'static [&'static str];
    /// A cheap authenticated call that says whether the capability can be reached. Never fails:
    /// a failure is a [`ProbeResult`] with `ok == false` and its error.
    ///
    /// **The account contract.** A success MUST name, as a string in `facts.account_id`, the
    /// identity the credential itself authenticates as, as the provider reports it for the
    /// credential (Meta: the page id of a Page token, the Instagram user id of an Instagram token,
    /// the WhatsApp phone number id of a WhatsApp Cloud token, the user id of a user token, each
    /// from the credential's own identity such as Graph `/me`; X: the user id; NetGSM: the SMS
    /// sender name (`msgheader`) or the PBX user name). Never an id taken from the request or from
    /// `public`: a provider that echoes the id it was asked about would let any credential pass
    /// for any account. (An account that is not the credential's own identity, such as a Meta ad
    /// account or a WhatsApp number reached with a user or system token, is named as the provider
    /// reports it for a node it serves only to a credential with access to it; the adapter says
    /// which.) The use cases compare it verbatim with the capability's external id; a
    /// success that names no account, or names it otherwise than as a string, never verifies the
    /// capability. Other facts are optional, non-secret, and screened before they are shown.
    async fn probe(&self, cred: &Credential, public: &Value) -> ProbeResult;
    /// A fresh credential when this one can and should be renewed (an expiring or rotating
    /// token), `None` when it needs no renewal.
    async fn refresh(&self, cred: &Credential) -> Result<Option<Credential>, ConnectorError>;
    /// The provider-side steps of a new connection, run once a credential has been sealed for a
    /// capability (an OAuth asset confirmed, credentials entered by hand) and before it is
    /// probed: subscribing a Facebook Page to the platform app's webhooks, registering a
    /// WhatsApp number. `public` is as [`Connector::probe`] gets it.
    ///
    /// Returns non-secret facts to keep in the capability's `connector_public` (an object, whose
    /// keys are merged in, but never over a connector-owned key such as `health` or `access`, nor
    /// over `hosts`, `name` or `external_id`, and screened like a probe's facts), or `Value::Null`
    /// for none. Best effort: a failure never undoes the connection, it is recorded in
    /// `connector_public.health.on_connected_error`. The default does nothing.
    async fn on_connected(
        &self,
        cred: &Credential,
        public: &Value,
    ) -> Result<Value, ConnectorError> {
        let _ = (cred, public);
        Ok(Value::Null)
    }
    /// Gives back, at the provider, the access `cred` grants the platform's app, once its
    /// capability is retired (TikTok's token revocation: the app then leaves the account's
    /// authorized apps). Best effort: the retirement, and the credential's erasure, never wait on
    /// it. The default does nothing (a provider that offers no revocation, or one this system does
    /// not call).
    async fn revoke(&self, cred: &Credential) -> Result<(), ConnectorError> {
        let _ = cred;
        Ok(())
    }
}

/// Sends SMS.
#[async_trait]
pub trait SmsSender: Send + Sync {
    /// Sends `text` to `to` (a phone number), with the caller's `reference` for correlating
    /// delivery reports when given. `commercial` enables the provider's commercial consent
    /// filter (NetGSM İYS); informational replies pass `false`.
    async fn send(
        &self,
        cred: &Credential,
        to: &str,
        text: &str,
        reference: Option<&str>,
        commercial: bool,
    ) -> Result<SendReceipt, ConnectorError>;
}

/// Where a post stands at the provider once [`Publisher::publish`] returned its receipt, for a
/// provider that publishes in the background (TikTok processes a video after accepting it).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PublishResolution {
    /// The post is live: its own receipt, whose id may differ from the one `publish` returned
    /// (TikTok's publish id becomes the post's id).
    Published(PublishReceipt),
    /// The post is live but the provider names no public id for it yet: TikTok names one only
    /// once the post is public and passed its moderation, so a post everyone may see can read
    /// complete before it has one, and one fewer may see never does. The receipt is the post as
    /// known now (TikTok's publish id, no URL): the publication settles as it unless a public id
    /// may still come (see `usecases::studio::publish::PUBLIC_ID_WAIT`).
    AwaitingPublicId(PublishReceipt),
    /// Not settled yet: ask again later.
    Pending,
    /// The provider gave up on it, for this reason.
    Failed(ConnectorError),
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
    /// Where the post `receipt` names stands at the provider (`public` as [`Connector::probe`]
    /// gets it). `None`, the default, for a provider whose `publish` answers only once the post is
    /// live: its receipt is the post. A read: it never publishes anything.
    async fn resolve(
        &self,
        cred: &Credential,
        public: &Value,
        receipt: &PublishReceipt,
    ) -> Result<Option<PublishResolution>, ConnectorError> {
        let _ = (cred, public, receipt);
        Ok(None)
    }
    /// What the provider says, right now, about the account a post goes to, for a provider whose
    /// posts a human makes on its posting screen (TikTok's `creator_info`, read fresh each time
    /// the screen is shown and before a choice is accepted; an account that may not post at this
    /// moment says why in [`TiktokCreator::cannot_post`] rather than failing). `None`, the
    /// default, for a provider without such a screen. A read: it never publishes anything.
    async fn creator_info(
        &self,
        cred: &Credential,
        public: &Value,
    ) -> Result<Option<TiktokCreator>, ConnectorError> {
        let _ = (cred, public);
        Ok(None)
    }
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
    /// The account's most recent public posts, newest first, at most `limit` (the provider may
    /// cap it), each with its counters, for a provider that lists them (TikTok's
    /// `/v2/video/list/`). `None`, the default, for one that does not.
    async fn recent_posts(
        &self,
        cred: &Credential,
        public: &Value,
        limit: u32,
    ) -> Result<Option<Vec<RecentPost>>, ConnectorError> {
        let _ = (cred, public, limit);
        Ok(None)
    }
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
    /// The name the provider shows for `sender_id`, the provider's id of a person who wrote to
    /// the capability (`public` as [`Connector::probe`] gets it); `None` when it tells none.
    /// Best-effort: the inbox only asks for a person it has no name for, and goes on without one.
    async fn sender_name(
        &self,
        cred: &Credential,
        public: &Value,
        sender_id: &str,
    ) -> Result<Option<String>, ConnectorError> {
        let _ = (cred, public, sender_id);
        Ok(None)
    }
    /// Asks the provider to share, once, what the WhatsApp Business app behind the capability
    /// holds (`sync`): its contacts or its chat history, which then arrive by webhook. The
    /// receipt's `provider_id` is the provider's request id. A provider takes each request once
    /// per onboarding: a request whose answer was lost is `Unknown` and must not be asked again
    /// blindly. `None`, the default, for a provider or a capability without such an app.
    async fn request_app_sync(
        &self,
        cred: &Credential,
        public: &Value,
        sync: AppSync,
    ) -> Result<Option<SendReceipt>, ConnectorError> {
        let _ = (cred, public, sync);
        Ok(None)
    }
}

/// Sends typed mail within `ws`, preserving the caller's Message-ID, thread headers and attachments.
#[async_trait]
pub trait MailSender: Send + Sync {
    async fn send(
        &self,
        ws: WorkspaceId,
        cred: &Credential,
        message: MailMessage,
    ) -> Result<SendReceipt, ConnectorError>;
}

/// Polls mailboxes within `ws`, independently of SMS delivery reports. No cursor storage happens here.
/// The explicit workspace controls authorization; `public` cannot override it.
#[async_trait]
pub trait MailboxPoller: Send + Sync {
    async fn poll(
        &self,
        ws: WorkspaceId,
        cred: &Credential,
        public: &Value,
        cursor: &MailboxCursor,
    ) -> Result<(Vec<InboundEventDraft>, MailboxCursor), ConnectorError>;
}

/// Reads and changes ad budgets.
#[async_trait]
pub trait AdBudgetWriter: Send + Sync {
    async fn set_status(
        &self,
        _cred: &Credential,
        _entity_id: &str,
        _status: AdStatus,
    ) -> Result<(), ConnectorError> {
        Err(ConnectorError::permanent("ad status is unsupported"))
    }
    async fn account_context(
        &self,
        _cred: &Credential,
        _public: &Value,
    ) -> Result<AdAccountContext, ConnectorError> {
        Err(ConnectorError::permanent(
            "ad account context is unsupported",
        ))
    }
    async fn adset_insights(
        &self,
        _cred: &Credential,
        _public: &Value,
        _since: Date,
        _until: Date,
    ) -> Result<Vec<AdSetInsights>, ConnectorError> {
        Err(ConnectorError::permanent("ad set insights are unsupported"))
    }
    async fn resolve_adset(
        &self,
        _cred: &Credential,
        _public: &Value,
        _ad_id: &str,
    ) -> Result<Option<String>, ConnectorError> {
        Err(ConnectorError::permanent(
            "ad set resolution is unsupported",
        ))
    }

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

/// Reads what a provider tells only when asked (polled, never pushed): the delivery reports of
/// messages sent earlier, and the inbox backup that finds messages a webhook missed.
#[async_trait]
pub trait DeliveryReports: Send + Sync {
    /// The delivery reports of the jobs `job_ids` (the provider ids of [`SmsSender::send`]
    /// receipts). A job the provider does not report on is absent from the answer.
    async fn report(
        &self,
        cred: &Credential,
        job_ids: &[String],
    ) -> Result<Vec<DeliveryStatus>, ConnectorError>;
    /// The messages that arrived between `from` and `to`, as events whose `external_id` is the
    /// one the provider's webhook gives the same message, so a poll never duplicates a push.
    async fn inbox(
        &self,
        cred: &Credential,
        from: OffsetDateTime,
        to: OffsetDateTime,
    ) -> Result<Vec<InboundEventDraft>, ConnectorError>;
}

/// The reason of the `ConnectorError::Permanent` a [`PublicSurface`] answers when the item a
/// reply or moderation names is gone on the provider (a deleted comment, a removed question):
/// the inbox then marks the item removed and fails the reply with `item_removed`. Which provider
/// answer means it is each adapter's to map (Meta's is VERIFY V-M10, spec §12).
pub const PUBLIC_ITEM_GONE: &str = "public_item_gone";

/// Replies and moderation on public items: comments on posts and marketplace questions (spec
/// 2026-10-30-inbox-comments-marketplace-design.md §6.1). `public` is as [`Connector::probe`]
/// gets it; `target` names the item. An adapter refuses, before any call, what the credential's
/// grant does not hold (a Meta token without the comment scopes).
#[async_trait]
pub trait PublicSurface: Send + Sync {
    /// Answers the item in front of everyone: a comment reply, a marketplace answer. The receipt
    /// carries the provider's id of the reply.
    async fn reply_public(
        &self,
        cred: &Credential,
        public: &Value,
        target: &PublicTarget,
        text: &str,
    ) -> Result<SendReceipt, ConnectorError>;
    /// Answers the item's author privately (Instagram's and Facebook's private reply). The
    /// default refuses: a surface without private replies.
    async fn reply_private(
        &self,
        cred: &Credential,
        public: &Value,
        target: &PublicTarget,
        text: &str,
    ) -> Result<PrivateReceipt, ConnectorError> {
        let _ = (cred, public, target, text);
        Err(ConnectorError::permanent("no private replies"))
    }
    /// Hides, shows again, deletes or reports the item.
    async fn moderate(
        &self,
        cred: &Credential,
        public: &Value,
        target: &PublicTarget,
        action: ModerationAction,
    ) -> Result<(), ConnectorError>;
    /// What the provider tells of the post or product `subject_external_id`; `None`, the
    /// default, when it tells nothing more than its items do. A read.
    async fn subject(
        &self,
        cred: &Credential,
        public: &Value,
        subject_external_id: &str,
    ) -> Result<Option<SubjectFacts>, ConnectorError> {
        let _ = (cred, public, subject_external_id);
        Ok(None)
    }
}

/// Polls public items: the new ones from a cursor, and the current state of known ones. Each
/// item comes back as an inbound event draft whose payload is a [`PublicEnvelope`], under the
/// same external ids a webhook gives the same state, so a poll never duplicates a push. No
/// cursor is stored here: the caller stores the returned cursor with the drafts.
#[async_trait]
pub trait PublicPoller: Send + Sync {
    /// The items new since `cursor` (an object, `{}` before the first poll), within `ws`, and
    /// the cursor to start from next time.
    async fn poll(
        &self,
        ws: WorkspaceId,
        cred: &Credential,
        public: &Value,
        cursor: &Value,
    ) -> Result<(Vec<InboundEventDraft>, Value), ConnectorError>;
    /// The current state of the items `targets` names, those whose state changed.
    async fn reconcile(
        &self,
        cred: &Credential,
        public: &Value,
        targets: &[PublicTarget],
    ) -> Result<Vec<InboundEventDraft>, ConnectorError>;
}

/// Places and ends calls through a PBX.
#[async_trait]
pub trait Telephony: Send + Sync {
    /// Rings `from_ext` and connects it to `to`; the receipt carries the call's correlation id.
    /// `public` is as [`Connector::probe`] gets it, and carries the workspace's call policy
    /// (whether calls may be recorded, which way the PBX places them; each adapter documents
    /// its keys).
    async fn click_to_call(
        &self,
        cred: &Credential,
        public: &Value,
        from_ext: &str,
        to: &str,
    ) -> Result<SendReceipt, ConnectorError>;
    /// Ends the live call whose id at the PBX is `call_id`, as the provider's call events name it
    /// (NetGSM: the `unique_id`). That is not always the receipt's correlation id: a NetGSM
    /// receipt carries the `crm_id`, which the call events carry beside the `unique_id`.
    async fn hangup(&self, cred: &Credential, call_id: &str) -> Result<(), ConnectorError>;
    /// The PBX's call records between `from` and `to`, as call events whose `external_id` is
    /// the one its webhook gives the same record, so a poll never duplicates a push.
    async fn call_records(
        &self,
        cred: &Credential,
        from: OffsetDateTime,
        to: OffsetDateTime,
    ) -> Result<Vec<InboundEventDraft>, ConnectorError>;
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
    /// Refused (no URL) when the flow cannot start: an app that is not this provider's, or no
    /// challenge for a provider that requires PKCE (X). Nothing is called: it only builds a URL.
    fn authorize_url(
        &self,
        app: &OAuthApp,
        redirect: &Url,
        state: &str,
        pkce_challenge: Option<&str>,
    ) -> Result<Url, ConnectorError>;
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
    /// [`OAuthProvider::authorize_url`] for the sign-in variant `flow` ([`OAuthFlow`]); without
    /// one, exactly `authorize_url`. The default refuses every variant (`Permanent`): a provider
    /// that has one overrides it.
    fn authorize_url_for(
        &self,
        app: &OAuthApp,
        redirect: &Url,
        state: &str,
        pkce_challenge: Option<&str>,
        flow: Option<OAuthFlow>,
    ) -> Result<Url, ConnectorError> {
        match flow {
            None => self.authorize_url(app, redirect, state, pkce_challenge),
            Some(_) => Err(ConnectorError::permanent(
                "this provider has no such sign-in flow",
            )),
        }
    }
    /// [`OAuthProvider::exchange`] for the sign-in variant `flow`; without one, exactly
    /// `exchange`. The default refuses every variant.
    async fn exchange_for(
        &self,
        app: &OAuthApp,
        redirect: &Url,
        code: &str,
        pkce_verifier: Option<&str>,
        flow: Option<OAuthFlow>,
    ) -> Result<Credential, ConnectorError> {
        match flow {
            None => self.exchange(app, redirect, code, pkce_verifier).await,
            Some(_) => Err(ConnectorError::permanent(
                "this provider has no such sign-in flow",
            )),
        }
    }
    /// [`OAuthProvider::list_assets`] for a credential the sign-in variant `flow` issued; without
    /// one, exactly `list_assets`. The default refuses every variant.
    async fn list_assets_for(
        &self,
        cred: &Credential,
        flow: Option<OAuthFlow>,
    ) -> Result<Vec<Asset>, ConnectorError> {
        match flow {
            None => self.list_assets(cred).await,
            Some(_) => Err(ConnectorError::permanent(
                "this provider has no such sign-in flow",
            )),
        }
    }
}

/// The provider adapters this process has. Every getter answers `None` for a provider without
/// that adapter or operation (or while no adapters are wired at all).
pub trait ConnectorRegistry: Send + Sync {
    fn connector(&self, provider: Provider) -> Option<Arc<dyn Connector>>;
    fn oauth(&self, provider: Provider) -> Option<Arc<dyn OAuthProvider>>;
    fn sms(&self, provider: Provider) -> Option<Arc<dyn SmsSender>>;
    fn mail_sender(&self, provider: Provider) -> Option<Arc<dyn MailSender>>;
    fn mailbox_poller(&self, provider: Provider) -> Option<Arc<dyn MailboxPoller>>;
    fn publisher(&self, provider: Provider) -> Option<Arc<dyn Publisher>>;
    fn insights(&self, provider: Provider) -> Option<Arc<dyn InsightsReader>>;
    fn messaging(&self, provider: Provider) -> Option<Arc<dyn MessagingSender>>;
    fn ads(&self, provider: Provider) -> Option<Arc<dyn AdBudgetWriter>>;
    fn leadgen(&self, provider: Provider) -> Option<Arc<dyn LeadGenFetcher>>;
    fn telephony(&self, provider: Provider) -> Option<Arc<dyn Telephony>>;
    fn consent(&self, provider: Provider) -> Option<Arc<dyn ConsentSync>>;
    fn delivery_reports(&self, provider: Provider) -> Option<Arc<dyn DeliveryReports>>;
    /// Replies and moderation on public items; `None`, the default, for a provider without them.
    fn public(&self, provider: Provider) -> Option<Arc<dyn PublicSurface>> {
        let _ = provider;
        None
    }
    /// The public items' poll; `None`, the default, for a provider without one.
    fn public_poller(&self, provider: Provider) -> Option<Arc<dyn PublicPoller>> {
        let _ = provider;
        None
    }
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
            comment_scopes: false,
        };
        let instagram = InstagramApp {
            app_id: "ig-id".into(),
            app_secret: "ig-secret-value".into(),
            comment_scopes: false,
        };
        let x = XApp {
            client_id: "x-id".into(),
            client_secret: "x-secret-value".into(),
        };
        let tiktok = TiktokApp {
            client_key: "tt-key".into(),
            client_secret: "tt-secret-value".into(),
        };
        let linkedin = LinkedinApp {
            client_id: "li-id".into(),
            client_secret: "li-secret-value".into(),
            organization_scopes: true,
            api_version: Some("202610".into()),
        };
        let printed = format!(
            "{meta:?} {instagram:?} {x:?} {tiktok:?} {linkedin:?} {:?} {:?} {:?}",
            OAuthApp::Meta(meta.clone()),
            OAuthApp::Tiktok(tiktok.clone()),
            OAuthApp::Linkedin(linkedin.clone())
        );
        for secret in [
            "meta-secret-value",
            "verify-token-value",
            "ig-secret-value",
            "x-secret-value",
            "tt-secret-value",
            "li-secret-value",
        ] {
            assert!(!printed.contains(secret), "{printed}");
        }
        for public in [
            "meta-id", "cfg-1", "v19.0", "ig-id", "x-id", "tt-key", "li-id", "202610",
        ] {
            assert!(printed.contains(public), "{printed}");
        }
        assert_eq!(OAuthApp::Tiktok(tiktok).client_id(), "tt-key");
        assert_eq!(
            OAuthApp::Linkedin(linkedin).client_secret(),
            "li-secret-value"
        );
        assert_eq!(OAuthApp::X(x).client_id(), "x-id");
        assert_eq!(
            OAuthApp::Instagram(instagram).client_secret(),
            "ig-secret-value"
        );
        assert_eq!(OAuthApp::Meta(meta).client_id(), "meta-id");
    }

    #[test]
    fn meta_app_debug_shows_comment_scopes_flag() {
        let meta = MetaApp {
            app_id: "meta-id".into(),
            app_secret: "meta-secret-value".into(),
            verify_token: "verify-token-value".into(),
            login_config_id: None,
            whatsapp_config_id: None,
            graph_version: None,
            comment_scopes: true,
        };
        let instagram = InstagramApp {
            app_id: "ig-id".into(),
            app_secret: "ig-secret-value".into(),
            comment_scopes: false,
        };
        let printed = format!("{meta:?} {instagram:?}");
        assert!(printed.contains("comment_scopes: true"), "{printed}");
        assert!(printed.contains("comment_scopes: false"), "{printed}");
        for secret in ["meta-secret-value", "verify-token-value", "ig-secret-value"] {
            assert!(!printed.contains(secret), "{printed}");
        }
    }

    fn envelope() -> PublicEnvelope {
        PublicEnvelope {
            kind: PublicKind::Comment,
            account_id: "17841400000000001".into(),
            external_id: "18000000000000002".into(),
            parent_external_id: Some("18000000000000001".into()),
            root_external_id: "18000000000000001".into(),
            status: EnvelopeStatus::Open,
            author: EnvelopeAuthor {
                id: Some("17841400000000009".into()),
                name: Some("a.customer".into()),
                is_self: false,
            },
            text: "Fiyatı nedir?".into(),
            created_at: time::macros::datetime!(2026-10-30 09:15 UTC),
            deadline: Some(time::macros::datetime!(2026-10-31 09:15 UTC)),
            live: true,
            subject: Some(EnvelopeSubject {
                kind: jt_inbox::SubjectKind::Post,
                external_id: "17900000000000001".into(),
                title: "Yeni sezon".into(),
                url: Some("https://www.instagram.example/p/abc/".into()),
                image_url: None,
                facts: serde_json::json!({ "media_product_type": "FEED" }),
            }),
            answer: Some(EnvelopeAnswer {
                text: "Merhaba".into(),
                at: Some(time::macros::datetime!(2026-10-30 10:00 UTC)),
            }),
            rejection: Some(EnvelopeRejection {
                reason: "contains a link".into(),
                at: None,
            }),
        }
    }

    #[test]
    fn envelope_round_trips_through_a_payload() {
        let provider_item = serde_json::json!({ "id": "18000000000000002", "from": {} });
        let payload = envelope().into_payload(provider_item.clone());
        assert_eq!(payload["provider_item"], provider_item);
        assert_eq!(payload["public"]["kind"], "comment");
        assert_eq!(payload["public"]["status"], "open");
        assert_eq!(payload["public"]["created_at"], "2026-10-30T09:15:00Z");
        assert_eq!(payload["public"]["subject"]["kind"], "post");
        assert_eq!(
            payload.as_object().unwrap().keys().collect::<Vec<_>>(),
            ["provider_item", "public"]
        );
        assert_eq!(PublicEnvelope::from_payload(&payload), Some(envelope()));

        // The optional parts read as absent when left out.
        let bare = serde_json::json!({ "public": {
            "kind": "question", "account_id": "123456", "external_id": "q-1",
            "root_external_id": "q-1", "status": "answered", "author": {},
            "text": "Bedeni var mı?", "created_at": "2026-10-30T09:15:00Z",
        }});
        let read = PublicEnvelope::from_payload(&bare).unwrap();
        assert_eq!(read.kind, PublicKind::Question);
        assert_eq!(read.status, EnvelopeStatus::Answered);
        assert_eq!(read.author, EnvelopeAuthor::default());
        assert_eq!(
            (
                read.parent_external_id,
                read.deadline,
                read.live,
                read.subject,
                read.answer,
                read.rejection
            ),
            (None, None, false, None, None, None)
        );
        for (status, key) in [
            (EnvelopeStatus::Open, "open"),
            (EnvelopeStatus::Edited, "edited"),
            (EnvelopeStatus::Removed, "removed"),
            (EnvelopeStatus::Answered, "answered"),
            (EnvelopeStatus::Pending, "pending"),
            (EnvelopeStatus::Rejected, "rejected"),
            (EnvelopeStatus::Expired, "expired"),
            (EnvelopeStatus::Reported, "reported"),
        ] {
            assert_eq!(serde_json::to_value(status).unwrap(), key);
        }
    }

    #[test]
    fn envelope_from_payload_ignores_unknown_fields() {
        let mut payload = envelope().into_payload(Value::Null);
        payload["public"]["future_field"] = serde_json::json!(1);
        payload["public"]["author"]["avatar"] = serde_json::json!("x");
        payload["public"]["subject"]["price"] = serde_json::json!(450);
        payload["occurred_at"] = serde_json::json!("2026-10-30T09:15:00Z");
        assert_eq!(PublicEnvelope::from_payload(&payload), Some(envelope()));
    }

    #[test]
    fn envelope_requires_its_identity_fields() {
        let payload = envelope().into_payload(Value::Null);
        for field in [
            "kind",
            "account_id",
            "external_id",
            "root_external_id",
            "status",
            "author",
            "text",
            "created_at",
        ] {
            let mut missing = payload.clone();
            missing["public"].as_object_mut().unwrap().remove(field);
            assert_eq!(PublicEnvelope::from_payload(&missing), None, "{field}");
        }
        for (field, value) in [
            ("account_id", serde_json::json!("  ")),
            ("external_id", serde_json::json!("")),
            ("root_external_id", serde_json::json!(" ")),
            ("parent_external_id", serde_json::json!("")),
            ("external_id", serde_json::json!("9".repeat(513))),
            ("kind", serde_json::json!("review")),
            ("status", serde_json::json!("deleted")),
            ("created_at", serde_json::json!("yesterday")),
        ] {
            let mut wrong = payload.clone();
            wrong["public"][field] = value;
            assert_eq!(PublicEnvelope::from_payload(&wrong), None, "{field}");
        }
        let mut longest = payload.clone();
        longest["public"]["external_id"] = serde_json::json!("9".repeat(512));
        assert!(PublicEnvelope::from_payload(&longest).is_some());
        assert_eq!(
            PublicEnvelope::from_payload(&serde_json::json!({ "messaging": {} })),
            None
        );
        assert_eq!(PublicEnvelope::from_payload(&Value::Null), None);
    }

    #[test]
    fn delivery_statuses_read_back_from_json() {
        let statuses = vec![
            DeliveryStatus {
                job_id: "17000000000000000000000001".into(),
                recipient: "905000000001".into(),
                status: DeliveryState::Delivered,
                at: Some(time::macros::datetime!(2026-10-23 09:15 UTC)),
                raw_code: "1".into(),
            },
            DeliveryStatus {
                job_id: "17000000000000000000000002".into(),
                recipient: "905000000002".into(),
                status: DeliveryState::Unknown("99".into()),
                at: None,
                raw_code: "99".into(),
            },
        ];
        let json = serde_json::to_value(&statuses).unwrap();
        assert_eq!(json[0]["status"], "delivered");
        assert_eq!(json[0]["at"], "2026-10-23T09:15:00Z");
        assert_eq!(json[1]["status"], serde_json::json!({ "unknown": "99" }));
        let back: Vec<DeliveryStatus> = serde_json::from_value(json).unwrap();
        assert_eq!(back, statuses);
    }

    #[test]
    fn publish_request_media_bytes_are_never_serialised() {
        let request = PublishRequest {
            text: "Merhaba".into(),
            media_urls: vec![Url::parse("https://cdn.test/a.png").unwrap()],
            link: None,
            media: vec![MediaUpload {
                bytes: vec![0x89, b'P', b'N', b'G', 1, 2, 3],
                mime: "image/png".into(),
                filename: "a.png".into(),
            }],
            privacy: None,
            tiktok: None,
            format: None,
        };
        let json = serde_json::to_value(&request).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "text": "Merhaba",
                "media_urls": ["https://cdn.test/a.png"],
                "link": null,
            })
        );
        // Read back, it carries no bytes: they are supplied again where they are needed.
        let back: PublishRequest = serde_json::from_value(json).unwrap();
        assert!(back.media.is_empty());
        assert_eq!(back.text, request.text);
        assert_eq!(PublishRequest::default().media, vec![]);
    }

    #[test]
    fn media_upload_debug_shows_its_size_not_its_bytes() {
        let media = MediaUpload {
            bytes: vec![7; 4096],
            mime: "image/jpeg".into(),
            filename: "photo.jpg".into(),
        };
        let printed = format!("{media:?}");
        assert!(printed.contains("4096"), "{printed}");
        assert!(printed.contains("image/jpeg"), "{printed}");
        assert!(printed.contains("photo.jpg"), "{printed}");
        assert!(!printed.contains("7, 7"), "{printed}");
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
