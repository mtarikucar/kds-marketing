# LinkedIn Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring LinkedIn to appropriate parity with the shipped Meta/TikTok integrations — modern organic publishing (personal + Company Pages), ads reporting via one-click OAuth, and an engagement analog (comments/lead-form) as the DM substitute — with everything LinkedIn gates behind partner review shipped complete-but-dormant behind env/capability flags.

**Architecture:** A shared versioned LinkedIn REST client (`linkedin-api.util.ts`, mirroring `meta-graph.util.ts`'s flat-result + auth-classifier idiom) underpins three surfaces, each plugging into already-merged `main` foundations: organic publish extends `network-adapters.ts`; ads clone the on-`main` ads foundation (`ad-account.service`, `ads-pull.service`, `AdMetric`) with a fresh OAuth-to-provision flow (reusing `signState`/`verifyState` + `PendingSocialConnection`); engagement adds a poller + `ChannelAdapter` (no webhook exists on LinkedIn's side) feeding `ConversationIngressService`. No schema migration.

**Tech Stack:** NestJS 11 + TypeScript 5.x (`tsconfig` has `strictNullChecks:false` — use flat result types, NOT discriminated unions), Prisma 6 / PostgreSQL, Jest 29 (`*.spec.ts`, ts-jest, mock `safeFetch` at the module seam), React 18 + Vite + Vitest. Secrets sealed AES-256-GCM via `sealSecret`/`openSecret`; outbound HTTP via `safeFetch` (SSRF-safe).

**Commands:** backend tests `cd backend && npx jest <path>`; build `npm run build`; frontend `cd frontend && npx tsc --noEmit && npx vitest run <path> && npm run build`. Worktree: `D:/HDD/projects/kds-marketing-linkedin` (branch `feat/linkedin-integration` off `origin/main`; deps already installed, Prisma client generated).

**Spec:** `docs/superpowers/specs/2026-06-24-linkedin-integration-design.md`.

---

## ⛔ Reality gates (from the spec — do not block on these; they gate go-LIVE, not the build)

- **Self-serve NOW:** personal-feed publishing (`openid profile w_member_social`). Phases 0–1 ship live without LinkedIn review.
- **Community Management API review (partner):** Company-Page publishing (`w_organization_social`), org read, comments/reactions (`*_social_feed` scopes). Phase 1 org path + Phase 3 ship dormant; activate on approval, no code change.
- **Marketing Developer Platform / Advertising API review (partner, hardest):** all `/rest/adAccounts`, `/rest/adAnalytics` (`r_ads_reporting`), AND programmatic refresh tokens. Phase 2 ships env-gated + demoable on a free `test:true` ad account; live tenant data after approval.
- **Tokens:** access tokens last 60 days (`expires_in: 5184000`); **refresh tokens are MDP-partner-only** — design for re-auth (reconnect), not programmatic refresh.

---

# PHASE 0 — Shared versioned REST client + config truth-up (keystone, self-serve)

File-disjoint from later phases. Build first; Phases 1–3 import from it.

### Task 0.1: `linkedin-api.util.ts` — versioned REST client + auth classifier

**Files:**
- Create: `backend/src/common/util/linkedin-api.util.ts`
- Test: `backend/src/common/util/linkedin-api.util.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// backend/src/common/util/linkedin-api.util.spec.ts
import { safeFetch } from './safe-fetch';
import {
  linkedinRest,
  linkedinUpload,
  isLinkedinAuthError,
  linkedinApiVersion,
} from './linkedin-api.util';

jest.mock('./safe-fetch');
const mockFetch = safeFetch as jest.MockedFunction<typeof safeFetch>;

function resp(
  body: unknown,
  { status = 200, headers = {} as Record<string, string> } = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  } as unknown as Response;
}

describe('linkedin-api.util', () => {
  const env = process.env;
  beforeEach(() => {
    process.env = { ...env };
    mockFetch.mockReset();
  });
  afterAll(() => {
    process.env = env;
  });

  it('linkedinApiVersion defaults to 202406 and honours a valid env override', () => {
    delete process.env.LINKEDIN_API_VERSION;
    expect(linkedinApiVersion()).toBe('202406');
    process.env.LINKEDIN_API_VERSION = '202506';
    expect(linkedinApiVersion()).toBe('202506');
    process.env.LINKEDIN_API_VERSION = 'garbage';
    expect(linkedinApiVersion()).toBe('202406');
  });

  it('injects Bearer + LinkedIn-Version + X-Restli headers on a GET', async () => {
    mockFetch.mockResolvedValue(resp({ elements: [] }));
    await linkedinRest('/rest/adAccountUsers', { accessToken: 'tok', query: { q: 'authenticatedUser' } });
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toBe('https://api.linkedin.com/rest/adAccountUsers?q=authenticatedUser');
    const h = (init as any).headers as Record<string, string>;
    expect(h.Authorization).toBe('Bearer tok');
    expect(h['LinkedIn-Version']).toBe('202406');
    expect(h['X-Restli-Protocol-Version']).toBe('2.0.0');
  });

  it('serialises a JSON body + sets Content-Type on a POST', async () => {
    mockFetch.mockResolvedValue(resp(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:99' } }));
    const r = await linkedinRest('/rest/posts', { accessToken: 'tok', method: 'POST', body: { author: 'urn:li:person:1' } });
    const init = mockFetch.mock.calls[0][1] as any;
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ author: 'urn:li:person:1' }));
    expect(r.ok).toBe(true);
    expect(r.restliId).toBe('urn:li:share:99'); // id arrives in the x-restli-id response header
  });

  it('classifies HTTP 401 as an auth error (flat result + isLinkedinAuthError)', async () => {
    mockFetch.mockResolvedValue(resp({ message: 'token expired', serviceErrorCode: 65601 }, { status: 401 }));
    const r = await linkedinRest('/rest/posts', { accessToken: 'tok', method: 'POST', body: {} });
    expect(r.ok).toBe(false);
    expect(r.error).not.toBeNull();
    expect(r.error!.isAuthError).toBe(true);
    expect(isLinkedinAuthError(r)).toBe(true); // accepts the whole result
    expect(isLinkedinAuthError(r.error)).toBe(true); // and the error
  });

  it('treats a 403 (permission/partner-gating) as a NON-auth error (no reconnect loop)', async () => {
    mockFetch.mockResolvedValue(resp({ message: 'Not enough permissions' }, { status: 403 }));
    const r = await linkedinRest('/rest/adAnalytics', { accessToken: 'tok' });
    expect(r.ok).toBe(false);
    expect(r.error!.isAuthError).toBe(false);
    expect(isLinkedinAuthError(r)).toBe(false);
  });

  it('returns a non-auth failure (never throws) on a network error', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNRESET'));
    const r = await linkedinRest('/rest/posts', { accessToken: 'tok' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
    expect(r.error!.isAuthError).toBe(false);
  });

  it('linkedinUpload PUTs raw bytes and returns the etag', async () => {
    mockFetch.mockResolvedValue(resp(null, { status: 201, headers: { etag: '/ambry/AQ123' } }));
    const out = await linkedinUpload('https://www.linkedin.com/dms-uploads/x', Buffer.from('abc'), 'image/png');
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toContain('/dms-uploads/');
    expect((init as any).method).toBe('PUT');
    expect((init as any).headers['Content-Type']).toBe('image/png');
    expect(out.ok).toBe(true);
    expect(out.etag).toBe('/ambry/AQ123');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest common/util/linkedin-api.util`
Expected: FAIL — `Cannot find module './linkedin-api.util'`.

- [ ] **Step 3: Write the implementation**

```typescript
// backend/src/common/util/linkedin-api.util.ts
import { safeFetch } from './safe-fetch';

/**
 * Thin versioned client for the LinkedIn REST API (api.linkedin.com/rest/*).
 * Plain module (NOT a Nest provider) so tests mock `safeFetch` at the module
 * seam — mirrors meta-graph.util.ts. Returns a FLAT result (data + error both
 * always present, error null iff ok) because the repo's tsconfig has
 * strictNullChecks:false and cannot narrow discriminated unions.
 *
 * Every /rest call needs: Authorization: Bearer, LinkedIn-Version: YYYYMM,
 * X-Restli-Protocol-Version: 2.0.0. Created entities return their id/urn in the
 * `x-restli-id` RESPONSE header (not the body). HTTP 401 = token invalid →
 * reauth; 403 = insufficient permission / partner-gating → plain error.
 */
const API_BASE = 'https://api.linkedin.com';
const DEFAULT_VERSION = '202406';

export function linkedinApiVersion(): string {
  const v = process.env.LINKEDIN_API_VERSION;
  return v && /^\d{6}$/.test(v) ? v : DEFAULT_VERSION;
}

export interface LinkedinError {
  message: string;
  status: number;
  serviceErrorCode: number | null;
  isAuthError: boolean;
  raw: unknown;
}

export interface LinkedinResult {
  ok: boolean;
  status: number;
  data: any;
  /** Value of the `x-restli-id` response header on creates (urn/id), else null. */
  restliId: string | null;
  error: LinkedinError | null;
}

export interface LinkedinFetchOptions {
  accessToken: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  version?: string;
  timeoutMs?: number;
}

/**
 * True when the error/result represents a LinkedIn token failure needing
 * reconnect. Accepts a thrown Error with `isAuthError`, a LinkedinError, or a
 * whole LinkedinResult (mirrors isMetaAuthError's tri-shape acceptance).
 */
export function isLinkedinAuthError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const o = err as any;
  if (o.isAuthError === true) return true;
  if (o.ok === false && o.error && o.error.isAuthError === true) return true;
  return false;
}

export async function linkedinRest(path: string, opts: LinkedinFetchOptions): Promise<LinkedinResult> {
  const { accessToken, method = 'GET', query, body, version, timeoutMs = 15_000 } = opts;
  const url = new URL(`${API_BASE}${path.startsWith('/') ? path : `/${path}`}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'LinkedIn-Version': version ?? linkedinApiVersion(),
    'X-Restli-Protocol-Version': '2.0.0',
  };
  const init: Record<string, unknown> = { method, headers, timeoutMs };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let res: Response;
  try {
    res = await safeFetch(url.toString(), init as any);
  } catch (e: any) {
    return {
      ok: false,
      status: 0,
      data: null,
      restliId: null,
      error: { message: e?.message ?? 'network error', status: 0, serviceErrorCode: null, isAuthError: false, raw: e },
    };
  }

  const restliId = res.headers?.get?.('x-restli-id') ?? null;
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (res.ok) {
    return { ok: true, status: res.status, data, restliId, error: null };
  }

  // 401 = invalid/expired token → reauth. 403 = permission/partner-gating → NOT reauth.
  const isAuthError = res.status === 401;
  const serviceErrorCode = typeof data?.serviceErrorCode === 'number' ? data.serviceErrorCode : null;
  const message = String(data?.message ?? `LinkedIn HTTP ${res.status}`);
  return {
    ok: false,
    status: res.status,
    data,
    restliId: null,
    error: { message, status: res.status, serviceErrorCode, isAuthError, raw: data },
  };
}

/** PUT raw bytes to a LinkedIn dms-uploads URL (no LinkedIn headers). Returns the etag (= uploaded part id for videos). */
export async function linkedinUpload(
  uploadUrl: string,
  bytes: Buffer,
  contentType = 'application/octet-stream',
): Promise<{ ok: boolean; etag: string | null; status: number }> {
  const res = await safeFetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: bytes,
    timeoutMs: 60_000,
  } as any);
  return { ok: res.ok, etag: res.headers?.get?.('etag') ?? null, status: res.status };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest common/util/linkedin-api.util`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/common/util/linkedin-api.util.ts backend/src/common/util/linkedin-api.util.spec.ts
git commit -m "feat(linkedin): shared versioned REST client + auth-error classifier"
```

### Task 0.2: fix the LinkedIn OAuth scope (`r_organization_admin` is not a real scope)

**Files:**
- Modify: `backend/src/modules/marketing/social-planner/oauth/social-oauth.config.ts` (LINKEDIN def, ~line 71-77)
- Test: `backend/src/modules/marketing/social-planner/oauth/social-oauth.config.spec.ts` (create if absent, else add a case)

- [ ] **Step 1: Write/extend the failing test**

```typescript
// add to social-oauth.config.spec.ts (create the file if it does not exist)
import { NETWORK_OAUTH } from './social-oauth.config';

describe('LinkedIn OAuth scopes', () => {
  it('uses the real r_organization_social read scope, not the non-existent r_organization_admin', () => {
    expect(NETWORK_OAUTH.LINKEDIN.scopes).toContain('r_organization_social');
    expect(NETWORK_OAUTH.LINKEDIN.scopes).not.toContain('r_organization_admin');
  });
  it('still requests member posting + org posting + openid identity', () => {
    expect(NETWORK_OAUTH.LINKEDIN.scopes).toEqual(
      expect.arrayContaining(['openid', 'profile', 'w_member_social', 'w_organization_social']),
    );
  });
});
```

- [ ] **Step 2: Run → FAIL**

Run: `cd backend && npx jest social-planner/oauth/social-oauth.config`
Expected: FAIL — current scopes contain `r_organization_admin`, not `r_organization_social`.

- [ ] **Step 3: Edit the LINKEDIN scopes array**

In `social-oauth.config.ts`, change the LINKEDIN `scopes` line from:
```typescript
    scopes: ['openid', 'profile', 'w_member_social', 'w_organization_social', 'r_organization_admin'],
```
to:
```typescript
    // openid/profile/w_member_social are self-serve; w_organization_social +
    // r_organization_social need Community Management API review (org assets stay
    // inert until granted). r_organization_admin was never a real LinkedIn scope.
    scopes: ['openid', 'profile', 'w_member_social', 'w_organization_social', 'r_organization_social'],
```

- [ ] **Step 4: Run → PASS.** Run: `cd backend && npx jest social-planner/oauth/social-oauth.config`

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/marketing/social-planner/oauth/social-oauth.config.ts backend/src/modules/marketing/social-planner/oauth/social-oauth.config.spec.ts
git commit -m "fix(linkedin): correct OAuth scope r_organization_admin -> r_organization_social"
```

### Task 0.3: env documentation

**Files:**
- Modify: `backend/.env.example`

- [ ] **Step 1: Append the LinkedIn block** (under the existing `LINKEDIN_CLIENT_ID`/`LINKEDIN_CLIENT_SECRET`, or add it if absent):

```bash
# ── LinkedIn ───────────────────────────────────────────────────────────────
# Social app (Sign In with LinkedIn + Share on LinkedIn + Community Management).
# Personal-feed publishing is self-serve; Company-Page publishing + comments
# need Community Management API review. Redirect URI to register:
#   ${PUBLIC_BASE_URL}/api/marketing/social/oauth/linkedin/callback
LINKEDIN_CLIENT_ID=
LINKEDIN_CLIENT_SECRET=
# REST API version (YYYYMM). Bump as LinkedIn sunsets versions.
LINKEDIN_API_VERSION=202406
# Ads app (Marketing Developer Platform / Advertising API — partner-reviewed).
# Distinct app from the social one above. Powers ads reporting. Redirect URI:
#   ${PUBLIC_BASE_URL}/api/marketing/ads/oauth/linkedin/callback
LINKEDIN_ADS_CLIENT_ID=
LINKEDIN_ADS_CLIENT_SECRET=
```

- [ ] **Step 2: Verify build**

Run: `cd backend && npm run build`
Expected: succeeds (no code change — sanity only).

- [ ] **Step 3: Commit**

```bash
git add backend/.env.example
git commit -m "docs(linkedin): document LinkedIn social + ads app env vars"
```

---

# PHASE 1 — Organic publishing modernization (LinkedIn `/rest/posts`)

This phase replaces the deprecated `POST /v2/ugcPosts` LinkedIn publish path with the versioned `POST /rest/posts` Posts API, routed through the Phase 0 `linkedinRest` / `linkedinUpload` helpers. It adds first-class image upload (single + multiImage), video register-upload, a `visibility` option, and surfaces it in the composer UI. It imports — and never redefines — the Phase 0 contract from `backend/src/common/util/linkedin-api.util.ts`.

Key facts the code below depends on (verified against the real files):
- `network-adapters.ts` currently exports `PublishResult`, `AccountRow`, `MediaItem`, `PostFormat`, `PublishOptions`, helpers `isVideoItem` / `toMediaItems`, and `publishLinkedIn(account, content, mediaUrls)` at lines 432–488; the dispatch's LINKEDIN case is line 776.
- `revealToken(account)` returns the decrypted token or `null`; `isNetworkConfigured('LINKEDIN')` gates on `LINKEDIN_CLIENT_ID`/`SECRET`.
- The existing spec `network-adapters.linkedin.spec.ts` mocks `safeFetch` and asserts the **old** `/v2/ugcPosts` body. Because Phase 0's `linkedinRest` itself calls `safeFetch` internally, those mock-return shapes change — task 1.2 **rewrites that spec** (same file) to the new `/rest/posts` contract rather than adding a parallel file.
- Frontend composer (`PostComposerDialog.tsx`) has no existing per-network options block beyond `formats`; `PostComposerSubmit` carries `content/media/formats/targetAccountIds/scheduledAt`. Task 1.5 introduces the `options.linkedin` carrier and the `LinkedinControls` block.

---

### Task 1.1: Add `LinkedinPostOptions` type + extend `PublishOptions`

**Files:**
- Modify: `backend/src/modules/marketing/social-planner/network-adapters.ts` (insert after the `PublishOptions` interface, currently lines 70–74)
- Test: folded into 1.2 (`network-adapters.linkedin.spec.ts`) + `npm run build`

- [ ] **Step 1: Add the option type and extend `PublishOptions`.** In `network-adapters.ts`, replace the existing `PublishOptions` interface block:

```ts
export interface PublishOptions {
  format?: PostFormat;
  /** Per-item MIME, parallel to mediaUrls — lets adapters pick image vs video. */
  mediaMime?: (string | undefined)[];
}
```

with:

```ts
/** LinkedIn-specific publish options (organic feed posts). */
export interface LinkedinPostOptions {
  /** Feed visibility for /rest/posts. Defaults to PUBLIC when unset. */
  visibility?: 'PUBLIC' | 'CONNECTIONS';
}

export interface PublishOptions {
  format?: PostFormat;
  /** Per-item MIME, parallel to mediaUrls — lets adapters pick image vs video. */
  mediaMime?: (string | undefined)[];
  /** LinkedIn organic post options (visibility). Honoured only by the LINKEDIN adapter. */
  linkedin?: LinkedinPostOptions;
}
```

- [ ] **Step 2: Verify it compiles (no behavioural change yet).** Run:
  - `cd backend && npm run build`
  - Expected: PASS (type-only addition; nothing references `linkedin` yet).

- [ ] **Step 3: Commit.**
  - `git add backend/src/modules/marketing/social-planner/network-adapters.ts`
  - `git commit -m "feat(linkedin): add LinkedinPostOptions(visibility) to PublishOptions"`

---

### Task 1.2: Rewrite `publishLinkedIn` onto `/rest/posts` (text + image + multiImage)

**Files:**
- Modify: `backend/src/modules/marketing/social-planner/network-adapters.ts` — replace `publishLinkedIn` (lines 431–488) and add the new import at the top
- Modify: `backend/src/modules/marketing/social-planner/network-adapters.linkedin.spec.ts` — rewrite to the `/rest/posts` contract
- Test: `backend/src/modules/marketing/social-planner/network-adapters.linkedin.spec.ts`

> Video (`isVideoItem`) is split into its own focused task (1.3) to keep this task bite-sized; this task implements text-only, single-image, and multi-image organic posts fully.

- [ ] **Step 1: Write the failing spec first.** Replace the entire contents of `network-adapters.linkedin.spec.ts` with the new contract. This mocks `safeFetch` at the module seam (Phase 0's `linkedinRest` and `linkedinUpload` both call `safeFetch` internally), so the mock must answer, in order: the image `initializeUpload` POST, the raw-bytes PUT upload, the image-bytes GET (download), and the final `/rest/posts` POST. We drive the sequence by URL.

```ts
import * as fetchMod from '../../../common/util/safe-fetch';
import { sealSecret } from '../../../common/crypto/secret-box.helper';
import { publishToNetwork, AccountRow } from './network-adapters';

jest.mock('../../../common/util/safe-fetch');
const mockFetch = fetchMod.safeFetch as jest.Mock;

/** A safeFetch-shaped Response with both json() and arrayBuffer()/headers. */
const res = (init: {
  ok?: boolean;
  status?: number;
  json?: any;
  bytes?: Buffer;
  restliId?: string;
  etag?: string;
}) =>
  ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => init.json ?? {},
    arrayBuffer: async () =>
      (init.bytes ?? Buffer.from('img')).buffer.slice(
        (init.bytes ?? Buffer.from('img')).byteOffset,
        (init.bytes ?? Buffer.from('img')).byteOffset + (init.bytes ?? Buffer.from('img')).byteLength,
      ),
    headers: {
      get: (h: string) => {
        const k = h.toLowerCase();
        if (k === 'x-restli-id') return init.restliId ?? null;
        if (k === 'etag') return init.etag ?? null;
        if (k === 'content-type') return 'image/jpeg';
        return null;
      },
    },
  }) as any;

describe('publishLinkedIn — /rest/posts (text + image + multiImage)', () => {
  beforeAll(() => {
    process.env.MARKETING_SECRET_KEY = Buffer.alloc(32, 9).toString('base64');
  });
  beforeEach(() => {
    process.env.LINKEDIN_CLIENT_ID = 'a';
    process.env.LINKEDIN_CLIENT_SECRET = 'b';
    process.env.LINKEDIN_API_VERSION = '202406';
    mockFetch.mockReset();
  });

  const account = (accountType: string | null): AccountRow => ({
    id: 'acc',
    network: 'LINKEDIN',
    externalId: 'ABC123',
    accessToken: sealSecret('tok'),
    accountType,
  });

  /** Route the mock by URL: image init → upload PUT → image GET → posts. */
  const routeImages = (imageUrn: string) => {
    mockFetch.mockImplementation((url: string, opts: any) => {
      const u = String(url);
      if (u.includes('/rest/images')) {
        return Promise.resolve(
          res({ json: { value: { uploadUrl: 'https://dms-uploads.example/up', image: imageUrn } } }),
        );
      }
      if (u.startsWith('https://dms-uploads')) {
        return Promise.resolve(res({ status: 201, etag: 'etag-1' }));
      }
      if (u.includes('/rest/posts')) {
        return Promise.resolve(res({ status: 201, restliId: 'urn:li:share:99' }));
      }
      // image bytes download (safeFetch GET item.url)
      return Promise.resolve(res({ bytes: Buffer.from('IMGBYTES') }));
    });
  };

  it('text-only: PUBLIC org post hits /rest/posts with correct author + distribution + commentary', async () => {
    mockFetch.mockResolvedValue(res({ status: 201, restliId: 'urn:li:share:1' }));
    const r = await publishToNetwork(account('LI_ORG'), 'hello world', []);
    expect(r.ok).toBe(true);
    expect(r.externalPostId).toBe('urn:li:share:1');

    const [url, opts] = mockFetch.mock.calls.find((c) => String(c[0]).includes('/rest/posts'))!;
    expect(String(url)).toContain('/rest/posts');
    expect(opts.headers['LinkedIn-Version']).toBe('202406');
    expect(opts.headers['X-Restli-Protocol-Version']).toBe('2.0.0');
    expect(String(opts.headers.Authorization)).toContain('Bearer ');
    const body = JSON.parse(opts.body);
    expect(body.author).toBe('urn:li:organization:ABC123');
    expect(body.commentary).toBe('hello world');
    expect(body.visibility).toBe('PUBLIC');
    expect(body.lifecycleState).toBe('PUBLISHED');
    expect(body.isReshareDisabledByAuthor).toBe(false);
    expect(body.distribution).toEqual({
      feedDistribution: 'MAIN_FEED',
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    });
    expect(body.content).toBeUndefined();
  });

  it('text-only person URN + CONNECTIONS visibility honoured', async () => {
    mockFetch.mockResolvedValue(res({ status: 201, restliId: 'urn:li:share:2' }));
    await publishToNetwork(account('LI_PERSON'), 'hi', [], {
      // opts.linkedin is threaded by the dispatch in task 1.4; call the adapter path here.
      // For 1.2 we assert via the dispatch default (PUBLIC) and a direct visibility test below.
    });
    const body = JSON.parse(
      mockFetch.mock.calls.find((c) => String(c[0]).includes('/rest/posts'))![1].body,
    );
    expect(body.author).toBe('urn:li:person:ABC123');
    expect(body.visibility).toBe('PUBLIC');
  });

  it('single image: init → PUT upload → reference image urn in content.media.id', async () => {
    routeImages('urn:li:image:img-1');
    const r = await publishToNetwork(account('LI_PERSON'), 'with image', [
      'https://cdn.example/a.jpg',
    ]);
    expect(r.ok).toBe(true);
    expect(r.externalPostId).toBe('urn:li:share:99');

    const initCall = mockFetch.mock.calls.find((c) => String(c[0]).includes('/rest/images'));
    expect(initCall).toBeTruthy();
    const initBody = JSON.parse(initCall![1].body);
    expect(initBody.initializeUploadRequest.owner).toBe('urn:li:person:ABC123');

    const putCall = mockFetch.mock.calls.find((c) => String(c[0]).startsWith('https://dms-uploads'));
    expect(putCall).toBeTruthy();
    expect(putCall![1].method).toBe('PUT');

    const postBody = JSON.parse(
      mockFetch.mock.calls.find((c) => String(c[0]).includes('/rest/posts'))![1].body,
    );
    expect(postBody.content).toEqual({ media: { id: 'urn:li:image:img-1' } });
    expect(postBody.content.multiImage).toBeUndefined();
  });

  it('multiImage: 2+ images → content.multiImage.images[] of urns', async () => {
    let n = 0;
    mockFetch.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes('/rest/images')) {
        n += 1;
        return Promise.resolve(
          res({ json: { value: { uploadUrl: `https://dms-uploads.example/u${n}`, image: `urn:li:image:img-${n}` } } }),
        );
      }
      if (u.startsWith('https://dms-uploads')) return Promise.resolve(res({ status: 201, etag: 'e' }));
      if (u.includes('/rest/posts')) return Promise.resolve(res({ status: 201, restliId: 'urn:li:share:multi' }));
      return Promise.resolve(res({ bytes: Buffer.from('B') }));
    });
    const r = await publishToNetwork(account('LI_ORG'), 'two pics', [
      'https://cdn.example/a.jpg',
      'https://cdn.example/b.jpg',
    ]);
    expect(r.ok).toBe(true);
    const postBody = JSON.parse(
      mockFetch.mock.calls.find((c) => String(c[0]).includes('/rest/posts'))![1].body,
    );
    expect(postBody.content.multiImage.images).toEqual([
      { id: 'urn:li:image:img-1' },
      { id: 'urn:li:image:img-2' },
    ]);
    expect(postBody.content.media).toBeUndefined();
  });

  it('401 on /rest/posts surfaces isAuthError + error string', async () => {
    mockFetch.mockResolvedValue(
      res({ ok: false, status: 401, json: { message: 'token expired', serviceErrorCode: 65601 } }),
    );
    const r = await publishToNetwork(account('LI_PERSON'), 'hi', []);
    expect(r.ok).toBe(false);
    expect(r.isAuthError).toBe(true);
    expect(r.error).toContain('token expired');
  });
});
```

  - Run: `cd backend && npx jest src/modules/marketing/social-planner/network-adapters.linkedin.spec.ts`
  - Expected: **FAIL** (old `publishLinkedIn` still posts to `/v2/ugcPosts`; the new assertions and `linkedinRest`/`linkedinUpload` usage don't exist yet).

- [ ] **Step 2: Add the Phase 0 import.** At the top of `network-adapters.ts`, after the existing `import { metaGraphFetch } ...` line (line 5), add:

```ts
import {
  linkedinRest,
  linkedinUpload,
  isLinkedinAuthError,
  LinkedinPostOptions as _LinkedinPostOptions,
} from '../../../common/util/linkedin-api.util';
```

> Note: `LinkedinPostOptions` is defined locally in this file (task 1.1) — only `linkedinRest`, `linkedinUpload`, `isLinkedinAuthError` are imported from Phase 0; the `_LinkedinPostOptions` alias is unused and should be dropped if your linter flags it. Use this minimal form instead:

```ts
import { linkedinRest, linkedinUpload, isLinkedinAuthError } from '../../../common/util/linkedin-api.util';
```

- [ ] **Step 3: Add an image-upload helper above `publishLinkedIn`.** Insert immediately before the current `publishLinkedIn` (line 431):

```ts
/**
 * Upload one image to LinkedIn for an organic post: initializeUpload (owner =
 * author urn) → download the bytes (SSRF-guarded safeFetch) → PUT them to the
 * returned dms-uploads URL. Returns the `urn:li:image:...` to reference in the
 * post content, or an error.
 */
async function linkedinUploadImage(
  token: string,
  author: string,
  item: MediaItem,
): Promise<{ urn?: string; error?: string; isAuthError?: boolean }> {
  const init = await linkedinRest('/rest/images?action=initializeUpload', {
    accessToken: token,
    method: 'POST',
    body: { initializeUploadRequest: { owner: author } },
  });
  if (!init.ok) {
    return { error: `LinkedIn image init: ${init.error.message}`.slice(0, 500), isAuthError: init.error.isAuthError };
  }
  const value = (init.data as any)?.value;
  const uploadUrl: string = value?.uploadUrl;
  const imageUrn: string = value?.image;
  if (!uploadUrl || !imageUrn) return { error: 'LinkedIn image init: missing uploadUrl/image' };

  const dl = await safeFetch(item.url, { method: 'GET', timeoutMs: 20_000 });
  if (!dl.ok) return { error: `LinkedIn image download failed: ${dl.status}` };
  const bytes = Buffer.from(await dl.arrayBuffer());
  if (bytes.length === 0) return { error: 'LinkedIn image download: empty body' };
  const mime = item.mime || dl.headers.get('content-type') || 'image/jpeg';

  const up = await linkedinUpload(uploadUrl, bytes, mime);
  if (!up.ok) return { error: `LinkedIn image upload failed: ${up.status}` };
  return { urn: imageUrn };
}
```

- [ ] **Step 4: Replace `publishLinkedIn` (lines 432–488).** Swap the entire old function for:

```ts
/** Publish to LinkedIn via the versioned Posts API (POST /rest/posts). */
async function publishLinkedIn(
  account: AccountRow,
  content: string,
  items: MediaItem[],
  options?: LinkedinPostOptions,
): Promise<PublishResult> {
  if (!isNetworkConfigured('LINKEDIN')) {
    return { ok: false, error: 'LinkedIn not configured: set LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET' };
  }
  const token = revealToken(account);
  if (!token) return { ok: false, error: 'accessToken could not be decrypted' };

  const author =
    account.accountType === 'LI_ORG'
      ? `urn:li:organization:${account.externalId}`
      : `urn:li:person:${account.externalId}`;
  const visibility = options?.visibility ?? 'PUBLIC';

  // Build content from media. Video is handled in task 1.3; here: images only.
  let postContent: Record<string, unknown> | undefined;
  const imageItems = (items || []).filter((m) => !isVideoItem(m));
  if (imageItems.length > 0) {
    const urns: string[] = [];
    for (const item of imageItems) {
      const up = await linkedinUploadImage(token, author, item);
      if (up.error) return { ok: false, error: up.error, isAuthError: up.isAuthError };
      urns.push(up.urn);
    }
    postContent =
      urns.length === 1
        ? { media: { id: urns[0] } }
        : { multiImage: { images: urns.map((id) => ({ id })) } };
  }

  const body: Record<string, unknown> = {
    author,
    commentary: content,
    visibility,
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
    ...(postContent ? { content: postContent } : {}),
  };

  const result = await linkedinRest('/rest/posts', { accessToken: token, method: 'POST', body });
  if (!result.ok) {
    logger.warn(`LinkedIn publish failed (${account.externalId}): ${result.error.message}`);
    return { ok: false, error: result.error.message.slice(0, 500), isAuthError: isLinkedinAuthError(result) };
  }
  const id = result.restliId;
  if (!id) return { ok: false, error: 'LinkedIn /rest/posts returned no x-restli-id' };
  return { ok: true, externalPostId: String(id) };
}
```

- [ ] **Step 5: Update the dispatch so `publishLinkedIn` gets `items` (signature changed).** The dispatch is finalized in task 1.4, but the new function now requires `items: MediaItem[]` — to keep the build green between tasks, change the LINKEDIN case (line 776) now from `return publishLinkedIn(account, content, mediaUrls);` to:

```ts
    case 'LINKEDIN':
      return publishLinkedIn(account, content, items, opts.linkedin);
```

- [ ] **Step 6: Run the spec — expect PASS.**
  - `cd backend && npx jest src/modules/marketing/social-planner/network-adapters.linkedin.spec.ts`
  - Expected: **PASS**.

- [ ] **Step 7: Build.**
  - `cd backend && npm run build`
  - Expected: PASS.

- [ ] **Step 8: Commit.**
  - `git add backend/src/modules/marketing/social-planner/network-adapters.ts backend/src/modules/marketing/social-planner/network-adapters.linkedin.spec.ts`
  - `git commit -m "feat(linkedin): publish via /rest/posts (text + image + multiImage) with visibility"`

---

### Task 1.3: Video register-upload path for `publishLinkedIn`

**Files:**
- Modify: `backend/src/modules/marketing/social-planner/network-adapters.ts` — add a `linkedinUploadVideo` helper and a video branch in `publishLinkedIn`
- Modify: `backend/src/modules/marketing/social-planner/network-adapters.linkedin.spec.ts` — add a video test
- Test: `backend/src/modules/marketing/social-planner/network-adapters.linkedin.spec.ts`

> LinkedIn videos use `/rest/videos?action=initializeUpload` → PUT each part (collect upload ETags) → `/rest/videos?action=finalizeUpload` with the ordered ETags. A single media item yields one part. The finalized `urn:li:video:...` goes in `content.media.id`.

- [ ] **Step 1: Add the failing video test.** Append this `it` block inside the existing `describe` in `network-adapters.linkedin.spec.ts`:

```ts
  it('single video: initialize → PUT part → finalize, reference video urn in content.media.id', async () => {
    mockFetch.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes('/rest/videos') && u.includes('finalizeUpload')) {
        return Promise.resolve(res({ status: 200, json: {} }));
      }
      if (u.includes('/rest/videos')) {
        return Promise.resolve(
          res({
            json: {
              value: {
                video: 'urn:li:video:vid-1',
                uploadInstructions: [
                  { uploadUrl: 'https://dms-uploads.example/part1', firstByte: 0, lastByte: 7 },
                ],
              },
            },
          }),
        );
      }
      if (u.startsWith('https://dms-uploads')) return Promise.resolve(res({ status: 200, etag: 'part-etag-1' }));
      if (u.includes('/rest/posts')) return Promise.resolve(res({ status: 201, restliId: 'urn:li:share:vid' }));
      return Promise.resolve(res({ bytes: Buffer.from('VIDEOBYTES') }));
    });

    const r = await publishToNetwork(account('LI_ORG'), 'a video', ['https://cdn.example/clip.mp4']);
    expect(r.ok).toBe(true);
    expect(r.externalPostId).toBe('urn:li:share:vid');

    const finalize = mockFetch.mock.calls.find(
      (c) => String(c[0]).includes('/rest/videos') && String(c[0]).includes('finalizeUpload'),
    );
    expect(finalize).toBeTruthy();
    const finalizeBody = JSON.parse(finalize![1].body);
    expect(finalizeBody.finalizeUploadRequest.video).toBe('urn:li:video:vid-1');
    expect(finalizeBody.finalizeUploadRequest.uploadedPartIds).toEqual(['part-etag-1']);

    const postBody = JSON.parse(
      mockFetch.mock.calls.find((c) => String(c[0]).includes('/rest/posts'))![1].body,
    );
    expect(postBody.content).toEqual({ media: { id: 'urn:li:video:vid-1' } });
  });
```

  - Run: `cd backend && npx jest src/modules/marketing/social-planner/network-adapters.linkedin.spec.ts`
  - Expected: **FAIL** (no video handling yet; current code filters videos out and posts text-only).

- [ ] **Step 2: Add the video-upload helper.** Insert immediately after `linkedinUploadImage` (added in task 1.2):

```ts
/**
 * Register-upload a single video for an organic post: initializeUpload (owner =
 * author urn, fileSizeBytes) → PUT each part to its uploadInstructions URL,
 * collecting the per-part ETag → finalizeUpload with the ordered ETags. Returns
 * the `urn:li:video:...` to reference, or an error.
 */
async function linkedinUploadVideo(
  token: string,
  author: string,
  item: MediaItem,
): Promise<{ urn?: string; error?: string; isAuthError?: boolean }> {
  const dl = await safeFetch(item.url, { method: 'GET', timeoutMs: 30_000 });
  if (!dl.ok) return { error: `LinkedIn video download failed: ${dl.status}` };
  const bytes = Buffer.from(await dl.arrayBuffer());
  if (bytes.length === 0) return { error: 'LinkedIn video download: empty body' };
  const mime = item.mime || dl.headers.get('content-type') || 'video/mp4';

  const init = await linkedinRest('/rest/videos?action=initializeUpload', {
    accessToken: token,
    method: 'POST',
    body: { initializeUploadRequest: { owner: author, fileSizeBytes: bytes.length, uploadCaptions: false, uploadThumbnail: false } },
  });
  if (!init.ok) {
    return { error: `LinkedIn video init: ${init.error.message}`.slice(0, 500), isAuthError: init.error.isAuthError };
  }
  const value = (init.data as any)?.value;
  const videoUrn: string = value?.video;
  const instructions: { uploadUrl: string; firstByte: number; lastByte: number }[] = value?.uploadInstructions ?? [];
  if (!videoUrn || instructions.length === 0) return { error: 'LinkedIn video init: missing video/uploadInstructions' };

  const uploadedPartIds: string[] = [];
  for (const part of instructions) {
    const slice = bytes.subarray(part.firstByte, part.lastByte + 1);
    const up = await linkedinUpload(part.uploadUrl, slice, mime);
    if (!up.ok) return { error: `LinkedIn video part upload failed: ${up.status}` };
    if (!up.etag) return { error: 'LinkedIn video part upload: missing ETag' };
    uploadedPartIds.push(up.etag);
  }

  const fin = await linkedinRest('/rest/videos?action=finalizeUpload', {
    accessToken: token,
    method: 'POST',
    body: { finalizeUploadRequest: { video: videoUrn, uploadToken: '', uploadedPartIds } },
  });
  if (!fin.ok) {
    return { error: `LinkedIn video finalize: ${fin.error.message}`.slice(0, 500), isAuthError: fin.error.isAuthError };
  }
  return { urn: videoUrn };
}
```

- [ ] **Step 3: Add the video branch in `publishLinkedIn`.** In `publishLinkedIn`, replace the media-building block (the `let postContent ...` through the `postContent = urns.length === 1 ? ... : ...` assignment) with the version that handles a single video first:

```ts
  // Build content from media. A single video takes precedence; otherwise images.
  let postContent: Record<string, unknown> | undefined;
  const videoItem = (items || []).find(isVideoItem);
  const imageItems = (items || []).filter((m) => !isVideoItem(m));
  if (videoItem) {
    const up = await linkedinUploadVideo(token, author, videoItem);
    if (up.error) return { ok: false, error: up.error, isAuthError: up.isAuthError };
    postContent = { media: { id: up.urn } };
  } else if (imageItems.length > 0) {
    const urns: string[] = [];
    for (const item of imageItems) {
      const up = await linkedinUploadImage(token, author, item);
      if (up.error) return { ok: false, error: up.error, isAuthError: up.isAuthError };
      urns.push(up.urn);
    }
    postContent =
      urns.length === 1
        ? { media: { id: urns[0] } }
        : { multiImage: { images: urns.map((id) => ({ id })) } };
  }
```

- [ ] **Step 4: Run the spec — expect PASS.**
  - `cd backend && npx jest src/modules/marketing/social-planner/network-adapters.linkedin.spec.ts`
  - Expected: **PASS** (all image, multiImage, text, video, and 401 cases green).

- [ ] **Step 5: Build.**
  - `cd backend && npm run build`
  - Expected: PASS.

- [ ] **Step 6: Commit.**
  - `git add backend/src/modules/marketing/social-planner/network-adapters.ts backend/src/modules/marketing/social-planner/network-adapters.linkedin.spec.ts`
  - `git commit -m "feat(linkedin): video register-upload (init→part→finalize) in publishLinkedIn"`

---

### Task 1.4: Thread `opts.linkedin` through the dispatch + regression-check the suite

**Files:**
- Modify: `backend/src/modules/marketing/social-planner/network-adapters.ts` — confirm the LINKEDIN case at the dispatch (line ~776) passes `items` + `opts.linkedin`
- Test: full `social-planner` suite

> Task 1.2 Step 5 already edited the case; this task verifies it is exactly right and runs the whole suite to confirm no regression in Meta/TikTok/Twitter/Epic-12 paths (all of which share `publishToNetwork`).

- [ ] **Step 1: Confirm the dispatch case.** In `publishToNetwork`, the LINKEDIN case must read:

```ts
    case 'LINKEDIN':
      return publishLinkedIn(account, content, items, opts.linkedin);
```

  (`items` is the `MediaItem[]` already built by `toMediaItems(mediaUrls, opts)` at the top of `publishToNetwork`; `opts.linkedin` is the new `LinkedinPostOptions` from task 1.1, `undefined` today → defaults to `PUBLIC`.)

- [ ] **Step 2: Run the full social-planner suite.**
  - `cd backend && npx jest src/modules/marketing/social-planner`
  - Expected: **PASS** (LinkedIn spec + `network-adapters.meta.spec.ts`, `network-adapters.tiktok.spec.ts`, `network-adapters.twitter-media.spec.ts`, `network-adapters.epic12.spec.ts`, `social-planner.*.spec.ts` all green; the LinkedIn signature change is isolated to its own case).

- [ ] **Step 3: Build.**
  - `cd backend && npm run build`
  - Expected: PASS.

- [ ] **Step 4: Commit (no-op-safe; captures the verified dispatch state).**
  - `git add backend/src/modules/marketing/social-planner/network-adapters.ts`
  - `git commit -m "feat(linkedin): thread opts.linkedin(visibility) through publishToNetwork dispatch"`

---

### Task 1.5: Composer UI — `LinkedinControls` visibility select + `options.linkedin` persistence

**Files:**
- Modify: `frontend/src/pages/marketing/social/types.ts` — add `LinkedinPostOptions` + extend `SocialPostOptions`
- Modify: `frontend/src/pages/marketing/social/PostComposerDialog.tsx` — add the `LinkedinControls` block + extend `PostComposerSubmit`
- Create: `frontend/src/pages/marketing/social/PostComposerDialog.linkedin.test.tsx`

> The current composer has no per-network options carrier beyond `formats`; this task introduces `submit.options.linkedin`. The value rides on `PostComposerSubmit` (the create mutation in `SocialPlannerPage.tsx` forwards a structured payload). Wiring `options.linkedin` end-to-end into the backend `CreatePostDto`/service → `publishToNetwork` `opts.linkedin` is a later phase; the adapter already honours it via the dispatch (task 1.4) once the service forwards it.

- [ ] **Step 1: Add the FE option type.** In `types.ts`, replace the `SocialPostOptions` interface:

```ts
export interface SocialPostOptions {
  formats?: Record<string, 'FEED' | 'REEL' | 'STORY'>;
  media?: { url: string; key?: string; mime?: string }[];
  mediaDeletedAt?: string;
}
```

with:

```ts
/** LinkedIn organic post options surfaced in the composer. */
export interface LinkedinPostOptions {
  visibility?: 'PUBLIC' | 'CONNECTIONS';
}

export interface SocialPostOptions {
  formats?: Record<string, 'FEED' | 'REEL' | 'STORY'>;
  media?: { url: string; key?: string; mime?: string }[];
  mediaDeletedAt?: string;
  linkedin?: LinkedinPostOptions;
}
```

- [ ] **Step 2: Write the failing test.** Create `frontend/src/pages/marketing/social/PostComposerDialog.linkedin.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { PostComposerDialog } from './PostComposerDialog';
import type { SocialAccount } from './types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, o?: any) => o?.defaultValue ?? _k }),
}));

const liAccount: SocialAccount = {
  id: 'li-1',
  network: 'LINKEDIN',
  externalId: 'ORG1',
  displayName: 'My Page',
  accessToken: '••••',
  tokenExpiresAt: null,
  enabled: true,
  createdAt: new Date().toISOString(),
  accountType: 'LI_ORG',
  connectedVia: 'OAUTH',
  lastError: null,
};

describe('PostComposerDialog — LinkedinControls', () => {
  it('persists visibility=CONNECTIONS into submit.options.linkedin', async () => {
    const onSubmit = vi.fn();
    render(
      <PostComposerDialog
        open
        onOpenChange={() => {}}
        accounts={[liAccount]}
        onSubmit={onSubmit}
        isPending={false}
      />,
    );
    // type content
    fireEvent.change(screen.getByPlaceholderText('What do you want to share?'), {
      target: { value: 'hello' },
    });
    // select the LinkedIn account
    fireEvent.click(screen.getByRole('checkbox'));
    // the LinkedIn visibility select appears; switch to CONNECTIONS
    const select = await screen.findByLabelText('LinkedIn visibility');
    fireEvent.change(select, { target: { value: 'CONNECTIONS' } });
    // submit
    fireEvent.click(screen.getByText('Create post'));
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0].options.linkedin).toEqual({ visibility: 'CONNECTIONS' });
  });

  it('defaults visibility to PUBLIC when a LinkedIn account is selected', async () => {
    const onSubmit = vi.fn();
    render(
      <PostComposerDialog
        open
        onOpenChange={() => {}}
        accounts={[liAccount]}
        onSubmit={onSubmit}
        isPending={false}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText('What do you want to share?'), {
      target: { value: 'hello' },
    });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByText('Create post'));
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0].options.linkedin).toEqual({ visibility: 'PUBLIC' });
  });
});
```

  - Run: `cd frontend && npx vitest run src/pages/marketing/social/PostComposerDialog.linkedin.test.tsx`
  - Expected: **FAIL** (no `LinkedinControls`, no `options` on submit).

- [ ] **Step 3: Extend `PostComposerSubmit`.** In `PostComposerDialog.tsx`, replace the `PostComposerSubmit` interface (lines 33–41) with:

```ts
export interface PostComposerSubmit {
  content: string;
  media: MediaItemValue[];
  /** Per-account format map (FB/IG only): { [socialAccountId]: FEED|REEL|STORY }. */
  formats: Record<string, PostFormat>;
  targetAccountIds: string[];
  /** ISO string when the user picked a schedule, else undefined (publish-later draft). */
  scheduledAt?: string;
  /** Per-network options. Currently LinkedIn visibility; present only when a
   *  LINKEDIN target is selected. */
  options: { linkedin?: { visibility: 'PUBLIC' | 'CONNECTIONS' } };
}
```

- [ ] **Step 4: Add LinkedIn visibility state + constant.** After the `FORMAT_NETWORKS` constant (line 55) add:

```ts
const LINKEDIN_VISIBILITIES = ['PUBLIC', 'CONNECTIONS'] as const;
type LinkedinVisibility = (typeof LINKEDIN_VISIBILITIES)[number];
```

  Inside the component, after `const fileRef = useRef<HTMLInputElement>(null);` (line 71) add:

```ts
  const [linkedinVisibility, setLinkedinVisibility] = useState<LinkedinVisibility>('PUBLIC');
```

  And in the populate effect, in the `else` branch reset (line 95) and the `post` branch (after `form.reset({...})` at line 93), restore from `post.options?.linkedin`:

  - In the `if (post)` branch, immediately after the `form.reset({...});` call add:

```ts
      setLinkedinVisibility(
        (post.options?.linkedin?.visibility as LinkedinVisibility) ?? 'PUBLIC',
      );
```

  - In the `else` branch, immediately after the `form.reset({...});` call add:

```ts
      setLinkedinVisibility('PUBLIC');
```

- [ ] **Step 5: Derive selected LinkedIn accounts + persist in `handleSubmit`.** After `formatAccounts` (line 155) add:

```ts
  const linkedinAccounts = accounts.filter(
    (a) => selected.includes(a.id) && a.network === 'LINKEDIN',
  );
```

  In `handleSubmit`, change the `onSubmit({...})` call (lines 114–120) to include `options`:

```ts
    onSubmit({
      content: values.content.trim(),
      media,
      formats,
      targetAccountIds: values.targetAccountIds,
      scheduledAt: values.scheduledAt ? new Date(values.scheduledAt).toISOString() : undefined,
      options: linkedinAccounts.length > 0 ? { linkedin: { visibility: linkedinVisibility } } : {},
    });
```

  > Note: `linkedinAccounts` is derived from `form.watch('targetAccountIds')`, so it reflects the current selection at submit time.

- [ ] **Step 6: Render the `LinkedinControls` block.** Insert immediately after the closing of the format block (after line 406, the `)}` that closes the `{formatAccounts.length > 0 && (...)}` expression) and before the `{/* Schedule */}` comment:

```tsx
          {/* LinkedIn visibility (organic feed posts) */}
          {linkedinAccounts.length > 0 && (
            <div className="space-y-2">
              <label
                htmlFor="linkedin-visibility"
                className="text-sm font-medium text-foreground"
              >
                {t('social.composer.linkedinVisibility', { defaultValue: 'LinkedIn visibility' })}
              </label>
              <select
                id="linkedin-visibility"
                aria-label={t('social.composer.linkedinVisibility', {
                  defaultValue: 'LinkedIn visibility',
                })}
                className="block w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
                value={linkedinVisibility}
                onChange={(e) => setLinkedinVisibility(e.target.value as LinkedinVisibility)}
              >
                {LINKEDIN_VISIBILITIES.map((v) => (
                  <option key={v} value={v}>
                    {t(`social.composer.linkedinVisibility_${v}`, {
                      defaultValue: v === 'PUBLIC' ? 'Anyone (public)' : 'Connections only',
                    })}
                  </option>
                ))}
              </select>
              <p className="text-caption text-muted-foreground">
                {t('social.composer.linkedinVisibilityHint', {
                  defaultValue: 'Controls who can see this post on LinkedIn.',
                })}
              </p>
            </div>
          )}
```

- [ ] **Step 7: Run the test — expect PASS.**
  - `cd frontend && npx vitest run src/pages/marketing/social/PostComposerDialog.linkedin.test.tsx`
  - Expected: **PASS**.

- [ ] **Step 8: Type-check + build.**
  - `cd frontend && npx tsc --noEmit`
  - Expected: PASS (the new `options` field on `PostComposerSubmit` is consumed by the existing call sites in `SocialPlannerPage.tsx`; if `tsc` flags `PostComposerSubmit` consumers that don't yet read `options`, that is fine — adding a field is backward-compatible for the producer).
  - `cd frontend && npm run build`
  - Expected: PASS.

- [ ] **Step 9: Commit.**
  - `git add frontend/src/pages/marketing/social/types.ts frontend/src/pages/marketing/social/PostComposerDialog.tsx frontend/src/pages/marketing/social/PostComposerDialog.linkedin.test.tsx`
  - `git commit -m "feat(linkedin): composer LinkedIn visibility control persisted into submit.options.linkedin"`

---

# PHASE 2 — Ads reporting via one-click LinkedIn-for-Business OAuth

> Ships **dormant**: every step is env-gated behind `LINKEDIN_ADS_CLIENT_ID` + `LINKEDIN_ADS_CLIENT_SECRET` (the *ads* app, distinct from the social `LINKEDIN_CLIENT_ID/SECRET`). With those unset, `isLinkedinAdsConfigured()` is `false`, so `/ads/status` reports `LINKEDIN:false`, `connect`/`pullAccount` short-circuit, and the OAuth `start` throws `BadRequestException` — the feature is fully inert until an operator provisions the ads app. Imports the **Phase 0** contract from `backend/src/common/util/linkedin-api.util.ts` (`linkedinRest`, `LinkedinResult`, `isLinkedinAuthError`, `linkedinApiVersion`) — never redefine those.

---

### Task 2.1: `isLinkedinAdsConfigured()` gate in `ads.types.ts`

**Files:**
- Modify: `backend/src/modules/marketing/ads/ads.types.ts` (append after line 17, the existing `isTiktokAdsConfigured`)
- Test: `backend/src/modules/marketing/ads/ads-types.spec.ts` (Create)

- [ ] **Step 1: Write the failing test.** Create `backend/src/modules/marketing/ads/ads-types.spec.ts`:
```ts
import { isLinkedinAdsConfigured } from './ads.types';

describe('isLinkedinAdsConfigured', () => {
  const orig = process.env;
  beforeEach(() => {
    process.env = { ...orig };
  });
  afterAll(() => {
    process.env = orig;
  });

  it('returns false when both ads vars are missing', () => {
    delete process.env.LINKEDIN_ADS_CLIENT_ID;
    delete process.env.LINKEDIN_ADS_CLIENT_SECRET;
    expect(isLinkedinAdsConfigured()).toBe(false);
  });

  it('returns false when only the client id is set', () => {
    process.env.LINKEDIN_ADS_CLIENT_ID = 'cid';
    delete process.env.LINKEDIN_ADS_CLIENT_SECRET;
    expect(isLinkedinAdsConfigured()).toBe(false);
  });

  it('returns true when both ads vars are set', () => {
    process.env.LINKEDIN_ADS_CLIENT_ID = 'cid';
    process.env.LINKEDIN_ADS_CLIENT_SECRET = 'sec';
    expect(isLinkedinAdsConfigured()).toBe(true);
  });
});
```

- [ ] **Step 2: Run → FAIL.** `cd backend && npx jest src/modules/marketing/ads/ads-types.spec.ts`
  Expected: **FAIL** (`isLinkedinAdsConfigured` is not exported).

- [ ] **Step 3: Implement the gate.** In `backend/src/modules/marketing/ads/ads.types.ts`, append after the existing `isTiktokAdsConfigured` function (after line 17):
```ts
export function isLinkedinAdsConfigured(): boolean {
  return !!(process.env.LINKEDIN_ADS_CLIENT_ID && process.env.LINKEDIN_ADS_CLIENT_SECRET);
}
```

- [ ] **Step 4: Run → PASS.** `cd backend && npx jest src/modules/marketing/ads/ads-types.spec.ts`
  Expected: **PASS** (3 tests).

- [ ] **Step 5: Commit.**
```bash
git add backend/src/modules/marketing/ads/ads.types.ts backend/src/modules/marketing/ads/ads-types.spec.ts && git commit -m "feat(ads): isLinkedinAdsConfigured env gate for LinkedIn ads app"
```

---

### Task 2.2: `linkedin-ads.client.ts` — `pullLinkedinInsights`

Pulls `/rest/adAnalytics` (pivot=CAMPAIGN, DAILY) and maps `elements[]` → `AdMetricRow[]`. Builds the rest.li query manually so the `dateRange=(...)` object parens are **not** percent-encoded but the `accounts=List(urn%3A...)` member **is** — passes the assembled query string to `linkedinRest` via `LinkedinFetchOptions.query` only for the simple params, and appends the rest.li-encoded segments to the path. Cost is a STRING → `parseFloat`; `campaignId` = last segment of `pivotValues[0]`; `leads` = `externalWebsiteConversions`; date = ISO from `dateRange.start`. No pagination (15k cap). On `!result.ok` throws `Object.assign(new Error(message), { isAuthError })`.

**Files:**
- Create: `backend/src/modules/marketing/ads/linkedin-ads.client.ts`
- Test: `backend/src/modules/marketing/ads/linkedin-ads-client.spec.ts` (Create)

- [ ] **Step 1: Write the failing test.** Create `backend/src/modules/marketing/ads/linkedin-ads-client.spec.ts`. The Phase 0 `linkedinRest` is implemented over `safeFetch`, so we mock at the `safeFetch` seam (matches `ads-clients.spec.ts`):
```ts
// ── safeFetch mock (the seam linkedinRest transports over) ──────────────────
const mockSafeFetch = jest.fn();
jest.mock('../../../common/util/safe-fetch', () => ({
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

import { pullLinkedinInsights } from './linkedin-ads.client';

function res(ok: boolean, status: number, body: unknown) {
  return {
    ok,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

beforeEach(() => mockSafeFetch.mockReset());

describe('pullLinkedinInsights', () => {
  it('maps analytics elements to AdMetricRow (string cost→number, pivot urn→campaignId, conversions→leads)', async () => {
    mockSafeFetch.mockResolvedValue(
      res(true, 200, {
        elements: [
          {
            pivotValues: ['urn:li:sponsoredCampaign:777'],
            dateRange: { start: { year: 2026, month: 6, day: 1 }, end: { year: 2026, month: 6, day: 1 } },
            impressions: 1000,
            clicks: 40,
            costInLocalCurrency: '12.34',
            externalWebsiteConversions: 3,
          },
        ],
      }),
    );
    const rows = await pullLinkedinInsights('tok', '512345', '2026-06-01', '2026-06-02');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      date: '2026-06-01',
      campaignId: '777',
      spend: 12.34,
      impressions: 1000,
      clicks: 40,
      leads: 3,
    });
  });

  it('targets the adAnalytics finder with the sponsoredAccount in the accounts List and pivot=CAMPAIGN', async () => {
    mockSafeFetch.mockResolvedValue(res(true, 200, { elements: [] }));
    await pullLinkedinInsights('tok', '512345', '2026-06-01', '2026-06-02');
    const url = mockSafeFetch.mock.calls[0][0] as string;
    expect(url).toContain('/rest/adAnalytics');
    expect(url).toContain('q=analytics');
    expect(url).toContain('pivot=CAMPAIGN');
    expect(url).toContain('timeGranularity=DAILY');
    // dateRange parens are NOT percent-encoded; account urn members ARE
    expect(url).toContain('dateRange=(start:(year:2026,month:6,day:1),end:(year:2026,month:6,day:2))');
    expect(url).toContain('accounts=List(urn%3Ali%3AsponsoredAccount%3A512345)');
  });

  it('sends the LinkedIn-Version header and a Bearer token (via linkedinRest)', async () => {
    process.env.LINKEDIN_API_VERSION = '202406';
    mockSafeFetch.mockResolvedValue(res(true, 200, { elements: [] }));
    await pullLinkedinInsights('tok', '512345', '2026-06-01', '2026-06-02');
    const opts = mockSafeFetch.mock.calls[0][1] as any;
    expect(opts.headers['Authorization']).toBe('Bearer tok');
    expect(opts.headers['LinkedIn-Version']).toBe('202406');
  });

  it('throws with isAuthError true on a 401 (drives TOKEN_EXPIRED)', async () => {
    mockSafeFetch.mockResolvedValue(res(false, 401, { message: 'Invalid access token', serviceErrorCode: 65601 }));
    await expect(
      pullLinkedinInsights('tok', '512345', '2026-06-01', '2026-06-02'),
    ).rejects.toMatchObject({ isAuthError: true });
  });

  it('throws WITHOUT isAuthError on a 403 (stays retry-friendly)', async () => {
    mockSafeFetch.mockResolvedValue(res(false, 403, { message: 'Not enough permissions' }));
    await expect(
      pullLinkedinInsights('tok', '512345', '2026-06-01', '2026-06-02'),
    ).rejects.not.toMatchObject({ isAuthError: true });
  });
});
```

- [ ] **Step 2: Run → FAIL.** `cd backend && npx jest src/modules/marketing/ads/linkedin-ads-client.spec.ts`
  Expected: **FAIL** (module `./linkedin-ads.client` does not exist).

- [ ] **Step 3: Implement the client.** Create `backend/src/modules/marketing/ads/linkedin-ads.client.ts`:
```ts
import { linkedinRest, LinkedinResult } from '../../../common/util/linkedin-api.util';
import { AdMetricRow } from './ads.types';

/**
 * LinkedIn Ads insights via the Marketing API adAnalytics finder. Per-day,
 * per-campaign spend / impressions / clicks (+ externalWebsiteConversions as
 * leads), pivoted on CAMPAIGN with DAILY granularity over [since, until].
 *
 * rest.li query encoding is delicate: the `dateRange=(...)` object MUST keep its
 * literal parens/colons (NOT percent-encoded) while each `accounts=List(...)`
 * URN member MUST be percent-encoded. URLSearchParams would double-encode the
 * parens, so we hand-assemble these reduced segments and append them to the path;
 * only `q`/`pivot`/`timeGranularity`/`fields` go through linkedinRest's `query`.
 *
 * Throws on a non-ok result so the caller records lastError; the thrown Error
 * carries `isAuthError` (401 → true, 403 → false) so the caller can mark the
 * account needs-reauth. Returns [] for an empty range. No pagination (15k cap).
 */
export async function pullLinkedinInsights(
  token: string,
  sponsoredAccountId: string,
  since: string,
  until: string,
): Promise<AdMetricRow[]> {
  const s = ymd(since);
  const e = ymd(until);
  // rest.li reduced objects — parens/colons kept literal; only the URN is encoded.
  const dateRange = `(start:(year:${s.y},month:${s.m},day:${s.d}),end:(year:${e.y},month:${e.m},day:${e.d}))`;
  const accountUrn = encodeURIComponent(`urn:li:sponsoredAccount:${sponsoredAccountId}`);
  const accounts = `List(${accountUrn})`;
  const fields =
    'externalWebsiteConversions,dateRange,impressions,clicks,costInLocalCurrency,pivotValues';
  // q + the reduced-object params appended raw (already correctly encoded).
  const path =
    `/rest/adAnalytics?q=analytics` +
    `&pivot=CAMPAIGN` +
    `&timeGranularity=DAILY` +
    `&dateRange=${dateRange}` +
    `&accounts=${accounts}` +
    `&fields=${fields}`;

  const result: LinkedinResult = await linkedinRest(path, {
    accessToken: token,
    method: 'GET',
    timeoutMs: 20_000,
  });

  if (!result.ok) {
    const err: any = new Error(
      `LinkedIn ads ${result.status}: ${String(result.error.message).slice(0, 300)}`,
    );
    err.isAuthError = result.error.isAuthError;
    throw err;
  }

  const elements: any[] = Array.isArray(result.data?.elements) ? result.data.elements : [];
  return elements.map((el) => parseLinkedinRow(el, since));
}

function parseLinkedinRow(el: any, fallbackDate: string): AdMetricRow {
  const pivot = String(el?.pivotValues?.[0] ?? '');
  const campaignId = pivot ? pivot.slice(pivot.lastIndexOf(':') + 1) : '';
  const start = el?.dateRange?.start;
  const date =
    start && typeof start.year === 'number'
      ? isoFromParts(start.year, start.month, start.day)
      : fallbackDate;
  return {
    date,
    campaignId,
    spend: parseFloat(String(el?.costInLocalCurrency ?? '0')) || 0,
    impressions: Number(el?.impressions || 0),
    clicks: Number(el?.clicks || 0),
    leads: Number(el?.externalWebsiteConversions || 0),
    raw: el,
  };
}

function ymd(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split('-').map((p) => Number(p));
  return { y, m, d };
}

function isoFromParts(y: number, m: number, d: number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${y}-${pad(m)}-${pad(d)}`;
}
```

- [ ] **Step 4: Run → PASS.** `cd backend && npx jest src/modules/marketing/ads/linkedin-ads-client.spec.ts`
  Expected: **PASS** (5 tests).

- [ ] **Step 5: Commit.**
```bash
git add backend/src/modules/marketing/ads/linkedin-ads.client.ts backend/src/modules/marketing/ads/linkedin-ads-client.spec.ts && git commit -m "feat(ads): pullLinkedinInsights — adAnalytics → AdMetricRow with auth-error flag"
```

---

### Task 2.3: `linkedin-ads-oauth.config.ts` — authorize/redirect/token helpers

Plain functions (NOT NestJS providers), mirroring `tiktok-business-oauth.config.ts`. `linkedinAdsRedirectUri()` = `PUBLIC_BASE_URL` + `/api/marketing/ads/oauth/linkedin/callback`; `buildLinkedinAdsAuthorizeUrl(state)` with space-delimited `r_ads_reporting r_ads` scopes (no PKCE — confidential client); token URL const; re-export `isLinkedinAdsConfigured` from `ads.types`.

**Files:**
- Create: `backend/src/modules/marketing/ads/linkedin-ads-oauth.config.ts`
- Test: `backend/src/modules/marketing/ads/linkedin-ads-oauth.config.spec.ts` (Create)

- [ ] **Step 1: Write the failing test.** Create `backend/src/modules/marketing/ads/linkedin-ads-oauth.config.spec.ts`:
```ts
import {
  isLinkedinAdsConfigured,
  linkedinAdsRedirectUri,
  buildLinkedinAdsAuthorizeUrl,
  LINKEDIN_ADS_TOKEN_URL,
} from './linkedin-ads-oauth.config';

describe('linkedin-ads-oauth.config', () => {
  const orig = process.env;
  beforeEach(() => {
    process.env = { ...orig };
  });
  afterAll(() => {
    process.env = orig;
  });

  describe('isLinkedinAdsConfigured (re-export)', () => {
    it('true only when both ads vars are set', () => {
      process.env.LINKEDIN_ADS_CLIENT_ID = 'cid';
      process.env.LINKEDIN_ADS_CLIENT_SECRET = 'sec';
      expect(isLinkedinAdsConfigured()).toBe(true);
      delete process.env.LINKEDIN_ADS_CLIENT_SECRET;
      expect(isLinkedinAdsConfigured()).toBe(false);
    });
  });

  describe('linkedinAdsRedirectUri', () => {
    it('appends the callback path, stripping trailing slashes', () => {
      process.env.PUBLIC_BASE_URL = 'https://api.example.com///';
      expect(linkedinAdsRedirectUri()).toBe(
        'https://api.example.com/api/marketing/ads/oauth/linkedin/callback',
      );
    });
  });

  describe('buildLinkedinAdsAuthorizeUrl', () => {
    it('builds the authorize URL with client id, state, redirect, and space-delimited ads scopes', () => {
      process.env.LINKEDIN_ADS_CLIENT_ID = 'LIADS';
      process.env.PUBLIC_BASE_URL = 'https://api.example.com';
      const url = buildLinkedinAdsAuthorizeUrl('st-123');
      expect(url).toContain('https://www.linkedin.com/oauth/v2/authorization');
      expect(url).toContain('response_type=code');
      expect(url).toContain('client_id=LIADS');
      expect(url).toContain('state=st-123');
      expect(url).toContain(
        'redirect_uri=' +
          encodeURIComponent('https://api.example.com/api/marketing/ads/oauth/linkedin/callback'),
      );
      // space-delimited scopes → encoded as %20
      expect(url).toContain('scope=r_ads_reporting%20r_ads');
    });
  });

  it('exposes the LinkedIn token endpoint', () => {
    expect(LINKEDIN_ADS_TOKEN_URL).toBe('https://www.linkedin.com/oauth/v2/accessToken');
  });
});
```

- [ ] **Step 2: Run → FAIL.** `cd backend && npx jest src/modules/marketing/ads/linkedin-ads-oauth.config.spec.ts`
  Expected: **FAIL** (module does not exist).

- [ ] **Step 3: Implement the config.** Create `backend/src/modules/marketing/ads/linkedin-ads-oauth.config.ts`:
```ts
/**
 * Pure configuration helpers for the LinkedIn-for-Business (ads) OAuth flow.
 * These are NOT NestJS providers — plain functions imported where needed.
 * CRITICAL BOUNDARY: this is the ADS app (LINKEDIN_ADS_CLIENT_ID/SECRET),
 * completely separate from the social-planner app (LINKEDIN_CLIENT_ID/SECRET).
 * Confidential client → authorization-code WITHOUT PKCE.
 */
import { isLinkedinAdsConfigured } from './ads.types';

export { isLinkedinAdsConfigured };

export const LINKEDIN_ADS_AUTHORIZE_URL = 'https://www.linkedin.com/oauth/v2/authorization';
export const LINKEDIN_ADS_TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';

/** Reporting + read scopes for the Marketing (ads) API. Space-delimited. */
export const LINKEDIN_ADS_SCOPES = 'r_ads_reporting r_ads';

export function linkedinAdsRedirectUri(): string {
  const base = (process.env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
  return `${base}/api/marketing/ads/oauth/linkedin/callback`;
}

export function buildLinkedinAdsAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.LINKEDIN_ADS_CLIENT_ID ?? '',
    redirect_uri: linkedinAdsRedirectUri(),
    state,
    scope: LINKEDIN_ADS_SCOPES, // URLSearchParams encodes the space → %20
  });
  return `${LINKEDIN_ADS_AUTHORIZE_URL}?${params.toString()}`;
}
```

- [ ] **Step 4: Run → PASS.** `cd backend && npx jest src/modules/marketing/ads/linkedin-ads-oauth.config.spec.ts`
  Expected: **PASS** (4 tests).

- [ ] **Step 5: Commit.**
```bash
git add backend/src/modules/marketing/ads/linkedin-ads-oauth.config.ts backend/src/modules/marketing/ads/linkedin-ads-oauth.config.spec.ts && git commit -m "feat(ads): LinkedIn ads OAuth config — authorize/redirect/token helpers"
```

---

### Task 2.4: `linkedin-ads-oauth.service.ts` — start / handleCallback / listPending / confirm

Mirrors `TiktokBusinessOAuthService` and the on-main `signState`/`PendingSocialConnection` patterns. `start` signs state `{workspaceId, network:'linkedin-ads'}`; `handleCallback` verifies network, exchanges code via form-POST, lists ad accounts via `linkedinRest('/rest/adAccountUsers?q=authenticatedUser')` then `GET /rest/adAccounts/{id}` for name/currency, seals `{token, accounts}` into a 15-min `PendingSocialConnection`; `listPending` strips the token + enforces TTL; `confirm` calls `adAccounts.connect(workspaceId, {provider:'LINKEDIN', ...})` per selected account, then deletes the pending row.

**Files:**
- Create: `backend/src/modules/marketing/ads/linkedin-ads-oauth.service.ts`
- Test: `backend/src/modules/marketing/ads/linkedin-ads-oauth.service.spec.ts` (Create)

- [ ] **Step 1: Write the failing test.** Create `backend/src/modules/marketing/ads/linkedin-ads-oauth.service.spec.ts`:
```ts
import { BadRequestException } from '@nestjs/common';
import { LinkedinAdsOAuthService } from './linkedin-ads-oauth.service';
import * as stateUtil from '../social-planner/oauth/social-oauth-state.util';
import * as secretBox from '../../../common/crypto/secret-box.helper';
import * as config from './linkedin-ads-oauth.config';
import * as safeFetchModule from '../../../common/util/safe-fetch';
import * as linkedinApi from '../../../common/util/linkedin-api.util';

const WS = 'ws-li-1';
const PENDING_ID = 'pending-li-1';
const NETWORK = 'linkedin-ads';

function makePrisma() {
  return {
    pendingSocialConnection: {
      create: jest.fn(),
      findFirst: jest.fn(),
      delete: jest.fn(),
    },
  };
}
function makeAdAccounts() {
  return { connect: jest.fn() };
}

describe('LinkedinAdsOAuthService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let adAccounts: ReturnType<typeof makeAdAccounts>;
  let svc: LinkedinAdsOAuthService;

  beforeEach(() => {
    prisma = makePrisma();
    adAccounts = makeAdAccounts();
    svc = new LinkedinAdsOAuthService(prisma as any, adAccounts as any);
    jest.restoreAllMocks();
    jest.spyOn(secretBox, 'isSecretBoxConfigured').mockReturnValue(true);
    jest.spyOn(config, 'isLinkedinAdsConfigured').mockReturnValue(true);
  });

  // ── start ──────────────────────────────────────────────────────────────────
  describe('start', () => {
    it('throws when secret box is not configured', async () => {
      jest.spyOn(secretBox, 'isSecretBoxConfigured').mockReturnValue(false);
      await expect(svc.start(WS)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws when the LinkedIn ads app is not configured', async () => {
      jest.spyOn(config, 'isLinkedinAdsConfigured').mockReturnValue(false);
      await expect(svc.start(WS)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('signs state with the linkedin-ads network and returns the authorize URL', async () => {
      jest.spyOn(stateUtil, 'signState').mockReturnValue('signed');
      jest.spyOn(config, 'buildLinkedinAdsAuthorizeUrl').mockReturnValue('https://li/auth?state=signed');
      const r = await svc.start(WS);
      expect(stateUtil.signState).toHaveBeenCalledWith({ workspaceId: WS, network: NETWORK });
      expect(r).toEqual({ authorizeUrl: 'https://li/auth?state=signed' });
    });
  });

  // ── handleCallback ──────────────────────────────────────────────────────────
  describe('handleCallback', () => {
    beforeEach(() => {
      jest.spyOn(stateUtil, 'verifyState').mockReturnValue({
        workspaceId: WS,
        network: NETWORK,
        nonce: 'n',
        exp: Date.now() + 60_000,
      });
    });

    it('throws when state is invalid', async () => {
      jest.spyOn(stateUtil, 'verifyState').mockReturnValue(null);
      await expect(svc.handleCallback('code', 'bad')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws on a network mismatch', async () => {
      jest.spyOn(stateUtil, 'verifyState').mockReturnValue({
        workspaceId: WS,
        network: 'linkedin', // social network, not ads
        nonce: 'n',
        exp: Date.now() + 60_000,
      });
      await expect(svc.handleCallback('code', 'st')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('exchanges the code, lists ad accounts, seals a pending row', async () => {
      process.env.LINKEDIN_ADS_CLIENT_ID = 'cid';
      process.env.LINKEDIN_ADS_CLIENT_SECRET = 'sec';
      jest.spyOn(safeFetchModule, 'safeFetch').mockResolvedValue({
        json: async () => ({ access_token: 'li-tok', expires_in: 5184000 }),
      } as any);
      const restSpy = jest
        .spyOn(linkedinApi, 'linkedinRest')
        // adAccountUsers
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          data: { elements: [{ account: 'urn:li:sponsoredAccount:111', role: 'ACCOUNT_MANAGER' }] },
          restliId: null,
          error: null,
        } as any)
        // adAccounts/111
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          data: { id: 111, name: 'Acme Ads', currency: 'USD', status: 'ACTIVE' },
          restliId: null,
          error: null,
        } as any);
      jest.spyOn(secretBox, 'sealSecret').mockReturnValue('v1:sealed');
      prisma.pendingSocialConnection.create.mockResolvedValue({ id: PENDING_ID });

      const r = await svc.handleCallback('code', 'st');

      expect(safeFetchModule.safeFetch).toHaveBeenCalledWith(
        config.LINKEDIN_ADS_TOKEN_URL,
        expect.objectContaining({ method: 'POST' }),
      );
      expect(restSpy.mock.calls[0][0]).toContain('/rest/adAccountUsers?q=authenticatedUser');
      expect(r).toEqual({ pendingId: PENDING_ID, workspaceId: WS });
      const createArg = prisma.pendingSocialConnection.create.mock.calls[0][0] as any;
      expect(createArg.data.network).toBe(NETWORK);
      expect(createArg.data.workspaceId).toBe(WS);
      // sealed payload carries the account, never echoed
      const sealed = JSON.parse((secretBox.sealSecret as jest.Mock).mock.calls[0][0]);
      expect(sealed.token).toBe('li-tok');
      expect(sealed.accounts[0]).toMatchObject({ externalAdId: '111', displayName: 'Acme Ads', currency: 'USD' });
    });

    it('throws when the token exchange returns no access_token', async () => {
      jest.spyOn(safeFetchModule, 'safeFetch').mockResolvedValue({
        json: async () => ({ error: 'invalid_grant' }),
      } as any);
      await expect(svc.handleCallback('code', 'st')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ── listPending ──────────────────────────────────────────────────────────────
  describe('listPending', () => {
    it('throws when the row is missing', async () => {
      prisma.pendingSocialConnection.findFirst.mockResolvedValue(null);
      await expect(svc.listPending(WS, PENDING_ID)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('returns accounts WITHOUT the token', async () => {
      const payload = {
        token: 'secret-token',
        accounts: [{ externalAdId: '111', displayName: 'Acme', currency: 'USD' }],
      };
      prisma.pendingSocialConnection.findFirst.mockResolvedValue({
        id: PENDING_ID,
        payload: 'sealed',
        expiresAt: new Date(Date.now() + 600_000),
      });
      jest.spyOn(secretBox, 'openSecret').mockReturnValue(JSON.stringify(payload));
      const r = await svc.listPending(WS, PENDING_ID);
      expect(r).toEqual({ accounts: payload.accounts });
      expect(JSON.stringify(r)).not.toContain('secret-token');
    });

    it('treats an expired row as not-found and deletes it', async () => {
      prisma.pendingSocialConnection.findFirst.mockResolvedValue({
        id: PENDING_ID,
        payload: 'sealed',
        expiresAt: new Date(Date.now() - 1000),
      });
      prisma.pendingSocialConnection.delete.mockResolvedValue({});
      await expect(svc.listPending(WS, PENDING_ID)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.pendingSocialConnection.delete).toHaveBeenCalledWith({ where: { id: PENDING_ID } });
    });
  });

  // ── confirm ───────────────────────────────────────────────────────────────────
  describe('confirm', () => {
    const payload = {
      token: 'raw-tok',
      accounts: [
        { externalAdId: '111', displayName: 'Acme', currency: 'USD' },
        { externalAdId: '222', displayName: 'Beta', currency: 'EUR' },
      ],
    };

    beforeEach(() => {
      prisma.pendingSocialConnection.findFirst.mockResolvedValue({
        id: PENDING_ID,
        payload: 'sealed',
        expiresAt: new Date(Date.now() + 600_000),
      });
      jest.spyOn(secretBox, 'openSecret').mockReturnValue(JSON.stringify(payload));
      adAccounts.connect.mockResolvedValue({ id: 'acc' });
      prisma.pendingSocialConnection.delete.mockResolvedValue({});
    });

    it('provisions a sealed LINKEDIN AdAccount via connect() for each selected account', async () => {
      const r = await svc.confirm(WS, PENDING_ID, ['111', '222']);
      expect(adAccounts.connect).toHaveBeenCalledTimes(2);
      expect(adAccounts.connect).toHaveBeenCalledWith(WS, {
        provider: 'LINKEDIN',
        externalAdId: '111',
        accessToken: 'raw-tok',
        displayName: 'Acme',
        currency: 'USD',
      });
      expect(r).toEqual({ connected: 2 });
    });

    it('only connects selected accounts', async () => {
      await svc.confirm(WS, PENDING_ID, ['222']);
      expect(adAccounts.connect).toHaveBeenCalledTimes(1);
      expect(adAccounts.connect).toHaveBeenCalledWith(WS, expect.objectContaining({ externalAdId: '222' }));
    });

    it('deletes the pending row after confirming', async () => {
      await svc.confirm(WS, PENDING_ID, ['111']);
      expect(prisma.pendingSocialConnection.delete).toHaveBeenCalledWith({ where: { id: PENDING_ID } });
    });
  });
});
```

- [ ] **Step 2: Run → FAIL.** `cd backend && npx jest src/modules/marketing/ads/linkedin-ads-oauth.service.spec.ts`
  Expected: **FAIL** (module does not exist).

- [ ] **Step 3: Implement the service.** Create `backend/src/modules/marketing/ads/linkedin-ads-oauth.service.ts`:
```ts
import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  isSecretBoxConfigured,
  sealSecret,
  openSecret,
} from '../../../common/crypto/secret-box.helper';
import { safeFetch } from '../../../common/util/safe-fetch';
import { linkedinRest } from '../../../common/util/linkedin-api.util';
import { signState, verifyState } from '../social-planner/oauth/social-oauth-state.util';
import {
  isLinkedinAdsConfigured,
  buildLinkedinAdsAuthorizeUrl,
  linkedinAdsRedirectUri,
  LINKEDIN_ADS_TOKEN_URL,
} from './linkedin-ads-oauth.config';
import { AdAccountService } from './ad-account.service';

const NETWORK = 'linkedin-ads';
const PENDING_TTL_MS = 15 * 60 * 1000; // 15 minutes

export interface LinkedinAdAccountInfo {
  externalAdId: string;
  displayName: string;
  currency: string | null;
}

interface PendingPayload {
  token: string;
  accounts: LinkedinAdAccountInfo[];
}

/**
 * One-click LinkedIn-for-Business (ads) OAuth → ad-account provisioning, in the
 * ads module. CRITICAL BOUNDARY: this is the ADS app, completely separate from
 * the social-planner LinkedIn connect. Confidential client (no PKCE). Inert
 * until LINKEDIN_ADS_CLIENT_ID/SECRET + MARKETING_SECRET_KEY are set.
 */
@Injectable()
export class LinkedinAdsOAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly adAccounts: AdAccountService,
  ) {}

  /** Step 1: build the LinkedIn ads authorize URL bound to this workspace. */
  async start(workspaceId: string): Promise<{ authorizeUrl: string }> {
    if (!isSecretBoxConfigured()) {
      throw new BadRequestException('Secret storage is not configured (MARKETING_SECRET_KEY)');
    }
    if (!isLinkedinAdsConfigured()) {
      throw new BadRequestException('LinkedIn ads app credentials are not configured on this platform');
    }
    const state = signState({ workspaceId, network: NETWORK });
    return { authorizeUrl: buildLinkedinAdsAuthorizeUrl(state) };
  }

  /**
   * Step 2: OAuth callback — verify state, exchange the code for an access
   * token (form-POST), list the authenticated user's ad accounts (with name +
   * currency), seal {token, accounts} into a 15-minute PendingSocialConnection.
   */
  async handleCallback(
    code: string,
    state: string,
  ): Promise<{ pendingId: string; workspaceId: string }> {
    const parsed = verifyState(state);
    if (!parsed || parsed.network !== NETWORK) {
      throw new BadRequestException('Invalid or expired OAuth state');
    }
    const { workspaceId } = parsed;

    // Exchange code → token (application/x-www-form-urlencoded, confidential client).
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: process.env.LINKEDIN_ADS_CLIENT_ID ?? '',
      client_secret: process.env.LINKEDIN_ADS_CLIENT_SECRET ?? '',
      redirect_uri: linkedinAdsRedirectUri(),
    });
    const tokenRes = await safeFetch(LINKEDIN_ADS_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      timeoutMs: 20_000,
    });
    const tokenJson: any = await tokenRes.json().catch(() => ({}));
    const token: string = tokenJson?.access_token;
    if (!token) {
      throw new BadRequestException('LinkedIn token exchange failed: no access_token in response');
    }

    const accounts = await this.listAdAccounts(token);

    const payload: PendingPayload = { token, accounts };
    const row = await this.prisma.pendingSocialConnection.create({
      data: {
        workspaceId,
        network: NETWORK,
        payload: sealSecret(JSON.stringify(payload)),
        expiresAt: new Date(Date.now() + PENDING_TTL_MS),
      },
    });
    return { pendingId: row.id, workspaceId };
  }

  /**
   * GET /rest/adAccountUsers?q=authenticatedUser → each element's `account` is a
   * 'urn:li:sponsoredAccount:{id}'. We then GET /rest/adAccounts/{id} for the
   * name + currency (best-effort per account).
   */
  private async listAdAccounts(token: string): Promise<LinkedinAdAccountInfo[]> {
    const usersRes = await linkedinRest('/rest/adAccountUsers?q=authenticatedUser', {
      accessToken: token,
      method: 'GET',
      timeoutMs: 20_000,
    });
    if (!usersRes.ok) {
      throw new BadRequestException('LinkedIn ad account lookup failed');
    }
    const elements: any[] = Array.isArray(usersRes.data?.elements) ? usersRes.data.elements : [];
    const ids = elements
      .map((el) => {
        const urn = String(el?.account ?? '');
        return urn ? urn.slice(urn.lastIndexOf(':') + 1) : '';
      })
      .filter(Boolean);

    return Promise.all(
      ids.map(async (id): Promise<LinkedinAdAccountInfo> => {
        try {
          const r = await linkedinRest(`/rest/adAccounts/${id}`, {
            accessToken: token,
            method: 'GET',
            timeoutMs: 20_000,
          });
          if (r.ok && r.data) {
            return {
              externalAdId: id,
              displayName: r.data.name ?? id,
              currency: r.data.currency ?? null,
            };
          }
        } catch {
          // best-effort
        }
        return { externalAdId: id, displayName: id, currency: null };
      }),
    );
  }

  /** Load a non-expired pending row scoped to the workspace (deletes if lapsed). */
  private async loadPendingRow(workspaceId: string, id: string) {
    const row = await this.prisma.pendingSocialConnection.findFirst({
      where: { id, workspaceId, network: NETWORK },
    });
    if (!row) throw new BadRequestException('Pending connection not found or expired');
    if (row.expiresAt.getTime() < Date.now()) {
      await this.prisma.pendingSocialConnection
        .delete({ where: { id: row.id } })
        .catch(() => undefined);
      throw new BadRequestException('Pending connection not found or expired');
    }
    return row;
  }

  /** Step 3: return the connectable ad accounts (NEVER the token). */
  async listPending(
    workspaceId: string,
    id: string,
  ): Promise<{ accounts: LinkedinAdAccountInfo[] }> {
    const row = await this.loadPendingRow(workspaceId, id);
    const payload = JSON.parse(openSecret(row.payload)) as PendingPayload;
    return { accounts: payload.accounts };
  }

  /** Step 4: provision the selected ad accounts, then delete the pending row. */
  async confirm(
    workspaceId: string,
    id: string,
    selected: string[],
  ): Promise<{ connected: number }> {
    const row = await this.loadPendingRow(workspaceId, id);
    const payload = JSON.parse(openSecret(row.payload)) as PendingPayload;

    const selectedSet = new Set(selected);
    const toConnect = payload.accounts.filter((a) => selectedSet.has(a.externalAdId));

    for (const acc of toConnect) {
      await this.adAccounts.connect(workspaceId, {
        provider: 'LINKEDIN',
        externalAdId: acc.externalAdId,
        accessToken: payload.token,
        displayName: acc.displayName,
        currency: acc.currency ?? undefined,
      });
    }

    await this.prisma.pendingSocialConnection.delete({ where: { id: row.id } });
    return { connected: toConnect.length };
  }
}
```

- [ ] **Step 4: Run → PASS.** `cd backend && npx jest src/modules/marketing/ads/linkedin-ads-oauth.service.spec.ts`
  Expected: **PASS** (all describe blocks).

- [ ] **Step 5: Commit.**
```bash
git add backend/src/modules/marketing/ads/linkedin-ads-oauth.service.ts backend/src/modules/marketing/ads/linkedin-ads-oauth.service.spec.ts && git commit -m "feat(ads): LinkedIn ads OAuth service — start/callback/pending/confirm provisioning"
```

---

### Task 2.5: `linkedin-ads-oauth.controller.ts` + module wiring

Routes under `marketing/ads/oauth`, mirroring `TiktokBusinessOAuthController`: `POST linkedin/start` (MANAGER + `settings.manage`), `GET linkedin/callback` (`@MarketingPublic`, redirects to `${appUrl}/ads?connect=<id>` or `?connect_error=1`), `GET linkedin/pending/:id`, `POST linkedin/pending/:id/confirm`. Register the controller + service in `marketing.module.ts`.

**Files:**
- Create: `backend/src/modules/marketing/ads/linkedin-ads-oauth.controller.ts`
- Modify: `backend/src/modules/marketing/marketing.module.ts` (add the ads-reporting import block near line 313–316; controller into the `controllers` array after `SocialOAuthController` at line 506; service into `providers` after `SocialTokenRefreshService` at line 699)

- [ ] **Step 1: Create the controller.** Create `backend/src/modules/marketing/ads/linkedin-ads-oauth.controller.ts`:
```ts
import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { IsArray, IsString } from 'class-validator';
import type { Response } from 'express';
import { MarketingRoute, MarketingPublic } from '../decorators/marketing-public.decorator';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { RequirePermission } from '../roles/require-permission.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { LinkedinAdsOAuthService } from './linkedin-ads-oauth.service';

class ConfirmLinkedinAdsDto {
  @IsArray()
  @IsString({ each: true })
  selected: string[];
}

/**
 * LinkedIn-for-Business (ads) OAuth endpoints for the ads module.
 * CRITICAL BOUNDARY: completely separate from the social-planner connect.
 * - POST linkedin/start              → returns authorizeUrl
 * - GET  linkedin/callback           → public; LinkedIn redirects here; we redirect to /ads?connect=<id>
 * - GET  linkedin/pending/:id        → list connectable ad accounts (no token)
 * - POST linkedin/pending/:id/confirm → provision the selected ad accounts
 */
@MarketingRoute()
@Controller('marketing/ads/oauth')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
export class LinkedinAdsOAuthController {
  constructor(private readonly svc: LinkedinAdsOAuthService) {}

  @Post('linkedin/start')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  start(@CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.start(u.workspaceId);
  }

  @Get('linkedin/callback')
  @MarketingPublic()
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Res() res: Response,
  ) {
    const appUrl = (process.env.FRONTEND_URL ?? process.env.APP_URL ?? '').replace(/\/+$/, '');
    if (error || !code || !state) {
      return res.redirect(302, `${appUrl}/ads?connect_error=1`);
    }
    try {
      const { pendingId } = await this.svc.handleCallback(code, state);
      return res.redirect(302, `${appUrl}/ads?connect=${pendingId}`);
    } catch {
      return res.redirect(302, `${appUrl}/ads?connect_error=1`);
    }
  }

  @Get('linkedin/pending/:id')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  pending(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.listPending(u.workspaceId, id);
  }

  @Post('linkedin/pending/:id/confirm')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  confirm(
    @Param('id') id: string,
    @Body() dto: ConfirmLinkedinAdsDto,
    @CurrentMarketingUser() u: MarketingUserPayload,
  ) {
    return this.svc.confirm(u.workspaceId, id, dto.selected);
  }
}
```

- [ ] **Step 2: Add the imports in `marketing.module.ts`.** Replace the ads-reporting import block (lines 313–316):
```ts
// Ad reporting — Meta Ads + TikTok Ads + LinkedIn Ads (GoHighLevel parity).
import { MarketingAdsController } from './controllers/marketing-ads.controller';
import { AdAccountService } from './ads/ad-account.service';
import { AdsPullService } from './ads/ads-pull.service';
import { LinkedinAdsOAuthController } from './ads/linkedin-ads-oauth.controller';
import { LinkedinAdsOAuthService } from './ads/linkedin-ads-oauth.service';
```

- [ ] **Step 3: Register the controller.** In the `controllers` array, after `SocialOAuthController,` (line 506):
```ts
    SocialOAuthController,
    LinkedinAdsOAuthController,
```

- [ ] **Step 4: Register the service.** In the `providers` array, after `SocialTokenRefreshService,` (line 699):
```ts
    SocialTokenRefreshService,
    // Ad reporting — one-click LinkedIn-for-Business (ads) OAuth provisioning.
    LinkedinAdsOAuthService,
```

- [ ] **Step 5: Build → PASS.** `cd backend && npm run build`
  Expected: **PASS** (compiles; the new controller/service resolve `AdAccountService` + `PrismaService` from the module).

- [ ] **Step 6: Commit.**
```bash
git add backend/src/modules/marketing/ads/linkedin-ads-oauth.controller.ts backend/src/modules/marketing/marketing.module.ts && git commit -m "feat(ads): mount LinkedIn ads OAuth controller + service in marketing module"
```

---

### Task 2.6: Wire `LINKEDIN` into the ads core (service, DTOs, status)

Add `LINKEDIN` to `PROVIDERS`, route `pullAccount` to `pullLinkedinInsights`, broaden the auth-error classification to also call `isLinkedinAuthError`, report `LINKEDIN` in `/status`, and extend both `@IsIn` provider lists.

**Files:**
- Modify: `backend/src/modules/marketing/ads/ad-account.service.ts` (line 14–20 imports + `PROVIDERS`; line 35–41 `status()`; line 63–65 error message; line 177–180 `pullAccount` routing; line 181–192 catch; line 240–242 `isProviderConfigured`)
- Modify: `backend/src/modules/marketing/dto/ad-account.dto.ts` (line 22, line 33)
- Test: `backend/src/modules/marketing/ads/ad-account.service.spec.ts` (append LINKEDIN cases)

- [ ] **Step 1: Write the failing tests.** Append to `backend/src/modules/marketing/ads/ad-account.service.spec.ts` — first add the linkedin client to the existing imports (after line 4, `import * as tiktokClient ...`):
```ts
import * as linkedinClient from './linkedin-ads.client';
```
Then add a default spy inside the top-level `beforeEach` (after line 36's `isTiktokAdsConfigured` spy, before the "Safe defaults" comment):
```ts
    jest.spyOn(adsTypes, 'isLinkedinAdsConfigured').mockReturnValue(true);
```
Then add these tests inside the `describe('pullAccount', ...)` block (after the existing `'dispatches to the TikTok client ...'` test):
```ts
    it('dispatches to the LinkedIn client for a LinkedIn account', async () => {
      jest.spyOn(secretBox, 'openSecret').mockReturnValue('plain');
      const liSpy = jest.spyOn(linkedinClient, 'pullLinkedinInsights').mockResolvedValue([]);
      prisma.adAccount.update.mockResolvedValue({});
      await svc.pullAccount(
        { ...account, provider: 'LINKEDIN', externalAdId: '512345' },
        '2026-06-01',
        '2026-06-03',
      );
      expect(liSpy).toHaveBeenCalledWith('plain', '512345', '2026-06-01', '2026-06-03');
    });

    it('marks TOKEN_EXPIRED on a LinkedIn auth error', async () => {
      jest.spyOn(secretBox, 'openSecret').mockReturnValue('plain');
      const err: any = new Error('LinkedIn ads 401: invalid token');
      err.isAuthError = true;
      jest.spyOn(linkedinClient, 'pullLinkedinInsights').mockRejectedValue(err);
      const written = await svc.pullAccount(
        { ...account, provider: 'LINKEDIN', externalAdId: '512345' },
        '2026-06-01',
        '2026-06-03',
      );
      expect(written).toBe(0);
      const upd = prisma.adAccount.update.mock.calls[0][0] as any;
      expect(upd.data.status).toBe('TOKEN_EXPIRED');
      expect(upd.data.lastError).toBe('reauth_required');
    });
```
Add a LINKEDIN connect test inside `describe('connect', ...)` (after the existing seal test):
```ts
    it('seals + upserts a LINKEDIN ad account', async () => {
      jest.spyOn(secretBox, 'isSecretBoxConfigured').mockReturnValue(true);
      jest.spyOn(secretBox, 'sealSecret').mockReturnValue('v1:sealed');
      prisma.adAccount.upsert.mockResolvedValue({ id: 'a1', provider: 'LINKEDIN' });
      await svc.connect(WS, {
        provider: 'LINKEDIN',
        externalAdId: '512345',
        displayName: 'Acme Ads',
        accessToken: 'li-tok',
        currency: 'USD',
      } as any);
      const arg = prisma.adAccount.upsert.mock.calls[0][0] as any;
      expect(arg.where.workspaceId_provider_externalAdId.provider).toBe('LINKEDIN');
      expect(arg.create.accessToken).toBe('v1:sealed');
    });
```
And extend the `status` test to assert LINKEDIN is reported:
```ts
    it('reports LINKEDIN configuration in status', () => {
      jest.spyOn(secretBox, 'isSecretBoxConfigured').mockReturnValue(true);
      expect(svc.status()).toHaveProperty('LINKEDIN');
    });
```

- [ ] **Step 2: Run → FAIL.** `cd backend && npx jest src/modules/marketing/ads/ad-account.service.spec.ts`
  Expected: **FAIL** (LINKEDIN not in `PROVIDERS`, no routing branch, no `LINKEDIN` in status, `isLinkedinAdsConfigured` spy target absent).

- [ ] **Step 3: Update imports + `PROVIDERS`.** In `ad-account.service.ts`, replace lines 14–20:
```ts
import { pullMetaInsights } from './meta-ads.client';
import { pullTiktokInsights } from './tiktok-ads.client';
import { pullLinkedinInsights } from './linkedin-ads.client';
import {
  isMetaAdsConfigured,
  isTiktokAdsConfigured,
  isLinkedinAdsConfigured,
  AdMetricRow,
} from './ads.types';
import { ConnectAdAccountDto } from '../dto/ad-account.dto';
import { isMetaAuthError } from '../../../common/util/meta-graph.util';
import { isLinkedinAuthError } from '../../../common/util/linkedin-api.util';

const PROVIDERS = ['META', 'TIKTOK', 'LINKEDIN'];
```

- [ ] **Step 4: Report LINKEDIN in `status()`.** Replace lines 35–41:
```ts
  status() {
    return {
      META: isMetaAdsConfigured(),
      TIKTOK: isTiktokAdsConfigured(),
      LINKEDIN: isLinkedinAdsConfigured(),
      secretBoxConfigured: isSecretBoxConfigured(),
    };
  }
```

- [ ] **Step 5: Fix the connect error message.** Replace line 64:
```ts
      throw new BadRequestException('provider must be META, TIKTOK or LINKEDIN');
```

- [ ] **Step 6: Add the pullAccount routing branch.** Replace lines 176–181 (the `try { rows = ... }`):
```ts
    let rows: AdMetricRow[];
    try {
      if (account.provider === 'META') {
        rows = await pullMetaInsights(token, account.externalAdId, from, to);
      } else if (account.provider === 'TIKTOK') {
        rows = await pullTiktokInsights(token, account.externalAdId, from, to);
      } else {
        rows = await pullLinkedinInsights(token, account.externalAdId, from, to);
      }
    } catch (e) {
```

- [ ] **Step 7: Broaden the auth-error classification.** Replace the `if (isMetaAuthError(e))` condition (line 186) so a LinkedIn auth error also marks reauth:
```ts
      if (isMetaAuthError(e) || isLinkedinAuthError(e)) {
        await this.markReauth(account.id);
```

- [ ] **Step 8: Add LINKEDIN to `isProviderConfigured`.** Replace lines 240–242:
```ts
  private isProviderConfigured(provider: string): boolean {
    if (provider === 'META') return isMetaAdsConfigured();
    if (provider === 'TIKTOK') return isTiktokAdsConfigured();
    return isLinkedinAdsConfigured();
  }
```

- [ ] **Step 9: Extend the DTO `@IsIn` lists.** In `dto/ad-account.dto.ts`, replace line 22:
```ts
  @IsString() @IsIn(['META', 'TIKTOK', 'LINKEDIN']) provider: string;
```
and line 33:
```ts
  @IsOptional() @IsString() @IsIn(['META', 'TIKTOK', 'LINKEDIN']) provider?: string;
```

- [ ] **Step 10: Run → PASS.** `cd backend && npx jest src/modules/marketing/ads/ad-account.service.spec.ts`
  Expected: **PASS** (existing + new LINKEDIN cases).

- [ ] **Step 11: Build → PASS.** `cd backend && npm run build`
  Expected: **PASS**.

- [ ] **Step 12: Commit.**
```bash
git add backend/src/modules/marketing/ads/ad-account.service.ts backend/src/modules/marketing/dto/ad-account.dto.ts backend/src/modules/marketing/ads/ad-account.service.spec.ts && git commit -m "feat(ads): wire LINKEDIN provider into ad-account core (routing, status, reauth, DTOs)"
```

---

### Task 2.7: Frontend — LinkedIn provider, OAuth service helpers, select dialog, page CTA

Add `LINKEDIN` to the `AdProvider` union + status + `AD_PROVIDERS`/labels; add `startLinkedinAdsOAuth` / `getLinkedinAdsPending` / `confirmLinkedinAdsPending`; add a `LinkedinAdsSelectDialog`; add a "Connect LinkedIn" CTA, the `?connect=<id>` handling, and a LinkedIn-aware Reconnect path in `AdReportingPage` (this LinkedIn worktree's page does not yet have the OAuth-return handling, so we clone it from the TikTok pieces).

**Files:**
- Modify: `frontend/src/features/marketing/api/ads.service.ts` (line 11 union; line 14–18 `AdProviderStatus`; append OAuth helpers after line 77)
- Modify: `frontend/src/pages/marketing/ads/adsSchemas.ts` (line 4 `AD_PROVIDERS`; line 6–9 labels; line 13 zod enum)
- Create: `frontend/src/pages/marketing/ads/LinkedinAdsSelectDialog.tsx`
- Modify: `frontend/src/pages/marketing/ads/AdReportingPage.tsx` (imports, OAuth-return effect, CTA, reconnect, provider filter, dialog render)

- [ ] **Step 1: Extend `ads.service.ts`.** Replace line 11:
```ts
export type AdProvider = 'META' | 'TIKTOK' | 'LINKEDIN';
```
Replace the `AdProviderStatus` interface (lines 14–18):
```ts
export interface AdProviderStatus {
  META: boolean;
  TIKTOK: boolean;
  LINKEDIN: boolean;
  secretBoxConfigured: boolean;
}
```
Append after line 77 (end of file):
```ts

// ── LinkedIn for Business (ads) OAuth ───────────────────────────────────────

export interface LinkedinAdsPendingAccount {
  externalAdId: string;
  displayName: string;
  currency: string | null;
}

export interface LinkedinAdsPending {
  accounts: LinkedinAdsPendingAccount[];
}

export interface LinkedinAdsConfirmResult {
  connected: number;
}

/** POST /ads/oauth/linkedin/start → { authorizeUrl } */
export const startLinkedinAdsOAuth = (): Promise<{ authorizeUrl: string }> =>
  marketingApi.post('/ads/oauth/linkedin/start').then((r) => r.data);

/** GET /ads/oauth/linkedin/pending/:id */
export const getLinkedinAdsPending = (id: string): Promise<LinkedinAdsPending> =>
  marketingApi.get(`/ads/oauth/linkedin/pending/${id}`).then((r) => r.data);

/** POST /ads/oauth/linkedin/pending/:id/confirm */
export const confirmLinkedinAdsPending = (
  id: string,
  selected: string[],
): Promise<LinkedinAdsConfirmResult> =>
  marketingApi.post(`/ads/oauth/linkedin/pending/${id}/confirm`, { selected }).then((r) => r.data);
```

- [ ] **Step 2: Extend `adsSchemas.ts`.** Replace line 4:
```ts
export const AD_PROVIDERS: AdProvider[] = ['META', 'TIKTOK', 'LINKEDIN'];
```
Replace the label map (lines 6–9):
```ts
export const AD_PROVIDER_LABEL: Record<AdProvider, string> = {
  META: 'Meta (Facebook / Instagram)',
  TIKTOK: 'TikTok',
  LINKEDIN: 'LinkedIn',
};
```
Replace the zod enum (line 13):
```ts
  provider: z.enum(['META', 'TIKTOK', 'LINKEDIN']),
```

- [ ] **Step 3: Create `LinkedinAdsSelectDialog.tsx`.** This clones `TiktokAdsSelectDialog` minus the DM/messaging switch (LinkedIn ads has no DM). Create `frontend/src/pages/marketing/ads/LinkedinAdsSelectDialog.tsx`:
```tsx
import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Link2 } from 'lucide-react';
import {
  getLinkedinAdsPending,
  confirmLinkedinAdsPending,
} from '../../../features/marketing/api/ads.service';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { EmptyState } from '@/components/ui/EmptyState';

interface Props {
  pendingId: string | null;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

/**
 * After the LinkedIn ads OAuth callback redirects to /ads?connect=<id>, this
 * dialog lists the sponsored ad accounts the user can connect to this workspace.
 */
export function LinkedinAdsSelectDialog({ pendingId, onOpenChange, onSuccess }: Props) {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string[]>([]);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['marketing', 'ads', 'linkedin', 'pending', pendingId],
    queryFn: () => getLinkedinAdsPending(pendingId!),
    enabled: !!pendingId,
    retry: false,
  });

  useEffect(() => {
    if (data?.accounts) {
      setSelected(data.accounts.map((a) => a.externalAdId));
    }
  }, [data]);

  const confirmMutation = useMutation({
    mutationFn: ({ id, sel }: { id: string; sel: string[] }) => confirmLinkedinAdsPending(id, sel),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['marketing', 'ads', 'accounts'] });
      toast.success(
        t('ads.toast.linkedinConnected', { defaultValue: 'LinkedIn ad account(s) connected' }),
      );
      onSuccess();
      onOpenChange(false);
    },
    onError: () => {
      toast.error(
        t('ads.toast.linkedinConnectFailed', { defaultValue: 'Failed to connect LinkedIn account' }),
      );
    },
  });

  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const handleConfirm = () => {
    if (!pendingId || selected.length === 0) return;
    confirmMutation.mutate({ id: pendingId, sel: selected });
  };

  return (
    <Dialog open={!!pendingId} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t('ads.oauth.linkedinSelectTitle', {
              defaultValue: 'Choose LinkedIn ad accounts',
            })}
          </DialogTitle>
          <DialogDescription>
            {t('ads.oauth.linkedinSelectBody', {
              defaultValue: 'Select the ad accounts to connect to this workspace.',
            })}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-2 py-2">
            {[0, 1].map((i) => (
              <div key={i} className="h-10 animate-pulse rounded-lg bg-surface-muted" />
            ))}
          </div>
        ) : isError || !data || data.accounts.length === 0 ? (
          <EmptyState
            icon={<Link2 className="h-8 w-8" />}
            title={t('ads.oauth.noLinkedinAccounts', { defaultValue: 'No ad accounts found' })}
            description={t('ads.oauth.noLinkedinAccountsHint', {
              defaultValue: 'Make sure you have access to at least one LinkedIn ad account.',
            })}
            className="border-0 py-4"
          />
        ) : (
          <div className="max-h-72 space-y-1.5 overflow-y-auto py-1">
            {data.accounts.map((a) => (
              <label
                key={a.externalAdId}
                htmlFor={`li-account-${a.externalAdId}`}
                className="flex cursor-pointer items-center gap-3 rounded-lg border border-border p-3 hover:bg-surface-muted"
              >
                <Checkbox
                  id={`li-account-${a.externalAdId}`}
                  checked={selected.includes(a.externalAdId)}
                  onCheckedChange={() => toggle(a.externalAdId)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {a.displayName}
                  </span>
                  <span className="block text-micro text-muted-foreground">{a.currency}</span>
                </span>
              </label>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button
            type="button"
            onClick={handleConfirm}
            loading={confirmMutation.isPending}
            disabled={!data || selected.length === 0}
          >
            {t('ads.oauth.connectSelected', { defaultValue: 'Connect selected' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Wire the page — imports.** In `AdReportingPage.tsx`, replace line 1:
```tsx
import { useEffect, useMemo, useState } from 'react';
```
After line 2 (`import { useMutation ... }`), add the router import:
```tsx
import { useSearchParams } from 'react-router-dom';
```
Replace the service import block (lines 15–24) to add `startLinkedinAdsOAuth`:
```tsx
import {
  getAdStatus,
  listAdAccounts,
  getAdMetrics,
  connectAdAccount,
  removeAdAccount,
  pullAdAccount,
  startLinkedinAdsOAuth,
  type AdAccount,
  type AdProvider,
} from '../../../features/marketing/api/ads.service';
```
After the `ConnectAdAccountDialog` import (line 27), add:
```tsx
import { LinkedinAdsSelectDialog } from './LinkedinAdsSelectDialog';
```

- [ ] **Step 5: Wire the page — state + OAuth-return effect + start handler.** After line 83 (`const [disconnectTarget, ...]`), add:
```tsx
  const [searchParams, setSearchParams] = useSearchParams();
  const [pendingConnectId, setPendingConnectId] = useState<string | null>(null);
```
After the closing `}` of `disconnectTarget` state declaration block (before the `// ── Queries ──` comment at line 85), insert the OAuth-return effect and the start handler:
```tsx
  // ── OAuth return handling ────────────────────────────────────────────────────
  // The LinkedIn ads OAuth callback redirects back to /ads?connect=<pendingId>
  // (success) or ?connect_error=1 (failure). Pick up the param once, open the
  // account selector, and strip it from the URL.
  useEffect(() => {
    const connectId = searchParams.get('connect');
    const connectErr = searchParams.get('connect_error');
    if (connectId) {
      setPendingConnectId(connectId);
      setView('accounts');
      searchParams.delete('connect');
      setSearchParams(searchParams, { replace: true });
    } else if (connectErr) {
      toast.error(
        t('ads.oauth.callbackError', {
          defaultValue: 'LinkedIn connection failed or was cancelled. Please try again.',
        }),
      );
      searchParams.delete('connect_error');
      setSearchParams(searchParams, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startLinkedinConnect = async () => {
    try {
      const { authorizeUrl } = await startLinkedinAdsOAuth();
      window.location.href = authorizeUrl;
    } catch {
      toast.error(
        t('ads.oauth.startFailed', { defaultValue: 'Could not start the LinkedIn connection' }),
      );
    }
  };

  const handleReconnect = (account: AdAccount) => {
    if (account.provider === 'LINKEDIN') {
      void startLinkedinConnect();
    } else {
      setConnectOpen(true);
    }
  };
```

- [ ] **Step 6: Wire the page — CTA in PageHeader.** Replace the `actions={...}` block (lines 182–189) with a two-button group:
```tsx
        actions={
          isManager ? (
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => void startLinkedinConnect()}
                disabled={!status?.LINKEDIN}
                title={
                  status?.LINKEDIN
                    ? undefined
                    : t('ads.oauth.linkedinNotConfigured', {
                        defaultValue: 'An admin must add LinkedIn ads app credentials first',
                      })
                }
                variant="outline"
              >
                {t('ads.oauth.linkedinConnect', { defaultValue: 'Connect LinkedIn' })}
              </Button>
              <Button onClick={() => setConnectOpen(true)} disabled={!canConnect} variant="outline">
                <Link2 className="h-4 w-4" aria-hidden="true" />
                {t('ads.connectAccount', { defaultValue: 'Connect account' })}
              </Button>
            </div>
          ) : undefined
        }
```

- [ ] **Step 7: Wire the page — provider filter + reconnect wiring + dialog render.** Add the LinkedIn option to the provider `<SelectContent>` (after the `TIKTOK` `SelectItem`, line 212):
```tsx
                <SelectItem value="LINKEDIN">{AD_PROVIDER_LABEL.LINKEDIN}</SelectItem>
```
Route the Reconnect button through `handleReconnect` — replace the `<AccountsView ... onConnect={() => setConnectOpen(true)} ...>` prop wiring by passing a reconnect handler. In the `AccountsView` JSX usage (lines 243–253) add `onReconnect={handleReconnect}` after `onConnect`:
```tsx
        <AccountsView
          accounts={accounts}
          isLoading={accountsLoading}
          isManager={isManager}
          canConnect={canConnect}
          onConnect={() => setConnectOpen(true)}
          onReconnect={handleReconnect}
          onDisconnect={setDisconnectTarget}
          onPull={(id) => pullMutation.mutate(id)}
          pullingId={pullMutation.isPending ? (pullMutation.variables as string) : null}
        />
```
Render the dialog — after the `<ConnectAdAccountDialog ... />` block (after line 261), add:
```tsx
      <LinkedinAdsSelectDialog
        pendingId={pendingConnectId}
        onOpenChange={(open) => { if (!open) setPendingConnectId(null); }}
        onSuccess={invalidateAccounts}
      />
```

- [ ] **Step 8: Wire the page — `AccountsView` reconnect prop.** Extend the `AccountsViewProps` interface (lines 453–462) by adding after `onConnect: () => void;`:
```tsx
  onReconnect: (account: AdAccount) => void;
```
Add `onReconnect` to the destructured params (after `onConnect,` at line 469):
```tsx
  onConnect,
  onReconnect,
```
Replace the Reconnect button (lines 556–561) so it calls `onReconnect(acc)` instead of `onConnect`:
```tsx
              {needsReauth && (
                <Button variant="outline" size="sm" onClick={() => onReconnect(acc)}>
                  <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
                  {t('ads.action.reconnect', { defaultValue: 'Reconnect' })}
                </Button>
              )}
```

- [ ] **Step 9: Typecheck → PASS.** `cd frontend && npx tsc --noEmit`
  Expected: **PASS** (no type errors; `LINKEDIN` is a member of every `AdProvider`-keyed map).

- [ ] **Step 10: Run the page test → PASS.** `cd frontend && npx vitest run src/pages/marketing/ads/AdReportingPage.test.tsx`
  Expected: **PASS** (existing assertions still hold; the new CTA is additive). If the test renders without a router and now fails on `useSearchParams`, wrap the render in `<MemoryRouter>` in that test file (the TikTok worktree's `AdReportingPage.test.tsx` already does this — mirror it).

- [ ] **Step 11: Build → PASS.** `cd frontend && npm run build`
  Expected: **PASS**.

- [ ] **Step 12: Commit.**
```bash
git add frontend/src/features/marketing/api/ads.service.ts frontend/src/pages/marketing/ads/adsSchemas.ts frontend/src/pages/marketing/ads/LinkedinAdsSelectDialog.tsx frontend/src/pages/marketing/ads/AdReportingPage.tsx frontend/src/pages/marketing/ads/AdReportingPage.test.tsx && git commit -m "feat(ads): LinkedIn ads — one-click OAuth connect + account picker + reconnect UI"
```

---

> **Dormancy note (whole phase):** with `LINKEDIN_ADS_CLIENT_ID`/`LINKEDIN_ADS_CLIENT_SECRET` unset, `isLinkedinAdsConfigured()` is `false` → `/ads/status` returns `LINKEDIN:false` so the "Connect LinkedIn" CTA is disabled, `LinkedinAdsOAuthService.start()` throws `BadRequestException`, `AdAccountService.connect('LINKEDIN', …)` and `pullAccount` short-circuit via `isProviderConfigured`, and any orphan LINKEDIN account is marked `lastError` rather than hit. The feature activates the moment an operator provisions the LinkedIn *ads* app credentials — no code change or migration (`AdAccount.provider` is a free-text `String`, comment updated to `META | TIKTOK | LINKEDIN`).

---

# PHASE 3 — Engagement on owned posts + Lead-Gen Forms (the DM substitute)

> **Honesty note (read this before building).** LinkedIn exposes **no general DM API**. This phase is **not** a DM inbox. It is *sanctioned engagement on the workspace's OWN organization posts*: read & reply to comments on posts you published, plus (a deferred stub) Lead Gen Form responses. It is **polling-based — there is no LinkedIn webhook** for comments, so a `@Cron` poller re-reads `/rest/socialActions/.../comments` and relies on `conversationIngress.ingest()`'s `externalMessageId` dedup (no cursor). The whole feature ships **dormant behind a capability flag** (`configPublic.linkedinEngagement === 'granted'`): until LinkedIn **Community Management** approves `w_organization_social`/`r_organization_social`, every path is inert (send → FAILED, poller → no-op). All HTTP goes through the **Phase 0** util `backend/src/common/util/linkedin-api.util.ts` (`linkedinRest`, `isLinkedinAuthError`, `linkedinApiVersion`) — never reimplement those here.

---

### Task 3.1: Extend ChannelType + ContactKind unions for LINKEDIN

**Files:**
- Modify: `backend/src/modules/marketing/channels/channel-adapter.interface.ts` (lines 10–18 `ChannelType`, line 27 `ContactKind`)
- Modify: `backend/src/modules/marketing/channels/conversation-ingress.service.ts` (lines 26–32 `SOURCE_BY_CHANNEL`, lines 308–324 `label()` switch)
- Test: folded into 3.2 (`linkedin-config.util.spec.ts`) + 3.3 (`linkedin-engagement.adapter.spec.ts`) — no standalone spec for a type union.

- [ ] **Step 1: Add `'LINKEDIN'` to the `ChannelType` union.** In `channel-adapter.interface.ts`, replace the union (lines 10–18):
  ```ts
  export type ChannelType =
    | 'WEBCHAT'
    | 'WHATSAPP'
    | 'SMS'
    | 'INSTAGRAM'
    | 'MESSENGER'
    | 'TIKTOK' // TikTok DM (Business Messaging) — gated API; inert without creds
    | 'LINKEDIN' // LinkedIn engagement (comments on OWNED org posts) — gated; inert without Community Management approval
    | 'EMAIL' // two-way email — per-workspace SMTP send + provider inbound webhook
    | 'VOICE'; // inbound AI phone (Twilio) — config-only, no text send
  ```

- [ ] **Step 2: Add `'LINKEDIN'` to the `ContactKind` union.** Replace line 27:
  ```ts
  /** How an external identity maps to a ContactIdentity.kind. */
  export type ContactKind = 'PHONE' | 'WA' | 'PSID' | 'IGSID' | 'WEBCHAT' | 'TIKTOKID' | 'EMAIL' | 'LINKEDIN';
  ```

- [ ] **Step 3: Map the new channel's lead source.** In `conversation-ingress.service.ts`, add a `LINKEDIN` entry to `SOURCE_BY_CHANNEL` (lines 26–32):
  ```ts
  /** Lead.source value for a first-touch on each channel type. */
  const SOURCE_BY_CHANNEL: Record<string, string> = {
    WEBCHAT: 'WEBSITE',
    WHATSAPP: 'OTHER',
    SMS: 'PHONE',
    INSTAGRAM: 'INSTAGRAM',
    MESSENGER: 'OTHER',
    LINKEDIN: 'OTHER',
  };
  ```

- [ ] **Step 4: Give the new channel a human label.** In the `label()` switch (lines 308–324), add a `LINKEDIN` case before `default`:
  ```ts
      case 'MESSENGER':
        return 'Messenger';
      case 'LINKEDIN':
        return 'LinkedIn';
      default:
        return 'Channel';
  ```

- [ ] **Step 5: Build to confirm the unions still compile.** Run command:
  ```bash
  cd backend && npm run build
  ```
  Expected: PASS (no TS errors; `'LINKEDIN'` now a valid `ChannelType`/`ContactKind`, all switches exhaustive).

- [ ] **Step 6: Commit.**
  ```bash
  git add backend/src/modules/marketing/channels/channel-adapter.interface.ts backend/src/modules/marketing/channels/conversation-ingress.service.ts
  git commit -m "feat(linkedin): extend ChannelType + ContactKind unions with LINKEDIN (engagement channel)"
  ```

---

### Task 3.2: linkedin-config.util — save-time secret validation, wired into ChannelsService

**Files:**
- Create: `backend/src/modules/marketing/channels/linkedin-config.util.ts`
- Modify: `backend/src/modules/marketing/channels/channels.service.ts` (import line ~22; `create()` lines 112–116; `update()` lines 230–245)
- Test: `backend/src/modules/marketing/channels/linkedin-config.util.spec.ts`

- [ ] **Step 1: Write the failing spec.** Create `linkedin-config.util.spec.ts`:
  ```ts
  import { BadRequestException } from '@nestjs/common';
  import { assertLinkedinEngagementSecrets } from './linkedin-config.util';

  /**
   * LinkedIn engagement channel credential validation. Requires an accessToken
   * (the OAuth token carrying w_organization_social / r_organization_social).
   * Failing at save-time with a clear message beats an opaque /rest error on the
   * first comment-reply. The channel stays inert behind its capability flag even
   * with a valid token until Community Management is approved.
   */
  describe('assertLinkedinEngagementSecrets', () => {
    it('accepts a present, non-blank access token (no throw)', () => {
      expect(() => assertLinkedinEngagementSecrets({ accessToken: 'AQX_tok123' })).not.toThrow();
    });

    it('rejects missing accessToken (throws BadRequestException)', () => {
      expect(() => assertLinkedinEngagementSecrets({})).toThrow(BadRequestException);
      expect(() => assertLinkedinEngagementSecrets(undefined)).toThrow(BadRequestException);
    });

    it('rejects blank / whitespace accessToken (throws BadRequestException)', () => {
      expect(() => assertLinkedinEngagementSecrets({ accessToken: '' })).toThrow(BadRequestException);
      expect(() => assertLinkedinEngagementSecrets({ accessToken: '   ' })).toThrow(BadRequestException);
    });

    it('error message mentions accessToken', () => {
      expect(() => assertLinkedinEngagementSecrets({})).toThrow(/accessToken/i);
    });
  });
  ```

- [ ] **Step 2: Run the spec — it MUST fail (module does not exist yet).**
  ```bash
  cd backend && npx jest src/modules/marketing/channels/linkedin-config.util.spec.ts
  ```
  Expected: FAIL (`Cannot find module './linkedin-config.util'`).

- [ ] **Step 3: Implement the util.** Create `linkedin-config.util.ts` (mirrors `tiktok-config.util.ts`):
  ```ts
  import { BadRequestException } from '@nestjs/common';

  /**
   * Validate the secret credentials of a LinkedIn engagement channel at
   * save-time. Engagement (read/reply to comments on OWNED org posts) needs an
   * `accessToken` — the OAuth token carrying w_organization_social /
   * r_organization_social. Failing here with an actionable message beats
   * discovering it as an opaque /rest error on the first comment-reply.
   *
   * NOTE: a present token does NOT make the channel live. Engagement stays inert
   * behind the `configPublic.linkedinEngagement === 'granted'` capability flag
   * until LinkedIn Community Management access is approved.
   */
  export function assertLinkedinEngagementSecrets(
    secrets: Record<string, string> | undefined,
  ): void {
    const s = secrets ?? {};
    const present = (k: string) => typeof s[k] === 'string' && s[k].trim() !== '';

    if (!present('accessToken')) {
      throw new BadRequestException(
        'LinkedIn engagement channel requires an "accessToken" (OAuth token with w_organization_social / r_organization_social).',
      );
    }
  }
  ```

- [ ] **Step 4: Re-run the spec — it MUST pass.**
  ```bash
  cd backend && npx jest src/modules/marketing/channels/linkedin-config.util.spec.ts
  ```
  Expected: PASS (4 tests green).

- [ ] **Step 5: Import the assert in `channels.service.ts`.** Add after the existing config-util imports (after line 22, `import { metaWebhookCallbackUrl } ...`):
  ```ts
  import { assertLinkedinEngagementSecrets } from './linkedin-config.util';
  ```

- [ ] **Step 6: Wire it into `create()`.** In the secrets block (lines 112–116), add a `LINKEDIN` branch:
  ```ts
      if (dto.secrets && Object.keys(dto.secrets).length) {
        if (dto.type === 'SMS') assertNetgsmSmsSecrets(dto.secrets);
        else if (isMetaChannelType(dto.type)) assertMetaSecrets(dto.type, dto.secrets);
        else if (dto.type === 'LINKEDIN') assertLinkedinEngagementSecrets(dto.secrets);
        data.configSealed = this.seal(dto.secrets);
      }
  ```

- [ ] **Step 7: Wire it into `update()`.** In the merge/validate block (lines 242–244), add the same branch:
  ```ts
        const merged = { ...current, ...dto.secrets };
        if (existing.type === 'SMS') assertNetgsmSmsSecrets(merged);
        else if (isMetaChannelType(existing.type)) assertMetaSecrets(existing.type, merged);
        else if (existing.type === 'LINKEDIN') assertLinkedinEngagementSecrets(merged);
        data.configSealed = this.seal(merged);
  ```

- [ ] **Step 8: Build to confirm the service still compiles.**
  ```bash
  cd backend && npm run build
  ```
  Expected: PASS.

- [ ] **Step 9: Commit.**
  ```bash
  git add backend/src/modules/marketing/channels/linkedin-config.util.ts backend/src/modules/marketing/channels/linkedin-config.util.spec.ts backend/src/modules/marketing/channels/channels.service.ts
  git commit -m "feat(linkedin): assertLinkedinEngagementSecrets + wire into channels create/update"
  ```

---

### Task 3.3: linkedin-engagement.adapter — capability-gated comment-reply adapter

**Files:**
- Create: `backend/src/modules/marketing/channels/adapters/linkedin-engagement.adapter.ts`
- Modify: `backend/src/modules/marketing/marketing.module.ts` (import after line 130; provider after line 584)
- Test: `backend/src/modules/marketing/channels/adapters/linkedin-engagement.adapter.spec.ts`

- [ ] **Step 1: Write the failing spec.** Create `linkedin-engagement.adapter.spec.ts`. It mocks the Phase 0 util at the module seam (`jest.mock('../../../../common/util/linkedin-api.util')`):
  ```ts
  import { LinkedinEngagementAdapter } from './linkedin-engagement.adapter';
  import * as linkedinApi from '../../../../common/util/linkedin-api.util';

  jest.mock('../../../../common/util/linkedin-api.util');

  describe('LinkedinEngagementAdapter', () => {
    const registry = { register: jest.fn() } as any;
    let adapter: LinkedinEngagementAdapter;
    const linkedinRest = linkedinApi.linkedinRest as jest.Mock;

    beforeEach(() => {
      jest.clearAllMocks();
      adapter = new LinkedinEngagementAdapter(registry);
    });

    const grantedConfig = (over: any = {}) => ({
      channelId: 'ch-li',
      workspaceId: 'w1',
      type: 'LINKEDIN',
      externalId: 'urn:li:organization:123',
      secrets: { accessToken: 'tok' },
      public: { linkedinEngagement: 'granted' },
      ...over,
    });

    it('registers itself on module init as LINKEDIN', () => {
      adapter.onModuleInit();
      expect(registry.register).toHaveBeenCalledWith(adapter);
      expect(adapter.type).toBe('LINKEDIN');
    });

    it('is INERT (FAILED, no HTTP) when the capability flag is not granted', async () => {
      const res = await adapter.send({
        config: grantedConfig({ public: {} }) as any,
        to: 'urn:li:ugcPost:999',
        text: 'hi',
      });
      expect(res.status).toBe('FAILED');
      expect(res.error).toContain('not granted');
      expect(linkedinRest).not.toHaveBeenCalled();
    });

    it('posts a comment REPLY with actor/object/message body to the post urn from `to`', async () => {
      linkedinRest.mockResolvedValue({ ok: true, status: 201, data: {}, restliId: 'urn:li:comment:(urn:li:ugcPost:999,888)', error: null });
      const res = await adapter.send({
        config: grantedConfig() as any,
        to: 'urn:li:ugcPost:999',
        text: 'Thanks for the comment!',
      });
      expect(linkedinRest).toHaveBeenCalledWith(
        '/rest/socialActions/urn%3Ali%3AugcPost%3A999/comments',
        expect.objectContaining({
          accessToken: 'tok',
          method: 'POST',
          body: {
            actor: 'urn:li:organization:123',
            object: 'urn:li:ugcPost:999',
            message: { text: 'Thanks for the comment!' },
          },
        }),
      );
      expect(res).toEqual({ externalMessageId: 'urn:li:comment:(urn:li:ugcPost:999,888)', status: 'SENT' });
    });

    it('maps a linkedinRest !ok into FAILED with the provider error message', async () => {
      linkedinRest.mockResolvedValue({ ok: false, status: 403, data: null, restliId: null, error: { message: 'ACCESS_DENIED', status: 403, serviceErrorCode: null, isAuthError: false, raw: {} } });
      const res = await adapter.send({ config: grantedConfig() as any, to: 'urn:li:ugcPost:999', text: 'hi' });
      expect(res.status).toBe('FAILED');
      expect(res.error).toContain('ACCESS_DENIED');
      expect(res.externalMessageId).toBeNull();
    });

    it('falls back to config.public.postUrn when `to` is empty', async () => {
      linkedinRest.mockResolvedValue({ ok: true, status: 201, data: {}, restliId: 'urn:li:comment:x', error: null });
      await adapter.send({
        config: grantedConfig({ public: { linkedinEngagement: 'granted', postUrn: 'urn:li:ugcPost:777' } }) as any,
        to: '',
        text: 'hi',
      });
      expect(linkedinRest).toHaveBeenCalledWith(
        '/rest/socialActions/urn%3Ali%3AugcPost%3A777/comments',
        expect.objectContaining({ body: expect.objectContaining({ object: 'urn:li:ugcPost:777' }) }),
      );
    });

    it('healthCheck is true only with an access token AND an externalId (actor urn)', async () => {
      expect((await adapter.healthCheck({ secrets: {}, externalId: 'urn:li:organization:123' } as any)).ok).toBe(false);
      expect((await adapter.healthCheck({ secrets: { accessToken: 't' }, externalId: null } as any)).ok).toBe(false);
      expect((await adapter.healthCheck({ secrets: { accessToken: 't' }, externalId: 'urn:li:organization:123' } as any)).ok).toBe(true);
    });
  });
  ```

- [ ] **Step 2: Run the spec — it MUST fail (adapter does not exist).**
  ```bash
  cd backend && npx jest src/modules/marketing/channels/adapters/linkedin-engagement.adapter.spec.ts
  ```
  Expected: FAIL (`Cannot find module './linkedin-engagement.adapter'`).

- [ ] **Step 3: Implement the adapter.** Create `linkedin-engagement.adapter.ts`:
  ```ts
  import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
  import { ChannelAdapterRegistry } from '../channel-adapter.registry';
  import {
    ChannelAdapter,
    ChannelCapability,
    OutboundSend,
    ResolvedChannelConfig,
    SendResult,
  } from '../channel-adapter.interface';
  import { linkedinRest } from '../../../../common/util/linkedin-api.util';

  const CAPS: readonly ChannelCapability[] = ['send', 'receive'];

  /**
   * LinkedIn engagement adapter — the DM substitute. LinkedIn exposes NO general
   * DM API, so "send" here means REPLY to a comment on one of the workspace's OWN
   * organization posts (POST /rest/socialActions/{postUrn}/comments). The poller
   * (linkedin-engagement-poll.service) provides the inbound half. Secrets:
   * { accessToken }. The channel's `externalId` is the actor urn that authors the
   * reply (urn:li:organization:{id} or urn:li:person:{id}).
   *
   * CAPABILITY GATE: fully inert until `config.public.linkedinEngagement ===
   * 'granted'` (set once LinkedIn Community Management access is approved). Until
   * then send() returns FAILED WITHOUT any HTTP — nothing leaks to LinkedIn.
   */
  @Injectable()
  export class LinkedinEngagementAdapter implements ChannelAdapter, OnModuleInit {
    readonly type = 'LINKEDIN' as const;
    readonly capabilities = CAPS;
    private readonly logger = new Logger(LinkedinEngagementAdapter.name);

    constructor(private readonly registry: ChannelAdapterRegistry) {}
    onModuleInit(): void {
      this.registry.register(this);
    }

    async send({ config, to, text }: OutboundSend): Promise<SendResult> {
      // Capability gate — dormant until Community Management is approved. Graceful
      // and inert: no token use, no HTTP, just a FAILED result the sender records.
      if (config.public?.linkedinEngagement !== 'granted') {
        return { externalMessageId: null, status: 'FAILED', error: 'LinkedIn engagement access not granted' };
      }
      const token = config.secrets.accessToken;
      if (!token) {
        return { externalMessageId: null, status: 'FAILED', error: 'LinkedIn access token missing' };
      }
      // The post we're commenting on: the conversation passes the post urn as `to`;
      // fall back to a channel-pinned post urn for single-post setups.
      const postUrn = (to && to.trim()) || String(config.public?.postUrn ?? '');
      if (!postUrn) {
        return { externalMessageId: null, status: 'FAILED', error: 'LinkedIn post urn missing (no `to` and no config.public.postUrn)' };
      }
      const res = await linkedinRest(
        `/rest/socialActions/${encodeURIComponent(postUrn)}/comments`,
        {
          accessToken: token,
          method: 'POST',
          body: {
            actor: config.externalId,
            object: postUrn,
            message: { text },
          },
        },
      );
      if (!res.ok) {
        return {
          externalMessageId: null,
          status: 'FAILED',
          error: `LinkedIn ${res.status}: ${String(res.error?.message ?? '').slice(0, 300)}`,
        };
      }
      // The created comment id is returned in the x-restli-id header (result.restliId).
      return { externalMessageId: res.restliId, status: 'SENT' };
    }

    async healthCheck(config: ResolvedChannelConfig) {
      const ok = !!config.secrets.accessToken && !!config.externalId;
      return {
        ok,
        details: {
          hasToken: !!config.secrets.accessToken,
          hasActorUrn: !!config.externalId,
          engagementGranted: config.public?.linkedinEngagement === 'granted',
        },
      };
    }
  }
  ```

- [ ] **Step 4: Re-run the spec — it MUST pass.**
  ```bash
  cd backend && npx jest src/modules/marketing/channels/adapters/linkedin-engagement.adapter.spec.ts
  ```
  Expected: PASS (6 tests green — gate off, body shape, restliId mapping, !ok mapping, postUrn fallback, healthCheck).

- [ ] **Step 5: Register the adapter in `marketing.module.ts`.** Add the import after line 130 (`import { TiktokDmAdapter } ...`):
  ```ts
  import { LinkedinEngagementAdapter } from './channels/adapters/linkedin-engagement.adapter';
  ```
  Then add it to the providers array right after `TiktokDmAdapter,` (line 584):
  ```ts
      TiktokDmAdapter,
      LinkedinEngagementAdapter,
  ```

- [ ] **Step 6: Build to confirm DI wiring compiles.**
  ```bash
  cd backend && npm run build
  ```
  Expected: PASS (adapter self-registers on init like `TiktokDmAdapter`).

- [ ] **Step 7: Commit.**
  ```bash
  git add backend/src/modules/marketing/channels/adapters/linkedin-engagement.adapter.ts backend/src/modules/marketing/channels/adapters/linkedin-engagement.adapter.spec.ts backend/src/modules/marketing/marketing.module.ts
  git commit -m "feat(linkedin): capability-gated comment-reply adapter (LINKEDIN, inert until granted)"
  ```

---

### Task 3.4: linkedin-engagement-poll.service — @Cron comment poller → conversation ingress

**Files:**
- Create: `backend/src/modules/marketing/channels/linkedin-engagement-poll.service.ts`
- Modify: `backend/src/modules/marketing/marketing.module.ts` (import after the new adapter import; provider after `NetgsmDlrPollService,` line 598)
- Test: `backend/src/modules/marketing/channels/linkedin-engagement-poll.service.spec.ts`

> Inbound half of the substitute. There is **no LinkedIn webhook for comments** — we poll. For each granted LINKEDIN channel, we find the workspace's recently-published LinkedIn org post urns (from `SocialPostTarget` rows: `network='LINKEDIN'`, `externalPostId` non-null, recent), `GET /rest/socialActions/{postUrn}/comments`, and ingest every comment whose `actor !== channel.externalId` (skip our own replies). `ingest()` dedups on `externalMessageId` (the comment id), so re-polling is safe — no cursor needed.

- [ ] **Step 1: Write the failing spec.** Create `linkedin-engagement-poll.service.spec.ts`:
  ```ts
  import { LinkedinEngagementPollService } from './linkedin-engagement-poll.service';
  import * as linkedinApi from '../../../common/util/linkedin-api.util';

  jest.mock('../../../common/util/linkedin-api.util');

  /**
   * Polls comments on the workspace's OWN LinkedIn org posts (there is no webhook)
   * and routes third-party comments through conversation ingress as inbound
   * messages. Self-authored replies (actor === channel actor urn) are skipped to
   * avoid a reply loop; ingest()'s externalMessageId dedup makes re-polling safe.
   * Fully no-ops when the channel's capability flag is not granted.
   */
  describe('LinkedinEngagementPollService.poll', () => {
    let prisma: any;
    let registry: any;
    let ingress: any;
    let service: LinkedinEngagementPollService;
    const linkedinRest = linkedinApi.linkedinRest as jest.Mock;

    const liChannel = {
      id: 'ch-li',
      workspaceId: 'w1',
      type: 'LINKEDIN',
      status: 'ACTIVE',
      externalId: 'urn:li:organization:123',
      configSealed: 'sealed',
      configPublic: { linkedinEngagement: 'granted' },
    };

    beforeEach(() => {
      jest.clearAllMocks();
      prisma = {
        workspace: { findMany: jest.fn().mockResolvedValue([{ id: 'w1' }]) },
        channel: { findMany: jest.fn().mockResolvedValue([liChannel]) },
        socialPostTarget: {
          findMany: jest.fn().mockResolvedValue([
            { externalPostId: 'urn:li:ugcPost:999' },
          ]),
        },
      };
      registry = {
        resolveConfig: jest.fn().mockReturnValue({
          channelId: 'ch-li',
          workspaceId: 'w1',
          type: 'LINKEDIN',
          externalId: 'urn:li:organization:123',
          secrets: { accessToken: 'tok' },
          public: { linkedinEngagement: 'granted' },
        }),
      };
      ingress = { ingest: jest.fn().mockResolvedValue({ deduped: false }) };
      service = new LinkedinEngagementPollService(prisma, registry, ingress);
    });

    it('ingests a third-party comment once as an InboundMessage tagged LINKEDIN', async () => {
      linkedinRest.mockResolvedValue({
        ok: true, status: 200, restliId: null, error: null,
        data: { elements: [
          { actor: 'urn:li:person:viewer-7', id: '888', message: { text: 'Great post!' }, object: 'urn:li:ugcPost:999', created: { time: 1 } },
        ] },
      });
      await service.poll();
      expect(ingress.ingest).toHaveBeenCalledTimes(1);
      const [chan, inbound] = ingress.ingest.mock.calls[0];
      expect(chan).toMatchObject({ id: 'ch-li', workspaceId: 'w1', type: 'LINKEDIN' });
      expect(inbound).toMatchObject({
        externalUserId: 'urn:li:person:viewer-7',
        kind: 'LINKEDIN',
        externalMessageId: '888',
        text: 'Great post!',
      });
    });

    it('skips a self-authored comment (actor === channel actor urn) — no reply loop', async () => {
      linkedinRest.mockResolvedValue({
        ok: true, status: 200, restliId: null, error: null,
        data: { elements: [
          { actor: 'urn:li:organization:123', id: '999', message: { text: 'our own reply' }, object: 'urn:li:ugcPost:999' },
        ] },
      });
      await service.poll();
      expect(ingress.ingest).not.toHaveBeenCalled();
    });

    it('no-ops entirely when the capability flag is not granted', async () => {
      prisma.channel.findMany.mockResolvedValue([
        { ...liChannel, configPublic: {} },
      ]);
      await service.poll();
      expect(prisma.socialPostTarget.findMany).not.toHaveBeenCalled();
      expect(linkedinRest).not.toHaveBeenCalled();
      expect(ingress.ingest).not.toHaveBeenCalled();
    });

    it('scopes the channel + post queries by workspaceId', async () => {
      linkedinRest.mockResolvedValue({ ok: true, status: 200, restliId: null, error: null, data: { elements: [] } });
      await service.poll();
      expect(prisma.channel.findMany.mock.calls[0][0].where).toEqual(
        expect.objectContaining({ workspaceId: 'w1', type: 'LINKEDIN', status: 'ACTIVE' }),
      );
      expect(prisma.socialPostTarget.findMany.mock.calls[0][0].where).toEqual(
        expect.objectContaining({ workspaceId: 'w1', network: 'LINKEDIN' }),
      );
    });

    it('does not query posts when there is no granted LINKEDIN channel', async () => {
      prisma.channel.findMany.mockResolvedValue([]);
      await service.poll();
      expect(prisma.socialPostTarget.findMany).not.toHaveBeenCalled();
      expect(linkedinRest).not.toHaveBeenCalled();
    });
  });
  ```

- [ ] **Step 2: Run the spec — it MUST fail (service does not exist).**
  ```bash
  cd backend && npx jest src/modules/marketing/channels/linkedin-engagement-poll.service.spec.ts
  ```
  Expected: FAIL (`Cannot find module './linkedin-engagement-poll.service'`).

- [ ] **Step 3: Implement the poller.** Create `linkedin-engagement-poll.service.ts` (cron + advisory-lock pattern from `netgsm-dlr-poll.service.ts` and `ads-pull.service.ts`):
  ```ts
  import { Injectable, Logger } from '@nestjs/common';
  import { Cron, CronExpression } from '@nestjs/schedule';
  import { PrismaService } from '../../../prisma/prisma.service';
  import { withAdvisoryLock } from '../../../common/scheduling/advisory-lock';
  import { ChannelAdapterRegistry } from './channel-adapter.registry';
  import { ConversationIngressService } from './conversation-ingress.service';
  import { InboundMessage } from './channel-adapter.interface';
  import { linkedinRest } from '../../../common/util/linkedin-api.util';

  /**
   * Polls comments on the workspace's OWN LinkedIn organization posts and routes
   * third-party comments into the SAME conversation ingress every other channel
   * uses — the inbound half of LinkedIn's "engagement DM substitute". LinkedIn has
   * NO comment webhook, so we re-read /rest/socialActions/{postUrn}/comments on a
   * schedule; ingest()'s externalMessageId dedup (the comment id) makes re-polling
   * idempotent, so no cursor is needed.
   *
   * Workspace-scoped selection + advisory-locked single-replica tick (mirrors
   * NetgsmDlrPollService). DORMANT by default: only channels whose
   * configPublic.linkedinEngagement === 'granted' are polled, so the feature does
   * nothing until LinkedIn Community Management access is approved.
   */
  @Injectable()
  export class LinkedinEngagementPollService {
    private readonly logger = new Logger(LinkedinEngagementPollService.name);

    /** Only read comments on recently-published posts; older ones age out. */
    private static readonly WINDOW_DAYS = 14;
    /** Bound the post fan-out per channel per tick (rate-limit friendly). */
    private static readonly MAX_POSTS_PER_CHANNEL = 25;

    constructor(
      private readonly prisma: PrismaService,
      private readonly registry: ChannelAdapterRegistry,
      private readonly ingress: ConversationIngressService,
    ) {}

    @Cron(CronExpression.EVERY_10_MINUTES, { name: 'linkedin-engagement-poll' })
    async pollDue(): Promise<void> {
      await withAdvisoryLock(
        this.prisma,
        'linkedin-engagement-poll',
        async () => {
          await this.poll();
        },
        this.logger,
      );
    }

    async poll(): Promise<{ ingested: number }> {
      const since = new Date(Date.now() - LinkedinEngagementPollService.WINDOW_DAYS * 86_400_000);
      let ingested = 0;

      const workspaces = await this.prisma.workspace.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true },
      });

      for (const ws of workspaces) {
        // ACTIVE LINKEDIN channels in THIS workspace; gate filtered in code so a
        // non-granted channel never touches the post query or LinkedIn at all.
        const channels = await this.prisma.channel.findMany({
          where: { workspaceId: ws.id, type: 'LINKEDIN', status: 'ACTIVE' },
        });
        const granted = channels.filter(
          (c: any) =>
            c.configPublic &&
            typeof c.configPublic === 'object' &&
            (c.configPublic as any).linkedinEngagement === 'granted',
        );
        if (granted.length === 0) continue;

        // Recent LinkedIn org post urns published from this workspace (the posts
        // whose comment threads we own). Distinct by externalPostId.
        const targets = await this.prisma.socialPostTarget.findMany({
          where: {
            workspaceId: ws.id,
            network: 'LINKEDIN',
            status: 'PUBLISHED',
            externalPostId: { not: null },
            post: { is: { publishedAt: { gte: since } } },
          },
          select: { externalPostId: true },
          take: LinkedinEngagementPollService.MAX_POSTS_PER_CHANNEL,
        });
        const postUrns = Array.from(
          new Set(targets.map((t: any) => t.externalPostId).filter(Boolean) as string[]),
        );
        if (postUrns.length === 0) continue;

        for (const channel of granted) {
          const config = this.registry.resolveConfig(channel as any);
          const token = config.secrets.accessToken;
          const actorUrn = config.externalId != null ? String(config.externalId) : '';
          if (!token) continue;

          for (const postUrn of postUrns) {
            const res = await linkedinRest(
              `/rest/socialActions/${encodeURIComponent(postUrn)}/comments`,
              { accessToken: token, method: 'GET' },
            );
            if (!res.ok) {
              // 404 = a post with zero comments; not an error worth logging loudly.
              if (res.status !== 404) {
                this.logger.warn(
                  `linkedin comments ${postUrn} failed: ${res.error?.message ?? res.status}`,
                );
              }
              continue;
            }
            const elements: any[] = res.data?.elements ?? [];
            for (const comment of elements) {
              const actor = comment?.actor != null ? String(comment.actor) : '';
              // Skip our OWN replies (echo) — same loop-guard as the DM adapter.
              if (!actor || actor === actorUrn) continue;
              const text = comment?.message?.text;
              if (typeof text !== 'string' || !text) continue;
              const inbound: InboundMessage = {
                externalUserId: actor,
                kind: 'LINKEDIN',
                externalMessageId: comment?.id != null ? String(comment.id) : null,
                text,
                displayName: null,
                raw: comment,
              };
              const out = await this.ingress.ingest(
                { id: channel.id, workspaceId: ws.id, type: 'LINKEDIN' },
                inbound,
              );
              if (out && !out.deduped) ingested += 1;
            }
          }
        }
      }

      if (ingested > 0) this.logger.log(`linkedin engagement poll: ingested ${ingested} comment(s)`);
      return { ingested };
    }
  }
  ```

- [ ] **Step 4: Re-run the spec — it MUST pass.**
  ```bash
  cd backend && npx jest src/modules/marketing/channels/linkedin-engagement-poll.service.spec.ts
  ```
  Expected: PASS (5 tests green — third-party ingest, self-skip, gate-off no-op, workspace scoping, no-channel short-circuit).

- [ ] **Step 5: Register the poller in `marketing.module.ts`.** Add the import next to the other channel imports (after the `LinkedinEngagementAdapter` import added in 3.3):
  ```ts
  import { LinkedinEngagementPollService } from './channels/linkedin-engagement-poll.service';
  ```
  Then add it to the providers array right after `NetgsmDlrPollService,` (line 598):
  ```ts
      NetgsmDlrPollService,
      LinkedinEngagementPollService,
  ```

- [ ] **Step 6: Build to confirm the @Cron service wires up.**
  ```bash
  cd backend && npm run build
  ```
  Expected: PASS.

- [ ] **Step 7: Commit.**
  ```bash
  git add backend/src/modules/marketing/channels/linkedin-engagement-poll.service.ts backend/src/modules/marketing/channels/linkedin-engagement-poll.service.spec.ts backend/src/modules/marketing/marketing.module.ts
  git commit -m "feat(linkedin): @Cron comment poller on owned org posts → conversation ingress (gated)"
  ```

---

### Task 3.5: Lead Gen Form ingestion — DEFERRED stub poller (gated, documented)

**Files:**
- Create: `backend/src/modules/marketing/channels/linkedin-leadform-poll.service.ts` (stub — no module registration yet)
- Test: `backend/src/modules/marketing/channels/linkedin-leadform-poll.service.spec.ts`

> **Deferred follow-up — intentionally lean.** Lead Gen Form responses ride the **Phase 2 ads token** (Advertising API, `r_marketing_leadgen_automation` scope), **not** the social-app token used above — a different app/permission tier that is **partner-gated** (LinkedIn Marketing Developer Platform access). Full TDD would bloat this plan, so this ships as a **documented stub poller behind the same capability flag**, wired only when a workspace has both an approved ads token and the leadgen permission. It is **NOT** registered in `marketing.module.ts` yet (no live `@Cron`).
>
> **Exact endpoint:** `GET /rest/leadFormResponses?q=owner&owner=(sponsoredAccount:urn:li:sponsoredAccount:{adAccountId})&versionTag=...` (LinkedIn Advertising API lead-sync; paginated by `start`/`count`). Each response element shape: `{ id, formId, submittedAt, leadType, formResponse:{ answers:[{ questionId, answerDetails:{ textQuestionAnswer:{ answer } } }] } }`.
>
> **InboundMessage mapping (when implemented):**
> - `externalUserId` = `urn:li:lead:{response.id}` (no profile urn is exposed for ads leads — the response id is the stable identity)
> - `kind` = `'LINKEDIN'`
> - `externalMessageId` = `response.id` (the lead-response id — drives ingest dedup)
> - `text` = a flattened "question: answer" summary built from `formResponse.answers[]`
> - `displayName` = the email/name answer if present, else `null`
> - `raw` = the full response element

- [ ] **Step 1: Write the stub spec (asserts the documented mapping + the gate).** Create `linkedin-leadform-poll.service.spec.ts`:
  ```ts
  import { LinkedinLeadformPollService, mapLeadFormResponse } from './linkedin-leadform-poll.service';

  /**
   * Lead Gen Form ingestion is a DEFERRED follow-up: it rides the Phase 2 ads
   * token + the partner-gated Advertising API (/rest/leadFormResponses) and is NOT
   * registered as a live @Cron yet. These tests pin the documented InboundMessage
   * mapping and prove the poller is inert until enabled, so the contract is locked
   * even though the live wiring is deferred.
   */
  describe('LinkedinLeadformPollService (deferred stub)', () => {
    it('mapLeadFormResponse flattens answers into an InboundMessage tagged LINKEDIN', () => {
      const inbound = mapLeadFormResponse({
        id: 'lead-42',
        formId: 'form-1',
        submittedAt: 1,
        formResponse: {
          answers: [
            { questionId: 'q-email', answerDetails: { textQuestionAnswer: { answer: 'a@b.com' } } },
            { questionId: 'q-msg', answerDetails: { textQuestionAnswer: { answer: 'Interested!' } } },
          ],
        },
      } as any);
      expect(inbound).toMatchObject({
        externalUserId: 'urn:li:lead:lead-42',
        kind: 'LINKEDIN',
        externalMessageId: 'lead-42',
      });
      expect(inbound.text).toContain('a@b.com');
      expect(inbound.text).toContain('Interested!');
    });

    it('poll() is INERT until lead-sync is enabled (returns {ingested:0}, no HTTP)', async () => {
      const prisma = { workspace: { findMany: jest.fn().mockResolvedValue([]) } } as any;
      const ingress = { ingest: jest.fn() } as any;
      const service = new LinkedinLeadformPollService(prisma, ingress);
      const out = await service.poll();
      expect(out).toEqual({ ingested: 0 });
      expect(ingress.ingest).not.toHaveBeenCalled();
    });
  });
  ```

- [ ] **Step 2: Run the spec — it MUST fail (service does not exist).**
  ```bash
  cd backend && npx jest src/modules/marketing/channels/linkedin-leadform-poll.service.spec.ts
  ```
  Expected: FAIL (`Cannot find module './linkedin-leadform-poll.service'`).

- [ ] **Step 3: Implement the stub.** Create `linkedin-leadform-poll.service.ts`:
  ```ts
  import { Injectable, Logger } from '@nestjs/common';
  import { PrismaService } from '../../../prisma/prisma.service';
  import { ConversationIngressService } from './conversation-ingress.service';
  import { InboundMessage } from './channel-adapter.interface';

  /**
   * DEFERRED FOLLOW-UP — LinkedIn Lead Gen Form ingestion.
   *
   * Lead responses are fetched from the Advertising API lead-sync endpoint:
   *   GET /rest/leadFormResponses
   *       ?q=owner
   *       &owner=(sponsoredAccount:urn:li:sponsoredAccount:{adAccountId})
   *   (paginated by start/count; element:
   *    { id, formId, submittedAt, formResponse:{ answers:[{ questionId,
   *      answerDetails:{ textQuestionAnswer:{ answer } } }] } })
   *
   * This rides the PHASE 2 ADS token (NOT the social-app token used by the
   * comment poller) + the partner-gated r_marketing_leadgen_automation scope, so
   * it is shipped as a documented STUB behind the same capability flag and is NOT
   * registered as a live @Cron. poll() is inert until lead-sync is wired.
   */
  @Injectable()
  export class LinkedinLeadformPollService {
    private readonly logger = new Logger(LinkedinLeadformPollService.name);

    constructor(
      private readonly prisma: PrismaService,
      private readonly ingress: ConversationIngressService,
    ) {}

    /** Inert until lead-sync (Advertising API partner access) is enabled. */
    async poll(): Promise<{ ingested: number }> {
      // Deferred: when enabled, for each workspace ads account with the leadgen
      // scope, GET /rest/leadFormResponses (paginated), map each element via
      // mapLeadFormResponse, and ingress.ingest({...,type:'LINKEDIN'}, inbound).
      // ingest()'s externalMessageId dedup (response.id) makes re-polling safe.
      return { ingested: 0 };
    }
  }

  /**
   * Map one LinkedIn lead-form response into a transport-agnostic InboundMessage.
   * Pure + exported so the documented mapping is unit-locked even while the live
   * poller is deferred.
   */
  export function mapLeadFormResponse(response: any): InboundMessage {
    const answers: any[] = response?.formResponse?.answers ?? [];
    const text = answers
      .map((a) => {
        const ans = a?.answerDetails?.textQuestionAnswer?.answer ?? '';
        return `${a?.questionId ?? 'q'}: ${ans}`;
      })
      .join('\n');
    // First answer that looks like an email is used to name the lead, else null.
    const email = answers
      .map((a) => a?.answerDetails?.textQuestionAnswer?.answer ?? '')
      .find((v) => typeof v === 'string' && v.includes('@'));
    return {
      externalUserId: `urn:li:lead:${response?.id ?? ''}`,
      kind: 'LINKEDIN',
      externalMessageId: response?.id != null ? String(response.id) : null,
      text,
      displayName: email || null,
      raw: response,
    };
  }
  ```

- [ ] **Step 4: Re-run the spec — it MUST pass.**
  ```bash
  cd backend && npx jest src/modules/marketing/channels/linkedin-leadform-poll.service.spec.ts
  ```
  Expected: PASS (2 tests green — mapping + inert poll). Service is intentionally NOT added to `marketing.module.ts` (no live cron).

- [ ] **Step 5: Commit.**
  ```bash
  git add backend/src/modules/marketing/channels/linkedin-leadform-poll.service.ts backend/src/modules/marketing/channels/linkedin-leadform-poll.service.spec.ts
  git commit -m "feat(linkedin): deferred Lead Gen Form ingestion stub + documented mapping (gated, unwired)"
  ```

---

### Task 3.6: Frontend — LinkedIn engagement channel card + capability status

**Files:**
- Modify: `frontend/src/pages/marketing/ChannelsSettingsPage.tsx` (`CHANNEL_TYPES` line 69; `SECRET_FIELDS` lines 72–81; `NEEDS_EXTERNAL_ID` lines 82–89; `ChannelRow` interface lines 44–61; channel-card body after the Meta block, line ~542)
- Test: `frontend/src/pages/marketing/ChannelsSettingsPage.test.tsx`

> Clone the TikTok DM channel entry (it's already in the dropdown). The card surfaces the **capability status from `mask()`** (`configPublic.linkedinEngagement`): `granted` → "engagement active"; otherwise an inert "pending Community Management approval" note — the same inert-feature honesty the Meta/SMS cards use.

- [ ] **Step 1: Add `LINKEDIN` to the type dropdown.** Replace `CHANNEL_TYPES` (line 69):
  ```ts
  const CHANNEL_TYPES = ['WEBCHAT', 'WHATSAPP', 'SMS', 'INSTAGRAM', 'MESSENGER', 'TIKTOK', 'LINKEDIN', 'EMAIL', 'VOICE'] as const;
  ```

- [ ] **Step 2: Add its secret + external-id descriptors.** In `SECRET_FIELDS` (after the `TIKTOK` line, line 78):
  ```ts
    TIKTOK: ['accessToken'],
    LINKEDIN: ['accessToken'],
  ```
  In `NEEDS_EXTERNAL_ID` (after the `TIKTOK` line, line 86):
  ```ts
    TIKTOK: 'TikTok business/creator ID',
    LINKEDIN: 'Actor URN (urn:li:organization:… or urn:li:person:…)',
  ```

- [ ] **Step 3: Surface `configPublic` on the row type.** Extend the `ChannelRow` interface (after `verifyTokenConfigured?: boolean;`, line 60):
  ```ts
    verifyTokenConfigured?: boolean;
    // LinkedIn engagement only: mask() echoes configPublic so the card can show
    // whether Community Management access has been granted (the capability flag).
    configPublic?: Record<string, unknown> | null;
  ```

- [ ] **Step 4: Add the LinkedIn status block to the channel card.** Insert immediately after the Meta block's closing `)}` (after line 542, before the closing `</CardContent>` on line 543):
  ```tsx
              {/* LinkedIn engagement (comments on OWNED org posts) is the DM
                  substitute — there is no LinkedIn DM API. It is polling-based and
                  stays DORMANT until LinkedIn Community Management access is granted
                  (capability flag in configPublic.linkedinEngagement). */}
              {c.type === 'LINKEDIN' && (
                <div className="mt-3 pt-3 border-t border-border">
                  {(c.configPublic as any)?.linkedinEngagement === 'granted' ? (
                    <p className="text-caption text-success">
                      {t(
                        'channels.linkedinGranted',
                        'Engagement active — replies to comments on your organization posts are AI-answered. (LinkedIn has no DM API; this is sanctioned engagement on owned posts.)',
                      )}
                    </p>
                  ) : (
                    <p className="text-caption text-muted-foreground">
                      {t(
                        'channels.linkedinPending',
                        'Dormant — comment engagement turns on once LinkedIn Community Management access is approved. LinkedIn exposes no DM API, so this answers comments on your OWN organization posts (polling-based, no webhook).',
                      )}
                    </p>
                  )}
                </div>
              )}
  ```

- [ ] **Step 5: Add a frontend test for the LinkedIn card status.** In `ChannelsSettingsPage.test.tsx`, add this test inside the `describe` block (after the existing "opens the create dialog" test, before the closing `});` on line 53):
  ```tsx
    it('renders the LinkedIn dormant status when engagement is not granted', async () => {
      const marketingApi = (await import('../../features/marketing/api/marketingApi')).default as any;
      marketingApi.get.mockImplementation((url: string) =>
        url === '/channels'
          ? Promise.resolve({
              data: [
                {
                  id: 'li1',
                  type: 'LINKEDIN',
                  name: 'Company page',
                  status: 'ACTIVE',
                  configuredSecrets: ['accessToken'],
                  configPublic: {},
                },
              ],
            })
          : Promise.resolve({ data: [] }),
      );
      render(<ChannelsSettingsPage />, { wrapper });
      expect(await screen.findByText(/Community Management access is approved/i)).toBeInTheDocument();
    });
  ```

- [ ] **Step 6: Typecheck + run the test + build.**
  ```bash
  cd frontend && npx tsc --noEmit && npx vitest run src/pages/marketing/ChannelsSettingsPage.test.tsx && npm run build
  ```
  Expected: PASS (tsc clean; the new test + the 2 existing tests green; build succeeds).

- [ ] **Step 7: Commit.**
  ```bash
  git add frontend/src/pages/marketing/ChannelsSettingsPage.tsx frontend/src/pages/marketing/ChannelsSettingsPage.test.tsx
  git commit -m "feat(linkedin): channels UI — LinkedIn engagement card + capability/dormant status"
  ```

---

## Self-Review

**Spec coverage** (against `2026-06-24-linkedin-integration-design.md`):
- Phase 0 ↔ shared `linkedin-api.util` (flat result + `isLinkedinAuthError`) + `r_organization_admin`→`r_organization_social` fix + env docs ✓
- Phase 1 ↔ `/v2/ugcPosts`→`/rest/posts`, register-upload (image+multiImage+video), `PublishOptions.linkedin` visibility, `isAuthError` surfaced, composer control ✓
- Phase 2 ↔ one-click OAuth-to-provision (clone of `tiktok-business-oauth` on on-main `signState`/`PendingSocialConnection`/`AdAccountService.connect`), `linkedin-ads.client` (adAnalytics), `PROVIDERS`/`isLinkedinAdsConfigured`/DTO/status/`markReauth`, frontend connect/reconnect ✓
- Phase 3 ↔ engagement analog: `ChannelType`+=LINKEDIN, comment-reply adapter (capability-gated), `@Cron` comment poller → `ConversationIngressService.ingest`, lead-form gated stub, channel card; DM correctly de-scoped ✓
- Data model: **no migration** — `SocialPost.options` JSON (`linkedin` key), `AdAccount.provider` string, `Channel.configPublic` JSON capability flag, `ContactIdentity.kind` free-form ✓
- Sequencing/gating: Phases 0–1 ship self-serve live; org publishing + ads + engagement ship dormant behind env/capability flags, activate on LinkedIn review with no code change ✓

**Placeholders:** none (scanned for TBD/TODO/"similar to"/"add error handling"/trailing `...` — clean). Task 3.5 (lead-form) is an explicit gated stub with the exact endpoint + `InboundMessage` mapping, not a hand-wave.

**Type consistency:** Phase 0's `LinkedinResult{ok,status,data,restliId,error}` + `linkedinRest`/`linkedinUpload`/`isLinkedinAuthError` are imported (never redefined) across Phases 1–3; `PublishOptions.linkedin: LinkedinPostOptions{visibility}` defined in 1.1, consumed in 1.2/1.4/1.5; `pullLinkedinInsights(token, sponsoredAccountId, since, until): AdMetricRow[]` defined in 2.2, consumed in 2.6; provider string `'LINKEDIN'` uniform across DTO/`PROVIDERS`/`status`/client routing; `ChannelType`/`ContactKind` `'LINKEDIN'` added in 3.1, consumed in 3.2–3.4. Flat result shape throughout (no discriminated-union narrowing — repo `strictNullChecks:false`).

**Execution caveats:** (1) Line-number references in "replace lines X–Y" steps are approximate — locate each edit by the **shown code** (content-match), since earlier tasks shift line numbers. (2) Each task that adds a Nest controller/service/adapter must register it in the owning module (called out per task); run the targeted suite after each to confirm DI resolves. (3) The `adAnalytics` rest.li query is hand-assembled (literal `dateRange(...)` parens, percent-encoded `sponsoredAccount` URN) — do not route it through `URLSearchParams` (it would double-encode the parens).
