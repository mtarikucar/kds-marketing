# One-click OAuth social account connect — design

**Date:** 2026-06-22
**Status:** Design — approved (sections 1–3)
**Part of:** [[meta-tiktok-integration]] / [[ghl-parity-program]]

## Problem & goal

The Social Planner's "Connect social account" dialog is **manual token entry**: the user must create a developer app, generate a page/profile access token by hand, find the page/profile ID, and paste both. That is infeasible for non-technical tenants. Goal: a **one-click OAuth "Connect" button per network** (Facebook, Instagram, LinkedIn, TikTok) — the user clicks, approves on the provider, picks which page(s)/account(s) to connect, done. Multi-tenant SaaS: each workspace OAuths its own assets through **shared platform apps** (our developer apps, env-configured once).

The system is already multi-tenant; this adds the OAuth acquisition path on top of the existing per-workspace sealed-token storage + publish adapters. The manual form stays as an advanced fallback.

**External dependency (not code):** publishing scopes require provider app review before *arbitrary* tenants can authorize — Meta App Review + Business Verification (`pages_manage_posts`, `instagram_content_publish`), LinkedIn Marketing Developer Platform (`w_organization_social`), TikTok Content Posting audit (`video.publish`). Until approved, OAuth works only for accounts added as app testers (our own). Code is built fully multi-tenant regardless; review is a parallel ops track.

## Architecture & flow

Shared platform app per network (env creds). Standard OAuth 2.0 authorization-code flow, per-workspace:

1. **Start** (authenticated): `POST /marketing/social/oauth/:network/start` → builds the provider authorize URL with a signed `state` and returns it; frontend redirects (full-page or popup).
2. **Provider consent** → provider redirects the browser to our **public** callback.
3. **Callback** (public, no auth header — browser redirect): `GET /marketing/social/oauth/:network/callback?code&state` → verify `state` (HMAC, binds workspace + network, short TTL) → exchange `code` for a token → upgrade to a long-lived token (+ refresh token where supported) → **list the user's connectable assets** (pages / IG business accounts / LinkedIn person+orgs / TikTok account) → persist a short-lived **PendingSocialConnection** row (assets + sealed provider token) → redirect the browser back to the app at `/social?connect=<pendingId>`.
4. **Select** (authenticated): frontend fetches the pending assets, shows a multi-select; on confirm `POST /marketing/social/oauth/pending/:id/confirm { selected: [...] }` → creates one `SocialAccount` per selected asset (token sealed, `connectedVia=OAUTH`, `accountType` set, `tokenExpiresAt` + sealed `refreshToken`) → deletes the pending row.

Existing publish adapters (`network-adapters.ts`) consume the resulting `SocialAccount` rows unchanged, except LinkedIn gains org support (below).

### Unit boundaries

- `social-oauth.config.ts` — per-network OAuth config (authorize/token endpoints, scopes, env var names, `isConfigured`). One place that knows provider URLs/scopes.
- `social-oauth-state.util.ts` — `signState({workspaceId,network,nonce})` / `verifyState(token)` (HMAC via `MARKETING_SECRET_KEY`, ~10 min TTL). Pure, unit-tested. Mirrors `netgsm-callback.util` pattern.
- `social-oauth.providers.ts` — per-network: `buildAuthorizeUrl(state, redirectUri)`, `exchangeCode(code, redirectUri)`, `refresh(refreshToken)`, `listAssets(token)`. Each returns a normalized shape `{ accessToken, refreshToken?, expiresAt?, assets: ConnectableAsset[] }`. Pure-ish (HTTP via `safeFetch`), unit-tested with mocked fetch.
- `social-oauth.service.ts` — orchestrates start/callback/confirm + the PendingSocialConnection lifecycle; workspace-scoped; seals tokens.
- `social-oauth.controller.ts` — the three routes above (start + confirm authenticated; callback public). Callback never logs tokens/state.
- `social-token-refresh.service.ts` — scheduled job: refresh accounts nearing `tokenExpiresAt`; on failure mark `enabled=false` + `lastError='reauth_required'`.
- Frontend `useSocialConnect` hook + `ConnectButtons` + `AccountSelectDialog` on `SocialPlannerPage`.

## Per-network detail

| Network | Authorize / token host | Scopes | Assets listed | externalId stored | accountType |
|---|---|---|---|---|---|
| **Facebook** | `facebook.com/v19.0/dialog/oauth` · `graph.facebook.com/v19.0/oauth/access_token` | `pages_show_list, pages_manage_posts, pages_read_engagement` | `/me/accounts` → Pages (each has its own page token) | Page ID | `PAGE` |
| **Instagram** | (same Meta OAuth) | `instagram_basic, instagram_content_publish, pages_show_list` | per Page `?fields=instagram_business_account` | IG business user ID | `IG_BUSINESS` |
| **LinkedIn** | `linkedin.com/oauth/v2/authorization` · `linkedin.com/oauth/v2/accessToken` | `w_member_social, w_organization_social, r_organization_admin, openid, profile` | `/v2/userinfo` (person) + `/v2/organizationAcls?q=roleAssignee&role=ADMINISTRATOR` (orgs) | person sub / org id | `LI_PERSON` / `LI_ORG` |
| **TikTok** | `tiktok.com/v2/auth/authorize/` · `open.tiktokapis.com/v2/oauth/token/` | `user.info.basic, video.publish` | `/v2/user/info/` → single account | open_id | `TIKTOK` |

- **Meta long-lived:** exchange short-lived user token → long-lived (`grant_type=fb_exchange_token`); page tokens derived from a long-lived user token do not expire. Store the page token per page.
- **Instagram** publishing uses the Page token + IG user id (already in `publishInstagram`). The OAuth picker surfaces IG accounts found behind the user's pages.
- **LinkedIn org support (adapter change):** `publishLinkedIn` currently hardcodes `urn:li:person:${externalId}`. Change to choose `urn:li:person:` vs `urn:li:organization:` from `account.accountType`. Org posts need `w_organization_social`.
- **TikTok** has refresh tokens (24h access / 365d refresh) → refresh job mandatory; externalId (open_id) is stored for display though the publish call authenticates by token.

## Data model

Additive migration on `social_accounts`:

```prisma
model SocialAccount {
  // ... existing fields ...
  refreshToken  String?  @db.Text   // SEALED — provider refresh token (LinkedIn/TikTok/Meta)
  accountType   String?             // PAGE | IG_BUSINESS | LI_PERSON | LI_ORG | TIKTOK
  connectedVia  String   @default("MANUAL")  // MANUAL | OAUTH
  lastError     String?             // e.g. 'reauth_required' when refresh fails
}
```

New model for the brief callback→select handoff:

```prisma
model PendingSocialConnection {
  id           String   @id @default(uuid())
  workspaceId  String
  network      String
  payload      String   @db.Text   // SEALED JSON: { token, refreshToken?, expiresAt?, assets:[{externalId,displayName,accountType,token?}] }
  createdAt    DateTime @default(now())
  expiresAt    DateTime            // ~15 min; a sweep deletes stale rows
  @@index([workspaceId])
  @@map("pending_social_connections")
}
```

## Endpoints

- `POST /marketing/social/oauth/:network/start` — auth'd (MANAGER); returns `{ authorizeUrl }`. 400 if network not configured (env creds missing).
- `GET /marketing/social/oauth/:network/callback?code&state` — **public** (`@MarketingPublic`); verifies state, exchanges, lists assets, persists pending, 302 → `${APP_URL}/social?connect=<id>` (or `?error=` on failure). Never logs code/token/state.
- `GET /marketing/social/oauth/pending/:id` — auth'd; returns the asset list to choose from (no tokens).
- `POST /marketing/social/oauth/pending/:id/confirm { selected: string[] }` — auth'd; creates SocialAccount rows for the selected externalIds; deletes pending.
- Redirect URI registered per provider: `${API_URL}/marketing/social/oauth/<network>/callback`.

## Token refresh

A scheduled job (reuse the existing marketing scheduled-jobs runner) runs hourly: for accounts with `tokenExpiresAt` within 7 days and a `refreshToken`, call the provider refresh, re-seal the new token/expiry. On failure: `enabled=false`, `lastError='reauth_required'`. Meta page tokens (non-expiring) are skipped. UI shows a "Reconnect" affordance for accounts in `reauth_required`.

## Security & multi-tenancy

- `state` is HMAC-signed (`MARKETING_SECRET_KEY`), carries `{workspaceId, network, nonce, exp}`; callback rejects expired/forged/mismatched-network state → CSRF-safe and workspace-bound.
- All provider tokens (access + refresh) sealed AES-256-GCM (`sealSecret`); never returned raw, never logged. Pending payload also sealed.
- Start/confirm require auth + MANAGER role + the network env-configured. Callback is public by necessity (provider redirect) but does nothing without a valid signed state.
- Everything workspace-scoped; pending rows scoped + TTL-swept.

## Prerequisites (one-time ops, per platform)

1. Create the developer app (Meta, LinkedIn, TikTok), enable the products (FB Login, IG, LinkedIn Share, TikTok Content Posting).
2. Register redirect URI `${API_URL}/marketing/social/oauth/<network>/callback`.
3. Set prod env: `META_APP_ID/SECRET`, `LINKEDIN_CLIENT_ID/SECRET`, `TIKTOK_CLIENT_KEY/SECRET`, and `APP_URL` (frontend base for the post-connect redirect).
4. Submit each app for review/audit (parallel track; testers work meanwhile).

## Phasing (build order)

- **Phase A — Meta (Facebook + Instagram):** shared Meta app; the highest-value pair and one app covers both. State util + config + Meta provider + start/callback/confirm + pending model + migration + frontend connect buttons + select dialog + Facebook/Instagram end-to-end. This proves the whole pattern.
- **Phase B — LinkedIn:** provider + person/org asset listing + adapter org-URN change + refresh.
- **Phase C — TikTok:** provider + refresh (mandatory) + video-only note in UI.
- **Phase D — Token-refresh job + reconnect UX** (Meta page tokens excepted).

Each phase its own plan section; Phase A is the gating vertical slice. Live OAuth round-trip validated once the provider apps + env are set (deferred, like prior integrations); all logic unit-tested with mocked fetch meanwhile.

## Testing

- **BE unit:** state sign/verify (tamper, expiry, wrong network); each provider's `buildAuthorizeUrl` (scopes/redirect/state present), `exchangeCode` + `listAssets` parsing (mocked fetch, success + error shapes), `refresh`; service confirm creates correct SocialAccount rows + seals tokens + scopes to workspace; LinkedIn adapter person vs org URN selection; refresh job marks `reauth_required` on failure.
- **FE unit:** connect buttons render per configured network (status endpoint), clicking start hits the start endpoint + redirects; select dialog lists assets + confirm posts selected ids; `reauth_required` accounts show Reconnect.
- **Live validation (deferred):** real OAuth round-trip per network once apps/env exist — connect → pick page → publish a test post → appears on the page with correct identity.

## Out of scope (YAGNI)

Story/Reels-specific options, post analytics/insights ingestion, multi-image carousels beyond current adapter behavior, scheduling changes, provider webhook-driven token revocation handling (refresh-failure → reconnect covers it), agency-level shared connections.
