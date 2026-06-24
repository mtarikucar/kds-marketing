# TikTok Integration — Design

- **Date:** 2026-06-23
- **Status:** Approved (user authorized end-to-end: "Onaylıyorum tamam hepsini")
- **Branch:** `feat/tiktok-integration`
- **Scope:** ALL of TikTok — organic publishing, ads reporting, DM messaging — at Meta-parity completeness
- **Testing:** LOCAL + SIMULATED (mocked TikTok APIs via `safeFetch` seam, signed fake webhooks, sandbox where available, local stack per `local-run-setup`)
- **Part of:** [[ghl-parity-program]] · sibling of [[2026-06-23-meta-integration-completion-design]] and [[2026-06-22-social-oauth-connect-design]]

## Goal

Bring TikTok to Meta-parity and harden it across three surfaces: full-feature organic publishing (FILE_UPLOAD + photo/carousel + per-post controls), OAuth-linked ads reporting, and two-way DM — all multi-tenant, sealed-token, env-gated/inert until provider approvals land. Reuse every existing convention (the generalized `social-oauth` framework, AES-256-GCM sealed secrets with registry-only decryption, `safeFetch`, all-inbound-through-ingress, advisory-locked crons, colocated `*.spec.ts`, conventional commits).

## Key finding — this is *completion + a corrected architecture*, not greenfield

TikTok is already ~70% built and wired into `marketing.module.ts`, but split across three subsystems with one structural gap and one **wrong-platform assumption** that the research corrected:

- **Organic (consumer platform):** `social-planner/network-adapters.ts → publishTikTok()` makes real Content Posting API calls (`/v2/post/publish/video/init/` + bounded status poll). OAuth connect + 365d refresh-token + hourly refresh already work via the `social-oauth` `tiktok` network (see sibling spec, Phase C). **Only PULL_FROM_URL, video-only, hardcoded PUBLIC + comments-on.**
- **Ads (business platform):** `ads/tiktok-ads.client.ts → pullTiktokInsights()` is a complete real Business API v1.3 `/report/integrated/get/` implementation (Access-Token header, bounded pagination, error checks, SSRF-safe fetch, AdMetric mapping). Hourly advisory-locked sweep exists (`ads/ads-pull.service.ts`). **Token is manual-paste only; no OAuth path; no reauth handling.**
- **DM (business platform):** `channels/adapters/tiktok-dm.adapter.ts` (real send to business-api v1.3 + `parseInbound`) and `controllers/tiktok-webhook.controller.ts` (HMAC + Meta-style GET challenge) exist and register into the AI ingress pipeline. **Token is manual-paste only; no OAuth; webhook contract modeled on Meta and likely wrong for TikTok (see risks).**

### The corrected architecture (research-grounded)

TikTok is **two developer platforms**, not one. This *inverts* the naïve "organic + DM share one login" intuition:

| Platform | Host | Powers | Token model |
|---|---|---|---|
| **Login Kit (consumer)** | `open.tiktokapis.com` | **Organic only** | 24h access / 365d refresh, auto-refresh. No live DM exists here (only read-only GDPR data-portability exports). |
| **TikTok for Business** | `business-api.tiktok.com` | **Ads + live DM** | Single non-expiring business token, **no refresh**, re-auth on revoke. Returns `advertiser_ids` + granted `scope`. |

So the connection model (user-approved) is **two OAuth connections**:
1. **TikTok Login** (existing `social-oauth` `tiktok` network) → `SocialAccount` → organic.
2. **TikTok for Business** (NEW `social-oauth` `tiktok-business` network) → one grant provisions **both** the ads `AdAccount`(s) **and** the DM `Channel` (when messaging scope is granted).

Sources for the platform facts (authoritative for the two-platform split; the two load-bearing premises — non-expiring business token and the BM DM contract — are gated in **Pre-flight verification gates** below, not assumed): user OAuth `https://developers.tiktok.com/doc/oauth-user-access-token-management`; business auth `https://business-api.tiktok.com/portal/auth` + token exchange `…/open_api/v1.3/oauth2/access_token/`; content posting `https://developers.tiktok.com/doc/content-posting-api-reference-direct-post`; webhooks `https://developers.tiktok.com/doc/webhooks-overview/`.

## Pre-flight verification gates (blocking)

Two of the four phases rest on vendor facts that could not be fetched from the live portal during research (JS-rendered docs). Each is a pass/fail gate that **must be checked against the live TikTok docs/sandbox before its dependent code is committed live** — until a gate passes, the dependent code ships inert behind its env/capability flag.

- **Gate G1 — business token lifetime (gates Phase 0/2).** Confirm the TikTok-for-Business access token is non-expiring and the exchange returns no `refresh_token`. If TRUE → `refresh()`=no-op + no refresh cron (as designed). If FALSE (it does expire/refresh) → add a refresh path on the NetGSM-DLR-poll pattern instead. Do not commit the no-refresh decision until confirmed.
- **Gate G2 — Business Messaging DM contract (gates Phase 3).** Confirm the BM **send endpoint path**, the **inbound webhook contract**, its **signature scheme**, and **whether a GET-challenge handshake is used**. Lock the DM adapter + webhook only after G2 passes; until then DM stays behind the `messaging` capability flag.

## How this plugs into the generalized `social-oauth` framework

The Meta session ([[2026-06-23-meta-integration-completion-design]] Phase 2/3) generalizes `social-oauth.service.ts confirm()` into a **per-asset dispatcher** (PAGE→SocialAccount[+Channel], AD_ACCOUNT→`AdAccountService`, WHATSAPP_NUMBER→Channel) and adds `connectedVia`, `/ads/oauth/*` routes, `linkFromOAuth`, and `markReauth`/`TOKEN_EXPIRED`/`reauth_required`. **TikTok rides that same machinery** — it adds a new `network` (`tiktok-business`) whose assets dispatch to `AdAccount` + DM `Channel`. No parallel OAuth stack.

⚠️ **Coordination:** Phase 2 below touches the same files the Meta session is editing (`social-oauth.*`, `ad-account.service.ts`, `marketing-ads.controller.ts`, frontend OAuth/ads files). **Sequence TikTok Phase 2 AFTER the Meta session's social-oauth dispatcher + `connectedVia` migration land**, or coordinate to rebase. See Risks.

## Build order (4 phases — file-disjoint across TikTok's own phases; Phase 2 overlaps the Meta session's files, see Coordination)

Shared business client first; then organic (consumer side, fully file-disjoint from the Meta work and most locally verifiable); then the business OAuth connective layer (highest Meta-overlap — sequence carefully); then DM (riskiest, depends on the Phase 0 client + Phase 2 token). Each phase is TDD'd, independently verified (`npm test` touched scope + `npm run build` + frontend `tsc`/Vitest), and committed before the next.

### Phase 0 — Shared TikTok-for-Business client + config (keystone)

**New:** `channels/tiktok-business.util.ts` (+ `.spec.ts`). Plain module (NOT a Nest provider — preserves the `safeFetch` mock seam, mirroring `meta-graph.util`):
- `businessApiBaseUrl(): string` — `https://business-api.tiktok.com/open_api/v1.3`.
- `tiktokBusinessFetch(path, { accessToken, method, query, body, timeoutMs }): Promise<TiktokBusinessResult>` — sets the `Access-Token` header, transports via `safeFetch`, parses the `{ code, message, request_id, data }` envelope once, returns a discriminated result.
- `TiktokBusinessError { httpStatus, code, message, requestId, isAuthError }` + `isTiktokBusinessAuthError(err)` — true for auth codes (40001/40002/40100-family) / HTTP 401.

**Modify:** `social-oauth.config.ts` — add a `tiktok-business` network entry (authorize `https://business-api.tiktok.com/portal/auth`, token `…/oauth2/access_token/`, env `TIKTOK_BUSINESS_APP_ID`/`TIKTOK_BUSINESS_APP_SECRET`, `isConfigured`). `main.ts` validateEnv — soft-check the **business** vars only (`TIKTOK_BUSINESS_APP_ID`/`TIKTOK_BUSINESS_APP_SECRET`; the audit found no env validation today). The consumer `TIKTOK_CLIENT_KEY/SECRET` are validated by the social-oauth work — don't double-claim that edit. `.env.example` — document `TIKTOK_BUSINESS_APP_ID/SECRET` (distinct from consumer `TIKTOK_CLIENT_KEY/SECRET`) + the business redirect URI.

**Tests:** envelope parse (success + `code!=0`), auth-error classification, header assembly, no-throw on missing creds.

### Phase 1 — Organic publish parity (consumer side; file-disjoint from Meta work)

**New:**
- `social-planner/tiktok-upload.util.ts` (+spec) — pure FILE_UPLOAD chunk math (`planChunks(videoSize)`: min 5 MB / max 64 MB chunk, final chunk ≤128 MB, ≤1000 chunks, `total_chunk_count = floor(size/chunk)`, whole-file when <5 MB) + a `transferChunks(uploadUrl, bytes, plan)` PUT loop (`Content-Range: bytes {first}-{last}/{total}`, `Content-Length`, `Content-Type` mp4/mov/webm) via `safeFetch`.
- `social-planner/tiktok-creator-info.util.ts` (+spec) — `queryCreatorInfo(token)` → `/v2/post/publish/creator_info/query/`; returns allowed `privacy_level_options`, read-only `comment_disabled`/`duet_disabled`/`stitch_disabled`, and `max_video_post_duration_sec`. The single source of truth for what the UI may offer (so the unaudited-app SELF_ONLY restriction is enforced by the API's own option list, not hardcoded). Exposed read-only through the existing `social-planner` controller (e.g. `GET /marketing/social-planner/accounts/:id/tiktok/creator-info`), reading the existing consumer `tiktok` `SocialAccount` sealed token — read-only enrichment of the existing connection, NOT a new OAuth surface (the consumer OAuth surface is owned by the social-oauth sibling).

**Modify:** `social-planner/network-adapters.ts → publishTikTok()` —
- Source mode: choose `FILE_UPLOAD` (init → `upload_url` → `transferChunks`) when no public media URL exists; else keep `PULL_FROM_URL`.
- Photo/carousel: when the post is images, call `/v2/post/publish/content/init/` (`media_type=PHOTO`, `photo_images` = up to 35 public+domain-verified URLs, `photo_cover_index`); video stays on `/v2/post/publish/video/init/`.
- Per-post controls: thread `privacy_level` + `disable_comment/duet/stitch` from the post's options, validated against `queryCreatorInfo` (reject/clip options the account can't use); stop hardcoding PUBLIC + comments-on.
- `social-planner.service.ts` — pass the per-post options through `schedulePost`/`publishDuePost` to the adapter.
- Frontend `SocialPlannerPage` composer — privacy-level + interaction toggles populated from a creator-info endpoint; photo-vs-video; a FILE_UPLOAD affordance for non-URL media.

**Data model:** ONE additive migration — `SocialPost.options Json?` (verified absent today on both `SocialPost` and `SocialPostTarget`). It carries the per-post privacy/interaction/media-type controls; thread into `SocialPostTarget` only if per-target overrides are needed.

**Tests:** chunk-math table (boundary sizes: <5 MB, exact multiples, >1000-chunk rejection), `content/init` PHOTO body, creator-info-driven privacy validation (SELF_ONLY-only account clips PUBLIC), video vs photo routing.

### Phase 2 — TikTok-for-Business OAuth → ads + DM provisioning (connective; HIGH Meta-overlap)

**Modify:**
- `social-oauth.providers.ts` (+spec) — add the `tiktok-business` provider: `buildAuthorizeUrl(state, redirectUri)` (`portal/auth?app_id&state&redirect_uri`), `exchangeCode(code, redirectUri)` (POST `oauth2/access_token/` `{ app_id, secret, auth_code, grant_type:"authorization_code" }`; parse `access_token`, `advertiser_ids`, `scope`), `listAssets(token)` (advertiser-info lookup → one `AD_ACCOUNT` `ConnectableAsset` per advertiser_id; if the granted `scope` includes messaging → also emit one `BUSINESS_MESSAGING` asset for the business account), `refresh()` = no-op (token non-expiring).
- `social-oauth.service.ts` confirm() dispatcher — add cases: `AD_ACCOUNT` (provider TIKTOK) → `AdAccountService.linkFromOAuth`; `BUSINESS_MESSAGING` → `ChannelsService` provisions a `Channel` (type `TIKTOK`, `externalId`=business account id, `configSealed={accessToken}`, `configPublic={connectedVia:'OAUTH', messaging:'granted'}`). `BUSINESS_MESSAGING` is an **additive extension** of the Meta-generalized `ConnectableAsset.accountType` union (`…|WHATSAPP_NUMBER|AD_ACCOUNT|BUSINESS_MESSAGING`), reusing Meta's collision→skip-not-abort and default→skip paths verbatim. **DM provisioning precedence** (mirrors Meta's per-Page `provisionMessaging[]` opt-in): messaging scope granted is NECESSARY (no scope → no `BUSINESS_MESSAGING` asset is emitted); the UI toggle is the user's explicit opt-in to actually create the Channel — absent the toggle, NO Channel is created even when scope is present. **Idempotent keys:** AdAccount on `(workspaceId, provider, advertiser_id)` (N advertisers → N AdAccounts); DM Channel on `(workspaceId, business-account id)` — exactly one Channel per business grant. Collisions skip-not-abort.
- `ads/ad-account.service.ts` — `linkFromOAuth`/`markReauth` handle `provider=TIKTOK` via `isTiktokBusinessAuthError`; `pullAccount` TIKTOK branch flags `TOKEN_EXPIRED`+`reauth_required` on auth error, clears on success. Reuse the status string `TOKEN_EXPIRED` for code-sharing with Meta, but for `tiktok-business` it semantically means **revoked / needs reauth**, not literal expiry — so add **no** expiry-window check (it could never fire on a non-expiring token). Token non-expiring → **no refresh path**: add a one-line guard to the social-oauth-owned `social-token-refresh.service.ts` to EXCLUDE the `tiktok-business` network from the sweep, while the consumer `tiktok` network keeps being refreshed there (24h/365d).
- Routes — TikTok-for-Business connect via the Meta-introduced `POST /ads/oauth/:provider/start` + `POST /ads/oauth/confirm`, where `:provider` is the **coarse provider enum `TIKTOK`** (matching Meta's `META`, per `LinkAdAccountDto`), which resolves internally to the **social-oauth network key `tiktok-business`**. These are two distinct identifiers: `provider=TIKTOK` (the ads/enum axis) ↔ `network=tiktok-business` (the OAuth-provider axis). The confirm dispatch provisions the AdAccount(s) and, when opted in, the DM Channel.
- Frontend — a "Connect TikTok for Business" CTA on both `AdReportingPage`/`ConnectAdAccountDialog` and `ChannelsSettingsPage`; the pending select dialog lists advertiser accounts + an "also enable TikTok DM" toggle (shown only when the `BUSINESS_MESSAGING` asset is present); `reauth_required` → Reconnect badge. Manual token paste kept as advanced fallback (sandbox/testing).

**Data model:** none new from TikTok — reuses Meta's additive `AdAccount.connectedVia` migration and the existing sealed `PendingSocialConnection.payload`, `AdAccount`(provider TIKTOK)/`Channel`(type TIKTOK) rows + enums. If Meta's `connectedVia` migration has not yet landed, add the same additive column (idempotent).

**Tests:** `tiktok-business` provider `buildAuthorizeUrl`/`exchangeCode`/`listAssets` parsing (mocked `safeFetch`: token response w/ + w/o messaging scope; advertiser-info shapes; auth errors); confirm() provisioning routing (AD_ACCOUNT→AdAccount sealed-not-raw; BUSINESS_MESSAGING→Channel; messaging-absent → no Channel); `ad-account.service` TIKTOK reauth classification.

### Phase 3 — DM two-way hardening + capability gating (channels; file-disjoint)

**Verify-first (blocking — this is Gate G2):** confirm the Business Messaging **send endpoint path**, **inbound webhook contract + signature scheme**, and **whether a GET-challenge handshake is used**, against the live portal docs — all were unfetchable during research (JS-rendered). Do not lock the adapter/webhook until G2 passes. Until then, DM stays behind the `messaging` capability flag (inert, fails gracefully).

**Modify:**
- `channels/adapters/tiktok-dm.adapter.ts` (+spec) — refactor `send` onto `tiktok-business.util`; token sourced from the OAuth-provisioned `Channel.configSealed`; gate `send` on `configPublic.messaging==='granted'` (capability flag) → when absent, `send` returns a graceful "messaging access not granted" result, the channel still ingests inbound (two-way with graceful degradation, as approved); live `healthCheck`.
- `controllers/tiktok-webhook.controller.ts` (+spec) — the **consumer-platform** events (`video.publish.completed` etc.) use `TikTok-Signature: t={ts},s={sig}`, HMAC-SHA256 over `ts + "." + rawBody` keyed by the app secret, with no GET-challenge per the consumer docs. Whether the **Business Messaging** webhook (the one DM actually uses) requires a GET-challenge or uses the same signature is **UNCONFIRMED → resolved by Gate G2**; do not assume. Align the controller to whatever G2 establishes; remove the current Meta-style assumptions; keep async-ACK-200 + background `process()` → `ConversationIngressService.ingest()`.
- `channels.service.ts` — DM `Channel` save-time validation (`tiktok-config.util.ts` +spec, mirroring `meta-config.util`/`netgsm-config.util`); `mask()` exposes `webhookUrl` + `messaging` status, never the token.

**Data model:** none — DM token in `configSealed`, status/`reauth` in `configPublic` JSON (business token non-expiring → no expiry columns needed).

**Tests:** `send` request shape + capability-gate (granted vs not); `parseInbound` normalization + self-echo/non-text filtering (regression); webhook signature verify (valid/forged/expired) once the scheme is confirmed; `tiktok-config.util` validation.

## Testing strategy (LOCAL + SIMULATED)

- Pure util specs (table-driven, zero IO): `tiktok-business.util` (envelope + auth classification), `tiktok-upload.util` (chunk math), `tiktok-creator-info.util` (option parsing), `tiktok-config.util`.
- Provider/service specs (mocked `safeFetch`/Prisma): `social-oauth.providers` tiktok-business; `social-oauth.service` confirm routing (sealed-not-raw, messaging-absent skip); `ad-account.service` TIKTOK reauth.
- Adapter specs: stub `safeFetch` to canned business-api 200/401; assert send body, capability gate, `parseInbound`, healthCheck.
- Webhook controller spec: signed fake payload through the raw-body path; assert ingress ran (after the contract is confirmed).
- Frontend (Vitest): "Connect TikTok for Business" CTA + advertiser/messaging select dialog + Reconnect badge; planner privacy/interaction selectors driven by creator-info.
- Gate each phase on backend `npm test` (touched scope) + `npm run build` + frontend `tsc`/Vitest before commit.

## Out of scope (YAGNI)

- Live TikTok app **audit** (consumer `video.publish`), Marketing API **app review** (sandbox→prod), and **Business Messaging allowlist** — parallel ops tracks; code ships multi-tenant + inert, flips on when approvals land.
- TikTok ad **creation/management/budget** writes — insights stay READ-ONLY (mirrors Meta).
- Consumer-platform DM **data-portability exports** (read-only GDPR copies — not live messaging).
- Video **transcode/hosting** beyond chunked upload of already-stored media; `video.upload` (inbox/drafts) flow — we use `video.publish` (Direct Post).
- DM **rich media** beyond text until the BM contract is confirmed.
- Proactive token-rotation cron for the business token (non-expiring; reauth is reactive on an auth error).

## Open items / risks

- **TOP RISK — DM contract unconfirmed (Gate G2):** BM send endpoint path + inbound webhook contract/signature/GET-challenge were unfetchable (JS-rendered portal). Verify-first in Phase 3; DM behind the `messaging` capability flag until G2 passes. The existing webhook controller's Meta-style GET-challenge is suspect.
- **Business token "non-expiring, no refresh" (Gate G1)** is schema/vendor-corroborated, not officially quoted — design revoke→reauth (no refresh cron); confirm before committing the no-refresh decision.
- **Unaudited consumer app** forces `SELF_ONLY` + private account + ≤5 distinct posters/24h — public organic is gated on passing TikTok audit; Creator Info drives the UI so the code degrades correctly pre-audit.
- **File overlap with the parallel Meta session** on `social-oauth.*` / `ad-account.service.ts` / `marketing-ads.controller.ts` / frontend ads+oauth files — sequence Phase 2 after the Meta dispatcher + `connectedVia` migration; rebase rather than fork.
- **Video duration is per-account** (`max_video_post_duration_sec` from Creator Info) — never hardcode a cap.
- **BM regional gating** excludes US/EEA/CH/UK and requires Business accounts — Turkey is eligible; confirm tenant regions before relying on DM.
- **Branch coordination:** Meta is on `feat/meta-integration`; TikTok on `feat/tiktok-integration`. Decide merge order (Meta first, given shared-file ownership).
