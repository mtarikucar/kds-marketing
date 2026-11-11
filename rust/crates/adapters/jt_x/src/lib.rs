//! The X adapter (spec §4.2 rule 1, §6.1, §6.4): an X account, connected with OAuth 2.0 and PKCE,
//! its posts (text, a link and up to four images) and its public counters; and an X ads account,
//! in which it builds campaigns (design 2026-11-11 §3.4).
//!
//! [`XConnector`] implements the connector ports of `jt_app` ([`Connector`], [`OAuthProvider`],
//! [`Publisher`], [`InsightsReader`], [`AdCampaignWriter`], [`AdBudgetWriter`]). X sends no
//! webhooks.
//!
//! **Transport.** The adapter holds no HTTP client: every call is built with
//! [`jt_outbound::Egress::prepare`] and sent under `EgressScope::Connector("x")`, so it can reach
//! only the `x` hosts of the fixed tier ([`X_HOSTS`]). Where it sends them is [`XBases`], the real
//! hosts by default ([`XBases::production`]): the API (`api.twitter.com`), the media upload
//! (`api.x.com`) and the Ads API (`ads-api.x.com`). The authorize dialog (`twitter.com`) is only
//! a URL for the owner's browser and is never fetched. Tests point the bases at an in-process
//! mock.
//!
//! **OAuth.** Authorization code with PKCE (S256), as a confidential client:
//!
//! | Step | Call |
//! |---|---|
//! | authorize | `https://twitter.com/i/oauth2/authorize?response_type=code&client_id&redirect_uri&scope&state&code_challenge&code_challenge_method=S256`, the scopes [`X_SCOPES`] (and [`AD_SCOPES`] when the platform's app has the Ads API) joined by spaces (`%20`); without a challenge (or for an app that is not X's), refused: `Permanent` "pkce required", and the use case starts no flow |
//! | exchange | `POST {api}/2/oauth2/token`, form `grant_type=authorization_code, code, redirect_uri, client_id, code_verifier`, `Authorization: Basic base64(client_id:client_secret)`; without a verifier, refused ("pkce required") |
//! | refresh | `POST {api}/2/oauth2/token`, form `grant_type=refresh_token, refresh_token, client_id`, the same `Basic` |
//!
//! A token answer becomes [`Credential::OAuth`]: its access token, its refresh token (on a
//! refresh, the one held when the answer names none), `expires_at` = now + `expires_in` (X's
//! access tokens live two hours), and the scopes the answer's `scope` grants (else those asked
//! for, or held). X rotates the refresh token on every refresh, so [`Connector::refresh`] renews
//! whenever it is called and always answers the new credential, which the use case seals in place
//! of the old. A credential without a refresh token cannot be renewed: `Auth` (reconnect).
//!
//! **Calls.**
//!
//! | Operation | Call |
//! |---|---|
//! | the account ([`OAuthProvider::list_assets`]), the probe | `GET {api}/2/users/me` |
//! | an image | `POST {upload}/2/media/upload`, multipart `media` (the file) and `media_category=tweet_image` (a GIF: `tweet_gif`) → `data.id` (or `media_id_string`) |
//! | a post | `POST {api}/2/tweets {text, media: {media_ids}}` |
//! | a post's counters | `GET {api}/2/tweets/{id}?tweet.fields=public_metrics` |
//! | the account's counters | `GET {api}/2/users/me?user.fields=public_metrics` |
//!
//! Every call but the three token calls carries the access token as `Authorization: Bearer`;
//! nothing secret ever goes in a URL.
//!
//! **Errors.** Nothing is thrown: every failure is a [`ConnectorError`], built through its
//! redacting constructors. Its reason names the HTTP status and the provider's own words (a
//! problem's `title`, `detail` and first `errors` message, or a token error's `error` and
//! `error_description`), with every secret of the call (the token, the client secret, the code,
//! the verifier, the refresh token) taken out, cut to 300 characters; never a body, a URL or a
//! header. The mapping, first match wins:
//!
//! | Answer | Error |
//! |---|---|
//! | HTTP 429 | `Throttle`, the largest wait ahead among `x-rate-limit-reset` (the endpoint's 15-minute window), `x-account-rate-limit-reset` (the same window of an ads account, on the Ads API), `x-app-limit-24hour-reset` and `x-user-limit-24hour-reset` (the 24-hour post caps), each epoch seconds minus now; else `Retry-After` (seconds); at most [`MAX_RETRY_AFTER`] |
//! | a token call's HTTP 401 `invalid_client` (the platform's X client id or secret refused: no reconnection can fix it) | `Permanent` ("platform client credentials rejected") |
//! | HTTP 401; a token call's `invalid_grant` (a spent code, a verifier that does not match, a spent or revoked refresh token); a refresh's `invalid_request` (X's answer to a refresh token it no longer accepts) | `Auth`: the owner must reconnect |
//! | HTTP 403 | `Permission` |
//! | HTTP 5xx, and the Ads API's 408 (`CANCELLED_REQUEST`) and 423 (`LOCK_ACQUISITION_TIMEOUT`); a read transport failure or broken response, a connect failure, a host resolving to no public address | `Transient` |
//! | A non-idempotent write may have reached the provider, but its answer was lost, broke off, was oversized/unreadable on success, or omitted the publication ID | `Unknown` (never retry blindly) |
//! | any other status (another 4xx, a redirect, which is never followed); a read 2xx answer that is not JSON, or an answer that carries `errors` and no `data` (a deleted post); a read answer lacking what the call needs; a read answer over 4 MiB; a host the `x` tier does not hold | `Permanent` |
//!
//! **Retries.** Reads (`GET`) are tried once more ([`READ_ATTEMPTS`] in all) when no answer
//! arrived (the connection failed, dropped or timed out), after [`DEFAULT_RETRY_DELAY`]. Posts,
//! uploads and the token calls are sent once, whatever happens: a second post could publish
//! twice, a second refresh would present a refresh token the first may have spent. One that gets
//! no answer after its request may have reached X fails `Unknown` with a reason saying its
//! outcome is unknown. Nothing is ever sent again once any answer arrived.
//!
//! **Posts.** Checked before anything is sent, each failure `Permanent`: the kind
//! (`public["kind_key"]` must be `x`, else "kind_key missing"), an [`Credential::OAuth`]
//! credential, at most [`MAX_IMAGES`] images, each 1 byte to [`MAX_IMAGE_BYTES`] of a type in
//! [`IMAGE_MIMES`] (compared ignoring case and surrounding space), a GIF only alone (X takes up
//! to four still images or one GIF), media URLs only with their bytes ("x needs media bytes": X
//! takes uploads only, and M3 supplies the bytes from the asset store), as many bytes as URLs
//! when both are given ("media bytes and urls disagree"; with equal counts the bytes are
//! uploaded, the URLs being where they were read from), something to post (text, a link or an
//! image), and the length. A link is put after the text, on a line of its own. The length is
//! counted with Unicode single/double-weight ranges, at most [`MAX_TEXT_CHARS`], every
//! explicit URL or bare domain counting [`LINK_CHARS`] (X wraps them in `t.co` links).
//! Images are uploaded one after
//! the other (`media_category=tweet_image`, a GIF `tweet_gif`), then the post is made with their
//! ids; a failed upload stops the post (the images uploaded before it expire unused at X). The receipt's URL is
//! `https://x.com/<username>/status/<id>`, the username being the first X handle among
//! `public["username"]`, the last probe's `public["facts"]["username"]` and the OAuth asset's
//! `public["asset"]["username"]` (where the connection use cases keep them), else
//! `https://x.com/i/status/<id>`.
//!
//! **Counters.** Every whole-number field of the answer's `public_metrics` is kept under X's own
//! name (a post: `retweet_count`, `reply_count`, `like_count`, `quote_count`, `bookmark_count`,
//! `impression_count`; the account: `followers_count`, `following_count`, `tweet_count`,
//! `listed_count`, `like_count`, `media_count`); the ports' maps have no room for the rest.
//!
//! **The probe** reads `GET /2/users/me` with the credential and names its `id` as
//! `facts.account_id` (the credential's own identity, never `public["external_id"]`), with its
//! `username`.
//!
//! **Kinds.** X serves `x` (an account that posts) and `x_ads` (an ads account). Posting and the
//! counters are the first's: every such operation refuses a `public` without it in
//! `public["kind_key"]` (`Permanent`, "kind_key missing") and calls nothing. Campaigns are the
//! ads account's: every such operation refuses another kind ("not an X ads account").
//!
//! **Ad campaigns** (`x_ads`; design 2026-11-11 §3.4, B67 and B92 to B97). X's ads are reached
//! through its Ads API (`ads-api.x.com`, version [`ADS_VERSION`] in the path), with the same
//! sign-in as an account that posts: when the platform's X app has the Ads API
//! (`XApp::ad_scopes`), every flow also asks for [`AD_SCOPES`], and a sign-in that was granted
//! `ads.write` offers the ads accounts it may build in beside its own account. Every call below
//! was written from X's Ads API documentation (`github.com/xdevplatform/docs`, commit
//! `fe4cdaf4`, read 2026-11-11). **Nothing here has been run against X**: the tests answer from
//! an in-process mock, and the first real campaign is the owner's, on their own account, with a
//! small budget and their approval at that moment (B38).
//!
//! *The shape of a call.* The token is the OAuth 2.0 bearer of the sign-in. The parameters
//! travel in the query, on a `POST` and a `PUT` too; only a card is sent as a JSON body. An
//! answer is `{request, data, next_cursor}`: a list is read page by page (`count=200`, then
//! `cursor`), at most [`MAX_AD_PAGES`] pages, and a list that still has more is refused, never
//! cut short. An error is `{errors: [{code, message}]}` under its HTTP status, and maps as every
//! other call of this crate does; its reason names X's code (`INVALID_PARAMETER`) and words. A
//! write whose answer was lost is never sent again: the next run looks for the object.
//!
//! *The calls.* An object is always named beside its ads account, which its own id does not
//! carry, so the ids this adapter hands out carry both (B70): `xa:{account}:campaign:{id}`,
//! `xa:{account}:line:{id}`, and for an ad `xa:{account}:ad:{line item}:{post}` (B94).
//!
//! | Step | Call |
//! |---|---|
//! | the ads accounts ([`OAuthProvider::list_assets`]) | `GET accounts`, then for each one that is not deleted (at most [`MAX_AD_ACCOUNTS`]) the three reads of "an ads account that can be built in" below; one that cannot is left out |
//! | an ads account that can be built in (the probe, and before each campaign) | `GET accounts/:id` → `approval_status` `ACCEPTED`, `timezone`; `GET accounts/:id/authenticated_user_access` → `user_id`, and `permissions` that hold `ACCOUNT_ADMIN` or `AD_MANAGER`; `GET accounts/:id/promotable_users` → the one `FULL` user, whom the account advertises as: the signed-in user is that user, or holds `TWEET_COMPOSER` (X's permission to write that user's promoted-only posts); `GET accounts/:id/funding_instruments` → exactly one that is `able_to_fund`, `ACTIVE` and not deleted, whose `currency` is the account's (B93) |
//! | finding an object by its name (before a creation, B71) | `GET accounts/:id/campaigns?q=name` and `GET accounts/:id/cards?q=name`; X matches a name by its beginning, so the rows are compared exactly, and two of one name are refused. The line item and the ad are found by their own steps |
//! | the campaign | `POST accounts/:id/campaigns?funding_instrument_id&name&total_budget_amount_local_micro&daily_budget_amount_local_micro&entity_status=PAUSED`: the whole budget as the total, and as the daily budget X asks most accounts for, which may not be above the total (B93) |
//! | a country | `GET targeting_criteria/locations?location_type=COUNTRIES&country_code`: the one row of that code, whose `targeting_value` a line item takes |
//! | the line item | the countries first; then `GET accounts/:id/line_items?campaign_ids&q=name`, and when none carries the name `POST accounts/:id/line_items?campaign_id&name&objective=WEBSITE_CLICKS&product_type=PROMOTED_TWEETS&placements=ALL_ON_TWITTER&start_time&end_time&total_budget_amount_local_micro&bid_strategy=AUTO&goal=LINK_CLICKS&entity_status=PAUSED`; then `GET accounts/:id/targeting_criteria?line_item_ids` and, for each country that is not on it, `POST accounts/:id/targeting_criteria?line_item_id&operator_type=EQ&targeting_type=LOCATION&targeting_value`. The step answers only once every country is there: a line item without a location is shown to everybody, everywhere (B95) |
//! | the image | `POST {upload}/2/media/upload` (multipart, `media_category=tweet_image`; `additional_owners` names the account's user when the signed-in user is another), a JPG or a PNG of at most 3 MB → its `media_key` (when the answer names none, `3_` and the media id); then `POST accounts/:id/media_library?media_key&name`, which is where a card takes its media from |
//! | the card | `POST accounts/:id/cards`, JSON `{name, components: [{type: "MEDIA", media_key}, {type: "DETAILS", title, destination: {type: "WEBSITE", url}}]}` → `card_uri`. A website card has no button |
//! | the ad | `GET accounts/:id/tweets?tweet_type=PUBLISHED&timeline_type=NULLCAST&name`; when no post carries the name, `POST accounts/:id/tweet?text&card_uri&nullcast=true&name`: a promoted-only post (it is not on the user's profile) of the user the account advertises as, which is X's default when no user is named (B92). The post is not promoted here: X has no paused promotion, so the ad is created off and switching it on promotes it (B94) |
//! | switching on and off | `PUT accounts/:id/campaigns/:id?entity_status=ACTIVE` or `PAUSED`, and the same for `line_items/:id`. A campaign's switch takes its line items with it (off: the campaign, then each line item, every one tried whatever the others answered; on: the line items, then the campaign), since on X this pause is the only limit a budget has (B97). An ad is switched on by `GET accounts/:id/promoted_tweets?line_item_ids` and, when its post is not promoted there, `POST accounts/:id/promoted_tweets?line_item_id&tweet_ids`; off by `DELETE accounts/:id/promoted_tweets/:id` (B94) |
//! | the state | `GET accounts/:id/campaigns/:id?with_deleted=true` → `entity_status`; `GET accounts/:id/line_items?campaign_ids`; `GET accounts/:id/promoted_tweets?line_item_ids&with_deleted=true`: an ad stands as the promotion that is there now says (`approval_status` `ACCEPTED`, `PENDING`, `REJECTED`), and is paused when every promotion it had was deleted |
//! | the days | `GET stats/accounts/:id?entity=PROMOTED_TWEET&entity_ids&start_time&end_time&granularity=DAY&placement=ALL_ON_TWITTER&metric_groups=ENGAGEMENT,BILLING`, at most twenty ids and seven days a call (X's limits), the end being the first day left out. X reads a day as the ads account's own, while the days asked for are days of UTC: one more day is read at each end (told only when something happened on it), and when X refuses the range that reaches a day ahead, the range without it is read. The line items read are the deleted ones too. The numbers of every promotion an ad ever had are added up, and the spend (`billed_charge_local_micro`) is rounded to the nearest minor unit after that (B96). `clicks` is every click on the post as X counts them; a result is a click on the card's link (`url_clicks`) |
//!
//! *What an ad is checked for before anything is sent.* Its text is 1 to 280 characters as X
//! counts them (the weighted count of a post) and carries no link written out (X takes a
//! website card or a link in the post, not both); the card's title is 1 to 70 characters; the
//! names of the card and of the post are at most 80. X also asks for an image at least 800
//! pixels wide, square or 1.91:1: that is not checked here, and X refuses another image at the
//! card, before anything runs.
//!
//! *No hard limit.* X's pages do not say that a campaign's total budget is never exceeded (a
//! campaign "runs until its budget is exhausted"; the only overspend they name is for ads
//! served after the end time, which X credits back). The platform rules of X therefore say
//! `hard_budget_cap: false`, Jeeta reads a running X campaign every fifteen minutes, and the
//! pause it sends once the budget is reached is the limit itself (B67, B97). Each reading
//! reads the campaign from its start, a week a call: X allows 250 analytics calls in fifteen
//! minutes for an ads account, which is about nineteen campaigns of ninety days.
//!
//! *What the first real run will show* (design A7, A10 to A13): whether the Ads API takes the
//! OAuth 2.0 token (X's Ads pages name OAuth 1.0a only, its newer pages say the Ads API accepts
//! OAuth 2.0 and that OAuth 1.0a closes on 2027-01-31); whether the one-call upload answers the
//! `media_key` a card needs and takes `additional_owners`; the words X uses for an account or
//! a promotion that is not accepted (only `ACCEPTED` is in its pages; `PENDING`,
//! `UNDER_REVIEW` and `REJECTED` are read as their names say, anything else is shown as it
//! is); how a line item is charged (no `pay_by` is sent: X sets it from the objective, and its
//! page names both a link click and an impression as the default); whether a plain
//! `PUT ...?entity_status=ACTIVE` switches a line item on (the reference says so; X's page on
//! its own MCP server names separate "activate" routes); and whether X takes two posts of one
//! text (`DUPLICATE_TWEET`).
//!
//! [`Connector`]: jt_app::ports::connectors::Connector
//! [`Connector::refresh`]: jt_app::ports::connectors::Connector::refresh
//! [`OAuthProvider`]: jt_app::ports::connectors::OAuthProvider
//! [`OAuthProvider::list_assets`]: jt_app::ports::connectors::OAuthProvider::list_assets
//! [`Publisher`]: jt_app::ports::connectors::Publisher
//! [`InsightsReader`]: jt_app::ports::connectors::InsightsReader
//! [`AdCampaignWriter`]: jt_app::ports::connectors::AdCampaignWriter
//! [`AdBudgetWriter`]: jt_app::ports::connectors::AdBudgetWriter
//! [`ConnectorError`]: jt_connector::ConnectorError
//! [`Credential::OAuth`]: jt_connector::Credential::OAuth

mod account;
mod ads;
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

pub use ads::{ADS_VERSION, MAX_AD_ACCOUNTS, MAX_AD_PAGES};
pub use client::MAX_RETRY_AFTER;

/// The hosts the adapter reaches, exactly the `x` entries of `jt_outbound::FIXED_HOSTS`: the API
/// and the media upload.
pub const X_HOSTS: &[&str] = &["api.twitter.com", "api.x.com", "ads-api.x.com"];

/// The scopes a flow whose app sets `ad_scopes` asks for too: reading and writing the user's
/// ads accounts through X's Ads API (X's own example: `scope=ads.read ads.write
/// offline.access`). Only an app X gave Ads API access to may ask.
pub const AD_SCOPES: &[&str] = &["ads.read", "ads.write"];

/// The scopes the authorize URL asks for: reading and writing posts, reading the account,
/// a refresh token (`offline.access`) and uploading media.
pub const X_SCOPES: &[&str] = &[
    "tweet.read",
    "tweet.write",
    "users.read",
    "offline.access",
    "media.write",
];

/// The most images one post carries.
pub const MAX_IMAGES: usize = 4;

/// The largest image uploaded, in bytes (5 MB).
pub const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;

/// The media types of the images uploaded. A GIF goes alone in a post and is uploaded as
/// `tweet_gif`.
pub const IMAGE_MIMES: &[&str] = &["image/jpeg", "image/png", "image/gif", "image/webp"];

/// The longest post, in characters.
pub const MAX_TEXT_CHARS: usize = 280;

/// What a link (the request's, or a URL in the text) counts for in a post's length: X wraps every
/// link in a 23-character `t.co` link.
pub const LINK_CHARS: usize = 23;

/// How many times a read is tried in all when no answer arrives (posts, uploads and token calls:
/// once).
pub const READ_ATTEMPTS: u32 = 2;

/// The pause before a read that got no answer is tried again, by default.
pub const DEFAULT_RETRY_DELAY: Duration = Duration::from_millis(300);

/// How long one call may take, connect to end of answer, by default (uploads: [`UPLOAD_TIMEOUT`]).
pub const ATTEMPT_TIMEOUT: Duration = Duration::from_secs(30);

/// How long one media upload may take, by default.
pub const UPLOAD_TIMEOUT: Duration = Duration::from_secs(120);

/// Where the adapter sends its calls and its users: the real hosts by default
/// ([`XBases::production`]). Each is a base URL (scheme, host, port and an optional path prefix)
/// the adapter appends its paths to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct XBases {
    /// The API and the token endpoint, `https://api.twitter.com`.
    pub api: Url,
    /// The media upload, `https://api.x.com`.
    pub upload: Url,
    /// The authorize dialog, `https://twitter.com`: only a URL for the owner's browser, never
    /// fetched, so not an egress host.
    pub authorize: Url,
    /// The Ads API, `https://ads-api.x.com`.
    pub ads: Url,
}

impl XBases {
    /// The real hosts.
    pub fn production() -> XBases {
        let url = |text: &str| Url::parse(text).expect("a valid X base URL");
        XBases {
            api: url("https://api.twitter.com"),
            upload: url("https://api.x.com"),
            authorize: url("https://twitter.com"),
            ads: url("https://ads-api.x.com"),
        }
    }
}

/// The X adapter. Cheap to share behind an `Arc`; it holds the egress client, the bases, the
/// platform's app configuration (the X client, read at call time), the pause before a read is
/// tried again ([`DEFAULT_RETRY_DELAY`]) and the time a call ([`ATTEMPT_TIMEOUT`]) and an upload
/// ([`UPLOAD_TIMEOUT`]) may take. It holds no credential: each call is given one.
pub struct XConnector {
    egress: Arc<Egress>,
    bases: XBases,
    apps: Arc<dyn PlatformAppConfig>,
    retry_delay: Duration,
    attempt_timeout: Duration,
    upload_timeout: Duration,
}

impl fmt::Debug for XConnector {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("XConnector")
            .field("bases", &self.bases)
            .field("retry_delay", &self.retry_delay)
            .field("attempt_timeout", &self.attempt_timeout)
            .field("upload_timeout", &self.upload_timeout)
            .finish_non_exhaustive()
    }
}

impl XConnector {
    /// The adapter over `egress`, sending to `bases`, with the platform's apps `apps`.
    pub fn new(egress: Arc<Egress>, bases: XBases, apps: Arc<dyn PlatformAppConfig>) -> XConnector {
        XConnector {
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
    pub fn with_retry_delay(mut self, delay: Duration) -> XConnector {
        self.retry_delay = delay;
        self
    }

    /// The adapter giving each call but an upload `timeout`, connect to end of answer, instead of
    /// [`ATTEMPT_TIMEOUT`] (tests time out in milliseconds).
    pub fn with_attempt_timeout(mut self, timeout: Duration) -> XConnector {
        self.attempt_timeout = timeout;
        self
    }

    /// The adapter giving each media upload `timeout` instead of [`UPLOAD_TIMEOUT`].
    pub fn with_upload_timeout(mut self, timeout: Duration) -> XConnector {
        self.upload_timeout = timeout;
        self
    }

    /// Where the adapter sends its calls.
    pub fn bases(&self) -> &XBases {
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
