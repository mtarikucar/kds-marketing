# LinkedIn Integration — Design Spec

**Date:** 2026-06-24
**Branch:** `feat/linkedin-integration` (off `origin/main` @ `9e7e23b`), isolated worktree `D:/HDD/projects/kds-marketing-linkedin`.
**Author session:** LinkedIn track (siblings: Meta = shipped to `main`; TikTok = PR #91 open).

## Goal

Bring LinkedIn to the **appropriate** parity with the shipped Meta/TikTok integrations across the marketing platform's three surfaces — organic publishing, ads reporting, and a messaging analog — honestly bounded by what LinkedIn's API actually permits a non-partner SaaS to do. Everything LinkedIn gates behind partner review ships **complete, tested, but dormant behind env/capability flags** (the exact pattern TikTok DM used), so the self-serve core lights up immediately and the rest activates on approval **with no further code change**.

## Scope (user-approved 2026-06-24)

- **Organic publishing** — personal feed **and** Company Pages (both). Modernize the existing (deprecated, partially-broken) adapter.
- **Ads reporting** — full LinkedIn Marketing API reporting via one-click OAuth, env-gated + demoable on a free `test:true` ad account; live tenant data gated on LinkedIn Marketing Developer Platform (MDP) approval.
- **Engagement analog** (the DM substitute) — comment/reaction management on owned Company-Page posts + Lead Gen Form ingestion, behind a capability flag, inert until Community Management approval. **Real member-to-member / page-inbox DM is NOT built — LinkedIn exposes no such API to a non-whitelisted SaaS.**

## API reality (grounds the scope — researched 2026-06-24)

| Capability | Availability |
|---|---|
| Personal-feed publishing (`w_member_social`, `openid profile`) | **Self-serve / instant** |
| Company-Page publishing, org read (`w_organization_social`, `r_organization_social`) | **Community Management API review** (partner) |
| Ads reporting (`r_ads_reporting`, adAnalytics) | **MDP / Advertising API review** (LinkedIn's hardest approval; gates multi-tenant client-account management) |
| Comments/reactions on owned posts (`/rest/socialActions`) | Community Management review; **polling only, no webhook** |
| Lead Gen Form responses | Advertising API (rides ads approval) |
| General DM / page inbox | **Not available** to third-party SaaS (closed named-partner program only). Unofficial session-driving APIs (Unipile et al.) = ToS/ban risk → rejected. |

## Current state — verified against `main` (not memory)

| Surface | State on `main` | Evidence |
|---|---|---|
| **OAuth connect** | ✅ Complete & wired | `social-oauth.config.ts:71-77` (`LINKEDIN` def), `social-oauth.providers.ts:274-344` (`linkedinProvider` — `exchangeCode`/`refresh`/`listAssets` for `LI_PERSON` via `/v2/userinfo` + `LI_ORG` via `organizationAcls`), `providerFor` (`:632`). Env-gated `LINKEDIN_CLIENT_ID`/`LINKEDIN_CLIENT_SECRET`. Frontend connect button already renders when configured. |
| **Organic publishing** | ⚠️ Exists but **deprecated + broken** | `network-adapters.ts:432-488` `publishLinkedIn(account, content, mediaUrls)` — only **3 args** (doesn't receive `opts`; dispatch `:776` passes none), uses deprecated **`POST /v2/ugcPosts`** with no `LinkedIn-Version` header, attaches images via the **`shareMediaCategory:'ARTICLE'` + `originalUrl`** shortcut (unreliable on the modern API), hardcodes `visibility: PUBLIC`, returns **no `isAuthError`**, no video/document/multi-format. Author URN by `accountType` (`LI_ORG`→organization else person) — correct. |
| **Ads** | ❌ Greenfield | `ad-account.service.ts` `PROVIDERS=['META','TIKTOK']`; `ads.types.ts` has `isMetaAdsConfigured`/`isTiktokAdsConfigured` only; no LinkedIn ads client/OAuth/routes. Foundation present: `ads-pull.service` (skips `TOKEN_EXPIRED`), `AdMetric` upsert, `meta-ads.client`/`tiktok-ads.client` shape, `signState`/`verifyState`, `PendingSocialConnection`. **`tiktok-business-oauth.*` one-click flow is NOT on `main`** (lives in the TikTok branch) — used only as a reference pattern. |
| **DM / engagement** | ❌ Absent | No LinkedIn `ChannelAdapter`/config-util/webhook. `ChannelType` lacks `LINKEDIN`. `ContactIdentity.kind` is a **free-form string** (no enum migration needed). |
| **Frontend** | Partial | LinkedIn in connect/publish gates; absent from `AD_PROVIDERS=['META','TIKTOK']`; no LinkedIn channel type; no per-post LinkedIn composer control. |

## Reusable foundation (extension points, verified)

- **Versioned HTTP client pattern:** `common/util/meta-graph.util.ts` (`metaGraphFetch`, flat `{ok, data, error:{message,isAuthError}}` result — **no discriminated-union narrowing**, because the repo's `tsconfig` has `strictNullChecks:false`). LinkedIn gets an analogous `linkedin-api.util.ts`.
- **Publish types/dispatch:** `network-adapters.ts` — `AccountRow` (`:17`), `PublishResult{ok,externalPostId?,error?,isAuthError?}` (`:9`), `PublishOptions{format?,mediaMime?}` (`:70`), `MediaItem{url,mime?}` (`:64`), `publishToNetwork(account,content,mediaUrls,opts)` (`:762`), `revealToken`/`isNetworkConfigured`/`safeFetch`.
- **OAuth connect:** `social-oauth.{config,providers,service}.ts`, `social-oauth-state.util` (`signState`/`verifyState`, HMAC 10-min TTL — shared with ads OAuth), `sealSecret`/`openSecret`.
- **Ads:** `ad-account.service.ts` (`PROVIDERS`, `connect`, `pullAccount`, `markReauth`), `ads.types.ts`, `ads-pull.service.ts`, `meta-ads.client`/`tiktok-ads.client`, `ad-account.dto.ts`. Reference one-click flow: `tiktok-business-oauth.*` (from the TikTok branch).
- **Channels/engagement:** `channel-adapter.interface.ts` (`ChannelType`, `ChannelAdapter`), `channels.service.ts` (`assertXSecrets`, `mask`), `conversation-ingress.service.ts`, `ContactIdentity.kind` (free-form).
- **Frontend:** `OAuthConnectButtons.tsx`, `PostComposerDialog.tsx` (`TiktokControls` = the per-network options pattern), `ads/adsSchemas.ts` (`AD_PROVIDERS`), `ads/ads.service.ts` (`startTiktokAdsOAuth` = clone target), `AdReportingPage.tsx`, `ChannelsSettingsPage.tsx`.

---

## Architecture — phases (file-disjoint, each TDD + verify + commit)

### Phase 0 — Shared versioned REST client + config truth-up
- **`linkedin-api.util.ts`** (new): `linkedinRest(path, {accessToken, method, query, body, version?})` over `safeFetch`; injects `LinkedIn-Version: <YYYYMM>` (env `LINKEDIN_API_VERSION`, default a recent stable e.g. `202406`), `X-Restli-Protocol-Version: 2.0.0`, `Authorization: Bearer`. Flat result `{ok, status, data, error:{message,isAuthError}|null}` (mirror `meta-graph.util`). Single **`isLinkedinAuthError(status, body)`** classifier (HTTP 401, `serviceErrorCode`/`code` token errors, `REVOKED_ACCESS_TOKEN`) reused by publish + ads + engagement.
- **Config fix:** `social-oauth.config.ts` LINKEDIN scopes — replace the **non-existent `r_organization_admin`** with `r_organization_social`. Document self-serve vs reviewed scopes inline.
- **Env docs:** `.env.example` — `LINKEDIN_API_VERSION`, and the ads/engagement gates introduced in later phases.

### Phase 1 — Organic publishing modernization (personal + org) — *self-serve, ships live*
Rewrite `publishLinkedIn` onto the modern API and thread `opts`:
- **`/v2/ugcPosts` → `POST /rest/posts`** via `linkedinRest`; parse the new id from the **`x-restli-id`** response header (fallback to body `id`).
- **Real asset upload** replacing `ARTICLE/originalUrl`: `POST /rest/images?action=initializeUpload` (resp. `videos`, `documents`) → `PUT` binary to `uploadUrl` → reference `urn:li:image|video|document:…`. MIME from `opts.mediaMime` (reuse `isVideoItem`/`toMediaItems`). For URLs without bytes, fetch via `safeFetch` then upload (the planner stores public URLs today; gate size).
- **Content shapes:** single image, **multi-image** (`content.multiImage`), single **video**, **document**, and text-only. *Carousel is sponsored-only → not built for organic.*
- **`PublishOptions.linkedin`**: `{ visibility?: 'PUBLIC'|'CONNECTIONS' }` (extend the `PublishOptions` interface; other networks ignore it). Default `PUBLIC`.
- **Dispatch:** change `:776` to `publishLinkedIn(account, content, items, opts)` and accept `MediaItem[]` + `opts`.
- **`isAuthError`** surfaced from token failures (via `isLinkedinAuthError`) → drives the existing reconnect affordance (parity with Meta).
- **Org path** (`LI_ORG`) is code-complete but only functions once `w_organization_social` is granted — no special-casing needed.
- **Frontend:** a `LinkedinControls` block in `PostComposerDialog` (visibility select), persisted into `SocialPost.options.linkedin` (JSON — **no migration**).

### Phase 2 — Ads reporting (one-click OAuth, env-gated + test account)
Clone the TikTok-business-OAuth pattern onto the on-`main` ads foundation:
- **`linkedin-ads-oauth.{config,service,controller}.ts`** (new, in `ads/`): `start → callback → pending/:id → confirm`, reusing `signState`/`verifyState` + `PendingSocialConnection`; `confirm()` → `AdAccountService.connect` provisioning `AdAccount` rows. Authorize `https://www.linkedin.com/oauth/v2/authorization` with `r_ads_reporting` (+`r_ads`); token at `/oauth/v2/accessToken`. Ad accounts via `GET /rest/adAccountUsers?q=authenticatedUser` → `urn:li:sponsoredAccount:{id}`; `reference = urn:li:organization|person:{id}` analog. Sealed token.
- **`linkedin-ads.client.ts`** (new): `GET /rest/adAnalytics` (`q=analytics`, `pivot=CAMPAIGN`, `timeGranularity=DAILY`, `dateRange`, `fields=` spend/impressions/clicks + a conversion field for `leads`) → normalize to `AdMetricRow[]` → idempotent `AdMetric` upsert. Single bounded call (15k-element cap; no paging). Uses `linkedinRest` + `isLinkedinAuthError`.
- **Wiring:** `PROVIDERS += 'LINKEDIN'` (`ad-account.service.ts`), `isLinkedinAdsConfigured()` in `ads.types.ts` (gate on `LINKEDIN_ADS_CLIENT_ID`/`LINKEDIN_ADS_CLIENT_SECRET` — a distinct ads app, mirroring TikTok's separate business app; falls back to the social `LINKEDIN_CLIENT_*` only if a single-app strategy is chosen at build time), accept `'LINKEDIN'` in `ConnectAdAccountDto`/`AdMetricsQueryDto` + `/ads/status`, `pullAccount` LinkedIn branch → `isLinkedinAuthError` → `markReauth` (`TOKEN_EXPIRED`, `lastError='reauth_required'`); `ads-pull` already skips `TOKEN_EXPIRED`. **Token refresh** is partner-gated → design for 60-day expiry + reconnect (no programmatic refresh assumed).
- **Frontend:** `AD_PROVIDERS += 'LINKEDIN'` (`adsSchemas.ts`), `startLinkedinAdsOAuth()` (`ads.service.ts`), connect + pending-select + Reconnect badge in `AdReportingPage`/`ConnectAdAccountDialog` (clone TikTok). Inert until `LINKEDIN_ADS_*` set.

### Phase 3 — Engagement analog (DM substitute), behind a capability flag
LinkedIn has no DM API, so this is sanctioned engagement, built dormant:
- **`linkedin-engagement.adapter.ts` + a poller** (no webhook exists): a scheduled job pulls **new comments/reactions on the workspace's owned LinkedIn org posts** via Community Management `/rest/socialActions/{shareUrn}/comments` → normalize → `ConversationIngressService.ingest` (post-thread = conversation; commenter = `ContactIdentity{kind:'linkedin'}` — free-form, **no migration**). Reply = `POST` a comment. `ChannelType` gains `'LINKEDIN'`.
- **Lead Gen Form responses** via the Ads API (`/rest/leadFormResponses` / lead-sync) → inbound contact capture (rides Phase 2 auth).
- **Capability gate:** `Channel.configPublic.linkedinEngagement === 'granted'` (the `messaging:'granted'` pattern TikTok DM uses). `send`/poll are inert when absent → ships complete + tested, activates on Community Management approval. `assertLinkedinSecrets` + `mask()` (surface webhook/poll status, never the token) mirror `tiktok-config.util`.
- **Honest boundary noted in code + UI:** this is *engagement on owned posts*, not a DM inbox.

## Data model

**No migration.** Reuse: `SocialAccount` (LinkedIn rows already supported), `AdAccount` (`provider` is a string — no enum), `PendingSocialConnection`, `SocialPost.options` JSON (add a `linkedin` key), `Channel` + `Channel.configPublic` JSON, `ContactIdentity.kind` (free-form string). If Phase 3 needs durable "last-seen comment" cursors, prefer an additive **nullable JSON** on the existing `Channel` over a new table — decided at plan time, kept additive/backward-compatible (the junction-shared-Prisma-client hazard the siblings hit is avoided by the fresh worktree install + additive-only changes).

## Error handling

- One classifier `isLinkedinAuthError` (Phase 0), used everywhere; flat result shapes (no DU narrowing).
- Publish/ads/poll degrade gracefully: auth failures → `isAuthError`/`markReauth` → reconnect UI; non-auth failures → logged, bounded `error` string; partner-gated surfaces are inert (not erroring) until their flag/env is set.
- All outbound HTTP via `safeFetch` (SSRF-safe). All tokens sealed (`sealSecret`/`openSecret`).

## Testing strategy (repo convention: TDD, mock `safeFetch`)

- **Phase 0:** `linkedin-api.util.spec` — version/headers/auth-classification (incl. 401 + `REVOKED_ACCESS_TOKEN`).
- **Phase 1:** `network-adapters.linkedin.spec` — `/rest/posts` body + headers, author URN person vs org, register-upload sequence (init→PUT→reference), multi-image, video, visibility from opts, `isAuthError` surfaced, id parsed from `x-restli-id`.
- **Phase 2:** ads-oauth spec (authorize URL/exchange/confirm→sealed `AdAccount`), `linkedin-ads.client` spec (adAnalytics→`AdMetricRow`→upsert), reauth classification.
- **Phase 3:** adapter spec (poll→ingest normalization, reply body, capability gate granted/not), config-util validation + `mask` hides token.
- **Per phase verify:** backend `npx jest <scope>` + `npm run build`; frontend `npx tsc --noEmit` + `npx vitest run <scope>` + `npm run build`. Commit per task.

## Sequencing & go-live gating

- **Phases 0–1** ship **live, self-serve** (personal-feed publishing needs no LinkedIn review; org path inert until Community Management approval).
- **Phases 2–3** ship **dormant behind env/capability flags**, activating on **MDP** (ads) / **Community Management** (engagement) approval with **no code change**. Demoable immediately (ads `test:true` account; engagement flag toggled in a dev workspace).
- External, non-code follow-ups (documented, not blockers): create LinkedIn developer app + products (Sign In with LinkedIn / Share on LinkedIn = instant; Community Management + Advertising API = reviewed), register the redirect URIs, set env creds, submit reviews.

## Self-review

- **Placeholders:** none — every unit names a concrete file/symbol + endpoint; partner-gated phases are explicitly dormant-by-design, not vague.
- **Consistency:** `PublishOptions`/`AccountRow`/`PublishResult` reused verbatim; `linkedin-api.util`/`isLinkedinAuthError` defined in P0 and consumed in P1–P3; `PROVIDERS`/`AdMetricRow`/`AdAccount` reused for ads; `ChannelAdapter`/`ConversationIngress`/`ContactIdentity.kind` reused for engagement.
- **Scope:** single coherent plan; DM correctly de-scoped (API-forbidden) with an honest engagement analog in its place; no new tables; no cross-session file races (extends already-merged `main`, own worktree).
- **Ambiguity:** the one open build-time choice (LinkedIn ads = separate app vs shared app) is called out explicitly in Phase 2 with a default (separate `LINKEDIN_ADS_*`, TikTok-style).
