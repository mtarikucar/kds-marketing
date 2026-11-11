//! The TikTok adapter (spec `docs/superpowers/specs/2026-10-27-tiktok-linkedin-connectors-design.md`
//! §2): a TikTok account, connected with Login Kit (OAuth 2.0 authorization code), its posts
//! through the Content Posting API (one uploaded video, or photos TikTok pulls from URLs), their
//! publishing status, and its public counters. And a TikTok ad account (`tiktok_ads`, design
//! `docs/superpowers/specs/2026-11-11-reklam-platformlari-design.md` §3.3), reached through
//! another API with another app: one-image carousel ads on TikTok itself, built switched off and
//! then enabled (see "Ad campaigns").
//!
//! [`TiktokConnector`] implements the connector ports of `jt_app` ([`Connector`],
//! [`OAuthProvider`], [`Publisher`] with [`Publisher::resolve`] and [`Publisher::creator_info`],
//! [`InsightsReader`], [`AdCampaignWriter`], [`AdBudgetWriter`]); [`webhook`] reads the webhooks TikTok sends (an account's lost access, a
//! post's moves), and a post's status is also polled.
//!
//! **Transport.** The adapter holds no HTTP client: every call is built with
//! [`jt_outbound::Egress::prepare`] and sent under `EgressScope::Connector("tiktok")`, so it can
//! reach only the `tiktok` hosts of the fixed tier ([`TIKTOK_HOSTS`]): the Open API and its token
//! endpoint (`open.tiktokapis.com`, [`TiktokBases::api`]) and the video upload (the host of the
//! `upload_url` a video's init answers with, used as is: `open-upload.tiktokapis.com`, or the
//! regional `open-upload-sg.tiktokapis.com`, which TikTok answered with for a Turkish account; an
//! upload URL on any other host is refused by the egress client, `Permanent`, and nothing is
//! posted). The authorize dialog (`www.tiktok.com`, [`TiktokBases::authorize`]) is only a URL
//! for the owner's browser and is never fetched. Tests point the bases at an in-process mock.
//!
//! **OAuth** (Login Kit for the web, <https://developers.tiktok.com/doc/login-kit-web>, and
//! <https://developers.tiktok.com/doc/oauth-user-access-token-management>):
//!
//! | Step | Call |
//! |---|---|
//! | authorize | `https://www.tiktok.com/v2/auth/authorize/?client_key&response_type=code&scope&redirect_uri&state&disable_auto_auth=1`, the scopes [`TIKTOK_SCOPES`] joined by commas; the authorization page always shown |
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
//! (reconnect). TikTok's refresh token "is valid for 365 days after the initial issuance": a year
//! after the owner connected, the refresh is refused (`invalid_grant`, `Auth`) and the capability
//! asks for a reconnection, as for any lost login.
//!
//! **Revocation** ([`Connector::revoke`], once the capability is retired):
//! `POST {api}/v2/oauth/revoke/`, form `client_key, client_secret, token` (the access token):
//! TikTok then drops the app from the account's authorized apps (the account's whole grant: the
//! use cases revoke only when no other capability holds the account). An access token that
//! has expired is renewed first ([`Connector::refresh`]'s call) and the fresh one revoked. Any
//! 2xx, its empty struct included, is a success; a failure maps as the token endpoint's do.
//! Revoking twice is harmless, so the call is tried once more when no answer arrived.
//!
//! **Calls.** Every call but the token calls and the upload carries the access token as
//! `Authorization: Bearer`; a JSON body is sent as `application/json; charset=UTF-8`.
//!
//! | Operation | Call | Scope |
//! |---|---|---|
//! | the account ([`OAuthProvider::list_assets`]), the probe | `GET {api}/v2/user/info/?fields=open_id,display_name` | `user.info.basic` |
//! | the account's username (best effort, for the asset, the probe and permalinks) | `POST {api}/v2/post/publish/creator_info/query/` → `creator_username` | `video.publish` |
//! | the posting screen ([`Publisher::creator_info`]), and before every post: who may see it, what the creator turned off, the longest video | `POST {api}/v2/post/publish/creator_info/query/` | `video.publish` |
//! | a video | `POST {api}/v2/post/publish/video/init/` → `publish_id`, `upload_url`; then `PUT upload_url` per chunk | `video.publish` |
//! | photos | `POST {api}/v2/post/publish/content/init/` → `publish_id` | `video.publish` |
//! | a video draft | `POST {api}/v2/post/publish/inbox/video/init/` → `publish_id`, `upload_url`; then `PUT upload_url` per chunk | `video.upload` |
//! | a photo draft | `POST {api}/v2/post/publish/content/init/ {post_mode: MEDIA_UPLOAD}` → `publish_id` | `video.upload` |
//! | a post's status ([`Publisher::resolve`]) | `POST {api}/v2/post/publish/status/fetch/ {publish_id}` | `video.publish` or `video.upload` |
//! | a post's counters | `POST {api}/v2/video/query/?fields=id,like_count,comment_count,share_count,view_count {filters: {video_ids: [id]}}` | `video.list` |
//! | the account's counters | `GET {api}/v2/user/info/?fields=follower_count,following_count,likes_count,video_count` | `user.info.stats` |
//! | the account's recent public videos ([`InsightsReader::recent_posts`]) | `POST {api}/v2/video/list/?fields=id,title,video_description,cover_image_url,share_url,create_time,like_count,comment_count,share_count,view_count {max_count}` | `video.list` |
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
//! | `rate_limit_exceeded`, `spam_risk_too_many_posts` (also with HTTP 200), `reached_active_user_cap`, `spam_risk_too_many_pending_share` (a draft's daily cap), HTTP 429 | `Throttle` (TikTok names no wait); on the posting screen's read, an HTTP 2xx with one of [`CANNOT_POST_CODES`] is an account that may not post at this moment, not an error |
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
//! text alone cannot be posted on TikTok, and a video with photos is not one post. Then the
//! choice a human made on the posting screen (`request.tiktok`, see "The posting screen"): none
//! is refused, `Permanent`, and so is a privacy left unchosen or not one of [`PRIVACY_LEVELS`]
//! as TikTok names them; the adapter never picks a privacy itself (`request.privacy` is not
//! read). Then `creator_info` is read, every time, and the choice checked against it
//! (`TiktokPost::check_postable`): a privacy level it does not offer is refused, `Permission`
//! ("privacy level X not available (app not audited or private account)": an app TikTok has not
//! audited is offered `SELF_ONLY` only); branded content that is private, a commercial content
//! disclosure naming neither your brand nor branded content (or one of them without the
//! disclosure), and a video longer than `max_video_post_duration_sec` (its length read from its
//! MP4 boxes, `MediaUpload::video_duration_ms`; one that cannot be read is left to TikTok,
//! `duration_check_failed`) are `Permanent`; nothing else is sent. `disable_comment`,
//! `disable_duet` and `disable_stitch` are off only for what the human allowed and the creator
//! has not turned off since; `brand_organic_toggle` ("Your brand") and `brand_content_toggle`
//! ("Branded content") are the disclosure's boxes; `is_aigc` is not sent.
//!
//! A draft (`TiktokPostMode::Draft`, the upload:
//! <https://developers.tiktok.com/doc/content-posting-api-reference-upload-video>) is sent to the
//! creator's TikTok inbox, where they finish editing and post it in TikTok. Its choice names no
//! privacy and no switch (and a video's no caption): `creator_info` is read and the choice
//! checked as above for a draft (the account may post, the video's length, the caption), and a
//! draft naming more is refused, `Permanent`. A video goes to
//! `POST /v2/post/publish/inbox/video/init/` with its `source_info` alone (the init takes no
//! `post_info`), then its chunks exactly as below; photos go to the photo init with `post_mode:
//! MEDIA_UPLOAD` and, when there is one, the caption as `description` (the privacy, the comment
//! switch and the commercial toggles are the Direct Post's,
//! <https://developers.tiktok.com/doc/content-posting-api-reference-photo-post>).
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
//! **The posting screen** ([`Publisher::creator_info`]). TikTok's Content Sharing Guidelines
//! (<https://developers.tiktok.com/doc/content-sharing-guidelines>) ask that the account be read
//! fresh when the screen is shown, that the human pick the privacy among its
//! `privacy_level_options` (no default), allow comments, duets and stitches themselves (none by
//! default, those the creator turned off greyed out), disclose commercial content, and consent
//! before anything is sent. The screen reads `creator_info` through [`Publisher::creator_info`]:
//! the nickname, username, avatar (https only), privacy options, what the creator turned off and
//! the longest video, and, for an account that may not post at this moment (an HTTP 2xx with one
//! of [`CANNOT_POST_CODES`]), the code in `cannot_post`; any other failure is the error. The
//! screen and the choice it records live in `jt_app` (`usecases::studio::tiktok`).
//!
//! **Status** ([`Publisher::resolve`]). `PUBLISH_COMPLETE` with a public id is
//! [`PublishResolution::Published`]: the receipt of the first `publicaly_available_post_id`
//! (TikTok's own spelling), with the permalink `https://www.tiktok.com/@<username>/video/<id>`
//! when a username is known (the first handle among `public["username"]`,
//! `public["facts"]["username"]` and `public["asset"]["username"]`). TikTok names a public id only
//! once the post is public and its moderation passed it: none ever for a post fewer may see
//! (`SELF_ONLY`, friends, followers), none yet for a public post under review. Without one,
//! `PUBLISH_COMPLETE` is [`PublishResolution::AwaitingPublicId`] with the receipt as sent (the
//! publish id, no URL): posted, and the use cases wait a while for the public id of a post chosen
//! public before they settle it as it is. `FAILED` is [`PublishResolution::Failed`] with
//! "publish failed: <fail_reason>",
//! `Permanent` (`auth_removed`, the creator having removed the app's access: `Auth`).
//! `SEND_TO_USER_INBOX` (a draft: TikTok notified the creator in its inbox to finish the post in
//! TikTok; <https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status>) is
//! settled too: [`PublishResolution::Published`] with the receipt as sent (the publish id, no
//! URL): any post is the creator's to make in TikTok, and there is none to count.
//! `PROCESSING_UPLOAD`, `PROCESSING_DOWNLOAD` (and a status TikTok may add later) are
//! [`PublishResolution::Pending`]. A failed status call is the error.
//!
//! **Counters.** Kept under TikTok's own names, whole numbers only: a post's `like_count`,
//! `comment_count`, `share_count`, `view_count`; the account's `follower_count`,
//! `following_count`, `likes_count`, `video_count`. A post is named by its video id (digits); a
//! receipt that kept its publish id has none to read. The recent videos are one page of the
//! video list (TikTok lists public videos only, newest first, at most [`MAX_LISTED_VIDEOS`]):
//! each its id, title (its description when it has none, cut to 150 characters), cover and
//! page (https URLs only, for the browser: never fetched) and posting time, with the post's
//! counters.
//!
//! **The probe** reads `GET /v2/user/info/` with the credential and names its `open_id` as
//! `facts.account_id` (the credential's own identity, never `public["external_id"]`), with its
//! `display_name` and (best effort) `username`.
//!
//! **Kinds.** TikTok serves `tiktok` (an account that posts) and `tiktok_ads` (an ad account).
//! Posting, its status and the counters are the first's: every such operation refuses a `public`
//! without it in `public["kind_key"]` (`Permanent`, "kind_key missing") and calls nothing.
//! Campaigns are the ad account's: every such operation refuses another kind ("not a TikTok ad
//! account") and a credential that is not an advertiser's.
//!
//! **Ad campaigns** (`tiktok_ads`; design 2026-11-11 §3.3, B69 and B88 to B90). TikTok's ads
//! are reached through its API for Business (`business-api.tiktok.com/open_api/v1.3`), not the
//! Open API of the rest of this crate, and with another app: the platform's TikTok for Business
//! app (`TiktokAdsApp`), which an advertiser authorizes for their ad accounts. Every call below
//! was written from TikTok's API for Business documentation
//! (`https://business-api.tiktok.com/portal/docs?id=...`, read 2026-11-11; the ids are named
//! beside each call). **Nothing here has been run against TikTok**: the tests answer from an
//! in-process mock, and the first real campaign is the owner's, on their own account, with a
//! small budget and their approval at that moment (B38).
//!
//! *The envelope.* Every answer is `{code, message, data, request_id}`, and the code decides
//! whatever the HTTP status says (`1737172488964097`): `0` is a success and its `data` is what a
//! call answers. The token goes in an `Access-Token` header. A `GET` carries its parameters in
//! the query, lists and objects as JSON text. First match wins:
//!
//! | Answer | Error |
//! |---|---|
//! | code `40016`, `40100`, `40132`, `40133` (too many requests, for the app or the ad account); HTTP 429 | `Throttle` |
//! | code `40113`, `40124`, `40125` (the platform's app is blocked or unknown, its developer profile is not approved, the app lacks a permission) | `Permanent` ("platform TikTok for Business app rejected"): no reconnection fixes it |
//! | code `40102`, `40104`, `40105` (the token expired, is empty or invalid), `40110` (an authorization code that is spent or cancelled); HTTP 401 | `Auth`: the owner must authorize again |
//! | code `40001`, `40106`, `40118`, `40119` (no permission, a token that is not this advertiser's, a feature the account is not allowlisted for, another company's advertiser); HTTP 403 | `Permission` |
//! | code `40202`, `50000`, `50002`, `51305`, `60001` (a write conflict, TikTok's own errors, maintenance); HTTP 5xx | `Transient` |
//! | a write answered `40050` (TikTok saw the request twice within ten seconds) or `20001` (it worked in part); a write whose answer was lost, broke off or is unreadable | `Unknown` (never sent again: the next run looks for the object by its name) |
//! | any other code (`40002` a parameter TikTok refuses, `40007` no such object, …) | `Permanent`, with the code and TikTok's own words |
//!
//! *The calls.* An object is always named beside its ad account, which its own id does not
//! carry, so the ids this adapter hands out carry both:
//! `tt:{advertiser}:{campaign|adgroup|ad}:{id}` (B70).
//!
//! | Step | Call |
//! |---|---|
//! | authorize | `{business}/portal/auth?app_id&state&redirect_uri`: the app's "Advertiser authorization URL" with the flow's own state (`1738373141733378`). TikTok comes back with `auth_code` (and another value as `code`): the authorization code is `auth_code` |
//! | exchange | `POST oauth2/access_token/ {app_id, secret, auth_code}` → `access_token`, `scope` (ids), `advertiser_ids` (`1739965703387137`). The token does not expire and has no refresh token; the granted ids are kept as scopes `tiktok_business:<id>`, which is also what tells an advertiser's credential from an account's |
//! | revoke | `POST oauth2/revoke_token/ {app_id, secret, access_token}` (`1739965949088770`) |
//! | the ad accounts ([`OAuthProvider::list_assets`]) | `GET oauth2/advertiser/get/?app_id&secret` (`1738455508553729`; TikTok takes the app's secret in this query: it is kept out of every reason), then `GET advertiser/info/?advertiser_ids=[...]` (`1739593083610113`) → `status`, `currency`, `display_timezone`, `country`; an account is offered when its status is `STATUS_ENABLE` |
//! | finding an object by its name (before each creation, B71) | `GET campaign/get/` and `adgroup/get/` with `filtering={"<x>_name", "primary_status": "STATUS_NOT_DELETE"}`; TikTok matches a name loosely, so the rows are compared exactly, and two of one name are refused. TikTok's list of ads has no filter by name: the ad step reads the ads of its own ad group (`GET ad/get/` with `filtering={"adgroup_ids"}`) and matches the name itself |
//! | the campaign | `POST campaign/create/ {advertiser_id, campaign_name, objective_type: "TRAFFIC", budget_mode: "BUDGET_MODE_TOTAL", budget, operation_status: "DISABLE"}` (`1739318962329602`) |
//! | a country | `GET tool/region/?advertiser_id&placements=["PLACEMENT_TIKTOK"]&objective_type=TRAFFIC&level_range=TO_COUNTRY` (`1737189539571713`): the one `COUNTRY` row whose `region_code` is the plan's code |
//! | the ad group | `POST adgroup/create/ {campaign_id, adgroup_name, promotion_type: "WEBSITE", placement_type: "PLACEMENT_TYPE_NORMAL", placements: ["PLACEMENT_TIKTOK"], location_ids, age_groups (18 and over), gender: "GENDER_UNLIMITED", budget_mode: "BUDGET_MODE_TOTAL", budget, schedule_type: "SCHEDULE_START_END", schedule_start_time, schedule_end_time (UTC), optimization_goal: "CLICK", billing_event: "CPC", bid_type: "BID_TYPE_NO_BID", pacing: "PACING_MODE_SMOOTH", operation_status: "DISABLE"}` (`1739499616346114`) |
//! | the image | `POST file/image/ad/upload/`, multipart: `advertiser_id`, `upload_type=UPLOAD_BY_FILE`, `image_signature` (the image's MD5), `file_name`, `image_file` (`1739067433456642`) → `image_id`; after a refused duplicate name (`40911`), `GET file/image/ad/search/` (`1740052016789506`), whose rows carry each image's `signature` |
//! | the ad's speaker | `GET identity/get/` (`1740218420781057`): the one `TT_USER` or `BC_AUTH_TT` identity that is available and may be advertised with |
//! | the ad's music | `GET file/image/ad/info/` (the image must be usable in a carousel), then `GET file/music/get/?music_scene=CAROUSEL_ADS&search_type=...` (`1740053909509122`): `SEARCH_BY_LIKED`, else `SEARCH_BY_HISTORY`, else `SEARCH_BY_KEYWORD` with `filtering={"keyword"}`; the first piece of the first search that answers one |
//! | the ad | `POST ad/create/ {advertiser_id, adgroup_id, creatives: [{ad_name, ad_format: "CAROUSEL_ADS", ad_text, call_to_action, image_ids, music_id, identity_type, identity_id, landing_page_url, operation_status: "DISABLE"}]}` (`1739953377508354`, `1766217791987713`) |
//! | switching on and off | `POST campaign/status/update/`, `adgroup/status/update/`, `ad/status/update/` `{advertiser_id, <x>_ids: [id], operation_status: "ENABLE" or "DISABLE"}` |
//! | the state | `GET campaign/get/` and `GET ad/get/` filtered by the campaign → `operation_status`, `secondary_status`; for an ad TikTok turned down, `GET ad/review_info/` → `reject_info[].reasons`, `suggestion` (`1740559669226498`) |
//! | the days | `GET report/integrated/get/?service_type=AUCTION&report_type=BASIC&data_level=AUCTION_AD&dimensions=["ad_id","stat_time_day"]&metrics=["spend","impressions","clicks"]&start_date&end_date&filtering=[{campaign_ids IN}]` (`1740302848100353`), thirty days at a time (TikTok's limit for a report by day) |
//!
//! The choices made here, each with its reason:
//!
//! - **A carousel of one image.** TikTok's own placement takes no single image ad; an image
//!   goes there as a carousel, which takes one to 35 images and requires a piece of music (B69).
//! - **The music.** TikTok recommends music for a carousel only from two images on, and an ad
//!   here shows one. So the piece is the first the advertiser marked as liked in TikTok's own
//!   tools (which makes the music theirs to choose, there), else the first the ad account used
//!   before, else the first TikTok finds for the keyword `background`; with none of the three
//!   the ad is refused. No agent chooses it.
//! - **The speaker.** TikTok no longer takes a name and an avatar as an ad's identity on its
//!   own placement: an ad speaks as a real TikTok account linked to the ad account. The adapter
//!   uses the one linked account that is available; with none, or with several, the ad is
//!   refused (it is never put under a guessed account), and a plan names no account (B88).
//! - **The budget.** The campaign's whole budget is the campaign's lifetime budget
//!   (`BUDGET_MODE_TOTAL`) and, once more, the ad group's, with a start and an end. TikTok's
//!   least budgets are known ahead: 20 US dollars a day for an ad group (times the scheduled
//!   days for a lifetime budget) and 50 for a campaign, each times the currency's "budget
//!   verification ratio" (`budgets.rs`, generated from TikTok's table). For a campaign, TikTok's
//!   budget page says 20 US dollars for a daily or a lifetime budget and its value-range table
//!   50 for a daily one: the stricter is kept. They are the account's limits, so a budget that
//!   is too small is a finding of the plan (B89).
//! - **No `request_id`.** TikTok describes `request_id` as what lets two campaigns carry one
//!   name; none is sent. Whether TikTok then refuses a second campaign of the same name is not
//!   said on its page: what keeps a build from making two is the search by name before it.
//! - **The audience** is the plan's countries, everyone of 18 and over, on TikTok itself
//!   (`PLACEMENT_TIKTOK`): the age groups are named explicitly, since TikTok refuses ads that may
//!   reach 13 to 17 in many markets. A country TikTok does not offer the ad account is refused.
//!   TikTok also shows such an ad in its own search results unless told otherwise
//!   (`search_result_enabled` is left to its default).
//! - **The image** must be a JPG or a PNG, told by its first bytes. Its file name carries its
//!   MD5: TikTok refuses a second file of one name in an ad account (`40911`), and the image of
//!   an upload whose answer was lost is then found by that digest.
//! - **The text** is at most 100 characters and carries no emoji (TikTok's rule; the plan is
//!   held to it before anything is sent). TikTok counts a Chinese or Japanese character twice:
//!   the adapter counts the same way before it sends.
//! - **States.** An ad TikTok's review turned down is `Disapproved` whatever its switch says,
//!   with the review's reasons as feedback; one switched off is paused; one under review is in
//!   review; one delivering, or waiting for its start, runs. Any other state (a budget reached,
//!   a balance that ran out, a missing authorization) is passed on by its name.
//! - **Numbers.** A day's `spend` (decimal text in the account's currency) becomes minor units,
//!   rounded to the nearest; its result is its clicks. Days are the ad account's own
//!   (`display_timezone`).
//! - **AI-made images.** TikTok's switch that labels an ad as AI-generated exists only for an
//!   ad with a custom identity, which its own placement no longer takes: an ad that speaks as a
//!   linked account cannot carry the label through the API (TikTok may add its own).
//!
//! What only a first real run can tell: the authorization page's address (TikTok shows it in
//! its portal and prints its form on no page; the form used here is the one that page has);
//! whether TikTok still creates a traffic campaign through `campaign/create/` after 2026-12-31
//! (its page on the upgraded Smart+ campaigns says "After December 31, 2026, you will no longer
//! have the ability to create Manual Campaigns using the /campaign/create/ endpoint", and those
//! campaigns take no traffic objective: design A6); whether the liked and the history lists of
//! music are empty for a new ad account, and what the keyword search answers;
//! whether a token sees a TikTok account another person linked to the ad account (A9); whether
//! an ad may be created switched off under a campaign and an ad group that are switched off;
//! whether the report names `spend` as text or as a number; and the least budgets TikTok
//! really enforces where its two pages disagree.
//!
//! **Webhooks** ([`webhook`]): the body of a delivery, once the gate checked its signature, read
//! into the event the use cases store and its effect; the crate sends nothing for them.
//!
//! **Not covered** (spec §4): direct messages and comments (no public API for Login Kit apps);
//! of ads, video ads, lead forms and TikTok's Smart+ campaigns.
//!
//! [`Connector`]: jt_app::ports::connectors::Connector
//! [`Connector::refresh`]: jt_app::ports::connectors::Connector::refresh
//! [`Connector::revoke`]: jt_app::ports::connectors::Connector::revoke
//! [`OAuthProvider`]: jt_app::ports::connectors::OAuthProvider
//! [`OAuthProvider::authorize_url`]: jt_app::ports::connectors::OAuthProvider::authorize_url
//! [`OAuthProvider::exchange`]: jt_app::ports::connectors::OAuthProvider::exchange
//! [`OAuthProvider::list_assets`]: jt_app::ports::connectors::OAuthProvider::list_assets
//! [`Publisher`]: jt_app::ports::connectors::Publisher
//! [`Publisher::resolve`]: jt_app::ports::connectors::Publisher::resolve
//! [`Publisher::creator_info`]: jt_app::ports::connectors::Publisher::creator_info
//! [`PublishResolution::Published`]: jt_app::ports::connectors::PublishResolution::Published
//! [`PublishResolution::AwaitingPublicId`]: jt_app::ports::connectors::PublishResolution::AwaitingPublicId
//! [`PublishResolution::Failed`]: jt_app::ports::connectors::PublishResolution::Failed
//! [`PublishResolution::Pending`]: jt_app::ports::connectors::PublishResolution::Pending
//! [`InsightsReader`]: jt_app::ports::connectors::InsightsReader
//! [`AdCampaignWriter`]: jt_app::ports::connectors::AdCampaignWriter
//! [`AdBudgetWriter`]: jt_app::ports::connectors::AdBudgetWriter
//! [`InsightsReader::recent_posts`]: jt_app::ports::connectors::InsightsReader::recent_posts
//! [`ConnectorError`]: jt_connector::ConnectorError
//! [`Credential::OAuth`]: jt_connector::Credential::OAuth

mod account;
mod ads;
mod budgets;
mod business;
mod client;
mod credential;
mod insights;
mod oauth;
mod ports;
mod publish;
pub mod webhook;

use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use jt_app::ports::connectors::PlatformAppConfig;
use jt_outbound::Egress;
use url::Url;

/// The hosts the adapter reaches, exactly the `tiktok` entries of `jt_outbound::FIXED_HOSTS`: the
/// Open API (with its token endpoint), the video upload, and the API for Business (ad accounts).
pub const TIKTOK_HOSTS: &[&str] = &[
    "open.tiktokapis.com",
    "open-upload.tiktokapis.com",
    "open-upload-sg.tiktokapis.com",
    "business-api.tiktok.com",
];

/// The scopes the authorize URL asks for (<https://developers.tiktok.com/doc/tiktok-api-scopes>):
/// the account's basic profile, posting directly, sending drafts to the creator's inbox
/// (`video.upload`), reading its videos (their counters) and its counters. A credential granted
/// before drafts existed lacks `video.upload`: it still posts directly.
pub const TIKTOK_SCOPES: &[&str] = &[
    "user.info.basic",
    "video.publish",
    "video.upload",
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

/// The `error.code`s `creator_info` answers with HTTP 200 for an account that may not post at
/// this moment (its daily post cap, a posting ban, the client's daily publishing users;
/// <https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info>): the
/// posting screen shows them and stops, rather than failing.
pub const CANNOT_POST_CODES: &[&str] = &[
    "spam_risk_too_many_posts",
    "spam_risk_user_banned_from_posting",
    "reached_active_user_cap",
];

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

/// The most videos one page of the video list holds (TikTok's `max_count` maximum).
pub const MAX_LISTED_VIDEOS: u32 = 20;

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
    /// The API for Business, `https://business-api.tiktok.com`: the calls an ad account is
    /// reached with, and the page an advertiser authorizes the platform's app on (that page is
    /// only a URL for the owner's browser).
    pub business: Url,
}

impl TiktokBases {
    /// The real hosts.
    pub fn production() -> TiktokBases {
        let url = |text: &str| Url::parse(text).expect("a valid TikTok base URL");
        TiktokBases {
            api: url("https://open.tiktokapis.com"),
            authorize: url("https://www.tiktok.com"),
            business: url("https://business-api.tiktok.com"),
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
