//! The Meta adapter (spec §4.2 rule 1, §6.1, §6.4): Facebook Pages, Messenger, Instagram (linked
//! to a Page, or through Instagram Login), WhatsApp Cloud, Meta Ads and lead-gen forms, over the
//! Graph API.
//!
//! [`MetaConnector`] implements the connector ports of `jt_app` ([`Connector`],
//! [`OAuthProvider`], [`Publisher`], [`InsightsReader`], [`MessagingSender`],
//! [`LeadGenFetcher`], [`AdBudgetWriter`]); [`webhook`] parses Meta's webhook bodies, purely.
//!
//! **Transport.** The adapter holds no HTTP client: every call is built with
//! [`jt_outbound::Egress::prepare`] and sent under `EgressScope::Connector("meta")`, so it can
//! reach only the `meta` hosts of the fixed tier ([`META_HOSTS`]). Where it sends them is
//! [`MetaBases`], the real hosts by default ([`MetaBases::production`]); tests point them at an
//! in-process mock.
//!
//! **Tokens.** A token travels in the `Authorization: Bearer` header, never in a URL (a paging
//! link's `access_token` is taken out before it is followed), except where the provider takes it
//! nowhere else: the code and token exchanges of Facebook Login and Instagram Login. Every call to
//! `graph.facebook.com` that carries a user, Page or WhatsApp token also carries
//! `appsecret_proof` = lowercase hex HMAC-SHA256 of the token under the Meta app's secret, paging
//! links included (an existing proof is replaced); calls to `graph.instagram.com` never do (that
//! host belongs to the Instagram app). The Meta app (its secret and Graph version) is read from
//! the [`PlatformAppConfig`] at call time; the Graph version defaults to
//! [`DEFAULT_GRAPH_VERSION`]. Calls to `graph.instagram.com` are unversioned.
//!
//! **Errors.** Nothing is thrown: every failure is a [`ConnectorError`], built through its
//! redacting constructors, its reason naming the Graph error's type, code, subcode and message
//! (never a body, a URL or a token). The provider's message has every secret of the call (the
//! token in use, the app secret, a token exchange's code, client secret or token) taken out, as
//! is and URL- or form-encoded, before the reason is cut to its length, whatever words carry it.
//! The mapping, first match wins:
//!
//! | Answer | Error |
//! |---|---|
//! | HTTP 429; Graph code 4, 17, 32, 613; a business-use-case limit (80000–80099); WhatsApp 130429, 131048, 131056 | `Throttle`, `retry_after` from `Retry-After` or the usage headers |
//! | Graph code 3, 10, 200–299, 803 | `Permission` |
//! | HTTP 401; code 190, 102, 104, 2500; subcode 458, 459, 460, 463, 464, 467; type `OAuthException` without a code | `Auth` |
//! | HTTP 5xx; `is_transient`; code 1, 2; a transport failure, a timeout, a body broken off, a host resolving to no public address | `Transient` |
//! | anything else: another Graph code (`(#100)` invalid parameter included), a body that is not JSON (but for HTTP 429 and 5xx), an answer over 4 MiB, a host the `meta` tier does not hold | `Permanent` |
//!
//! (`OAuthException` is the type of nearly every Graph error, throttles and permission errors
//! included, so the type alone means `Auth` only without a code; with a code, the code decides.)
//!
//! **Kinds.** Ports that take `public` (the capability's public fields as the use cases hand them
//! to adapters, with `kind_key` and `external_id` set from the capability) choose the call by
//! `public["kind_key"]`, and by the credential's variant where the kind is absent; the account an
//! operation acts on (an ad account, an Instagram account) is `public["external_id"]`.
//!
//! **Identity of an Instagram Login token.** Instagram Login and Facebook Login both yield a
//! [`Credential::OAuth`]; one is an Instagram Login token when a granted scope starts with
//! `instagram_business_` (every Instagram Login exchange records its scopes) or, for a pasted
//! token, when it starts with `IG` (as Instagram's tokens do, Facebook's starting with `EA`).
//!
//! [`Connector`]: jt_app::ports::connectors::Connector
//! [`OAuthProvider`]: jt_app::ports::connectors::OAuthProvider
//! [`Publisher`]: jt_app::ports::connectors::Publisher
//! [`InsightsReader`]: jt_app::ports::connectors::InsightsReader
//! [`MessagingSender`]: jt_app::ports::connectors::MessagingSender
//! [`LeadGenFetcher`]: jt_app::ports::connectors::LeadGenFetcher
//! [`AdBudgetWriter`]: jt_app::ports::connectors::AdBudgetWriter
//! [`ConnectorError`]: jt_connector::ConnectorError
//! [`Credential::OAuth`]: jt_connector::Credential::OAuth

mod ads;
mod assets;
mod credential;
mod graph;
mod insights;
mod leadgen;
mod messaging;
mod oauth;
mod ports;
mod probe;
mod publish;
pub mod webhook;

use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use jt_app::ports::connectors::PlatformAppConfig;
use jt_outbound::Egress;
use url::Url;

pub use graph::DEFAULT_GRAPH_VERSION;
pub use oauth::{FACEBOOK_SCOPES, INSTAGRAM_SCOPES, PAGE_SUBSCRIBED_FIELDS};
pub use webhook::{
    InboundEventDraft, ParseError, ParsedEvent, WebhookError, parse, verify_and_parse,
};

/// The hosts the adapter reaches, exactly the `meta` entries of `jt_outbound::FIXED_HOSTS`: the
/// Graph API, the Instagram Graph API, Instagram Login's token endpoint and the resumable media
/// upload (not used in M1b; listed so a capability names every host its connector may reach).
pub const META_HOSTS: &[&str] = &[
    "graph.facebook.com",
    "graph.instagram.com",
    "api.instagram.com",
    "rupload.facebook.com",
];

/// How many times an Instagram media container is read before giving up, by default.
pub const CONTAINER_POLL_ATTEMPTS: u32 = 30;

/// The pause between two reads of an Instagram media container, by default.
pub const CONTAINER_POLL_INTERVAL: Duration = Duration::from_secs(3);

/// Where the adapter sends its calls and its users: the real hosts by default
/// ([`MetaBases::production`]). Each is a base URL (scheme, host, port and an optional path
/// prefix) the adapter appends its paths to.
///
/// `facebook_dialog` and `instagram_dialog` only build the authorize URLs a browser is sent to;
/// the adapter never fetches them, so they are not egress hosts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MetaBases {
    /// The Graph API, `https://graph.facebook.com`.
    pub graph: Url,
    /// The Instagram Graph API (Instagram Login tokens), `https://graph.instagram.com`.
    pub instagram_graph: Url,
    /// Instagram Login's code exchange, `https://api.instagram.com`.
    pub instagram_api: Url,
    /// Facebook Login's dialog and post permalinks, `https://www.facebook.com`.
    pub facebook_dialog: Url,
    /// Instagram Login's dialog, `https://www.instagram.com`.
    pub instagram_dialog: Url,
}

impl MetaBases {
    /// The real hosts.
    pub fn production() -> MetaBases {
        let url = |text: &str| Url::parse(text).expect("a valid Meta base URL");
        MetaBases {
            graph: url("https://graph.facebook.com"),
            instagram_graph: url("https://graph.instagram.com"),
            instagram_api: url("https://api.instagram.com"),
            facebook_dialog: url("https://www.facebook.com"),
            instagram_dialog: url("https://www.instagram.com"),
        }
    }
}

/// How an Instagram media container is waited for: read up to `attempts` times, `interval` apart,
/// until it is `FINISHED`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ContainerPoll {
    pub interval: Duration,
    pub attempts: u32,
}

impl Default for ContainerPoll {
    fn default() -> Self {
        ContainerPoll {
            interval: CONTAINER_POLL_INTERVAL,
            attempts: CONTAINER_POLL_ATTEMPTS,
        }
    }
}

/// The Meta adapter. Cheap to share behind an `Arc`; it holds the egress client, the bases and
/// the platform's app configuration, read at call time (the Meta app's secret signs
/// `appsecret_proof`, its Graph version prefixes Graph paths).
pub struct MetaConnector {
    egress: Arc<Egress>,
    bases: MetaBases,
    apps: Arc<dyn PlatformAppConfig>,
    poll: ContainerPoll,
}

impl fmt::Debug for MetaConnector {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MetaConnector")
            .field("bases", &self.bases)
            .field("poll", &self.poll)
            .finish_non_exhaustive()
    }
}

impl MetaConnector {
    /// The adapter over `egress`, sending to `bases`, with the platform's apps `apps`, and the
    /// default container poll ([`ContainerPoll::default`]).
    pub fn new(
        egress: Arc<Egress>,
        bases: MetaBases,
        apps: Arc<dyn PlatformAppConfig>,
    ) -> MetaConnector {
        MetaConnector {
            egress,
            bases,
            apps,
            poll: ContainerPoll::default(),
        }
    }

    /// The adapter waiting for Instagram media containers as `poll` says (tests poll without
    /// pausing).
    pub fn with_container_poll(mut self, poll: ContainerPoll) -> MetaConnector {
        self.poll = poll;
        self
    }

    /// Where the adapter sends its calls.
    pub fn bases(&self) -> &MetaBases {
        &self.bases
    }
}

/// Stands in for a secret in `Debug` output.
pub(crate) struct Masked;

impl fmt::Debug for Masked {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("***")
    }
}
