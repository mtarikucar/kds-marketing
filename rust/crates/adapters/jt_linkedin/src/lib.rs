//! The LinkedIn adapter (spec `docs/superpowers/specs/2026-10-27-tiktok-linkedin-connectors-design.md`
//! §3): a LinkedIn member's own feed (`linkedin_member`) and the organization pages the member
//! administers (`linkedin_page`), connected with OAuth 2.0; their posts (text, a link, images or
//! one video) and the organizations' counters. And the ad accounts the member manages campaigns
//! in (`linkedin_ads`, design `docs/superpowers/specs/2026-11-11-reklam-platformlari-design.md`
//! §3.2): single-image sponsored content, built paused and then activated (see "Ad campaigns").
//!
//! [`LinkedinConnector`] implements the connector ports of `jt_app` ([`Connector`],
//! [`OAuthProvider`], [`Publisher`], [`InsightsReader`], [`AdCampaignWriter`],
//! [`AdBudgetWriter`]). LinkedIn sends no webhooks here, and it publishes synchronously:
//! [`Publisher::resolve`] keeps its default (the receipt is the post).
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
//! | authorize | `{authorize}/oauth/v2/authorization?response_type=code&client_id&redirect_uri&state&scope`, the scopes joined by spaces (`%20`): [`MEMBER_SCOPES`], [`ORGANIZATION_SCOPES`] too when the flow's app sets `organization_scopes` and [`AD_SCOPES`] when it sets `ad_scopes` (the operator sets each once LinkedIn approved its product for the app), each scope once |
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
//! **Ad campaigns** (`linkedin_ads`; design 2026-11-11 §3.2 and decisions B85 to B87). Every
//! call below was written from LinkedIn's Marketing API pages of version `202610`
//! (`learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/...`: `account-structure/
//! create-and-manage-account-users`, `create-and-manage-accounts`,
//! `create-and-manage-campaign-groups`, `create-and-manage-campaigns`,
//! `create-and-manage-creatives`, `advertising-targeting/ads-targeting`, and
//! `ads-reporting/ads-reporting`), read 2026-11-11. **Nothing here has been run against
//! LinkedIn**: the tests answer from an in-process mock, and the first real campaign is the
//! owner's, on their own account, with a small budget and their approval at that moment (B38).
//!
//! A LinkedIn campaign is three levels, and the build's steps sit on them as follows. An object
//! is reached under its ad account, which its own URN does not name, so the ids this adapter
//! hands out carry both: `li:{account}:{group|campaign|creative}:{number}` (B70); an id of
//! another shape, or of another account than the capability's, is refused before any call.
//!
//! | Step | Call |
//! |---|---|
//! | the ad accounts of a sign-in ([`OAuthProvider::list_assets`] with `rw_ads` granted) | `GET {api}/rest/adAccountUsers?q=authenticatedUser` (and `&start=N` while the answer's `paging.total` names more) → each element's `account` and `role`; an account is offered when the role is `CAMPAIGN_MANAGER`, `ACCOUNT_MANAGER` or `ACCOUNT_BILLING_ADMIN`, it is `ACTIVE`, and it advertises for a company page; at most [`MAX_AD_ACCOUNTS`] |
//! | an ad account (the probe, the limits, and before each write that needs its currency or its page) | `GET {api}/rest/adAccounts/{id}` → `currency`, `status`, `reference` (`urn:li:organization:N`), `test` |
//! | finding an object by its name (before each creation, B71) | `GET .../adCampaignGroups` and `.../adCampaigns` with `q=search&search=(name:(values:List({name})),status:(values:List(ACTIVE,DRAFT,PAUSED)))`, paged by `metadata.nextPageToken` to at most [`MAX_AD_PAGES`] pages; two objects of one name are refused |
//! | the campaign (`create_campaign`) | a campaign group: `POST .../adAccounts/{id}/adCampaignGroups {account, name, runSchedule: {start, end}, status: "ACTIVE", totalBudget: {amount, currencyCode}}` → its number in `x-restli-id` |
//! | a country | `GET {api}/rest/adTargetingEntities?q=typeahead&queryVersion=QUERY_USES_URNS&facet=urn%3Ali%3AadTargetingFacet%3Alocations&query={name}&locale=(language:en,country:US)`: the one element whose `name` is the country's own, from LinkedIn's country table |
//! | the level under it (`create_adset`) | a campaign: `POST .../adCampaigns {account, campaignGroup, name, type: "SPONSORED_UPDATES", format: "STANDARD_UPDATE", objectiveType: "WEBSITE_VISIT", optimizationTargetType: "MAX_CLICK", costType: "CPM", unitCost: {amount: "0"}, locale, offsiteDeliveryEnabled: false, audienceExpansionEnabled: false, creativeSelection: "OPTIMIZED", associatedEntity, politicalIntent: "NOT_POLITICAL", pacingStrategy: "LIFETIME", totalBudget, runSchedule, targetingCriteria: {include: {and: [{or: {"urn:li:adTargetingFacet:interfaceLocales": [locale]}}, {or: {"urn:li:adTargetingFacet:locations": [...]}}]}}, status: "PAUSED"}` |
//! | the image (`upload_image`) | as a post's image, owned by the account's company page |
//! | the creative (`create_creative`) | no call: the ad's parts are checked and `"inline"` is answered |
//! | the ad (`create_ad`) | `GET .../creatives?q=criteria&campaigns=List({campaign urn})&sortOrder=ASCENDING` with `X-RestLi-Method: FINDER` (a creative that carries the ad's name is adopted), else `POST .../creatives?action=createInline {creative: {inlineContent: {post}, campaign, intendedStatus: "DRAFT", name}}`: the post and the creative in one call |
//! | switching on and off ([`AdBudgetWriter::set_status`]) | `POST` the object with `X-RestLi-Method: PARTIAL_UPDATE` and `{patch: {$set: {status}}}` (a group, a campaign) or `{patch: {$set: {intendedStatus}}}` (a creative, its URN percent-encoded in the path) |
//! | the state (`campaign_state`) | `GET .../adCampaignGroups/{id}` → `status`; the group's campaigns (`q=search&search=(campaignGroup:(values:List({group urn})),status:...)`); each campaign's creatives (the finder above) → `intendedStatus`, `review.status`, `review.rejectionReasons` |
//! | the days (`ad_days`) | `GET {api}/rest/adAnalytics?q=analytics&pivot=CREATIVE&timeGranularity=DAILY&dateRange=(start:(year,month,day),end:(...))&campaigns=List(...)&fields=dateRange,pivotValues,impressions,clicks,landingPageClicks,costInLocalCurrency` |
//!
//! The choices made here, each with its reason:
//!
//! - **The page.** An ad is the company page's post. The page is the organization the ad
//!   account advertises for (its `reference`): the image's owner, the post's `author` and the
//!   campaign's `associatedEntity` are all that one organization, read from LinkedIn at each
//!   step and never taken from a plan (B85). An account that advertises for a member is not
//!   offered and fails its probe ("the LinkedIn ad account advertises for no company page").
//! - **The budget.** The campaign's whole budget is the group's `totalBudget` and, once more,
//!   the campaign's own with `pacingStrategy: "LIFETIME"`: LinkedIn says of it "you spend no more
//!   than the full budget for the lifetime of the campaign". A daily budget is never set (LinkedIn
//!   may spend more than a daily budget on a day). Amounts go out as decimal text in the account's
//!   currency. LinkedIn names its least lifetime budget, which follows the length of the run, only
//!   when it refuses one: the limits answer no minimum, and a budget that is too small ends the
//!   build at the campaign step with LinkedIn's own words, nothing spent (B86).
//! - **Paused first.** The group is created `ACTIVE` (LinkedIn creates a group active or as a
//!   draft), the campaign `PAUSED` and each creative as a `DRAFT`: nothing is served. The build
//!   then activates the creatives (LinkedIn's review of a creative starts when it leaves the
//!   draft state), the campaign and the group, in that order.
//! - **The run.** `runSchedule` is in milliseconds since the epoch; a start that is now is put
//!   five minutes ahead (LinkedIn refuses a start in the past).
//! - **The audience** is the plan's countries and nothing else (B87). LinkedIn takes a country
//!   only as its own `urn:li:geo` entity, which it serves by name, not by code: the country's
//!   English name comes from LinkedIn's country code table (`countries.rs`), and the typeahead
//!   answer is taken only when exactly one element carries exactly that name; anything else is
//!   refused, never guessed. The campaign's `locale` is the listed locale of the first country,
//!   else `en_US`; the audience names it too (`interfaceLocales`, the language of the members'
//!   LinkedIn interface), as LinkedIn's website-visit sample and Campaign Manager's "profile
//!   language" do: members who use LinkedIn in another language are not shown the ads.
//!   `politicalIntent` is always `NOT_POLITICAL` (B79: no political advertising, and no country
//!   of the European Union is targeted).
//! - **The ad.** Single-image sponsored content leading to a website: the post is the page's,
//!   shown to nobody but through the ad (`feedDistribution: "NONE"`, `adContext.dscAdAccount`),
//!   its text in LinkedIn's little text format, the headline as the image's `title`, the address
//!   as `contentLandingPage` and the button as `contentCallToActionLabel` (`LEARN_MORE`,
//!   `SIGN_UP`, `SHOP_NOW`, `VIEW_QUOTE`, `SUBSCRIBE`, `APPLY`, `DOWNLOAD`). The image must be a
//!   JPG, a PNG or a GIF, told by its first bytes. The creative carries the build's own name, by
//!   which a creative made before a lost answer is found again.
//! - **States.** A creative LinkedIn rejected is `Disapproved` whatever its switch says, with
//!   its `rejectionReasons` as feedback; an active creative whose review is not `APPROVED` is in
//!   review; a draft or a paused one is paused. LinkedIn refuses to pause a creative in review
//!   (400): the refusal is passed on, and the use cases pause the ad again once it runs (B77).
//! - **Numbers.** A day's `costInLocalCurrency` (decimal text in the account's currency) becomes
//!   minor units, rounded to the nearest; its result is `landingPageClicks`. A number LinkedIn
//!   leaves out is absent, never zero. LinkedIn counts days in UTC.
//!
//! What only a first real run can tell: whether a campaign may be created `PAUSED`; whether
//! the inline post takes the `distribution` the Posts API requires of a post (LinkedIn's two
//! inline samples leave it out) and the inline creative a `DRAFT` status (its samples create it
//! active); whether the creatives finder answers each creative's `name` (its sample row does not
//! show one: without it a creative made before a lost answer is not found, and a second one is
//! made, still under the campaign's one budget); whether the member's ad account role is enough
//! to upload the page's image (LinkedIn: "the caller must have ADMIN or DSC permissions for the
//! company page"; a 403 there ends the build with LinkedIn's words); whether a
//! created group's number comes back in `x-restli-id` as a campaign's and a creative's do (the
//! group page does not say; without it the creation is `Unknown` and the next run finds the group
//! by its name); whether a paused group goes back to `ACTIVE` (the page names only the way from
//! active to paused); whether `objectiveType` is `WEBSITE_VISIT` (LinkedIn's samples) rather than
//! `WEBSITE_VISITS` (one of its schema tables); whether the typeahead names each country exactly
//! as the country table does; the least lifetime budget in each currency; and whether a test ad
//! account behaves as documented (its creatives are rejected by themselves and it reports no
//! numbers).
//!
//! **The probe** names, as `facts.account_id`, the identity the credential itself reaches, never
//! an id taken from `public`:
//!
//! | Kind | Call | `account_id` |
//! |---|---|---|
//! | `linkedin_member` | `GET /v2/userinfo` | its `sub`: the member the token authenticates as |
//! | `linkedin_page` | the credential's `organizationAcls` (`ADMINISTRATOR`, `APPROVED`) | the organization number of the ACL element naming `public["external_id"]`: a node LinkedIn serves only to the member's own token, and only for organizations the member administers; none → `Permission` ("the credential administers no such organization") |
//! | `linkedin_ads` | `GET /rest/adAccounts/{id}` | the ad account LinkedIn answers for, which must be the one asked for, `ACTIVE` and advertising for a company page; with `currency`, `organization_id` and `test_account` |
//!
//! with `name` (the member's name; the page's `localizedName`, best effort). The organization
//! lookup is never the identity: LinkedIn answers it for organizations a member does not
//! administer too.
//!
//! **Kinds.** LinkedIn serves `linkedin_member`, `linkedin_page` and `linkedin_ads`. Posting and
//! counters are the first two's: every such operation refuses a `public` without either in
//! `public["kind_key"]` (`Permanent`, "kind_key missing") and calls nothing. Campaigns are the
//! ad account's: every such operation refuses another kind ("not a LinkedIn ad account").
//!
//! [`Connector`]: jt_app::ports::connectors::Connector
//! [`Connector::refresh`]: jt_app::ports::connectors::Connector::refresh
//! [`OAuthProvider`]: jt_app::ports::connectors::OAuthProvider
//! [`OAuthProvider::list_assets`]: jt_app::ports::connectors::OAuthProvider::list_assets
//! [`Publisher`]: jt_app::ports::connectors::Publisher
//! [`Publisher::resolve`]: jt_app::ports::connectors::Publisher::resolve
//! [`InsightsReader`]: jt_app::ports::connectors::InsightsReader
//! [`AdCampaignWriter`]: jt_app::ports::connectors::AdCampaignWriter
//! [`AdBudgetWriter`]: jt_app::ports::connectors::AdBudgetWriter
//! [`AdBudgetWriter::set_status`]: jt_app::ports::connectors::AdBudgetWriter::set_status
//! [`ConnectorError`]: jt_connector::ConnectorError
//! [`Credential::OAuth`]: jt_connector::Credential::OAuth

mod account;
mod ads;
mod client;
mod countries;
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

/// The scopes a flow whose app sets `ad_scopes` asks for too (the Advertising API): managing and
/// reading the member's ad accounts (`rw_ads`, `r_ads`), their numbers (`r_ads_reporting`), and
/// posting as the company page an ad speaks as (`w_organization_social`,
/// `r_organization_social`: an ad's image and its post are the page's)
/// (<https://learn.microsoft.com/en-us/linkedin/marketing/increasing-access>). As with
/// [`ORGANIZATION_SCOPES`], only an app LinkedIn approved for them may ask.
pub const AD_SCOPES: &[&str] = &[
    "rw_ads",
    "r_ads",
    "r_ads_reporting",
    "w_organization_social",
    "r_organization_social",
];

/// The most ad accounts of a sign-in offered for connection.
pub const MAX_AD_ACCOUNTS: usize = 50;

/// The most pages of one list of an ad account read (its campaign groups, campaigns or
/// creatives by a search).
pub const MAX_AD_PAGES: usize = 20;

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
