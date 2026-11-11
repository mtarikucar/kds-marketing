# Step 4: ad campaigns on Google, LinkedIn, TikTok and X — implementation plan

**Goal:** an ad campaign runs on the platform of its ad account: Meta (built), then Google Search,
LinkedIn, TikTok and X, each with the platform's own total budget as the limit.

**Architecture:** the campaign use cases (`jt_app::usecases::ads`) stay as they are and learn the
platform from the ad account's capability kind. What a plan must look like on a platform is one
table in the core (`ads/platform.rs`); what the platform's API needs is its adapter's business
behind the unchanged `AdCampaignWriter` / `AdBudgetWriter` ports, whose spec structs grow the
fields the other platforms need. Each platform ships on its own: rules + adapter + connect + panel.

**Spec:** `docs/superpowers/specs/2026-11-11-reklam-platformlari-design.md` (B61–B75). Research
reports and doc copies of the session that wrote it are not in the repo; every call an adapter makes
is written in its crate docs with the page it was read from.

## Global constraints

- Nothing here has run against a real platform: README and crate docs say so; the first real
  campaign on each platform is the owner's, on their own account, small budget, explicit approval
  at that moment (B38).
- Creation is paused first, activation last (B11). Every object is named `jeeta:<campaign>:<part>`
  and looked up by that name before it is created (B71).
- The campaign budget is the platform's own total budget (B32). X documents no hard cap (B67).
- No `cargo fmt --all` (use `rustfmt --edition 2024 <files>`); `jobs = 8`; one heavy cargo job at a
  time; i18n keys line by line; commits carry no AI attribution; only own files by explicit path.
- Migrations: the campaign needs none (it is one JSON record; new fields are `serde(default)`).
  A provider that signs in through OAuth needs one: `oauth_pending` checks its `provider` and
  `app` against a closed list (task 2 found this with a real database: `0041_google_provider`).
  Every migration is a reversible pair whose round trip is tested.

## Review focus

1. A stored Meta campaign (plan and build written before this step) still reads, builds on and is
   watched: every new field is `serde(default)`, `page` is still read from the same key.
2. A plan carrying a field its platform does not take is refused naming the field, never built with
   the field silently dropped.
3. A Google build cut off between any two calls goes on without a second budget, campaign, ad group,
   keyword set or ad.
4. A held ad the provider still reports as running is paused again by the watch.
5. A platform whose adapter is not configured (no app credentials) refuses a plan with
   `account_unreadable`, and nothing panics on a kind without a writer.

---

## Task 1 — core: platform rules, plan and build by platform (with Google's plan shape)

**Files**
- Create `rust/crates/jt_app/src/usecases/ads/platform.rs`: `AdsPlatform { Meta, Google }` (later
  `Linkedin`, `Tiktok`, `X`), `PlatformRules` (serializable, static), `of_kind`, `rules`.
- Modify `ports/connectors.rs`: `AdAccountLimits.min_total_budget_minor` (default 0);
  `CampaignSpec { +start_at, +end_at }`; `AdSetSpec { +budget_minor, +keywords }`;
  `CreativeSpec { page_id → identity_id: Option<String>, image_hash → image: Option<String>,
  +headlines, +descriptions, call_to_action: Option<CallToAction> }`; `AdSpec { +creative }`.
- Modify `ports/ads.rs`: `PlanAd` (texts, `call_to_action`, `page`, `material_ids` optional;
  `+headlines`, `+descriptions`); `CampaignPlan.keywords`; `PlanAudience` ages default 18/65;
  `Built.platform` (default Meta).
- Modify `ads/plan.rs` (shape by rules, findings by rules, schema), `ads/build.rs` (specs, image
  step only where the platform takes one), `ads/watch.rs` (interval by platform, held ads paused
  again, preview only where the platform has one), `ads/mod.rs` (account of any ad platform;
  `CampaignDetail.platforms`; a fixed end checked against the chosen account's platform at open).
- Modify `jt_connector::provider`: `Provider::Google` serving `google_ads`; every exhaustive match
  (`bin/jeeta/src/connectors.rs`, `jt_app` connector use case and ports, testkit, MCP).
- Modify `jt_meta/src/campaigns.rs` for the renamed spec fields; `jt_testkit` fakes (ad campaigns
  offered for Google too); MCP `tools/ads.rs` descriptions; `work.rs` agent brief.
- Panel: `api/ads.ts`, `pages/ads/{OpenCampaignDialog,CampaignPage,CampaignShared}.tsx`,
  `components/ModuleStatusLine.tsx`, `lib/connectors.ts`, `lib/capabilityGoals.ts`, i18n.
- Tests: `jt_app/tests/ads_campaigns.rs` (Google plan: accepted, each foreign field refused, 2-day
  run refused, build order and specs, no image step), `jt_app/tests/ads_platform.rs` (rules table),
  `jt_meta/tests/ad_campaigns.rs`, `jt_testkit/tests/ad_campaign_fakes.rs`, panel tests.

**Rules of a plan (B63–B66)**

| | Meta | Google |
|---|---|---|
| `page` | a live `facebook_page` | not taken |
| `instagram` | optional | not taken |
| `material_ids` | exactly one image | not taken |
| `primary_text` / `headline` / `description` | 1000 / 100 / 100 (optional) | not taken |
| `call_to_action` | the nine listed | not taken |
| `headlines` / `descriptions` | not taken | 3–15 × ≤30 chars / 2–4 × ≤90 chars |
| `keywords` (plan) | not taken | 1–20, each ≤80 chars and ≤10 words |
| audience | all fields | countries only (ages 18–65, no genders) |
| placements | automatic or platforms | automatic only |
| result | link click, lead form | link click |
| run | 24 h – 90 d | 72 h – 90 d |

A field the platform does not take, a missing one, a text too long: `VALIDATION` naming the field
(`field_not_for_this_platform`, `required_on_this_platform`, `1_to_N_characters`); counts for
nothing. A run the platform does not take (`duration_not_supported`, with `least_hours` and
`most_days`) and a budget under the platform's minimum (`below_the_accounts_minimum`, `least`) are
findings of a refused plan.

**Steps**
- [x] 1.1 Ports and platform table; Meta adapter and fakes follow the renamed fields; workspace builds.
- [x] 1.2 `plan.rs` by rules + schema; tests for the Google shape and the Meta shape unchanged.
- [x] 1.3 `build.rs`, `watch.rs`, `mod.rs`; tests for the Google build order and the held-ad pause.
- [x] 1.4 MCP descriptions, agent brief, panel, i18n; panel tests.
- [x] 1.5 `make check`, README, design/plan log, commit, push.

## Task 2 — Google Ads adapter (`jt_google`)

New crate `rust/crates/adapters/jt_google` (model: `jt_linkedin`): OAuth (authorization code,
offline, scope `https://www.googleapis.com/auth/adwords`), refresh, `ListAccessibleCustomers` →
assets with currency, time zone and status, probe, `AdCampaignWriter` + `AdBudgetWriter::set_status`,
`campaign_state` (`ad_group_ad.policy_summary`), `ad_days` (GAQL by ad and day). Wiring:
`GoogleApp` in `PlatformAppConfig` (env `JEETA_GOOGLE_CLIENT_ID`, `JEETA_GOOGLE_CLIENT_SECRET`,
`JEETA_GOOGLE_ADS_DEVELOPER_TOKEN` when the API still asks for one), `OAuthCallback::Google`,
`FIXED_HOSTS`, registry, connect use case, panel connect card, deployment env docs.

- [x] 2.1 Crate, client, error table, OAuth + refresh, assets, probe; tests against an in-process mock.
- [x] 2.2 Writer: budget → campaign → ad group (+ country, keywords) → ad; idempotent by name; status.
- [x] 2.3 Reads: state and daily numbers; tests.
- [x] 2.4 Wiring, panel, README; `make check`; commit, push (`e892fb18`). Staging release: when the owner agrees.

## Task 3 — LinkedIn ads (in `jt_linkedin`)

Rules row, `linkedin_ads` kind served by LinkedIn, ad scopes on the LinkedIn app
(`JEETA_LINKEDIN_AD_SCOPES`), ad accounts as assets (`adAccountUsers?q=authenticatedUser`), writer:
campaign group → campaign (`totalBudget`, `LIFETIME`) → image → dark post → creative → activation;
state from `review.status`; days from `adAnalytics`.

- [x] 3.1 Rules row, kind, ad scopes flag, ad accounts as assets, probe; writer, switches, reads;
  tests against the in-process mock; wiring, panel, README; commit, push (`2e9fb655`).

## Task 4 — TikTok ads (in `jt_tiktok`, TikTok for Business app)

Rules row (identity of the ad account, music chosen by Jeeta), `OAuthCallback::TiktokAds`, advertiser
accounts as assets, writer: campaign → ad group → image → music → carousel ad; status endpoints;
`/ad/review_info/`; `/report/integrated/get/`. Minimum budgets from the documented table.

- [x] 4.1 Second OAuth app (`TiktokAdsApp`, `OAuthCallback::TiktokAds`, migration `0042`), API for
  Business client, ad accounts as assets, probe, limits; writer, switches, reads; tests against the
  in-process mock; rules row, panel (`auth_code`), README.

## Task 5 — X ads (in `jt_x`)

`x_ads` kind, rules row (15-minute watch, no hard cap said on the panel and in the tool), ad scopes
on the X app, ad accounts as assets, writer: campaign → line item (+ targeting) → media → card →
promoted-only post → promoted post; pausing an ad deletes the promoted post, resuming makes it
again (B73).

- [x] 5.1 `x_ads` kind, ad scopes flag (`JEETA_X_AD_SCOPES`), ads accounts as assets, probe, limits;
  writer, switches, reads; tests against the in-process mock; rules row, the "no hard limit" notice
  on the panel and in the tool texts, README.

---

## Execution log

(what differs from the plan, added as each task ends)

### Task 1 (2026-11-11)

Done as planned, with these differences and additions:

- `AdsPlatform` lives in `ports/ads.rs` (the campaign record carries it as `built.platform`); the
  rules table is `usecases/ads/platform.rs`.
- No separate `ads_platform.rs` test file: the three new tests are in `jt_app/tests/ads_campaigns.rs`
  (`a_plan_carries_only_what_its_platform_takes`,
  `a_search_campaign_is_planned_built_without_an_image_and_watched`,
  `an_end_the_chosen_accounts_platform_does_not_take_is_refused_at_opening`).
- A plan that names something that is no ad account at all has no platform: only what every
  platform shares is looked at and the account is the one finding (as before).
- `placements` is `automatic` when left out; `age_min` / `age_max` are 18 / 65 when left out.
- Text-only ads get the truth check without a material (`materials::check_texts`, design B78).
- The platform's run length is measured from when the campaign would really start
  (`start_at.max(now)`), which also catches a Meta campaign planned late (it used to fail at the
  build).
- Google's text limits were read again from Google's own pages before they went into the table
  (headline 30, description 90: support.google.com/google-ads/answer/7684791; keyword 80 characters
  and 10 words: the API reference of `KeywordInfo`).
- Builder's calls added to the design: B76 (phrase match), B77 (held ads paused again, replacing
  the refusal of B73), B78 (truth check of text-only ads), B79 (no EU targeting on any platform).

### Task 2 (2026-11-11)

`jt_google` is built as planned (crate docs hold every call). What differs from the plan and what
was decided on the way:

- **No developer token.** Google gives API access per Google Cloud project now; the only settings
  are `JEETA_GOOGLE_CLIENT_ID` and `JEETA_GOOGLE_CLIENT_SECRET`.
- **Field names come from Google's own REST description** (the v26 discovery document), not from
  the guide pages, which mix spellings.
- **Idempotency.** Campaign and ad group are looked up by name. A search ad has no name at Google,
  so the ad step adopts an ad of the ad group that already says the same (B81); the core therefore
  refuses two ads that say the same on Google (`same_as_another_ad`, in a plan and in a move).
- **Atomic steps.** Budget + campaign are one mutate; ad group + its country criteria + its
  keywords are one mutate. Nothing of ours can exist half built.
- **Days, not instants** (B80): the core's longest run on Google became 89 days.
- **The stored credential names no end** (B83): found while reading the access check
  (`chain::capability_access` refuses a connection whose `access.expires_at` passed, and Google's
  access token lives exactly as long as the refresh job's round). The adapter gets an access token
  per call with the refresh token and keeps it in memory.
- **A migration after all**: `0041_google_provider` widens the two checks of `oauth_pending`
  (`provider`, `app`) to take `google`. The in-memory tests could not see the need; the server's
  own test against a real database did (`500` on `connector.start_oauth`). Its down keeps the
  widened checks while a Google flow is pending and touches no row; up, down, up is tested.
  LinkedIn and X ads reuse their providers and callbacks; TikTok ads will need the same kind of
  migration for its second app.
- **Platform project errors are the platform's** (B84).
- Only Google Search, people present in the countries, phrase match, maximize clicks (B76, B82).
- Not built: manager-account access, Demand Gen, a keyword forecast, conversion tracking.
- A local run of `m4_deployment::production_build_refuses_test_loopback` fails on this machine
  because `target/release/jeeta` is older than migrations 0039 and 0040; CI builds its own.

### Task 3 (2026-11-11)

LinkedIn ad campaigns, in `jt_linkedin` (`src/ads.rs`, `src/countries.rs`, `tests/ads.rs`). What
differs from the plan's sketch, each recorded in the design (B85 to B87):

- **No page in the plan.** The ad speaks as the company page its ad account advertises for (the
  account's `reference`), read at LinkedIn at each step. The port did not change
  (`upload_image` keeps its shape); a plan on a LinkedIn account that names a `page` is refused
  naming the field. This keeps ads independent of the Community Management API, which
  `linkedin_page` needs.
- **The post and the creative are one call** (`creatives?action=createInline`), so the creative
  step sends nothing and the ad step makes both; a creative carries the build's own name and is
  found by it after a lost answer.
- **The campaign group is created active**, the campaign paused and the creatives as drafts
  (LinkedIn creates a group "in ACTIVE or DRAFT state"; whether a paused campaign may sit in a
  draft group is not documented).
- **No minimum budget finding.** LinkedIn names its least lifetime budget only when it refuses
  one: the limits answer none, and a budget that is too small ends the build at the campaign step
  with LinkedIn's own words.
- **Countries only**, each found by its name in LinkedIn's own country table; no age, no gender.
  The panel shows LinkedIn's targeting notice where a LinkedIn account is chosen and on a
  LinkedIn campaign's page.
- **A new finding**, `image_type_not_taken` (`PlatformRules.image_types`): LinkedIn takes a JPG,
  a PNG or a GIF, and another image would otherwise only be refused at the build.
- **`JEETA_LINKEDIN_AD_SCOPES`** (`LinkedinApp.ad_scopes`): off until LinkedIn approved the
  Advertising API; while off a `linkedin_ads` flow is `provider_product_not_enabled`. No
  migration: `oauth_pending` already takes the provider and the app `linkedin`.
- An independent pass held every key, enum, query and header of `ads.rs` against the saved
  LinkedIn pages. What it changed: the creatives finder now names its Rest.li method
  (`X-RestLi-Method: FINDER`, which LinkedIn requires), the audience carries the campaign's
  locale as `interfaceLocales` (as LinkedIn's website-visit sample does), a cancelled group is
  read in both of LinkedIn's spellings, a rejection reason may be an object, and the ad accounts
  are read to the total the finder names. What stays open is listed in the crate docs ("What only
  a first real run can tell").
- Tests: `jt_linkedin/tests/ads.rs` (22, against the in-process mock), two more in
  `jt_app/tests/ads_campaigns.rs`, one in `jt_app/tests/connector.rs`, the scope test in
  `jt_linkedin/src/oauth.rs`. Nothing was run against LinkedIn.

### Task 4 (2026-11-11)

TikTok ad campaigns, in `jt_tiktok` (`src/business.rs`, `src/ads.rs`, `src/budgets.rs`,
`tests/ads.rs`). What differs from the plan's sketch, each recorded in the design (B88 to B90):

- **A second client, not a second crate.** TikTok's API for Business has its own host, its own
  header (`Access-Token`) and an answer whose own `code` decides whatever the HTTP status says;
  `business.rs` is that client, beside the Open API one. `business-api.tiktok.com` joined the
  fixed hosts of the `tiktok` connector.
- **The authorization code is `auth_code`.** TikTok's redirect carries a `code` too, which is
  another value: the panel's callback page sends `auth_code` for the `tiktok_ads` callback.
- **The speaker is the ad account's one linked TikTok account**, found at the ad step; none or
  several is a refusal. A plan names no account.
- **The music** (design B91): TikTok recommends music only for two images or more, so for a
  one-image ad the piece is the first the advertiser liked in TikTok's tools, else the first the
  ad account used before, else the first result of a search for `background`; none: refused.
- An independent pass held every path, key, enum and answer field of `ads.rs`, `business.rs` and
  the OAuth functions against the saved TikTok pages. What it changed: the music search (above;
  the first version asked for a recommendation with one image, which TikTok does not take), the
  ad lookup (TikTok's list of ads has no name filter: the ad group's ads are read and matched),
  the image lookup after a refused duplicate name (no digest filter: the library is read), an
  identity TikTok marks as unusable for Spark Ads is skipped, a Chinese or Japanese character
  counts twice in the text, a long range of days is read thirty at a time, and the app refusal
  keeps TikTok's own words.
- **Minimum budgets are known ahead** (TikTok's ratio table, generated into `budgets.rs`), so they
  are the account's limits and a plan finding, unlike LinkedIn's.
- **Countries only**, all ages of 18 and over named explicitly; no age range, no gender.
- **A new rule flag**, `no_emoji` (`PlatformRules`): TikTok refuses emoji in an ad's text.
- **`md-5`** is a direct dependency of `jt_tiktok` (TikTok checks an upload against its MD5).
- **An advertiser's credential** has no expiry and no refresh token; its scopes carry the ids
  TikTok granted behind `tiktok_business:`, which is how `refresh` and `revoke` tell it from an
  account's Login Kit credential. No scope is required of it by the plan check (B62).
- Migration `0042_tiktok_ads_app` (reversible; round trip tested) widens `oauth_pending.app`.
- Tests: `jt_tiktok/tests/ads.rs` (21, against the in-process mock), one more in
  `jt_app/tests/ads_campaigns.rs`, one in `jt_app/tests/connector.rs`, the migration's in
  `jt_pg/tests/migrations.rs`, the panel's `auth_code` test. Nothing was run against TikTok.
- Open: A6. TikTok's page says manual campaigns can no longer be created through
  `/campaign/create/` after 2026-12-31, and its Smart+ campaigns take no traffic objective. The
  owner must ask TikTok before relying on this platform; a negative answer means a redesign
  around web conversions (which needs a pixel).
- The machine's disk filled during this task's full test run (`rust/target` at 132 GB): the full
  local run of this task is recorded here once it has been repeated.

### Task 5 (2026-11-12)

X ad campaigns, in `jt_x` (`src/ads.rs`, `tests/ads.rs`). What differs from the plan's sketch, each
recorded in the design (B92 to B97):

- **The same app and the same callback.** An ads account is reached with the sign-in of an
  account that posts: once the operator sets `JEETA_X_AD_SCOPES`, every X flow also asks for
  `ads.read` and `ads.write`, and a sign-in that was granted them offers its ads accounts.
  Without the flag an `x_ads` flow is refused (`provider_product_not_enabled`). No migration: the
  provider and the app `x` were already allowed, and no database check lists capability kinds.
- **The countries moved into the line item step** (B95). The plan's chain put the targeting last;
  a line item without a location is shown to everybody, everywhere, so the step now finds the
  countries first, makes or adopts the line item, adds each country that is missing and answers
  only then. The core's lookup by name answers nothing for a line item: the step adopts it
  itself, so that a build that broke off half way gets its missing country.
- **One funding instrument** (B93): an ads account is offered, and a campaign built, only when
  exactly one funding instrument can pay. The campaign's daily budget, which X asks most accounts
  for, is the total itself.
- **An ad is a line item and a post** (B94): its id names neither of X's promoted-post rows,
  since pausing deletes that row and resuming makes another. Its state is the promotion that is
  there now; its daily numbers add up every promotion it ever had (B96).
- **No button.** A website card has an image, a title and an address: an X plan takes no call to
  action and no description; `headline` is the card's title (70 characters), `primary_text` the
  post (280).
- **The pause is the limit** (B67, B97). X's rules say `hard_budget_cap: false` and
  `watch_minutes: 15`; the core already read both. On X a campaign's switch takes its line items
  with it (off: the campaign, then each line item, and the pause counts only once both are off;
  on: the line items, then the campaign). The panel says so where an X ads account is chosen
  and on an X campaign's page (`NoHardCapNotice`, driven by the rules of the campaign's
  platform), and the agent's tool texts say it too.
- `XApp.ad_scopes`, `AdsPlatform::X`, the `x_ads` kind (54 kinds), `ads-api.x.com` among the
  fixed hosts of the `x` connector, the reason of an Ads API error names X's code.
- An independent pass held every path, parameter, enum and answer field of `ads.rs` against the
  saved X pages and found none contradicted. What it changed was logic: the ad is created off
  (the first version promoted the post at creation, which on a running campaign would have run
  before the build switched it on); the days are read with one more day at each end (X reads a
  day as the ads account's own, the core asks for days of UTC: east of UTC the first hours of a
  day would have been read a day late, on the one platform where the reading is the limit); the
  post is written for the account's own user by X's default, not for the line item's
  `advertiser_user_id`, and `TWEET_COMPOSER` is asked only of a signed-in user who is not that
  user; the image is added to the account's media library; a pause tries both levels whatever
  the first answers; spend is rounded after an ad's promotions are added up; a deleted line
  item's spend is still read; a link written out in the post's text is refused (rule `no_link`,
  checked at the plan too); the Ads API's 408 and 423 pass by themselves; the ads account's own
  rate limit header is read.
- Tests: `jt_x/tests/ads.rs` (18, against the in-process mock), one more in
  `jt_app/tests/ads_campaigns.rs` (an X campaign from its plan to its end at the budget, read
  every fifteen minutes), one in `jt_app/tests/connector.rs`, two in the panel's
  `Campaigns.test.tsx`. Nothing was run against X.
- Open (design A7, A10, A11): whether the Ads API takes the OAuth 2.0 token; whether the one-call
  upload answers the `media_key` a card needs and a post written as the ads account's user may
  use that image; the words X uses for an account or a promotion that is not accepted. The X Ads
  API Agreement's duties (fees shown apart, X's approval for a white-label version) are the
  owner's to read before applying (design §7).
