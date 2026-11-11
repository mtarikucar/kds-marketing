//! The Google adapter (design `docs/superpowers/specs/2026-11-11-reklam-platformlari-design.md`
//! §3.1): the Google Ads accounts a signed-in user reaches directly (`google_ads`), connected
//! with OAuth 2.0, and search campaigns built in them.
//!
//! [`GoogleConnector`] implements the connector ports of `jt_app` ([`Connector`],
//! [`OAuthProvider`], [`AdCampaignWriter`], [`AdBudgetWriter`]). Google sends no webhooks here.
//!
//! **Nothing here has been run against Google.** Every call is written from Google's documents
//! (the pages named below, read 2026-11-11) and from the API's own REST description
//! (`https://googleads.googleapis.com/$discovery/rest?version=v26`, revision 20261110, from which
//! every JSON field name and enum value was taken), and is tested against an in-process mock.
//! The first real campaign is the owner's, on their own account (design 2026-11-10 B38).
//!
//! **Transport.** The adapter holds no HTTP client: every call is built with
//! [`jt_outbound::Egress::prepare`] and sent under `EgressScope::Connector("google")`, so it can
//! reach only the `google` hosts of the fixed tier ([`GOOGLE_HOSTS`]): the Google Ads API
//! (`googleads.googleapis.com`) and the token endpoint (`oauth2.googleapis.com`). The authorize
//! dialog (`accounts.google.com`) is only a URL for the owner's browser. Tests point the bases
//! ([`GoogleBases`]) at an in-process mock.
//!
//! **OAuth.** Authorization code, as a confidential web client with offline access
//! (<https://developers.google.com/identity/protocols/oauth2/web-server>):
//!
//! | Step | Call |
//! |---|---|
//! | authorize | `{authorize}/o/oauth2/v2/auth?client_id&redirect_uri&response_type=code&scope&access_type=offline&prompt=consent&include_granted_scopes=true&state`, the scope [`ADS_SCOPE`]. `access_type=offline` asks for a refresh token; `prompt=consent` makes Google return one on a reconnection too ("The `refresh_token` is only returned on the first authorization" otherwise) |
//! | exchange | `POST {oauth}/token`, form `grant_type=authorization_code, code, redirect_uri, client_id, client_secret` |
//! | refresh | `POST {oauth}/token`, form `grant_type=refresh_token, refresh_token, client_id, client_secret` |
//! | revoke | `POST {oauth}/revoke`, form `token` (the refresh token, else the access token) |
//!
//! A token answer becomes [`Credential::OAuth`]: its access token, its refresh token (on a
//! refresh, the one held: Google's refresh answer names none and the refresh token does not
//! rotate) and the scopes its space-delimited `scope` grants. **It names no end.** A Google
//! connection lives as long as its refresh token; the access token that came with it lives about
//! an hour, the same as the refresh job's round, so a stored end would make the connection read
//! as expired for a while every hour. An exchange that brings no refresh token is refused
//! (`Permanent`): without one the connection would die within the hour.
//!
//! **The access token of a call.** The adapter does not count on the stored access token: a call
//! asks the token endpoint for one with the credential's refresh token and keeps it in memory
//! until it has less than [`TOKEN_MARGIN`] left (one token call an hour per connection, whatever
//! the number of calls). A credential that does name an end in the future is used as it is.
//!
//! **Access.** Google gives API access per Google Cloud project, the one that owns the OAuth
//! client (<https://developers.google.com/google-ads/api/docs/api-policy/access-levels>): no
//! developer token is sent ("optional and ignored by the API servers",
//! <https://developers.google.com/google-ads/api/docs/get-started/dev-token>). A project with Test
//! access cannot call a production account; the error is mapped as the platform's, not the
//! tenant's (below). Accounts are reached directly: no `login-customer-id` is sent, so an account
//! the user reaches only through a manager account is not offered (design §6).
//!
//! **Calls.** REST, JSON, `{api}/v26/...` ([`API_VERSION`]; a version lives about a year,
//! <https://developers.google.com/google-ads/api/docs/sunset-dates>), `Authorization: Bearer`.
//!
//! | Operation | Call |
//! |---|---|
//! | the accounts ([`OAuthProvider::list_assets`]) | `GET customers:listAccessibleCustomers` → `resourceNames`; then for each (at most [`MAX_ACCOUNTS`]) the account's facts |
//! | an account's facts (assets, the probe, [`AdCampaignWriter::account_limits`]) | `POST customers/{id}/googleAds:search` `SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.status, customer.manager, customer.test_account FROM customer LIMIT 1` |
//! | find by name | `googleAds:search` on `campaign` / `ad_group` by `name`, not removed |
//! | the campaign | one `googleAds:mutate`: a campaign budget (`period: CUSTOM_PERIOD`, `totalAmountMicros`, `explicitlyShared: false`) under a temporary resource name, and the campaign on it (`SEARCH`, `PAUSED`, `targetSpend: {}`, Google Search only, `startDateTime`, `endDateTime`, `containsEuPoliticalAdvertising: DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING`, `geoTargetTypeSetting.positiveGeoTargetType: PRESENCE`) |
//! | the ad group | the countries' geo target constants (`googleAds:search` on `geo_target_constant`), then one `googleAds:mutate`: the ad group (`SEARCH_STANDARD`, `PAUSED`), one location criterion per country on the campaign, one keyword criterion per keyword (`PHRASE`) |
//! | an ad | `googleAds:search` for an ad of the ad group with the same texts and address (adopted when there is one), else one `googleAds:mutate`: the ad group ad (`PAUSED`, `finalUrls`, `responsiveSearchAd.headlines` / `.descriptions`) |
//! | a status ([`AdBudgetWriter::set_status`]) | `googleAds:mutate`: `update` of `status` (`ENABLED` / `PAUSED`) with `updateMask: "status"` on the campaign, the ad group or the ad group ad the id names |
//! | the state | `googleAds:search`: `campaign.status`; each ad's `status` and `policy_summary` |
//! | the daily numbers | `googleAds:search` on `ad_group_ad` with `segments.date`, `metrics.impressions`, `metrics.clicks`, `metrics.cost_micros` and `customer.currency_code` |
//!
//! A mutate is one transaction ("operations execute atomically",
//! <https://developers.google.com/google-ads/api/docs/mutating/bulk-mutate>): a budget is never
//! left without its campaign, an ad group never without its countries and keywords.
//!
//! **Ids.** An object is known by Google's own resource name, which carries its account and its
//! kind: `customers/{customer}/campaigns/{id}`, `customers/{customer}/adGroups/{id}`,
//! `customers/{customer}/adGroupAds/{ad group}~{ad}`. That is what the writer answers, what the
//! state and the daily numbers name an ad by, and what a status change is given. An id of any
//! other shape is refused before a call, and so is one of an account other than the capability's
//! wherever the capability is at hand (a status change is given the id alone: it goes to the
//! account the id names, and Google decides whether the credential reaches it).
//!
//! **What a search campaign is made of, and the calls that were this adapter's to make**
//! (builder's calls, design B68, B76):
//!
//! - *Bidding*: "Maximize clicks" (`targetSpend` with nothing set), which a total budget allows
//!   (<https://developers.google.com/google-ads/api/docs/campaigns/budgets/overview>).
//! - *Where it shows*: Google Search only. The Display Network and the search partners are off:
//!   the plan is a search ad, and what was planned and checked is what runs.
//! - *Who sees it*: people in the plan's countries (`PRESENCE`), not people merely interested in
//!   them, searching for what the keywords match as a phrase.
//! - *When*: Google takes a start and an end "in the customer's time zone" and day granularity
//!   for every campaign type ("Set the time component to 00:00:00 for daily granularity, time
//!   granularity is only supported for some campaign types"). So the campaign is given the local
//!   day of its start from `00:00:00` and the local day of its end to `23:59:59`. The exact end
//!   is Jeeta's own (the watch pauses the campaign at its end time); Google's is the backstop,
//!   and the total budget the limit either way. A span Google counts in days is why the core
//!   lets a campaign run 89 days here, not 90.
//! - *No creative object*: a responsive search ad carries its texts itself, so
//!   [`AdCampaignWriter::create_creative`] only checks them and answers [`INLINE`], and the ad
//!   step builds the ad from the creative it is handed.
//! - *An ad has no name at Google* (the API's `Ad.name` is for other ad types), so an ad cannot
//!   be looked up by Jeeta's name for it. Instead the ad step looks, before creating, for an ad of
//!   the ad group that already says exactly this: after a lost answer the ad that was made is
//!   adopted and no second one is created. (The core refuses a plan in which two ads say the
//!   same.)
//!
//! **Money.** Google counts in micros of the account's currency ("One million micros is
//! equivalent to one currency unit"); the core counts in the currency's minor units. A budget is
//! sent as minor units × 10^(6 − exponent); a reported cost is rounded to the nearest minor unit.
//!
//! **Days.** `segments.date` is the account's own day. The daily numbers are asked for one day
//! before and one day after the days the core names, so that a campaign whose account is behind
//! or ahead of UTC loses no day; a day is kept as Google names it.
//!
//! **Errors.** Nothing is thrown: every failure is a [`ConnectorError`], built through its
//! redacting constructors. Its reason names the HTTP status and Google's own words (the first
//! error's code as `group.VALUE`, its message, and for a policy finding its topics; a token
//! error's `error` and `error_description`), with every secret of the call taken out, cut to 300
//! characters; never a body, a URL or a header. The mapping, first match wins:
//!
//! | Answer | Error |
//! |---|---|
//! | a token call's `invalid_client`; an error that is the platform project's own, whatever its status: `authorizationError` `CLOUD_PROJECT_...`, `DEVELOPER_TOKEN_...`, `PROJECT_DISABLED`, `MISSING_TOS`; `authenticationError` `ORGANIZATION_NOT_RECOGNIZED`, `ORGANIZATION_NOT_APPROVED`, ...; `quotaError.ACCESS_PROHIBITED` | `Permanent` ("platform client credentials rejected" / "the platform's Google Cloud project may not call this account"): no reconnection fixes it |
//! | HTTP 429; any other `quotaError` (`RESOURCE_EXHAUSTED`, `RESOURCE_TEMPORARILY_EXHAUSTED`, ...) | `Throttle`, for `Retry-After` seconds when the answer names it, else for the error's own `quotaErrorDetails.retryDelay`, at most [`MAX_RETRY_AFTER`] |
//! | an `authenticationError` about one account and the user who signed in (`CUSTOMER_NOT_FOUND`, `NOT_ADS_USER`, `TWO_STEP_VERIFICATION_NOT_ENROLLED`, ...) | `Permission`: signing in again as the same user changes nothing |
//! | HTTP 401; any other `authenticationError`; a token call's `invalid_grant` | `Auth`: the owner must reconnect |
//! | HTTP 403; any other `authorizationError` (`USER_PERMISSION_DENIED`, `CUSTOMER_NOT_ENABLED`, ...) | `Permission` |
//! | HTTP 5xx; an `internalError`; a read transport failure or broken answer, a connect failure, a host resolving to no public address | `Transient` |
//! | A write whose answer was lost, broke off, or was unreadable on success | `Unknown` (never sent again blindly: the next build looks the object up first) |
//! | any other status; a read answer that is not JSON, lacks what the call needs or is over 4 MiB; a host the `google` tier does not hold | `Permanent` |
//!
//! **Retries.** Reads (`googleAds:search`, the account list) are tried once more
//! ([`READ_ATTEMPTS`] in all) when no answer arrived, after [`DEFAULT_RETRY_DELAY`]. Token calls
//! and mutates are sent once, whatever happens. Nothing is sent again once any answer arrived.
//!
//! **The probe** names, as `facts.account_id`, the account the credential itself reaches: the
//! `customer.id` Google answers for `public["external_id"]` with this token, never the id taken
//! from `public`; with `name`, `currency`, `time_zone` and `test_account`. An account that is not
//! `ENABLED` fails the probe (`Permission`): it cannot run ads. A test account is the exception:
//! Google reports it `CLOSED`, and it is taken.
//!
//! **What only a first real run can tell** (none of it is in Google's machine-readable
//! description): whether a start day of today is taken once its `00:00:00` has passed
//! (`CANNOT_SET_DATE_TO_PAST` exists); whether every account may use a total budget
//! (`CAMPAIGN_BUDGET_PERIOD_NOT_AVAILABLE`: "not on the allow-list for this campaign budget
//! period"); whether the `Country` target type filter and the `policy_topic_entries` selection
//! are accepted as written. Each of them fails loudly, in Google's words, and creates nothing.
//!
//! **Kinds.** Google serves `google_ads`. Every operation that takes `public` refuses one whose
//! `kind_key` is another (`Permanent`) and one without a customer id of 1 to 12 digits in
//! `external_id` (hyphens are dropped), and calls nothing.
//!
//! [`Connector`]: jt_app::ports::connectors::Connector
//! [`Connector::refresh`]: jt_app::ports::connectors::Connector::refresh
//! [`OAuthProvider`]: jt_app::ports::connectors::OAuthProvider
//! [`OAuthProvider::list_assets`]: jt_app::ports::connectors::OAuthProvider::list_assets
//! [`AdCampaignWriter`]: jt_app::ports::connectors::AdCampaignWriter
//! [`AdCampaignWriter::account_limits`]: jt_app::ports::connectors::AdCampaignWriter::account_limits
//! [`AdCampaignWriter::create_creative`]: jt_app::ports::connectors::AdCampaignWriter::create_creative
//! [`AdBudgetWriter`]: jt_app::ports::connectors::AdBudgetWriter
//! [`AdBudgetWriter::set_status`]: jt_app::ports::connectors::AdBudgetWriter::set_status
//! [`ConnectorError`]: jt_connector::ConnectorError
//! [`Credential::OAuth`]: jt_connector::Credential::OAuth

mod account;
mod campaigns;
mod client;
mod oauth;
mod ports;
mod reads;

use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use jt_app::ports::connectors::PlatformAppConfig;
use jt_outbound::Egress;
use time::OffsetDateTime;
use url::Url;

pub use client::MAX_RETRY_AFTER;

/// The hosts the adapter reaches, exactly the `google` entries of `jt_outbound::FIXED_HOSTS`:
/// the Google Ads API and the token endpoint.
pub const GOOGLE_HOSTS: &[&str] = &["googleads.googleapis.com", "oauth2.googleapis.com"];

/// The one scope of the Google Ads API, for reading and for writing
/// (<https://developers.google.com/google-ads/api/docs/oauth/multi-user-authentication>).
pub const ADS_SCOPE: &str = "https://www.googleapis.com/auth/adwords";

/// The version of the Google Ads API the calls name: `v26` (2026-10-14), the latest on
/// <https://developers.google.com/google-ads/api/docs/sunset-dates>, where it ends in November
/// 2027. Before then the calls are to be compared with the next version's description and this
/// raised.
pub const API_VERSION: &str = "v26";

/// What [`AdCampaignWriter::create_creative`](jt_app::ports::connectors::AdCampaignWriter::create_creative)
/// answers: a search ad has no creative object of its own.
pub const INLINE: &str = "inline";

/// The most accounts of a sign-in whose facts are read and offered.
pub const MAX_ACCOUNTS: usize = 50;

/// The most pages of a search answer read (each up to 10,000 rows, Google's fixed page size).
pub const MAX_PAGES: usize = 20;

/// How much life an access token must have left to be used for a call.
pub const TOKEN_MARGIN: time::Duration = time::Duration::seconds(90);

/// How many times a read is tried in all when no answer arrives (token calls and mutates: once).
pub const READ_ATTEMPTS: u32 = 2;

/// The pause before a read that got no answer is tried again, by default.
pub const DEFAULT_RETRY_DELAY: Duration = Duration::from_millis(300);

/// How long one call may take, connect to end of answer, by default.
pub const ATTEMPT_TIMEOUT: Duration = Duration::from_secs(30);

/// Where the adapter sends its calls and its users: the real hosts by default
/// ([`GoogleBases::production`]). Each is a base URL (scheme, host, port and an optional path
/// prefix) the adapter appends its paths to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GoogleBases {
    /// The Google Ads API, `https://googleads.googleapis.com`.
    pub api: Url,
    /// The token and revoke endpoints, `https://oauth2.googleapis.com`.
    pub oauth: Url,
    /// The authorize dialog, `https://accounts.google.com`: only a URL for the owner's browser,
    /// never fetched.
    pub authorize: Url,
}

impl GoogleBases {
    /// The real hosts.
    pub fn production() -> GoogleBases {
        let url = |text: &str| Url::parse(text).expect("a valid Google base URL");
        GoogleBases {
            api: url("https://googleads.googleapis.com"),
            oauth: url("https://oauth2.googleapis.com"),
            authorize: url("https://accounts.google.com"),
        }
    }
}

/// An access token the adapter got with a refresh token, and when it ends.
#[derive(Clone)]
pub(crate) struct Minted {
    pub(crate) access_token: String,
    pub(crate) expires_at: OffsetDateTime,
}

/// The Google adapter. Cheap to share behind an `Arc`; it holds the egress client, the bases,
/// the platform's app configuration (the Google client, read at call time), the pause before a
/// read is tried again, the time a call may take, and the access tokens it got itself, by the
/// refresh token they came from (in memory only; see the crate docs). It holds no stored
/// credential: each call is given one.
pub struct GoogleConnector {
    egress: Arc<Egress>,
    bases: GoogleBases,
    apps: Arc<dyn PlatformAppConfig>,
    retry_delay: Duration,
    attempt_timeout: Duration,
    minted: Mutex<HashMap<String, Minted>>,
}

impl fmt::Debug for GoogleConnector {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GoogleConnector")
            .field("bases", &self.bases)
            .field("retry_delay", &self.retry_delay)
            .field("attempt_timeout", &self.attempt_timeout)
            .finish_non_exhaustive()
    }
}

impl GoogleConnector {
    /// The adapter over `egress`, sending to `bases`, with the platform's apps `apps`.
    pub fn new(
        egress: Arc<Egress>,
        bases: GoogleBases,
        apps: Arc<dyn PlatformAppConfig>,
    ) -> GoogleConnector {
        GoogleConnector {
            egress,
            bases,
            apps,
            retry_delay: DEFAULT_RETRY_DELAY,
            attempt_timeout: ATTEMPT_TIMEOUT,
            minted: Mutex::new(HashMap::new()),
        }
    }

    /// The adapter pausing `delay` before a read that got no answer is tried again (tests do not
    /// pause).
    pub fn with_retry_delay(mut self, delay: Duration) -> GoogleConnector {
        self.retry_delay = delay;
        self
    }

    /// The adapter giving each call `timeout`, connect to end of answer, instead of
    /// [`ATTEMPT_TIMEOUT`] (tests time out in milliseconds).
    pub fn with_attempt_timeout(mut self, timeout: Duration) -> GoogleConnector {
        self.attempt_timeout = timeout;
        self
    }

    /// Where the adapter sends its calls.
    pub fn bases(&self) -> &GoogleBases {
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
