# Social OAuth Connect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One-click OAuth "Connect" per network (Facebook, Instagram, LinkedIn, TikTok) for the Social Planner — click → approve on provider → pick page(s)/account(s) → connected, multi-tenant.

**Architecture:** Shared platform apps (env creds). OAuth 2.0 auth-code flow: authenticated `start` builds an HMAC-`state`-signed authorize URL; public `callback` exchanges the code, lists the user's assets, and stows them in a short-lived sealed `PendingSocialConnection`; the user then picks which assets to connect, creating sealed `SocialAccount` rows the existing publish adapters consume. A scheduled job refreshes expiring tokens.

**Tech Stack:** NestJS 11 + Prisma + Jest (backend); React + react-query + Vitest (frontend). Tokens sealed via `sealSecret`/`openSecret` (AES-256-GCM). HTTP via `safeFetch`. HMAC via `crypto` (mirror `netgsm-callback.util`).

---

## Reference: established integration points (verified)

- Public route decorator: `import { MarketingPublic } from '../decorators/marketing-public.decorator'` → `@MarketingPublic()` makes `MarketingGuard` skip auth.
- Secret box: `import { sealSecret, openSecret, isSecretBoxConfigured } from '../../../common/crypto/secret-box.helper'`.
- HTTP: `import { safeFetch } from '../../../common/util/safe-fetch'` — `safeFetch(url, { method, headers, body, timeoutMs })` returns a fetch-like `Response`.
- Current user: `@CurrentMarketingUser() u: MarketingUserPayload` → `u.workspaceId`, `u.id`, `u.role`.
- Roles: `@MarketingRoles('MANAGER')` + `MarketingRolesGuard` (admits OWNER too). Permissions: `PermissionsGuard`.
- Frontend API base: `import { API_URL } from '../../../lib/env'` (value already used by `marketingApi`).
- Backend frontend-redirect base: `process.env.APP_URL`.
- Social planner service/controller live in `backend/src/modules/marketing/social-planner/`. Publish adapters: `network-adapters.ts`. Status endpoint: `GET /marketing/social-planner/status` returns `{FACEBOOK,INSTAGRAM,LINKEDIN,TIKTOK,secretBoxConfigured}` booleans (from `isNetworkConfigured`).

## File structure

**Backend (new, under `src/modules/marketing/social-planner/oauth/`):**
- `social-oauth.config.ts` — per-network config: authorize/token URLs, scopes, env-var names, `redirectUri(network)`, `isConfigured(network)`.
- `social-oauth-state.util.ts` — `signState`/`verifyState` (HMAC, TTL). Pure.
- `social-oauth.providers.ts` — per-network `buildAuthorizeUrl`, `exchangeCode`, `listAssets`, `refresh`; normalized return types.
- `social-oauth.service.ts` — start/handleCallback/listPending/confirm + PendingSocialConnection lifecycle; seals tokens; workspace-scoped.
- `social-oauth.controller.ts` — `start` (auth), `callback` (public), `pending/:id` (auth), `pending/:id/confirm` (auth).
- `social-token-refresh.service.ts` — scheduled refresh of expiring tokens.

**Backend (modified):**
- `prisma/schema.prisma` — `SocialAccount` +`refreshToken`/`accountType`/`connectedVia`/`lastError`; new `PendingSocialConnection`.
- `network-adapters.ts` — LinkedIn person-vs-org URN from `accountType`; accept `accountType` on `AccountRow`.
- `social-planner.module.ts` (or `marketing.module.ts`) — register new controller + services.

**Frontend (new, under `src/pages/marketing/social/` or feature dir):**
- `useSocialConnect.ts` — start (redirect) + pending fetch + confirm mutations.
- `ConnectAccountButtons.tsx` — one "Connect" button per configured network.
- `AccountSelectDialog.tsx` — multi-select of pending assets → confirm.

**Frontend (modified):**
- `SocialPlannerPage.tsx` — render connect buttons; on `?connect=<id>` open the select dialog; show `reauth_required` reconnect.

---

## Phase A — Meta (Facebook + Instagram) vertical slice

### Task A1: Prisma schema — SocialAccount fields + PendingSocialConnection

**Files:** Modify `backend/prisma/schema.prisma`; generate client + migration.

- [ ] **Step 1: Add fields to `SocialAccount`** (after `tokenExpiresAt`):

```prisma
  refreshToken  String?  @db.Text   // SEALED — provider refresh token
  accountType   String?             // PAGE | IG_BUSINESS | LI_PERSON | LI_ORG | TIKTOK
  connectedVia  String   @default("MANUAL")  // MANUAL | OAUTH
  lastError     String?             // e.g. 'reauth_required'
```

- [ ] **Step 2: Add the pending model** (after `SocialAccount`):

```prisma
/// Short-lived handoff between OAuth callback and the user's account-pick step.
model PendingSocialConnection {
  id          String   @id @default(uuid())
  workspaceId String
  network     String
  payload     String   @db.Text   // SEALED JSON: { token, refreshToken?, expiresAt?, assets:[...] }
  createdAt   DateTime @default(now())
  expiresAt   DateTime

  @@index([workspaceId])
  @@map("pending_social_connections")
}
```

- [ ] **Step 3: Generate client + migration**

Run: `cd backend && npx prisma generate` (works without DB).
For the migration SQL, generate via the throwaway-docker-postgres method used in this repo (no local dev DB): spin a temp postgres, `DATABASE_URL=... npx prisma migrate dev --name social_oauth_fields --create-only`, then discard. If unavailable, hand-author `backend/prisma/migrations/<ts>_social_oauth_fields/migration.sql` with `ALTER TABLE social_accounts ADD COLUMN ...` (nullable + default 'MANUAL' for connectedVia) and `CREATE TABLE pending_social_connections (...)`. Migration is additive (safe; prod auto-applies on deploy).

- [ ] **Step 4: Commit** — `git add backend/prisma && git commit -m "feat(social): schema for OAuth tokens + pending connections"`

### Task A2: OAuth state util (HMAC sign/verify)

**Files:** Create `backend/src/modules/marketing/social-planner/oauth/social-oauth-state.util.ts` + `.spec.ts`.

- [ ] **Step 1: Write the failing test** (`social-oauth-state.util.spec.ts`):

```ts
import { signState, verifyState } from './social-oauth-state.util';

describe('social oauth state', () => {
  const env = process.env;
  beforeAll(() => { process.env.MARKETING_SECRET_KEY = 'x'.repeat(64); });
  afterAll(() => { process.env = env; });

  it('round-trips workspace + network', () => {
    const s = signState({ workspaceId: 'ws1', network: 'FACEBOOK' });
    const v = verifyState(s);
    expect(v).toMatchObject({ workspaceId: 'ws1', network: 'FACEBOOK' });
  });

  it('rejects a tampered token', () => {
    const s = signState({ workspaceId: 'ws1', network: 'FACEBOOK' });
    expect(verifyState(s.slice(0, -2) + 'aa')).toBeNull();
  });

  it('rejects an expired token', () => {
    const s = signState({ workspaceId: 'ws1', network: 'FACEBOOK' }, -1);
    expect(verifyState(s)).toBeNull();
  });

  it('rejects garbage', () => {
    expect(verifyState('not-a-token')).toBeNull();
  });
});
```

- [ ] **Step 2: Run → FAIL** (`npx jest social-oauth-state`).

- [ ] **Step 3: Implement:**

```ts
import { createHmac, timingSafeEqual } from 'crypto';

const TTL_MS = 10 * 60 * 1000;

function key(): string {
  const k = process.env.MARKETING_SECRET_KEY;
  if (!k) throw new Error('MARKETING_SECRET_KEY not set');
  return k;
}

export interface StatePayload {
  workspaceId: string;
  network: string;
  nonce: string;
  exp: number;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function signState(
  data: { workspaceId: string; network: string },
  ttlMs: number = TTL_MS,
): string {
  const payload: StatePayload = {
    workspaceId: data.workspaceId,
    network: data.network,
    nonce: b64url(createHmac('sha256', key()).update(`${data.workspaceId}:${Date.now()}:${Math.round(performance.now())}`).digest()).slice(0, 16),
    exp: Date.now() + ttlMs,
  };
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = b64url(createHmac('sha256', key()).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyState(token: string): StatePayload | null {
  try {
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    const expected = b64url(createHmac('sha256', key()).update(body).digest());
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()) as StatePayload;
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
```

Note: `performance.now()` — import from `perf_hooks` if needed (`import { performance } from 'perf_hooks'`). Jest's fake-timer ban (`Date.now`) does NOT apply to backend Jest; only the workflow JS sandbox bans it. Backend specs already use `Date.now()` freely.

- [ ] **Step 4: Run → PASS. Step 5: Commit** — `feat(social): OAuth state HMAC util`.

### Task A3: OAuth config (per-network endpoints/scopes)

**Files:** Create `oauth/social-oauth.config.ts` + `.spec.ts`.

- [ ] **Step 1: Failing test** — assert `isConfigured('FACEBOOK')` reflects env, `redirectUri('FACEBOOK')` ends with `/marketing/social/oauth/facebook/callback`, and `NETWORK_OAUTH.FACEBOOK.scopes` includes `pages_manage_posts`.

```ts
import { NETWORK_OAUTH, isOAuthConfigured, redirectUri } from './social-oauth.config';
describe('social oauth config', () => {
  it('builds the redirect uri from API_URL', () => {
    process.env.API_URL = 'https://api.example.com/api';
    expect(redirectUri('FACEBOOK')).toBe('https://api.example.com/api/marketing/social/oauth/facebook/callback');
  });
  it('facebook requires page publish scope', () => {
    expect(NETWORK_OAUTH.FACEBOOK.scopes).toContain('pages_manage_posts');
  });
  it('isOAuthConfigured reflects env presence', () => {
    delete process.env.META_APP_ID; delete process.env.META_APP_SECRET;
    expect(isOAuthConfigured('FACEBOOK')).toBe(false);
    process.env.META_APP_ID = 'a'; process.env.META_APP_SECRET = 'b';
    expect(isOAuthConfigured('FACEBOOK')).toBe(true);
  });
});
```

- [ ] **Step 2: FAIL. Step 3: Implement:**

```ts
export type Network = 'FACEBOOK' | 'INSTAGRAM' | 'LINKEDIN' | 'TIKTOK';

interface OAuthDef {
  authorizeUrl: string;
  scopes: string[];
  clientIdEnv: string;
  clientSecretEnv: string;
}

export const NETWORK_OAUTH: Record<Network, OAuthDef> = {
  FACEBOOK: {
    authorizeUrl: 'https://www.facebook.com/v19.0/dialog/oauth',
    scopes: ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement', 'business_management'],
    clientIdEnv: 'META_APP_ID',
    clientSecretEnv: 'META_APP_SECRET',
  },
  INSTAGRAM: {
    authorizeUrl: 'https://www.facebook.com/v19.0/dialog/oauth',
    scopes: ['pages_show_list', 'instagram_basic', 'instagram_content_publish', 'business_management'],
    clientIdEnv: 'META_APP_ID',
    clientSecretEnv: 'META_APP_SECRET',
  },
  LINKEDIN: {
    authorizeUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    scopes: ['openid', 'profile', 'w_member_social', 'w_organization_social', 'r_organization_admin'],
    clientIdEnv: 'LINKEDIN_CLIENT_ID',
    clientSecretEnv: 'LINKEDIN_CLIENT_SECRET',
  },
  TIKTOK: {
    authorizeUrl: 'https://www.tiktok.com/v2/auth/authorize/',
    scopes: ['user.info.basic', 'video.publish'],
    clientIdEnv: 'TIKTOK_CLIENT_KEY',
    clientSecretEnv: 'TIKTOK_CLIENT_SECRET',
  },
};

export function clientId(n: Network): string | undefined { return process.env[NETWORK_OAUTH[n].clientIdEnv]; }
export function clientSecret(n: Network): string | undefined { return process.env[NETWORK_OAUTH[n].clientSecretEnv]; }
export function isOAuthConfigured(n: Network): boolean { return !!(clientId(n) && clientSecret(n)); }

export function redirectUri(n: Network): string {
  const base = (process.env.API_URL ?? '').replace(/\/$/, '');
  return `${base}/marketing/social/oauth/${n.toLowerCase()}/callback`;
}
```

- [ ] **Step 4: PASS. Step 5: Commit** — `feat(social): OAuth per-network config`.

### Task A4: Meta provider (authorize URL, code exchange, asset listing)

**Files:** Create `oauth/social-oauth.providers.ts` + `.spec.ts` (Meta portion first; LinkedIn/TikTok added in Phases B/C).

Define normalized types and the Meta functions. `listAssets` returns Facebook Pages AND the IG business account behind each page, tagged by `accountType`, each carrying its own page token.

- [ ] **Step 1: Failing test** (mock `safeFetch`):

```ts
import * as fetchMod from '../../../../common/util/safe-fetch';
import { metaProvider } from './social-oauth.providers';

jest.mock('../../../../common/util/safe-fetch');
const mockFetch = fetchMod.safeFetch as jest.Mock;
const res = (body: any, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => body });

describe('metaProvider.listAssets', () => {
  beforeEach(() => { process.env.META_APP_ID='a'; process.env.META_APP_SECRET='b'; mockFetch.mockReset(); });
  it('returns pages + their IG accounts', async () => {
    mockFetch
      .mockResolvedValueOnce(res({ data: [{ id: 'P1', name: 'Acme', access_token: 'pt1' }] })) // /me/accounts
      .mockResolvedValueOnce(res({ instagram_business_account: { id: 'IG1' }, name: 'Acme' })); // page?fields=ig
    const assets = await metaProvider.listAssets('USERTOKEN');
    expect(assets).toEqual(expect.arrayContaining([
      expect.objectContaining({ externalId: 'P1', accountType: 'PAGE', token: 'pt1' }),
      expect.objectContaining({ externalId: 'IG1', accountType: 'IG_BUSINESS', token: 'pt1' }),
    ]));
  });
});

describe('metaProvider.buildAuthorizeUrl', () => {
  it('includes client_id, scope, redirect, state', () => {
    process.env.META_APP_ID='APPID'; process.env.API_URL='https://api.x/api';
    const url = metaProvider.buildAuthorizeUrl('FACEBOOK', 'STATE');
    expect(url).toContain('client_id=APPID');
    expect(url).toContain('state=STATE');
    expect(decodeURIComponent(url)).toContain('pages_manage_posts');
    expect(decodeURIComponent(url)).toContain('/marketing/social/oauth/facebook/callback');
  });
});
```

- [ ] **Step 2: FAIL. Step 3: Implement** (`social-oauth.providers.ts`):

```ts
import { safeFetch } from '../../../../common/util/safe-fetch';
import {
  NETWORK_OAUTH, Network, clientId, clientSecret, redirectUri,
} from './social-oauth.config';

export interface ConnectableAsset {
  externalId: string;
  displayName: string;
  accountType: string; // PAGE | IG_BUSINESS | LI_PERSON | LI_ORG | TIKTOK
  token?: string;      // per-asset token (FB/IG page token); falls back to the user token
}

export interface ExchangeResult {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
}

const GRAPH = 'https://graph.facebook.com/v19.0';

function authorizeUrl(network: Network, state: string): string {
  const def = NETWORK_OAUTH[network];
  const p = new URLSearchParams({
    client_id: clientId(network) ?? '',
    redirect_uri: redirectUri(network),
    state,
    response_type: 'code',
    scope: def.scopes.join(network === 'TIKTOK' ? ',' : (network === 'LINKEDIN' ? ' ' : ',')),
  });
  // TikTok uses client_key, not client_id
  if (network === 'TIKTOK') { p.delete('client_id'); p.set('client_key', clientId(network) ?? ''); }
  return `${def.authorizeUrl}?${p.toString()}`;
}

export const metaProvider = {
  buildAuthorizeUrl: (network: 'FACEBOOK' | 'INSTAGRAM', state: string) => authorizeUrl(network, state),

  async exchangeCode(network: 'FACEBOOK' | 'INSTAGRAM', code: string): Promise<ExchangeResult> {
    // short-lived user token
    const tokRes = await safeFetch(
      `${GRAPH}/oauth/access_token?` + new URLSearchParams({
        client_id: clientId(network) ?? '',
        client_secret: clientSecret(network) ?? '',
        redirect_uri: redirectUri(network),
        code,
      }).toString(),
      { method: 'GET', timeoutMs: 15000 },
    );
    const tok = await tokRes.json() as any;
    if (!tokRes.ok || !tok.access_token) throw new Error(tok?.error?.message ?? 'meta token exchange failed');
    // upgrade to long-lived
    const llRes = await safeFetch(
      `${GRAPH}/oauth/access_token?` + new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: clientId(network) ?? '',
        client_secret: clientSecret(network) ?? '',
        fb_exchange_token: tok.access_token,
      }).toString(),
      { method: 'GET', timeoutMs: 15000 },
    );
    const ll = await llRes.json() as any;
    const accessToken = ll.access_token ?? tok.access_token;
    const expiresAt = ll.expires_in ? new Date(Date.now() + ll.expires_in * 1000) : undefined;
    return { accessToken, expiresAt };
  },

  async listAssets(userToken: string): Promise<ConnectableAsset[]> {
    const out: ConnectableAsset[] = [];
    const pagesRes = await safeFetch(
      `${GRAPH}/me/accounts?fields=id,name,access_token&access_token=${encodeURIComponent(userToken)}`,
      { method: 'GET', timeoutMs: 15000 },
    );
    const pages = await pagesRes.json() as any;
    for (const pg of (pages?.data ?? [])) {
      out.push({ externalId: pg.id, displayName: pg.name, accountType: 'PAGE', token: pg.access_token });
      // IG business account behind the page
      try {
        const igRes = await safeFetch(
          `${GRAPH}/${pg.id}?fields=instagram_business_account{id,username}&access_token=${encodeURIComponent(pg.access_token)}`,
          { method: 'GET', timeoutMs: 15000 },
        );
        const ig = await igRes.json() as any;
        if (ig?.instagram_business_account?.id) {
          out.push({
            externalId: ig.instagram_business_account.id,
            displayName: `${pg.name} (Instagram)`,
            accountType: 'IG_BUSINESS',
            token: pg.access_token,
          });
        }
      } catch { /* page without IG — skip */ }
    }
    return out;
  },
};

// exported for reuse by the controller/service authorize step
export { authorizeUrl as buildAuthorizeUrlGeneric };
```

- [ ] **Step 4: PASS. Step 5: Commit** — `feat(social): Meta OAuth provider`.

### Task A5: PendingSocialConnection + service orchestration

**Files:** Create `oauth/social-oauth.service.ts` + `.spec.ts`.

Service responsibilities: `start(workspaceId, network)` → `{ authorizeUrl }` (throws if not configured); `handleCallback(network, code, state)` → verify state, exchange, list assets, seal+store pending, return `{ pendingId, workspaceId }`; `listPending(workspaceId, id)` → `{ network, assets: [{externalId,displayName,accountType}] }` (no tokens); `confirm(workspaceId, id, selectedIds)` → create SocialAccount rows (seal token + refresh), delete pending.

- [ ] **Step 1: Failing test** — with a mocked PrismaService + mocked providers, assert `confirm` creates one sealed `socialAccount.upsert` per selected id with `connectedVia:'OAUTH'` + correct `accountType`, and deletes the pending row; `start` throws `BadRequestException` when `isOAuthConfigured` is false; `listPending` strips tokens.

```ts
// Pseudostructure (mirror booking.service.spec.ts mock style):
const prisma = {
  pendingSocialConnection: { create: jest.fn(), findFirst: jest.fn(), delete: jest.fn() },
  socialAccount: { upsert: jest.fn().mockResolvedValue({ id: 'a' }) },
};
// confirm: pending.findFirst returns sealed payload with 2 assets; selectedIds=['P1']
// expect socialAccount.upsert called once with create.connectedVia==='OAUTH', accountType==='PAGE', sealed token
// expect pendingSocialConnection.delete called
```

- [ ] **Step 2: FAIL. Step 3: Implement** the service (sealing each asset's token via `sealSecret`, payload via `sealSecret(JSON.stringify(...))`; `listPending`/`confirm` scope by `{ id, workspaceId }`; `confirm` re-seals the per-asset token and writes `tokenExpiresAt`/`refreshToken`). Use the `metaProvider` for `FACEBOOK`/`INSTAGRAM`; a `providerFor(network)` switch (LinkedIn/TikTok added later).

- [ ] **Step 4: PASS. Step 5: Commit** — `feat(social): OAuth service + pending-connection lifecycle`.

### Task A6: OAuth controller (start / callback / pending / confirm)

**Files:** Create `oauth/social-oauth.controller.ts`; register in the social-planner module.

- [ ] **Step 1: Implement controller:**

```ts
@MarketingRoute()
@Controller('marketing/social/oauth')
export class SocialOAuthController {
  constructor(private readonly svc: SocialOAuthService) {}

  @Post(':network/start')
  @UseGuards(MarketingGuard, MarketingRolesGuard)
  @MarketingRoles('MANAGER')
  start(@Param('network') network: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.start(u.workspaceId, network.toUpperCase());
  }

  @Get(':network/callback')
  @MarketingPublic()
  async callback(
    @Param('network') network: string,
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Res() res: Response,
  ) {
    const appUrl = (process.env.APP_URL ?? '').replace(/\/$/, '');
    if (error || !code || !state) {
      return res.redirect(302, `${appUrl}/social?connect_error=1`);
    }
    try {
      const { pendingId } = await this.svc.handleCallback(network.toUpperCase(), code, state);
      return res.redirect(302, `${appUrl}/social?connect=${pendingId}`);
    } catch {
      return res.redirect(302, `${appUrl}/social?connect_error=1`);
    }
  }

  @Get('pending/:id')
  @UseGuards(MarketingGuard, MarketingRolesGuard)
  @MarketingRoles('MANAGER')
  pending(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.listPending(u.workspaceId, id);
  }

  @Post('pending/:id/confirm')
  @UseGuards(MarketingGuard, MarketingRolesGuard)
  @MarketingRoles('MANAGER')
  confirm(@Param('id') id: string, @Body() dto: ConfirmDto, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.confirm(u.workspaceId, id, dto.selected);
  }
}
```

`ConfirmDto`: `@IsArray() @IsString({each:true}) @ArrayMaxSize(50) selected: string[]`. Import guards/decorators as the social-planner controller does; `Response` from `express`; `@Res()` used (Express 5 — call `res.redirect`).

- [ ] **Step 2: Register** the controller + `SocialOAuthService` + providers in the module that declares `SocialPlannerController` (check `social-planner.module.ts`; if the planner is wired in `marketing.module.ts`, add there). Run the marketing suite to confirm DI resolves.

- [ ] **Step 3: Commit** — `feat(social): OAuth controller (start/callback/pending/confirm)`.

### Task A7: Frontend — connect buttons + select dialog (Meta)

**Files:** Create `useSocialConnect.ts`, `ConnectAccountButtons.tsx`, `AccountSelectDialog.tsx`; modify `SocialPlannerPage.tsx`.

- [ ] **Step 1:** `useSocialConnect` — `startConnect(network)` POSTs `/social/oauth/${network}/start` then `window.location.href = authorizeUrl`; `usePending(id)` GETs `/social/oauth/pending/${id}`; `confirm(id, selected)` POSTs `/social/oauth/pending/${id}/confirm` then invalidates `['marketing','social','accounts']`.

- [ ] **Step 2:** `ConnectAccountButtons` — for each network where the status endpoint reports configured, render a "Connect <Network>" button calling `startConnect`. Networks not configured render disabled with a tooltip "Admin must set up the app".

- [ ] **Step 3:** `AccountSelectDialog` — props `{ pendingId }`; fetches pending assets; checkbox list; "Connect selected" → `confirm`.

- [ ] **Step 4:** In `SocialPlannerPage`, read `?connect=` / `?connect_error=` from the URL: on `connect`, open `AccountSelectDialog` with that id; on `connect_error`, toast an error. Render `ConnectAccountButtons` near the existing "Connect account" manual entry.

- [ ] **Step 5:** Vitest — `useSocialConnect`/buttons: clicking Connect hits start; select dialog lists assets + confirm posts selected. Mock `marketingApi` + `window.location`.

- [ ] **Step 6:** `npx tsc --noEmit && npx vitest run src/pages/marketing/social` → green. Commit — `feat(social): OAuth connect buttons + account select (Meta)`.

### Task A8: Phase A verification

- [ ] Backend: `npx jest src/modules/marketing` green. Frontend: `tsc` + `vitest run` + `npm run build` green. Commit any fixups.

---

## Phase B — LinkedIn

### Task B1: LinkedIn provider

**Files:** Modify `oauth/social-oauth.providers.ts` (+ spec).

- [ ] Add `linkedinProvider` with `buildAuthorizeUrl('LINKEDIN', state)` (space-delimited scopes), `exchangeCode` (POST `https://www.linkedin.com/oauth/v2/accessToken`, `grant_type=authorization_code`, form-encoded; returns `access_token`, `expires_in`, `refresh_token`), and `listAssets(token)`:
  - person: GET `https://api.linkedin.com/v2/userinfo` (Bearer) → `{ sub, name }` → asset `{ externalId: sub, displayName: name, accountType: 'LI_PERSON', token }`.
  - orgs: GET `https://api.linkedin.com/v2/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&projection=(elements*(organization~(localizedName)))` (Bearer, `X-Restli-Protocol-Version: 2.0.0`) → for each element, org id from `organization` URN + `localizedName` → asset `{ externalId: orgId, displayName, accountType: 'LI_ORG', token }`.
- [ ] Tests: authorize URL has space-delimited scopes + `w_organization_social`; `listAssets` parses person + orgs (mocked fetch).
- [ ] Commit — `feat(social): LinkedIn OAuth provider (person + org)`.

### Task B2: LinkedIn publish adapter — person vs org URN

**Files:** Modify `network-adapters.ts` (+ spec).

- [ ] Add `accountType?: string` to `AccountRow`. In `publishLinkedIn`, choose author URN:

```ts
const author = account.accountType === 'LI_ORG'
  ? `urn:li:organization:${account.externalId}`
  : `urn:li:person:${account.externalId}`;
```

- [ ] Thread `accountType` from the DB row wherever `AccountRow` is built (the publish path that loads `socialAccount`). Verify the select includes `accountType`.
- [ ] Test: `publishLinkedIn` builds `urn:li:organization:` when `accountType==='LI_ORG'`, else `urn:li:person:` (mock fetch, assert request body author). Commit — `fix(social): LinkedIn org-page publishing`.

### Task B3: wire LinkedIn into `providerFor` + verify

- [ ] `social-oauth.service.providerFor('LINKEDIN')` → linkedinProvider; confirm path seals refresh token. BE suite green. Commit.

---

## Phase C — TikTok

### Task C1: TikTok provider

**Files:** Modify `oauth/social-oauth.providers.ts` (+ spec).

- [ ] `tiktokProvider`: `buildAuthorizeUrl('TIKTOK', state)` (uses `client_key`, comma scopes); `exchangeCode` (POST `https://open.tiktokapis.com/v2/oauth/token/`, form: `client_key`, `client_secret`, `code`, `grant_type=authorization_code`, `redirect_uri`; returns `access_token`, `expires_in`, `refresh_token`, `open_id`); `listAssets(token)` GET `https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name` (Bearer) → single asset `{ externalId: open_id, displayName, accountType: 'TIKTOK', token }`. (open_id may also come from exchange; prefer the user/info call for display name.)
- [ ] Tests: authorize URL uses `client_key` + comma scopes incl. `video.publish`; `listAssets` parses the account. Commit — `feat(social): TikTok OAuth provider`.

### Task C2: wire TikTok into `providerFor` + verify

- [ ] `providerFor('TIKTOK')` → tiktokProvider. BE suite green. Commit.

---

## Phase D — Token refresh job + reconnect UX

### Task D1: refresh service

**Files:** Create `oauth/social-token-refresh.service.ts` + `.spec.ts`.

- [ ] `refreshExpiring()`: find `socialAccount` where `tokenExpiresAt` < now+7d AND `refreshToken` not null AND `enabled=true`; for each, call `providerFor(network).refresh(openSecret(refreshToken))`; on success re-seal new token/refresh/expiry; on failure set `enabled=false, lastError='reauth_required'`. Meta `PAGE`/`IG_BUSINESS` page tokens are non-expiring → skip (no refreshToken stored for them).
- [ ] Add `refresh(refreshToken)` to each provider (Meta: n/a/no-op; LinkedIn + TikTok: real). 
- [ ] Register on the existing marketing scheduled-jobs runner (hourly). Mirror how other periodic marketing jobs register (check `scheduled-jobs`/cron wiring used by e.g. DLR poll or outbox).
- [ ] Tests: success re-seals; failure marks `reauth_required`; non-expiring skipped. Commit — `feat(social): scheduled token refresh`.

### Task D2: reconnect UX

**Files:** Modify `SocialPlannerPage`/account list + the accounts list endpoint to expose `connectedVia`, `accountType`, and a `needsReauth` (`lastError==='reauth_required'`) flag (never the token).

- [ ] Accounts with `needsReauth` render a "Reconnect" button → `startConnect(network)`. Test the flag renders the button. Commit — `feat(social): reconnect prompt for expired accounts`.

### Task D3: env docs

- [ ] Add to `backend/.env.example`: `TIKTOK_CLIENT_KEY=`, `TIKTOK_CLIENT_SECRET=`, and a comment block documenting the redirect URIs + `APP_URL` requirement for the social OAuth flow. Commit.

---

## Final verification

- [ ] `cd backend && npx prisma generate && npx jest src/modules/marketing` → green.
- [ ] `cd frontend && npx tsc --noEmit && npx vitest run && npm run build` → green.
- [ ] Document deferred live validation: per network, set the developer app + env + redirect URI, then OAuth round-trip (connect → pick → publish test) — works for app testers immediately, all tenants after provider review.

## Self-review

**Spec coverage:** start/callback/confirm flow → A5/A6; per-network providers → A4/B1/C1; data model → A1; LinkedIn org → B2; refresh + reconnect → D1/D2; security (HMAC state, sealed tokens) → A2/A5; prerequisites/env → D3; manual form retained (untouched). All spec sections mapped.

**Placeholders:** none — code provided for novel units; repetitive providers (LinkedIn/TikTok) specified with exact endpoints/scopes/parsing + tests.

**Type consistency:** `ConnectableAsset {externalId,displayName,accountType,token?}` and `ExchangeResult {accessToken,refreshToken?,expiresAt?}` used uniformly across providers/service. `accountType` values (PAGE/IG_BUSINESS/LI_PERSON/LI_ORG/TIKTOK) match the schema + adapter. `providerFor(network)` is the single dispatch point. `redirectUri`/`isOAuthConfigured` names consistent across config/providers/controller.
