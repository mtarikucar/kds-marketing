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
- Migrations: none expected (the campaign is one JSON record; new fields are `serde(default)`).

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
- [ ] 1.5 `make check`, README, design/plan log, commit, push.

## Task 2 — Google Ads adapter (`jt_google`)

New crate `rust/crates/adapters/jt_google` (model: `jt_linkedin`): OAuth (authorization code,
offline, scope `https://www.googleapis.com/auth/adwords`), refresh, `ListAccessibleCustomers` →
assets with currency, time zone and status, probe, `AdCampaignWriter` + `AdBudgetWriter::set_status`,
`campaign_state` (`ad_group_ad.policy_summary`), `ad_days` (GAQL by ad and day). Wiring:
`GoogleApp` in `PlatformAppConfig` (env `JEETA_GOOGLE_CLIENT_ID`, `JEETA_GOOGLE_CLIENT_SECRET`,
`JEETA_GOOGLE_ADS_DEVELOPER_TOKEN` when the API still asks for one), `OAuthCallback::Google`,
`FIXED_HOSTS`, registry, connect use case, panel connect card, deployment env docs.

- [ ] 2.1 Crate, client, error table, OAuth + refresh, assets, probe; tests against an in-process mock.
- [ ] 2.2 Writer: budget → campaign → ad group (+ country, keywords) → ad; idempotent by name; status.
- [ ] 2.3 Reads: state and daily numbers; tests.
- [ ] 2.4 Wiring, panel, README; `make check`; commit, push; staging release when the owner agrees.

## Task 3 — LinkedIn ads (in `jt_linkedin`)

Rules row, `linkedin_ads` kind served by LinkedIn, ad scopes on the LinkedIn app
(`JEETA_LINKEDIN_AD_SCOPES`), ad accounts as assets (`adAccountUsers?q=authenticatedUser`), writer:
campaign group → campaign (`totalBudget`, `LIFETIME`) → image → dark post → creative → activation;
state from `review.status`; days from `adAnalytics`.

## Task 4 — TikTok ads (in `jt_tiktok`, TikTok for Business app)

Rules row (identity of the ad account, music chosen by Jeeta), `OAuthCallback::TiktokAds`, advertiser
accounts as assets, writer: campaign → ad group → image → music → carousel ad; status endpoints;
`/ad/review_info/`; `/report/integrated/get/`. Minimum budgets from the documented table.

## Task 5 — X ads (in `jt_x`)

`x_ads` kind, rules row (15-minute watch, no hard cap said on the panel and in the tool), ad scopes
on the X app, ad accounts as assets, writer: campaign → line item (+ targeting) → media → card →
promoted-only post → promoted post; pausing an ad deletes the promoted post, resuming makes it
again (B73).

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
