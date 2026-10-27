//! The TikTok adapter (spec `docs/superpowers/specs/2026-10-27-tiktok-linkedin-connectors-design.md`
//! §2): a TikTok account, connected with Login Kit (OAuth 2.0 authorization code), its posts
//! through the Content Posting API (one uploaded video, or photos TikTok pulls from URLs), their
//! publishing status, and its public counters.
//!
//! [`TiktokConnector`] implements the connector ports of `jt_app` ([`Connector`],
//! [`OAuthProvider`], [`Publisher`] with [`Publisher::resolve`], [`InsightsReader`]). Webhooks are
//! not used: a post's status is polled.
//!
//! **Transport.** The adapter holds no HTTP client: every call is built with
//! [`jt_outbound::Egress::prepare`] and sent under `EgressScope::Connector("tiktok")`, so it can
//! reach only the `tiktok` hosts of the fixed tier ([`TIKTOK_HOSTS`]): the Open API and its token
//! endpoint (`open.tiktokapis.com`, [`TiktokBases::api`]) and the video upload
//! (`open-upload.tiktokapis.com`, the host of the `upload_url` a video's init answers with, used as
//! is; an upload URL on any other host is refused by the egress client, `Permanent`, and nothing
//! is posted). The authorize dialog (`www.tiktok.com`, [`TiktokBases::authorize`]) is only a URL
//! for the owner's browser and is never fetched. Tests point the bases at an in-process mock.
//!
//! **OAuth** (Login Kit for the web, <https://developers.tiktok.com/doc/login-kit-web>, and
//! <https://developers.tiktok.com/doc/oauth-user-access-token-management>):
//!
//! | Step | Call |
//! |---|---|
//! | authorize | `https://www.tiktok.com/v2/auth/authorize/?client_key&response_type=code&scope&redirect_uri&state`, the scopes [`TIKTOK_SCOPES`] joined by commas |
//! | exchange | `POST {api}/v2/oauth/token/`, form `client_key, client_secret, code, grant_type=authorization_code, redirect_uri` |
//! | refresh | `POST {api}/v2/oauth/token/`, form `client_key, client_secret, grant_type=refresh_token, refresh_token` |
//!
//! The web flow takes no PKCE (TikTok names `code_verifier` for mobile and desktop apps only): a
//! challenge given to [`OAuthProvider::authorize_url`] is not put in the URL, and a verifier given
//! to [`OAuthProvider::exchange`] is not sent, so both ends of a flow agree. The client secret
//! travels in the form, never in a URL or a header. A token answer becomes
//! [`Credential::OAuth`]: its access token (TikTok's live 24 hours), its refresh token (on a
//! refresh, the one held when the answer names none: TikTok says the returned refresh token "may
//! be different", and the new one must be used), `expires_at` = now + `expires_in`, and the
//! scopes its comma-separated `scope` grants (else those asked for, or held).
//!
//! [`Connector::refresh`] is called every hour for every TikTok capability; it renews only a
//! credential that expires within [`REFRESH_AHEAD`] (or has expired, or names no expiry), and
//! answers `None` for the others. One without a refresh token cannot be renewed: `Auth`
//! (reconnect).
//!
//! **Calls.** Every call but the token calls and the upload carries the access token as
//! `Authorization: Bearer`; a JSON body is sent as `application/json; charset=UTF-8`.
//!
//! | Operation | Call | Scope |
//! |---|---|---|
//! | the account ([`OAuthProvider::list_assets`]), the probe | `GET {api}/v2/user/info/?fields=open_id,display_name` | `user.info.basic` |
//! | the account's username (best effort, for the asset, the probe and permalinks) | `POST {api}/v2/post/publish/creator_info/query/` → `creator_username` | `video.publish` |
//! | before every post: who may see it, what the creator turned off | `POST {api}/v2/post/publish/creator_info/query/` | `video.publish` |
//! | a video | `POST {api}/v2/post/publish/video/init/` → `publish_id`, `upload_url`; then `PUT upload_url` per chunk | `video.publish` |
//! | photos | `POST {api}/v2/post/publish/content/init/` → `publish_id` | `video.publish` |
//! | a post's status ([`Publisher::resolve`]) | `POST {api}/v2/post/publish/status/fetch/ {publish_id}` | `video.publish` |
//! | a post's counters | `POST {api}/v2/video/query/?fields=id,like_count,comment_count,share_count,view_count {filters: {video_ids: [id]}}` | `video.list` |
//! | the account's counters | `GET {api}/v2/user/info/?fields=follower_count,following_count,likes_count,video_count` | `user.info.stats` |
//!
//! The username is not read from `/v2/user/info/`: its `username` field needs `user.info.profile`,
//! which the app does not ask for (<https://developers.tiktok.com/doc/tiktok-api-v2-get-user-info>);
//! `creator_info`'s `creator_username` names the same account under `video.publish`, which it
//! does. A failure of that lookup only leaves the username out.
//!
//! **Errors.** Nothing is thrown: every failure is a [`ConnectorError`], built through its
//! redacting constructors. Its reason is `HTTP <status> <code>: <message>`, the code and message
//! being the answer's `error.code` and `error.message` (a token answer's `error` and
//! `error_description`), with every secret of the call (the access token, the client secret, the
//! code, the refresh token, the upload URL and its parts) taken out, cut to 300 characters; never
//! a body, a URL or a header. A success is HTTP 2xx **and** `error.code == "ok"`
//! (<https://developers.tiktok.com/doc/tiktok-api-v2-error-handling>): a 2xx with another code
//! maps by the code, one with no code is `Permanent` (a read) or `Unknown` (a write that may have
//! posted). The mapping, first match wins:
//!
//! | Answer | Error |
//! |---|---|
//! | the token endpoint: HTTP 429 | `Throttle` |
//! | the token endpoint: `invalid_client` (the platform's client key or secret refused: no reconnection fixes it) | `Permanent` ("platform client credentials rejected") |
//! | the token endpoint: `invalid_grant` (a spent or wrong code, an expired or revoked refresh token, <https://developers.tiktok.com/doc/oauth-error-handling>), HTTP 401 | `Auth` |
//! | the token endpoint: HTTP 5xx, `server_error`, `temporarily_unavailable` | `Transient` |
//! | `scope_not_authorized` (HTTP 401: the grant lacks the scope, so it is not the credential's death), `scope_permission_missed` | `Permission` |
//! | `privacy_level_option_mismatch`, `unaudited_client_can_only_post_to_private_accounts`, `spam_risk_user_banned_from_posting` | `Permission` |
//! | `rate_limit_exceeded`, `spam_risk_too_many_posts` (also with HTTP 200), `reached_active_user_cap`, HTTP 429 | `Throttle` (TikTok names no wait) |
//! | `access_token_invalid`; `access_token_expired`, `token_revoked` (v1's names, not in TikTok's current table); HTTP 401 | `Auth`: the owner must reconnect |
//! | `internal_error`, HTTP 5xx; a read's transport failure or broken answer, a connect failure, a host resolving to no public address | `Transient` |
//! | a call that may have posted (a photo's init, a video's last chunk) or spent a grant (the token calls) whose answer was lost, broke off, was oversized or unreadable on success, or lacked the publish id | `Unknown` (never retry blindly) |
//! | `url_ownership_unverified`, `invalid_param`, any other 4xx or status; a read answer lacking what the call needs; a read answer over 4 MiB; a host the `tiktok` tier does not hold | `Permanent` |
//!
//! **Retries.** Reads (`GET`, and the `POST` queries: `creator_info`, the status, the video query)
//! are tried once more ([`READ_ATTEMPTS`] in all) when no answer arrived (the connection failed,
//! dropped or timed out), after [`DEFAULT_RETRY_DELAY`]. Writes (the token calls, the inits, the
//! chunks) are sent once, whatever happens. TikTok posts a video only once all of it is uploaded,
//! so a video's init or a chunk before the last that got no answer fails `Transient` (nothing can
//! have been posted, and the next attempt starts over with a new init); the last chunk, a photo
//! post's init and the token calls fail `Unknown`. Nothing is ever sent again once any answer
//! arrived.
//!
//! **Posts.** Checked before anything is sent, each failure `Permanent`: the kind
//! (`public["kind_key"]` must be `tiktok`, else "kind_key missing"), an [`Credential::OAuth`]
//! credential, and the shape: exactly one of
//!
//! - one video: one `video/mp4` file in `request.media` (compared ignoring case and surrounding
//!   space), 1 byte to [`MAX_VIDEO_BYTES`], and no media URLs; its title is the text and the
//!   link (after a blank line), at most [`MAX_TITLE_UNITS`] UTF-16 units;
//! - photos: 1 to [`MAX_PHOTOS`] `https` URLs in `request.media_urls`, and no bytes; their
//!   description is the text and the link, at most [`MAX_DESCRIPTION_UNITS`] UTF-16 units (no
//!   title is sent: the request has one text);
//!
//! text alone cannot be posted on TikTok, and a video with photos is not one post. The privacy is
//! `request.privacy` (one of [`PRIVACY_LEVELS`], compared ignoring case) or
//! [`DEFAULT_PRIVACY`]. Then `creator_info` is read, every time: a privacy level it does not offer
//! is refused, `Permission` ("privacy level X not available (app not audited or private
//! account)"), and nothing else is sent (an app TikTok has not audited is offered `SELF_ONLY`
//! only, so it never posts privately unless asked to). `disable_comment`, `disable_duet` and
//! `disable_stitch` are what the creator turned off; the branded-content toggles are sent `false`
//! and `is_aigc` is not sent.
//!
//! A video is sent as `FILE_UPLOAD` (<https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide>):
//! below [`CHUNK_BYTES`] in one chunk (`chunk_size` = the whole size), else in chunks of
//! [`CHUNK_BYTES`], `total_chunk_count` = the size divided by it rounded down, the last chunk
//! taking the remaining bytes (under 2 × [`CHUNK_BYTES`], so within TikTok's 5–64 MB chunks, a
//! last chunk of at most 128 MB and at most 1000 chunks). The chunks go one after the other to
//! the `upload_url`, each a `PUT` with `Content-Type`, `Content-Length` and `Content-Range: bytes
//! {first}-{last}/{total}`, and no access token (the upload URL is its own authority); every 2xx
//! is taken (TikTok answers 206 before the last chunk, 201 after it). A failed chunk stops the
//! post. Photos go as `PULL_FROM_URL`, `post_mode: DIRECT_POST`, `media_type: PHOTO`, the first
//! photo the cover; TikTok fetches them itself, from a domain verified in its developer portal
//! (else `url_ownership_unverified`).
//!
//! The receipt is the `publish_id`, without a URL: TikTok publishes in the background.
//!
//! **Status** ([`Publisher::resolve`]). `PUBLISH_COMPLETE` is
//! [`PublishResolution::Published`]: the receipt of the first `publicaly_available_post_id`
//! (TikTok's own spelling), with the permalink `https://www.tiktok.com/@<username>/video/<id>`
//! when a username is known (the first handle among `public["username"]`,
//! `public["facts"]["username"]` and `public["asset"]["username"]`); TikTok names no public id for
//! a post nobody else may see (`SELF_ONLY`), and the receipt then keeps the publish id, without a
//! URL. `FAILED` is [`PublishResolution::Failed`] with "publish failed: <fail_reason>",
//! `Permanent` (`auth_removed`, the creator having removed the app's access: `Auth`).
//! `PROCESSING_UPLOAD`, `PROCESSING_DOWNLOAD`, `SEND_TO_USER_INBOX` (and a status TikTok may add
//! later) are [`PublishResolution::Pending`]. A failed status call is the error.
//!
//! **Counters.** Kept under TikTok's own names, whole numbers only: a post's `like_count`,
//! `comment_count`, `share_count`, `view_count`; the account's `follower_count`,
//! `following_count`, `likes_count`, `video_count`. A post is named by its video id (digits); a
//! receipt that kept its publish id has none to read.
//!
//! **The probe** reads `GET /v2/user/info/` with the credential and names its `open_id` as
//! `facts.account_id` (the credential's own identity, never `public["external_id"]`), with its
//! `display_name` and (best effort) `username`.
//!
//! **Kinds.** TikTok serves one kind, `tiktok`. Every operation that takes `public` refuses one
//! without it in `public["kind_key"]` (`Permanent`, "kind_key missing") and calls nothing.
//!
//! **Not covered** (spec §4): direct messages and comments (no public API for Login Kit apps),
//! ads (`tiktok_ads`), webhooks, and the video's duration against `max_video_post_duration_sec`
//! (the adapter does not read MP4 files; TikTok refuses a video too long, `duration_check_failed`).
//!
//! [`Connector`]: jt_app::ports::connectors::Connector
//! [`Connector::refresh`]: jt_app::ports::connectors::Connector::refresh
//! [`OAuthProvider`]: jt_app::ports::connectors::OAuthProvider
//! [`OAuthProvider::authorize_url`]: jt_app::ports::connectors::OAuthProvider::authorize_url
//! [`OAuthProvider::exchange`]: jt_app::ports::connectors::OAuthProvider::exchange
//! [`OAuthProvider::list_assets`]: jt_app::ports::connectors::OAuthProvider::list_assets
//! [`Publisher`]: jt_app::ports::connectors::Publisher
//! [`Publisher::resolve`]: jt_app::ports::connectors::Publisher::resolve
//! [`PublishResolution::Published`]: jt_app::ports::connectors::PublishResolution::Published
//! [`PublishResolution::Failed`]: jt_app::ports::connectors::PublishResolution::Failed
//! [`PublishResolution::Pending`]: jt_app::ports::connectors::PublishResolution::Pending
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

/// The hosts the adapter reaches, exactly the `tiktok` entries of `jt_outbound::FIXED_HOSTS`: the
/// Open API (with its token endpoint) and the video upload.
pub const TIKTOK_HOSTS: &[&str] = &["open.tiktokapis.com", "open-upload.tiktokapis.com"];

/// The scopes the authorize URL asks for (<https://developers.tiktok.com/doc/tiktok-api-scopes>):
/// the account's basic profile, posting directly, reading its videos (their counters) and its
/// counters. `video.upload` (drafts to the inbox) is not asked for: posts go out directly.
pub const TIKTOK_SCOPES: &[&str] = &[
    "user.info.basic",
    "video.publish",
    "video.list",
    "user.info.stats",
];

/// Who may see a post, by TikTok's names (`privacy_level`); the same as `jt_studio`'s.
pub const PRIVACY_LEVELS: &[&str] = &[
    "PUBLIC_TO_EVERYONE",
    "MUTUAL_FOLLOW_FRIENDS",
    "FOLLOWER_OF_CREATOR",
    "SELF_ONLY",
];

/// The privacy of a post whose request names none.
pub const DEFAULT_PRIVACY: &str = "PUBLIC_TO_EVERYONE";

/// How long before its expiry a credential is renewed. TikTok's access tokens live 24 hours and
/// the refresh job runs hourly, so a token is renewed once, some 18 hours into its life.
pub const REFRESH_AHEAD: time::Duration = time::Duration::hours(6);

/// The media type of the one video a post uploads.
pub const VIDEO_MIME: &str = "video/mp4";

/// The largest video uploaded, in bytes (TikTok's 4 GB).
pub const MAX_VIDEO_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// The size of a video's chunks, in bytes (10 MiB, within TikTok's 5–64 MB); a smaller video goes
/// in one chunk.
pub const CHUNK_BYTES: u64 = 10 * 1024 * 1024;

/// The longest video title (the text and the link), in UTF-16 units.
pub const MAX_TITLE_UNITS: usize = 2200;

/// The longest photo post description (the text and the link), in UTF-16 units.
pub const MAX_DESCRIPTION_UNITS: usize = 4000;

/// The most photos one post carries.
pub const MAX_PHOTOS: usize = 35;

/// How many times a read is tried in all when no answer arrives (writes: once).
pub const READ_ATTEMPTS: u32 = 2;

/// The pause before a read that got no answer is tried again, by default.
pub const DEFAULT_RETRY_DELAY: Duration = Duration::from_millis(300);

/// How long one call may take, connect to end of answer, by default (chunks: [`UPLOAD_TIMEOUT`]).
pub const ATTEMPT_TIMEOUT: Duration = Duration::from_secs(30);

/// How long one chunk of a video may take, by default.
pub const UPLOAD_TIMEOUT: Duration = Duration::from_secs(120);

/// Where the adapter sends its calls and its users: the real hosts by default
/// ([`TiktokBases::production`]). Each is a base URL (scheme, host, port and an optional path
/// prefix) the adapter appends its paths to. The video upload goes to the URL TikTok answers
/// with, not to a base.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TiktokBases {
    /// The Open API and the token endpoint, `https://open.tiktokapis.com`.
    pub api: Url,
    /// The authorize dialog, `https://www.tiktok.com`: only a URL for the owner's browser, never
    /// fetched, so not an egress host.
    pub authorize: Url,
}

impl TiktokBases {
    /// The real hosts.
    pub fn production() -> TiktokBases {
        let url = |text: &str| Url::parse(text).expect("a valid TikTok base URL");
        TiktokBases {
            api: url("https://open.tiktokapis.com"),
            authorize: url("https://www.tiktok.com"),
        }
    }
}

/// The TikTok adapter. Cheap to share behind an `Arc`; it holds the egress client, the bases, the
/// platform's app configuration (the TikTok app, read at call time), the pause before a read is
/// tried again ([`DEFAULT_RETRY_DELAY`]) and the time a call ([`ATTEMPT_TIMEOUT`]) and a chunk
/// ([`UPLOAD_TIMEOUT`]) may take. It holds no credential: each call is given one.
pub struct TiktokConnector {
    egress: Arc<Egress>,
    bases: TiktokBases,
    apps: Arc<dyn PlatformAppConfig>,
    retry_delay: Duration,
    attempt_timeout: Duration,
    upload_timeout: Duration,
}

impl fmt::Debug for TiktokConnector {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TiktokConnector")
            .field("bases", &self.bases)
            .field("retry_delay", &self.retry_delay)
            .field("attempt_timeout", &self.attempt_timeout)
            .field("upload_timeout", &self.upload_timeout)
            .finish_non_exhaustive()
    }
}

impl TiktokConnector {
    /// The adapter over `egress`, sending to `bases`, with the platform's apps `apps`.
    pub fn new(
        egress: Arc<Egress>,
        bases: TiktokBases,
        apps: Arc<dyn PlatformAppConfig>,
    ) -> TiktokConnector {
        TiktokConnector {
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
    pub fn with_retry_delay(mut self, delay: Duration) -> TiktokConnector {
        self.retry_delay = delay;
        self
    }

    /// The adapter giving each call but a chunk `timeout`, connect to end of answer, instead of
    /// [`ATTEMPT_TIMEOUT`] (tests time out in milliseconds).
    pub fn with_attempt_timeout(mut self, timeout: Duration) -> TiktokConnector {
        self.attempt_timeout = timeout;
        self
    }

    /// The adapter giving each chunk of a video `timeout` instead of [`UPLOAD_TIMEOUT`].
    pub fn with_upload_timeout(mut self, timeout: Duration) -> TiktokConnector {
        self.upload_timeout = timeout;
        self
    }

    /// Where the adapter sends its calls.
    pub fn bases(&self) -> &TiktokBases {
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
