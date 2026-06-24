# Meta Integration Completion — Design

- **Date:** 2026-06-23
- **Status:** Approved (autonomous build — user authorized end-to-end without per-phase approval gates)
- **Branch:** `feat/meta-integration`
- **Scope:** ALL of Meta — messaging channels, OAuth onboarding, Ads
- **Testing:** LOCAL + SIMULATED (signed fake webhooks using the real `META_APP_SECRET` in local `.env`, mocked Graph API, local stack per `local-run-setup`)

## Goal

Bring the Meta surface to NetGSM-parity completeness and harden it: finish delivery receipts, save-time validation, live health, richer send (messaging); a single "Connect with Facebook" that auto-provisions assets (oauth); OAuth-linked ad accounts + reauth surfacing (ads); and one correct shared Graph client (cross-cutting, with `appsecret_proof` everywhere).

## Key finding — this is *completion*, not greenfield

Meta is already ~90% built and wired into `marketing.module.ts`:

- **Messaging:** `channels/adapters/meta-messaging.adapter.ts` (Messenger + Instagram DM), `whatsapp-cloud.adapter.ts`, signed `controllers/meta-webhook.controller.ts` (X-Hub-Signature-256 over raw body, GET hub.challenge), inbound funnels through `ConversationIngressService`.
- **OAuth:** `social-planner/oauth/*` — signed-state connect (start/callback/pending/confirm), sealed token storage, Facebook/Instagram publishing.
- **Ads:** `ads/meta-ads.client.ts` insights pull (read-only), `ads/ad-account.service.ts` (manual token paste), hourly advisory-locked cron.

The work is to close the gaps below, reusing every existing convention: adapter self-registration, AES-256-GCM sealed secrets (registry-only decryption), `safeFetch`, all-inbound-through-ingress, env-gated/inert features, colocated `*.spec.ts`, conventional commits.

## Build order (4 phases, file-ownership disjoint per phase)

Cross-cutting helper first so the others build on it; then messaging (most locally-verifiable), then oauth (the connective layer), then ads (consumes oauth discovery). Each phase owns a disjoint file set → no shared-file races; each is TDD'd, independently verified (`npm test` + `npm run build`), and committed before the next.

### Dedup rules (collapsed overlaps from the design drafts)
- `appsecret_proof` lives ONLY in the shared helper (Phase 0); the ads-specific proof file is dropped.
- Ad-account discovery lives ONLY in `social-oauth.providers.ts` (Phase 2); ads (Phase 3) only adds `linkFromOAuth` reading `AD_ACCOUNT` assets from the sealed pending payload.
- A single `isMetaAuthError` predicate (helper) is used by send, publish, and pull.
- Reuse `PendingSocialConnection` for `AD_ACCOUNT` assets — no parallel pending table.
- `GRAPH_API_VERSION` centralized (env, default `v19.0`); the OAuth dialog URL uses a `graphApiVersion()` accessor.

## Shared interface — `channels/meta-graph.util.ts` (the keystone)

Plain module (NOT a Nest provider, to preserve the `safeFetch` mock seam):

- `graphBaseUrl(): string` — `https://graph.facebook.com/${GRAPH_API_VERSION ?? 'v19.0'}`
- `appSecretProof(accessToken): string | null` — lowercase-hex `HMAC-SHA256(accessToken)` keyed by `META_APP_SECRET`; returns `null` (never throws) when the secret is unset.
- `metaGraphFetch(path, { accessToken, method, query, body, timeoutMs }): Promise<MetaGraphResult>` — assembles URL, appends `access_token` + `appsecret_proof` to the query, transports via `safeFetch`, parses JSON once, returns a discriminated result.
- `metaGraphFollow(absoluteNextUrl, accessToken)` — re-derives/overwrites `appsecret_proof` on a provider-issued `paging.next` URL, then `safeFetch`.
- `MetaGraphError { httpStatus, code, subcode, fbtraceId, message, isAuthError }` and `isMetaAuthError(err)` — true for Graph code 190 / subcodes 458/459/460/463/467 / HTTP 401.

Used by: `meta-ads.client`, `review-clients`, `whatsapp-cloud.adapter`, `meta-messaging.adapter`, `social-oauth.providers`, `network-adapters`, `ad-account.service`.

## Phase 0 — Cross-cutting Graph helper

**New:** `channels/meta-graph.util.ts` (+ `.spec.ts`).
**Modify (refactor onto helper, read-only/publish sites — preserve existing contracts & test mock seams):** `ads/meta-ads.client.ts` (first page via `metaGraphFetch`, pages via `metaGraphFollow`; now throws helper's auth-aware error), `reviews/review-clients.ts` (inert-returns-`[]` preserved), `social-planner/network-adapters.ts` (publish; token to query+proof; return `isAuthError`-flagged errors). `main.ts` validateEnv soft-check for `GRAPH_API_VERSION`; `.env.example` documents `GRAPH_API_VERSION` (default v19.0, recommend operators set v23.0) and the expanded `META_APP_SECRET` role.

**Tests:** deterministic proof vs known HMAC vector; version default/override; no-throw on missing secret; auth-error classification; `metaGraphFollow` proof overwrite; existing `ads-clients.spec.ts` stays green + asserts `appsecret_proof` now present. Token-EXCHANGE OAuth calls do NOT get proof (no access_token yet).

## Phase 1 — Messaging hardening

**Contract (additive):** `channel-adapter.interface.ts` — add `StatusUpdate { externalMessageId, status: 'DELIVERED'|'READ'|'FAILED', reason?, at? }`, optional `parseStatusUpdates?(config, body): StatusUpdate[]`, and optional `OutboundSend.template { name, languageCode, components? }` / `OutboundSend.media { url, kind:'image'|'document', filename?, caption? }`.

**New:** `channels/meta-status.util.ts` (+spec) — pure `parseWaStatuses`, `parseMessengerStatuses`, `rankMetaStatus`. `channels/message-receipt.service.ts` (+spec) — `apply(workspaceId, updates)`: lookup `Message` by `@unique externalMessageId`, workspace-scoped, OUTBOUND-only, monotonic advance (rank guard, no regression), FAILED carries reason→`error`, best-effort SSE, never throws. `channels/meta-config.util.ts` (+spec) — `assertMetaSecrets` (WHATSAPP: accessToken+phoneNumberId; MESSENGER/INSTAGRAM: pageAccessToken). `channels/meta-callback.util.ts` (+spec) — `metaWebhookCallbackUrl(baseUrl)` static `/api/public/channels/meta/webhook`.

**Modify:** `whatsapp-cloud.adapter.ts` (+new spec) and `meta-messaging.adapter.ts` (+new spec) — refactor send onto `metaGraphFetch`; add `parseStatusUpdates`; live `healthCheck` (WA: GET `{phoneNumberId}`; Messenger/IG: GET `/me`); template + media bodies. `channels.service.ts` — call `assertMetaSecrets` in create()+update() for the three Meta types (update validates merged secrets); `mask()` adds `webhookUrl` + `verifyTokenConfigured` for those types (never the token value). `controllers/meta-webhook.controller.ts` (+spec) — after the ingest loop, call `adapter.parseStatusUpdates` → `MessageReceiptService.apply(channel.workspaceId, updates)`. `channels/message-sender.service.ts` (+spec) — thread optional template/media through to `adapter.send` (text path unchanged; FAILED still refunds quota). `marketing.module.ts` — register `MessageReceiptService`. Frontend `ChannelsSettingsPage.tsx` — webhook URL copy-box + verify-token hint for the three Meta types.

**Data model:** none (`Message.status` already enumerates RECEIVED|SENT|DELIVERED|READ|FAILED; `externalMessageId` already `@unique`).

## Phase 2 — Unified Meta OAuth onboarding ("Connect with Facebook")

**Modify:** `social-oauth.config.ts` — broaden FACEBOOK scopes (`whatsapp_business_management`, `whatsapp_business_messaging`, `ads_read`, `pages_messaging`) used only when `META_LOGIN_CONFIG_ID` unset; dialog URL via `graphApiVersion()`. `social-oauth.providers.ts` (+spec) — refactor reads onto helper; extend `ConnectableAsset` with typed `meta` blob + accountTypes `WHATSAPP_NUMBER`|`AD_ACCOUNT`; add `discoverWhatsApp` (/me/businesses→owned_whatsapp_business_accounts→phone_numbers) and `discoverAdAccounts` (/me/adaccounts?fields=account_id,name,currency), each in try/catch so a missing scope degrades gracefully. `social-oauth.service.ts` (+spec) — inject `ChannelsService` + `AdAccountService`; carry `asset.meta` through the sealed payload; rewrite `confirm()` as a per-asset dispatcher (PAGE→SocialAccount[+MESSENGER Channel if opted-in]; IG_BUSINESS→SocialAccount[+INSTAGRAM Channel]; WHATSAPP_NUMBER→WHATSAPP Channel; AD_ACCOUNT→`AdAccountService.connect`), tokens sealed per-asset, collisions→skipped (not abort), pending deleted, per-kind summary. `social-oauth.controller.ts` — `ConfirmDto` gains optional `provisionMessaging: string[]`. Frontend `social/OAuthConnectButtons.tsx`, `AccountSelectDialog.tsx`, `useSocialConnect.ts`, `OAuthConnect.test.tsx` — single CTA + grouped asset list + per-Page/IG "also enable messaging" toggle.

**Data model:** none (PendingSocialConnection.payload is sealed free-form JSON; Channel/SocialAccount/AdAccount columns + unique constraints already exist).

## Phase 3 — Meta Ads hardening (insights stay READ-ONLY)

**Modify:** `ads/ad-account.service.ts` (+spec) — `linkFromOAuth(workspaceId, pendingId, externalAdId)` reads the sealed pending payload, seals the chosen ad-account token, upserts `connectedVia:'OAUTH'`, status ACTIVE; in `pullAccount()` catch `isMetaAuthError` → `markReauth` (status `TOKEN_EXPIRED` + lastError `reauth_required`); successful pull clears lastError + resets ACTIVE; manual `connect()` sets `connectedVia:'MANUAL'`. `dto/ad-account.dto.ts` — `LinkAdAccountDto { provider:'META', pendingId, externalAdId }`. `controllers/marketing-ads.controller.ts` — POST `/ads/oauth/:provider/start` + POST `/ads/oauth/confirm` (MANAGER + settings.manage + @Audit), reuse the social pending endpoint filtered to AD_ACCOUNT. `ads/ads-pull.service.ts` (+spec regression) — confirm the due query filters `status:'ACTIVE'` so TOKEN_EXPIRED rows stop hammering Meta. Frontend `ads/ads.service.ts`, `AdReportingPage.tsx`, `ConnectAdAccountDialog.tsx`, `adsSchemas.ts` — OAuth connect + pending picker + Reconnect badge/button for TOKEN_EXPIRED; manual paste kept as fallback.

**Data model:** ONE additive migration — `AdAccount.connectedVia String @default("MANUAL")` (non-breaking; mirrors `SocialAccount.connectedVia`). `status`/`lastError`/`refreshToken`/`tokenExpiresAt` already exist.

## Testing strategy (LOCAL + SIMULATED)

- Pure mappers/util specs (table-driven, zero IO): `meta-graph.util`, `meta-status.util`, `meta-config.util`, `meta-callback.util`, appsecret_proof vector.
- Service specs (mocked Prisma + collaborators): `message-receipt.service` (monotonic/no-regression/no-throw), `ad-account.service` (reauth classification, linkFromOAuth), `social-oauth.service` (confirm provisioning routing, sealed-not-raw, collision→skip).
- Adapter specs: stub `fetch`/`safeFetch` to canned Graph 200/401; assert request body for text/template/media, SendResult, healthCheck ok/fail, `parseStatusUpdates`.
- Webhook controller spec: build a status-only payload, sign with `createHmac('sha256', META_APP_SECRET)` (existing `sign()` helper), feed raw Buffer through `receive()`, assert `receipts.apply` ran.
- OAuth providers spec: mock `safeFetch` sequences for pages/IG + WhatsApp + ad-account discovery; assert merged asset list + graceful per-group 4xx degradation + `appsecret_proof`.
- Frontend (Vitest): grouped select dialog, webhook copy-box, Reconnect button.
- Gate each phase on backend `npm test` (touched scope) + `npm run build` + frontend `tsc`/Vitest before commit.

## Out of scope (YAGNI)
- WhatsApp interactive quick-replies/carousels/list messages; media UPLOAD/hosting (only by-URL); WhatsApp template MANAGEMENT (send already-approved templates by name only).
- Campaign/adset/ad creation, budget control, any Marketing API write (`ads_management`) — insights stay read-only.
- Live Facebook App Review / production scope approval; webhook subscription automation; proactive token-rotation cron (reauth is reactive on a 190).
- Receipt timestamp persistence/analytics; per-channel Meta webhook tokens (one app/one URL; HMAC + verify token is the boundary).
- Bumping `GRAPH_API_VERSION` in committed config (ship v19.0 default; recommend v23.0 in docs).

## Open items / risks
- 7–8 site Graph refactor: preserve existing `safeFetch` mocks + never-throw FAILED contracts; do read-only sites first; gate on green specs.
- Broadened OAuth scopes need Meta App Review — gated behind env/FLB config, inert until approved (fine for local+simulated).
- Confirm Messenger/IG delivery+read webhook field shapes vs current Graph docs before locking `parseMessengerStatuses`.
- WhatsApp Channel token choice (page/user long-lived vs System User) — verify against Graph behavior during impl.
- Provisioning collision UX (same-workspace idempotent update vs cross-tenant hard-skip).
