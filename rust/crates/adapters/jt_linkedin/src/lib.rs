//! The LinkedIn adapter (spec `docs/superpowers/specs/2026-10-27-tiktok-linkedin-connectors-design.md`
//! §3): a LinkedIn member's own feed (`linkedin_member`) and the organization pages the member
//! administers (`linkedin_page`), connected with OAuth 2.0; their posts (text, a link, images or
//! one video) and the organizations' counters.
//!
//! [`LinkedinConnector`] implements the connector ports of `jt_app` ([`Connector`],
//! [`OAuthProvider`], [`Publisher`], [`InsightsReader`]). LinkedIn sends no webhooks here, and it
//! publishes synchronously: [`Publisher::resolve`] keeps its default (the receipt is the post).
//!
//! **Transport.** The adapter holds no HTTP client: every call is built with
//! [`jt_outbound::Egress::prepare`] and sent under `EgressScope::Connector("linkedin")`, so it can
//! reach only the `linkedin` hosts of the fixed tier ([`LINKEDIN_HOSTS`]). Where it sends them is
//! [`LinkedinBases`], the real hosts by default ([`LinkedinBases::production`]): the API and OpenID
//! userinfo (`api.linkedin.com`) and the token endpoint (`www.linkedin.com`). The upload URLs the
//! Images and Videos APIs hand out are used as they come; they are on `www.linkedin.com`
//! (`/dms-uploads/...`, both APIs' documented answers), and a host the tier does not hold is
//! refused before anything is sent. The authorize dialog (`www.linkedin.com`) is only a URL for
//! the owner's browser. Tests point the bases at an in-process mock.
//!
//! **OAuth.** Authorization code, as a confidential web client
//! (<https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow>):
//!
//! | Step | Call |
//! |---|---|
//! | authorize | `{authorize}/oauth/v2/authorization?response_type=code&client_id&redirect_uri&state&scope`, the scopes joined by spaces (`%20`): [`MEMBER_SCOPES`], and [`ORGANIZATION_SCOPES`] too when the flow's app sets `organization_scopes` (the use case sets it for `linkedin_page` flows once the operator enabled them) |
//! | exchange | `POST {oauth}/oauth/v2/accessToken`, form `grant_type=authorization_code, code, redirect_uri, client_id, client_secret` |
//! | refresh | `POST {oauth}/oauth/v2/accessToken`, form `grant_type=refresh_token, refresh_token, client_id, client_secret` |
//!
//! No PKCE: LinkedIn's PKCE flow is for native apps on a loopback redirect, on its own endpoint,
//! enabled per app by LinkedIn
//! (<https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow-native>);
//! a challenge or a verifier handed in is not sent. A token answer becomes
//! [`Credential::OAuth`]: its access token, its refresh token (LinkedIn issues one only to apps
//! approved for programmatic refresh, the Marketing Developer Platform; on a refresh, the one held
//! when the answer names none), `expires_at` = now + `expires_in` (LinkedIn's access tokens live
//! 60 days, `5184000`), and the scopes its `scope` grants (documented as space-delimited; commas
//! are taken too), else those asked for, or held. [`Connector::refresh`] renews a credential that
//! holds a refresh token whenever it is called; one without answers `None` (nothing to renew
//! with): the access token then expires and the capability needs reconnecting, LinkedIn's own
//! contract for apps without programmatic refresh
//! (<https://learn.microsoft.com/en-us/linkedin/shared/authentication/programmatic-refresh-tokens>).
//!
//! LinkedIn invalidates every earlier access token of a member when a flow asks for a different
//! set of scopes (the authorization-code-flow page above): a member who connects a page with the
//! organization scopes after connecting their own feed with the member scopes leaves the first
//! capability with a dead token. Flows that ask for the same scopes keep each other's tokens.
//!
//! **Calls.** Every call to `{api}/rest/` carries `Linkedin-Version` ([`DEFAULT_API_VERSION`], or
//! the app's `api_version`) and `X-Restli-Protocol-Version: 2.0.0`
//! (<https://learn.microsoft.com/en-us/linkedin/marketing/versioning>); URNs in a URL are
//! percent-encoded (`urn%3Ali%3A...`, the Posts API's rule).
//!
//! | Operation | Call |
//! |---|---|
//! | the member ([`OAuthProvider::list_assets`] with `openid` or `profile` granted; the `linkedin_member` probe) | `GET {api}/v2/userinfo` (OpenID, unversioned) → `sub`, `name`, `picture` |
//! | the pages (`list_assets` with `rw_organization_admin` granted; the `linkedin_page` probe) | `GET {api}/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED&start&count`, paged by `start` to at most [`MAX_ACL_PAGES`] pages, each element's `organization` (or `organizationTarget`) URN |
//! | the pages' names | `GET {api}/rest/organizations?ids=List(ids)` (asset listing), `GET {api}/rest/organizations/{id}` (probe) → `localizedName` |
//! | an image | `POST {api}/rest/images?action=initializeUpload {initializeUploadRequest: {owner}}` → `value.uploadUrl`, `value.image`; `PUT uploadUrl` the bytes, `Content-Type` the image's, with the bearer token |
//! | a video | `POST {api}/rest/videos?action=initializeUpload {initializeUploadRequest: {owner, fileSizeBytes, uploadCaptions: false, uploadThumbnail: false}}` → `value.video`, `value.uploadInstructions[{uploadUrl, firstByte, lastByte}]`, `value.uploadToken`; `PUT` each part's bytes to its `uploadUrl` (`Content-Type: application/octet-stream`, no token), keeping each answer's `ETag`; `POST {api}/rest/videos?action=finalizeUpload {finalizeUploadRequest: {video, uploadToken, uploadedPartIds}}` |
//! | a post | `POST {api}/rest/posts` → `201`, the post's URN in the `x-restli-id` header |
//! | a page post's counters | `GET {api}/rest/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity={org urn}&shares=List({urn})` (`ugcPosts=List(...)` for a `urn:li:ugcPost:`) |
//! | a page's followers | `GET {api}/rest/networkSizes/{org urn}?edgeType=COMPANY_FOLLOWED_BY_MEMBER` → `firstDegreeSize` |
//!
//! Every call to the API carries the access token as `Authorization: Bearer`; so does an image
//! upload (the Assets API page the Images API refers to requires it), and a video part never does
//! (the same page: the upload "shouldn't include an OAuth token"). The token calls carry the client
//! secret in their form, as LinkedIn takes it. Nothing secret ever goes in a URL the adapter builds
//! (the upload URLs LinkedIn hands out carry its own upload tokens; they are never logged or
//! quoted).
//!
//! **Errors.** Nothing is thrown: every failure is a [`ConnectorError`], built through its
//! redacting constructors. Its reason names the HTTP status and LinkedIn's own words (an API
//! error's `code`, else its `serviceErrorCode`, and its `message`; a token error's `error` and
//! `error_description`), with every secret of the call (the token, the client secret, the code,
//! the refresh token, an upload URL and its query) taken out, cut to 300 characters; never a body,
//! a URL or a header. The mapping, first match wins
//! (<https://learn.microsoft.com/en-us/linkedin/shared/api-guide/concepts/error-handling>):
//!
//! | Answer | Error |
//! |---|---|
//! | HTTP 429 | `Throttle`, for `Retry-After` seconds when the answer names it (LinkedIn documents none: its daily limits reset at midnight UTC), at most [`MAX_RETRY_AFTER`] |
//! | a token call's `invalid_client` (the platform's LinkedIn client id or secret refused: no reconnection can fix it) | `Permanent` ("platform client credentials rejected") |
//! | HTTP 401 from the API or a token call; a code exchange's `invalid_grant` or `invalid_redirect_uri` (LinkedIn's answer to an expired or spent code, too); a refresh's `invalid_grant` or `invalid_request` (LinkedIn's answer to a refresh token that is invalid, expired or revoked) | `Auth`: the owner must reconnect |
//! | HTTP 403 | `Permission` |
//! | HTTP 426 (the `Linkedin-Version` sent is not active, `NONEXISTENT_VERSION`) | `Permanent`, naming the version sent |
//! | HTTP 5xx; a read transport failure or broken answer, a connect failure, a host resolving to no public address | `Transient` |
//! | A write (a token call, an upload, a post) whose answer was lost, broke off, or was oversized or unreadable on success; a post accepted without a valid `x-restli-id` | `Unknown` (never retry blindly) |
//! | an upload URL's HTTP 401 (an expired upload URL: the account's token is not at fault); any other status (another 4xx, a redirect, which is never followed); a read answer that is not JSON, lacks what the call needs or is over 4 MiB; a host the `linkedin` tier does not hold | `Permanent` |
//!
//! **Retries.** Reads (`GET`) are tried once more ([`READ_ATTEMPTS`] in all) when no answer
//! arrived (the connection failed, dropped or timed out), after [`DEFAULT_RETRY_DELAY`]. Token
//! calls, uploads and posts are sent once, whatever happens. Nothing is ever sent again once any
//! answer arrived.
//!
//! **Posts.** Checked before anything is sent, each failure `Permanent`: the kind, an
//! [`Credential::OAuth`] credential, the account's id in `public["external_id"]` (a member's `sub`:
//! 1 to 64 ASCII letters, digits, `-` or `_`; an organization's number: 1 to 20 digits, so it can
//! never change the URN it is put in), media URLs only with their bytes ("linkedin needs media
//! bytes": LinkedIn takes uploads only), as many bytes as URLs when both are given ("media bytes and
//! urls disagree"), each file non-empty and of a type of [`IMAGE_MIMES`] or [`VIDEO_MIME`]
//! (compared ignoring case and surrounding space), at most [`MAX_IMAGES`] images, one video of
//! [`MIN_VIDEO_BYTES`] to [`MAX_VIDEO_BYTES`], something to post, and at most
//! [`MAX_COMMENTARY_CHARS`] characters of text (counted before escaping). The author is
//! `urn:li:person:{external_id}` (`linkedin_member`) or `urn:li:organization:{external_id}`
//! (`linkedin_page`); it also owns the uploads. The post
//! (<https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api>):
//! `{author, commentary, visibility: "PUBLIC", distribution: {feedDistribution: "MAIN_FEED",
//! targetEntities: [], thirdPartyDistributionChannels: []}, lifecycleState: "PUBLISHED",
//! isReshareDisabledByAuthor: false, content?}`; `privacy` is ignored (LinkedIn posts publicly).
//!
//! - The commentary is the text in LinkedIn's `little` format
//!   (<https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/little-text-format>):
//!   every reserved character (`| { } @ [ ] ( ) < > # \ * _ ~`) is escaped with a backslash, so
//!   the text shows as written and can never become a mention; only a `#` that starts a word
//!   (at the start or after a space) and is followed by a letter or digit is left as a hashtag.
//! - A link with no media becomes `content.article {source, title}`: LinkedIn requires a title
//!   (under 400 characters) and scrapes nothing, so the link itself, cut to
//!   [`MAX_ARTICLE_TITLE_CHARS`], is the title. A link with media is put after the text, on a
//!   line of its own.
//! - One image is `content.media {id}`, two to twenty `content.multiImage {images: [{id}]}`
//!   (the MultiImage API's bounds). Images go up one after the other; a failed upload stops the
//!   post.
//! - A video wins over images: with one, the images are left out (the spec's rule). It is
//!   `content.media {id}` once its parts are uploaded and the upload finalized; LinkedIn keeps the
//!   post waiting while it processes the video (the Post schema's
//!   `lifecycleStateInfo.contentStatus`), so the adapter does not poll it.
//!
//! The receipt names the post's URN from `x-restli-id` (`urn:li:share:N` or `urn:li:ugcPost:N`)
//! and its page, `https://www.linkedin.com/feed/update/{urn}/` (the Posts API's form).
//!
//! **Counters** (`linkedin_page` only; the statistics need `rw_organization_admin`,
//! <https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/share-statistics>).
//! A post's: every whole number of the matching element's `totalShareStatistics`, under
//! [`POST_METRICS`]' names (`like_count`, `comment_count`, `share_count`, `click_count`,
//! `impression_count`, `unique_impressions_count`); a post LinkedIn leaves out of the answer has
//! no actions and no impressions, and reads as zero on every one (LinkedIn's rule). The account's:
//! `follower_count`, the organization's `firstDegreeSize`
//! (<https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-lookup-api>).
//! A member's posts and account have no counters LinkedIn opens to apps (`r_member_social` is
//! restricted): both reads fail `Permanent` without a call.
//!
//! **The probe** names, as `facts.account_id`, the identity the credential itself reaches, never
//! an id taken from `public`:
//!
//! | Kind | Call | `account_id` |
//! |---|---|---|
//! | `linkedin_member` | `GET /v2/userinfo` | its `sub`: the member the token authenticates as |
//! | `linkedin_page` | the credential's `organizationAcls` (`ADMINISTRATOR`, `APPROVED`) | the organization number of the ACL element naming `public["external_id"]`: a node LinkedIn serves only to the member's own token, and only for organizations the member administers; none → `Permission` ("the credential administers no such organization") |
//!
//! with `name` (the member's name; the page's `localizedName`, best effort). The organization
//! lookup is never the identity: LinkedIn answers it for organizations a member does not
//! administer too.
//!
//! **Kinds.** LinkedIn serves `linkedin_member` and `linkedin_page`. Every operation that takes
//! `public` refuses one without either in `public["kind_key"]` (`Permanent`, "kind_key missing")
//! and calls nothing.
//!
//! [`Connector`]: jt_app::ports::connectors::Connector
//! [`Connector::refresh`]: jt_app::ports::connectors::Connector::refresh
//! [`OAuthProvider`]: jt_app::ports::connectors::OAuthProvider
//! [`OAuthProvider::list_assets`]: jt_app::ports::connectors::OAuthProvider::list_assets
//! [`Publisher`]: jt_app::ports::connectors::Publisher
//! [`Publisher::resolve`]: jt_app::ports::connectors::Publisher::resolve
//! [`InsightsReader`]: jt_app::ports::connectors::InsightsReader
//! [`ConnectorError`]: jt_connector::ConnectorError
//! [`Credential::OAuth`]: jt_connector::Credential::OAuth

mod account;
mod client;
mod credential;
mod insights;
mod oauth;
mod ports;
mod publish;

use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use jt_app::ports::connectors::PlatformAppConfig;
use jt_outbound::Egress;
use url::Url;

pub use client::MAX_RETRY_AFTER;

/// The hosts the adapter reaches, exactly the `linkedin` entries of `jt_outbound::FIXED_HOSTS`:
/// the API and OpenID userinfo, and the token endpoint and the media uploads.
pub const LINKEDIN_HOSTS: &[&str] = &["api.linkedin.com", "www.linkedin.com"];

/// The scopes every flow asks for: signing in with OpenID Connect (`openid`, `profile`: the
/// member's `sub` and name from userinfo) and posting on the member's own feed
/// (`w_member_social`, the Share on LinkedIn product).
pub const MEMBER_SCOPES: &[&str] = &["openid", "profile", "w_member_social"];

/// The scopes a flow whose app sets `organization_scopes` asks for too (the Community Management
/// API): reading and writing the organizations' posts (`r_organization_social`,
/// `w_organization_social`) and the pages the member administers, with their statistics
/// (`rw_organization_admin`). LinkedIn refuses a whole authorize request naming a scope the app
/// was not granted, so only an app approved for them may ask.
pub const ORGANIZATION_SCOPES: &[&str] = &[
    "r_organization_social",
    "w_organization_social",
    "rw_organization_admin",
];

/// The `Linkedin-Version` of the REST calls when the app names none: `202610`, the latest
/// version (October 2026) on LinkedIn's versioning page, whose versions are supported for at
/// least a year after their release (<https://learn.microsoft.com/en-us/linkedin/marketing/versioning>).
/// A version LinkedIn has retired answers 426, which fails naming the version sent; the app's
/// `api_version` overrides this one.
pub const DEFAULT_API_VERSION: &str = "202610";

/// The most images one post carries (a multi-image post: 2 to 20).
pub const MAX_IMAGES: usize = 20;

/// The media types of the images uploaded (the Images API takes JPG, GIF and PNG).
pub const IMAGE_MIMES: &[&str] = &["image/jpeg", "image/png", "image/gif"];

/// The media type of a video (the Videos API takes MP4).
pub const VIDEO_MIME: &str = "video/mp4";

/// The smallest video uploaded, in bytes (the Videos API: "between 75kb and 500MB").
pub const MIN_VIDEO_BYTES: usize = 75_000;

/// The largest video uploaded, in bytes (500 MB).
pub const MAX_VIDEO_BYTES: usize = 500 * 1024 * 1024;

/// The longest text of a post, in characters (LinkedIn's limit for a post).
pub const MAX_COMMENTARY_CHARS: usize = 3000;

/// The longest article title sent, in characters (LinkedIn's: under 400).
pub const MAX_ARTICLE_TITLE_CHARS: usize = 399;

/// The most pages of the organization access list read (each up to [`ACL_PAGE_SIZE`] entries).
pub const MAX_ACL_PAGES: usize = 20;

/// The entries asked for per page of the organization access list.
pub const ACL_PAGE_SIZE: usize = 50;

/// The names of a page post's counters, as LinkedIn names them in `totalShareStatistics` and as
/// they are kept.
pub const POST_METRICS: &[(&str, &str)] = &[
    ("likeCount", "like_count"),
    ("commentCount", "comment_count"),
    ("shareCount", "share_count"),
    ("clickCount", "click_count"),
    ("impressionCount", "impression_count"),
    ("uniqueImpressionsCount", "unique_impressions_count"),
];

/// The name of a page's follower counter.
pub const FOLLOWER_COUNT: &str = "follower_count";

/// How many times a read is tried in all when no answer arrives (token calls, uploads and posts:
/// once).
pub const READ_ATTEMPTS: u32 = 2;

/// The pause before a read that got no answer is tried again, by default.
pub const DEFAULT_RETRY_DELAY: Duration = Duration::from_millis(300);

/// How long one call may take, connect to end of answer, by default (uploads: [`UPLOAD_TIMEOUT`]).
pub const ATTEMPT_TIMEOUT: Duration = Duration::from_secs(30);

/// How long one upload (an image, a video part) may take, by default.
pub const UPLOAD_TIMEOUT: Duration = Duration::from_secs(120);

/// Where the adapter sends its calls and its users: the real hosts by default
/// ([`LinkedinBases::production`]). Each is a base URL (scheme, host, port and an optional path
/// prefix) the adapter appends its paths to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkedinBases {
    /// The REST API and OpenID userinfo, `https://api.linkedin.com`.
    pub api: Url,
    /// The token endpoint, `https://www.linkedin.com`.
    pub oauth: Url,
    /// The authorize dialog, `https://www.linkedin.com`: only a URL for the owner's browser, never
    /// fetched.
    pub authorize: Url,
}

impl LinkedinBases {
    /// The real hosts.
    pub fn production() -> LinkedinBases {
        let url = |text: &str| Url::parse(text).expect("a valid LinkedIn base URL");
        LinkedinBases {
            api: url("https://api.linkedin.com"),
            oauth: url("https://www.linkedin.com"),
            authorize: url("https://www.linkedin.com"),
        }
    }
}

/// The LinkedIn adapter. Cheap to share behind an `Arc`; it holds the egress client, the bases,
/// the platform's app configuration (the LinkedIn client and its API version, read at call time),
/// the pause before a read is tried again ([`DEFAULT_RETRY_DELAY`]) and the time a call
/// ([`ATTEMPT_TIMEOUT`]) and an upload ([`UPLOAD_TIMEOUT`]) may take. It holds no credential: each
/// call is given one.
pub struct LinkedinConnector {
    egress: Arc<Egress>,
    bases: LinkedinBases,
    apps: Arc<dyn PlatformAppConfig>,
    retry_delay: Duration,
    attempt_timeout: Duration,
    upload_timeout: Duration,
}

impl fmt::Debug for LinkedinConnector {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LinkedinConnector")
            .field("bases", &self.bases)
            .field("retry_delay", &self.retry_delay)
            .field("attempt_timeout", &self.attempt_timeout)
            .field("upload_timeout", &self.upload_timeout)
            .finish_non_exhaustive()
    }
}

impl LinkedinConnector {
    /// The adapter over `egress`, sending to `bases`, with the platform's apps `apps`.
    pub fn new(
        egress: Arc<Egress>,
        bases: LinkedinBases,
        apps: Arc<dyn PlatformAppConfig>,
    ) -> LinkedinConnector {
        LinkedinConnector {
            egress,
            bases,
            apps,
            retry_delay: DEFAULT_RETRY_DELAY,
            attempt_timeout: ATTEMPT_TIMEOUT,
            upload_timeout: UPLOAD_TIMEOUT,
        }
    }

    /// The adapter pausing `delay` before a read that got no answer is tried again (tests do not
    /// pause).
    pub fn with_retry_delay(mut self, delay: Duration) -> LinkedinConnector {
        self.retry_delay = delay;
        self
    }

    /// The adapter giving each call but an upload `timeout`, connect to end of answer, instead of
    /// [`ATTEMPT_TIMEOUT`] (tests time out in milliseconds).
    pub fn with_attempt_timeout(mut self, timeout: Duration) -> LinkedinConnector {
        self.attempt_timeout = timeout;
        self
    }

    /// The adapter giving each upload (an image, a video part) `timeout` instead of
    /// [`UPLOAD_TIMEOUT`].
    pub fn with_upload_timeout(mut self, timeout: Duration) -> LinkedinConnector {
        self.upload_timeout = timeout;
        self
    }

    /// Where the adapter sends its calls.
    pub fn bases(&self) -> &LinkedinBases {
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
