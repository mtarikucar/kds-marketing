# TikTok Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring TikTok to Meta-parity — full-feature organic publishing, OAuth-linked ads reporting, and two-way DM — multi-tenant, sealed-token, env/capability-gated.

**Architecture:** Two TikTok developer platforms. **Login Kit consumer** (`open.tiktokapis.com`) powers organic publish through the existing `social-oauth` `tiktok` network + `social-planner`. **TikTok for Business** (`business-api.tiktok.com`) powers ads + live DM through one non-expiring business token, provisioned by a new `tiktok-business` network that rides the Meta-generalized `social-oauth` confirm()-dispatcher. See spec: `docs/superpowers/specs/2026-06-23-tiktok-integration-design.md`.

**Tech Stack:** NestJS 11 + TypeScript 5.3, Prisma 6.19 / PostgreSQL, Jest 29 (`*.spec.ts`, ts-jest), React 18 + Vite. Secrets sealed AES-256-GCM via `sealSecret`/`openSecret`; outbound HTTP via `safeFetch` (SSRF-safe, returns a web `Response`).

**Commands:** backend tests `cd backend && npx jest <path>` (full suite `npm test`); build `npm run build` (`nest build`); migration `npx prisma migrate dev --name <name>`; frontend type-check `cd frontend && npx tsc --noEmit`, tests `npx vitest run <path>`.

---

## ⛔ Blocking pre-flight gates (from the spec)

These do NOT block Phases 0–1 (fully buildable now). They gate Phases 2–3:

- **Gate G1 — business token lifetime** (gates the Phase 2 no-refresh decision). Confirm against live docs/sandbox that the TikTok-for-Business access token is non-expiring and the exchange returns no `refresh_token`. If FALSE → add a refresh path instead of `refresh()`=no-op.
- **Gate G2 — Business Messaging DM contract** (gates Phase 3). Confirm the BM send endpoint path, inbound webhook contract, signature scheme, and whether a GET-challenge is used. DM code stays behind the `messaging` capability flag until G2 passes.
- **Coordination gate** — Phase 2 edits files the parallel Meta session owns (`social-oauth.*`, `ad-account.service.ts`, `marketing-ads.controller.ts`, frontend ads/oauth). Execute Phase 2 only AFTER the Meta session's social-oauth confirm()-dispatcher + `AdAccount.connectedVia` migration land on `main`; then rebase `feat/tiktok-integration`. **Before executing Phase 2/3, re-gather verbatim source of the then-current Meta-owned files — the code sketches below are against the documented interfaces, not yet the merged code.**

---

# PHASE 0 — Shared TikTok-for-Business client + config (keystone, unblocked)

File-disjoint from the Meta session. Build first; Phases 2 and 3 depend on it.

### Task 0.1: `tiktok-business.util.ts` HTTP client

**Files:**
- Create: `backend/src/modules/marketing/channels/tiktok-business.util.ts`
- Test: `backend/src/modules/marketing/channels/tiktok-business.util.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// backend/src/modules/marketing/channels/tiktok-business.util.spec.ts
import { safeFetch } from '../../../common/util/safe-fetch';
import {
  tiktokBusinessFetch,
  isTiktokBusinessAuthError,
  TiktokBusinessError,
  businessApiBaseUrl,
} from './tiktok-business.util';

jest.mock('../../../common/util/safe-fetch');
const mockedFetch = safeFetch as jest.MockedFunction<typeof safeFetch>;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('tiktok-business.util', () => {
  afterEach(() => jest.resetAllMocks());

  it('returns ok with data on code 0', async () => {
    mockedFetch.mockResolvedValue(
      jsonResponse({ code: 0, message: 'OK', request_id: 'r1', data: { advertiser_ids: ['1'] } }),
    );
    const res = await tiktokBusinessFetch('/oauth2/advertiser/get/', { accessToken: 't' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({ advertiser_ids: ['1'] });
      expect(res.requestId).toBe('r1');
    }
  });

  it('classifies an auth error from a non-zero auth code', async () => {
    mockedFetch.mockResolvedValue(
      jsonResponse({ code: 40105, message: 'Access token is invalid', request_id: 'r2' }, 200),
    );
    const res = await tiktokBusinessFetch('/report/integrated/get/', { accessToken: 't' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBeInstanceOf(TiktokBusinessError);
      expect(res.error.code).toBe(40105);
      expect(isTiktokBusinessAuthError(res.error)).toBe(true);
    }
  });

  it('classifies a non-auth business error as non-auth', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ code: 40000, message: 'param error' }, 200));
    const res = await tiktokBusinessFetch('/x/', { accessToken: 't' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(isTiktokBusinessAuthError(res.error)).toBe(false);
  });

  it('treats a thrown network error as a (retryable) auth-agnostic failure', async () => {
    mockedFetch.mockRejectedValue(new Error('ECONNRESET'));
    const res = await tiktokBusinessFetch('/x/', { accessToken: 't' });
    expect(res.ok).toBe(false);
  });

  it('sends the Access-Token header and JSON body, and builds the v1.3 base URL', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ code: 0, data: {} }));
    await tiktokBusinessFetch('/report/integrated/get/', {
      accessToken: 'secret-token',
      method: 'POST',
      body: { advertiser_id: '1' },
    });
    const [url, init] = mockedFetch.mock.calls[0];
    expect(url).toBe(`${businessApiBaseUrl()}/report/integrated/get/`);
    expect((init as any).headers['Access-Token']).toBe('secret-token');
    expect((init as any).body).toBe(JSON.stringify({ advertiser_id: '1' }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest channels/tiktok-business.util`
Expected: FAIL — `Cannot find module './tiktok-business.util'`.

- [ ] **Step 3: Write the implementation**

```typescript
// backend/src/modules/marketing/channels/tiktok-business.util.ts
import { safeFetch } from '../../../common/util/safe-fetch';

/**
 * Thin client for the TikTok-for-Business API (business-api.tiktok.com).
 * Plain module (NOT a Nest provider) so tests can mock `safeFetch` at the
 * module seam — mirrors how the Meta Graph helper is structured.
 *
 * Response envelope is { code, message, request_id, data }; code === 0 is
 * success even on HTTP 200-with-error-code. Auth/permission failures surface
 * as specific non-zero codes (or HTTP 401) and must be classified so the ads
 * sweep / DM send can flag reauth_required rather than retry forever.
 */
const DEFAULT_BASE = 'https://business-api.tiktok.com/open_api/v1.3';

export function businessApiBaseUrl(): string {
  const override = process.env.TIKTOK_BUSINESS_API_BASE_URL;
  return (override && override.replace(/\/+$/, '')) || DEFAULT_BASE;
}

export interface TiktokBusinessRequest {
  accessToken: string;
  method?: 'GET' | 'POST';
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  timeoutMs?: number;
}

export class TiktokBusinessError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly code: number,
    readonly requestId: string | undefined,
    readonly isAuthError: boolean,
  ) {
    super(message);
    this.name = 'TiktokBusinessError';
  }
}

export type TiktokBusinessResult<T = any> =
  | { ok: true; data: T; requestId?: string }
  | { ok: false; error: TiktokBusinessError };

/** Auth/permission/token codes per the TikTok Business API error reference. */
const AUTH_CODES = new Set([40001, 40002, 40100, 40101, 40102, 40104, 40105, 40110]);

export function isTiktokBusinessAuthError(err: unknown): boolean {
  return err instanceof TiktokBusinessError && err.isAuthError;
}

export async function tiktokBusinessFetch<T = any>(
  path: string,
  req: TiktokBusinessRequest,
): Promise<TiktokBusinessResult<T>> {
  const { accessToken, method = 'GET', query, body, timeoutMs = 20_000 } = req;

  const url = new URL(`${businessApiBaseUrl()}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }

  let res: Response;
  try {
    res = await safeFetch(url.toString(), {
      method,
      headers: {
        'Access-Token': accessToken,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      timeoutMs,
    });
  } catch (e: any) {
    // Network/SSRF/timeout — not an auth verdict; let the caller retry later.
    return {
      ok: false,
      error: new TiktokBusinessError(e?.message ?? 'network error', 0, 0, undefined, false),
    };
  }

  let json: any;
  try {
    json = await res.json();
  } catch {
    json = {};
  }

  const code = Number(json?.code ?? (res.ok ? 0 : -1));
  const requestId = typeof json?.request_id === 'string' ? json.request_id : undefined;

  if (res.ok && code === 0) {
    return { ok: true, data: json?.data as T, requestId };
  }

  const isAuth = res.status === 401 || AUTH_CODES.has(code);
  const message = String(json?.message ?? `HTTP ${res.status}`);
  return {
    ok: false,
    error: new TiktokBusinessError(message, res.status, code, requestId, isAuth),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest channels/tiktok-business.util`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/marketing/channels/tiktok-business.util.ts backend/src/modules/marketing/channels/tiktok-business.util.spec.ts
git commit -m "feat(tiktok): shared TikTok-for-Business API client + auth classification"
```

### Task 0.2: env documentation + startup soft-check

**Files:**
- Modify: `backend/.env.example`
- Modify: `backend/src/main.ts` (the existing `validateEnv` soft-check block)

- [ ] **Step 1: Add the business app vars to `.env.example`**

Append under the TikTok section (next to the existing `TIKTOK_CLIENT_KEY`/`TIKTOK_CLIENT_SECRET`):

```bash
# TikTok for Business (Marketing API + Business Messaging). Distinct developer
# app from the consumer TIKTOK_CLIENT_KEY/SECRET above. Powers ads reporting and
# (allowlist-gated) DM. Register redirect URI:
#   ${API_URL}/api/marketing/ads/oauth/tiktok/callback
TIKTOK_BUSINESS_APP_ID=
TIKTOK_BUSINESS_APP_SECRET=
# Optional: override the API base (e.g. a sandbox host) — defaults to v1.3 prod.
# TIKTOK_BUSINESS_API_BASE_URL=
```

- [ ] **Step 2: Add a soft-check in `main.ts` validateEnv**

Open `backend/src/main.ts`, find the existing `validateEnv` (the function that `logger.warn`s about missing optional integration vars). Add, mirroring the existing warn style:

```typescript
if (!process.env.TIKTOK_BUSINESS_APP_ID || !process.env.TIKTOK_BUSINESS_APP_SECRET) {
  logger.warn(
    'TikTok-for-Business not configured (TIKTOK_BUSINESS_APP_ID/SECRET unset) — TikTok ads & DM connect will be inert.',
  );
}
```

Do NOT add the consumer `TIKTOK_CLIENT_KEY/SECRET` here — those belong to the social-oauth work.

- [ ] **Step 3: Verify build**

Run: `cd backend && npm run build`
Expected: succeeds (no type errors).

- [ ] **Step 4: Commit**

```bash
git add backend/.env.example backend/src/main.ts
git commit -m "chore(tiktok): document business-app env + startup soft-check"
```

---

# PHASE 1 — Organic publish parity (consumer side, unblocked)

Extends the working consumer `publishTikTok`. File-disjoint from the Meta session. The consumer OAuth + token refresh already exist (social-oauth `tiktok` network) — do NOT touch them.

### Task 1.1: migration — `SocialPost.options`

**Files:**
- Modify: `backend/prisma/schema.prisma` (model `SocialPost`, ~line 2821)

- [ ] **Step 1: Add the column**

In `model SocialPost`, after `mediaUrls String[]`, add:

```prisma
  /// Per-post publish options (network-specific). For TikTok:
  /// { tiktok?: { privacyLevel?: string, disableComment?: boolean,
  ///   disableDuet?: boolean, disableStitch?: boolean, mediaType?: 'VIDEO'|'PHOTO',
  ///   coverIndex?: number } }
  options     Json?
```

- [ ] **Step 2: Generate the migration**

Run: `cd backend && npx prisma migrate dev --name social_post_options`
Expected: creates `prisma/migrations/<ts>_social_post_options/migration.sql` adding a nullable `options jsonb`, regenerates the client.

- [ ] **Step 3: Verify build**

Run: `cd backend && npm run build`
Expected: succeeds; `SocialPost.options` is on the generated type.

- [ ] **Step 4: Commit**

```bash
git add backend/prisma/schema.prisma backend/prisma/migrations
git commit -m "feat(social-planner): add SocialPost.options for per-post controls"
```

### Task 1.2: `tiktok-upload.util.ts` — FILE_UPLOAD chunk math + transfer

**Files:**
- Create: `backend/src/modules/marketing/social-planner/tiktok-upload.util.ts`
- Test: `backend/src/modules/marketing/social-planner/tiktok-upload.util.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tiktok-upload.util.spec.ts
import { planChunks, MB } from './tiktok-upload.util';

describe('planChunks', () => {
  it('uploads a sub-5MB file as a single whole chunk', () => {
    const size = 3 * MB;
    const plan = planChunks(size);
    expect(plan.totalChunkCount).toBe(1);
    expect(plan.chunkSize).toBe(size);
    expect(plan.ranges).toEqual([{ index: 0, start: 0, end: size - 1 }]);
  });

  it('splits a large file into >=5MB chunks with the remainder folded into the last', () => {
    const size = 25 * MB; // with 10MB default chunk -> floor(25/10)=2 chunks
    const plan = planChunks(size);
    expect(plan.totalChunkCount).toBe(2);
    expect(plan.chunkSize).toBe(10 * MB);
    expect(plan.ranges[0]).toEqual({ index: 0, start: 0, end: 10 * MB - 1 });
    // last chunk absorbs the remainder (10MB..25MB)
    expect(plan.ranges[1]).toEqual({ index: 1, start: 10 * MB, end: size - 1 });
    const lastSize = plan.ranges[1].end - plan.ranges[1].start + 1;
    expect(lastSize).toBeLessThanOrEqual(128 * MB);
  });

  it('grows chunk size to stay within 1000 chunks', () => {
    const size = 12_000 * MB; // 12GB hypothetical — would be >1000 chunks at 10MB
    const plan = planChunks(size);
    expect(plan.totalChunkCount).toBeLessThanOrEqual(1000);
    expect(plan.chunkSize).toBeLessThanOrEqual(64 * MB);
    expect(plan.chunkSize).toBeGreaterThanOrEqual(5 * MB);
  });

  it('rejects an empty or oversized file', () => {
    expect(() => planChunks(0)).toThrow();
    expect(() => planChunks(5 * 1024 * MB)).toThrow(); // > 4GB cap
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest social-planner/tiktok-upload.util`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// tiktok-upload.util.ts
import { safeFetch } from '../../../common/util/safe-fetch';

export const MB = 1024 * 1024;
const MIN_CHUNK = 5 * MB;
const MAX_CHUNK = 64 * MB;
const FINAL_MAX = 128 * MB;
const MAX_CHUNKS = 1000;
const MAX_FILE = 4 * 1024 * MB; // TikTok hard cap 4GB
const DEFAULT_CHUNK = 10 * MB;

export interface ChunkRange {
  index: number;
  start: number;
  end: number; // inclusive byte offset
}
export interface ChunkPlan {
  chunkSize: number;
  totalChunkCount: number;
  ranges: ChunkRange[];
}

/**
 * Compute the TikTok FILE_UPLOAD chunk plan for a video of `videoSize` bytes.
 * Rules (Content Posting media-transfer guide): chunk 5MB..64MB; the final
 * chunk folds in the remainder (<=128MB); <=1000 chunks; files <5MB upload
 * whole. Because chunkSize<=64MB, the folded final chunk is always <128MB.
 */
export function planChunks(videoSize: number): ChunkPlan {
  if (!Number.isInteger(videoSize) || videoSize <= 0) {
    throw new Error('videoSize must be a positive integer');
  }
  if (videoSize > MAX_FILE) {
    throw new Error(`video exceeds TikTok 4GB limit (${videoSize} bytes)`);
  }
  if (videoSize < MIN_CHUNK) {
    return { chunkSize: videoSize, totalChunkCount: 1, ranges: [{ index: 0, start: 0, end: videoSize - 1 }] };
  }

  let chunkSize = DEFAULT_CHUNK;
  if (Math.floor(videoSize / chunkSize) > MAX_CHUNKS) {
    chunkSize = Math.min(MAX_CHUNK, Math.ceil(videoSize / MAX_CHUNKS));
  }
  const totalChunkCount = Math.floor(videoSize / chunkSize);

  const ranges: ChunkRange[] = [];
  for (let i = 0; i < totalChunkCount; i++) {
    const start = i * chunkSize;
    const end = i === totalChunkCount - 1 ? videoSize - 1 : start + chunkSize - 1;
    ranges.push({ index: i, start, end });
  }
  const finalSize = ranges[totalChunkCount - 1].end - ranges[totalChunkCount - 1].start + 1;
  if (finalSize > FINAL_MAX) {
    // Unreachable while chunkSize<=64MB (final<2*chunkSize<128MB) — guard anyway.
    throw new Error('final chunk would exceed 128MB');
  }
  return { chunkSize, totalChunkCount, ranges };
}

/** PUT each chunk to the TikTok-issued upload_url. Throws on the first failure. */
export async function transferChunks(
  uploadUrl: string,
  bytes: Buffer,
  plan: ChunkPlan,
  contentType = 'video/mp4',
): Promise<void> {
  for (const r of plan.ranges) {
    const slice = bytes.subarray(r.start, r.end + 1);
    const res = await safeFetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(slice.length),
        'Content-Range': `bytes ${r.start}-${r.end}/${bytes.length}`,
      },
      body: slice,
      timeoutMs: 60_000,
    });
    if (!res.ok && res.status !== 201 && res.status !== 206) {
      throw new Error(`chunk ${r.index} upload failed: HTTP ${res.status}`);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest social-planner/tiktok-upload.util`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/marketing/social-planner/tiktok-upload.util.ts backend/src/modules/marketing/social-planner/tiktok-upload.util.spec.ts
git commit -m "feat(tiktok): FILE_UPLOAD chunk planning + transfer helper"
```

### Task 1.3: `tiktok-creator-info.util.ts` — Creator Info query

**Files:**
- Create: `backend/src/modules/marketing/social-planner/tiktok-creator-info.util.ts`
- Test: `backend/src/modules/marketing/social-planner/tiktok-creator-info.util.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tiktok-creator-info.util.spec.ts
import { safeFetch } from '../../../common/util/safe-fetch';
import { queryCreatorInfo, validatePrivacyLevel } from './tiktok-creator-info.util';

jest.mock('../../../common/util/safe-fetch');
const mockedFetch = safeFetch as jest.MockedFunction<typeof safeFetch>;
const resp = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => body } as unknown as Response);

describe('tiktok-creator-info.util', () => {
  afterEach(() => jest.resetAllMocks());

  it('parses the creator-info option set', async () => {
    mockedFetch.mockResolvedValue(
      resp({
        data: {
          privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'],
          comment_disabled: false,
          duet_disabled: true,
          stitch_disabled: false,
          max_video_post_duration_sec: 300,
        },
      }),
    );
    const info = await queryCreatorInfo('tok');
    expect(info.privacyLevelOptions).toContain('PUBLIC_TO_EVERYONE');
    expect(info.duetDisabled).toBe(true);
    expect(info.maxVideoPostDurationSec).toBe(300);
  });

  it('clips a privacy level the account cannot use down to the first allowed option', () => {
    const info = { privacyLevelOptions: ['SELF_ONLY'], commentDisabled: false, duetDisabled: false, stitchDisabled: false, maxVideoPostDurationSec: 60 };
    expect(validatePrivacyLevel('PUBLIC_TO_EVERYONE', info)).toBe('SELF_ONLY');
    expect(validatePrivacyLevel('SELF_ONLY', info)).toBe('SELF_ONLY');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest social-planner/tiktok-creator-info.util`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// tiktok-creator-info.util.ts
import { safeFetch } from '../../../common/util/safe-fetch';

export interface TiktokCreatorInfo {
  privacyLevelOptions: string[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxVideoPostDurationSec: number;
}

/** Query the creator's allowed post options (consumer Content Posting API). */
export async function queryCreatorInfo(accessToken: string): Promise<TiktokCreatorInfo> {
  const res = await safeFetch('https://open.tiktokapis.com/v2/post/publish/creator_info/query/', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json; charset=UTF-8' },
    timeoutMs: 15_000,
  });
  const json = (await res.json()) as any;
  if (!res.ok || json?.error?.code === 'access_token_invalid') {
    throw new Error(String(json?.error?.message ?? `creator_info HTTP ${res.status}`));
  }
  const d = json?.data ?? {};
  return {
    privacyLevelOptions: Array.isArray(d.privacy_level_options) ? d.privacy_level_options : ['SELF_ONLY'],
    commentDisabled: !!d.comment_disabled,
    duetDisabled: !!d.duet_disabled,
    stitchDisabled: !!d.stitch_disabled,
    maxVideoPostDurationSec: Number(d.max_video_post_duration_sec ?? 0),
  };
}

/** Force the requested privacy level into what the account actually allows. */
export function validatePrivacyLevel(requested: string | undefined, info: TiktokCreatorInfo): string {
  if (requested && info.privacyLevelOptions.includes(requested)) return requested;
  return info.privacyLevelOptions[0] ?? 'SELF_ONLY';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest social-planner/tiktok-creator-info.util`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/marketing/social-planner/tiktok-creator-info.util.ts backend/src/modules/marketing/social-planner/tiktok-creator-info.util.spec.ts
git commit -m "feat(tiktok): creator-info query + privacy-level validation"
```

### Task 1.4: extend `publishTikTok` — options, FILE_UPLOAD, photo/carousel

**Files:**
- Modify: `backend/src/modules/marketing/social-planner/network-adapters.ts`
- Test: `backend/src/modules/marketing/social-planner/network-adapters.tiktok.spec.ts`

Current signature: `publishToNetwork(account, content, mediaUrls)` → `publishTikTok(account, content, mediaUrls)`. We add an optional `options` arg threaded from the post.

- [ ] **Step 1: Write the failing test** (mock `safeFetch`; assert request bodies)

```typescript
// network-adapters.tiktok.spec.ts
import { safeFetch } from '../../../common/util/safe-fetch';
import { openSecret } from '../../../common/crypto/secret-box.helper';
import { publishToNetwork, AccountRow } from './network-adapters';

jest.mock('../../../common/util/safe-fetch');
jest.mock('../../../common/crypto/secret-box.helper');
const mockedFetch = safeFetch as jest.MockedFunction<typeof safeFetch>;
(openSecret as jest.Mock).mockReturnValue('plain-token');

const resp = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => body } as unknown as Response);
const account: AccountRow = { id: 'a', network: 'TIKTOK', externalId: 'tt1', accessToken: 'sealed', accountType: 'TIKTOK' };

beforeAll(() => {
  process.env.TIKTOK_CLIENT_KEY = 'k';
  process.env.TIKTOK_CLIENT_SECRET = 's';
});
afterEach(() => jest.clearAllMocks());

it('passes per-post privacy + interaction options into the video init body', async () => {
  // creator_info -> video init -> status poll complete
  mockedFetch
    .mockResolvedValueOnce(resp({ data: { privacy_level_options: ['PUBLIC_TO_EVERYONE'], comment_disabled: false, duet_disabled: false, stitch_disabled: false, max_video_post_duration_sec: 300 } }))
    .mockResolvedValueOnce(resp({ data: { publish_id: 'pub1' } }))
    .mockResolvedValueOnce(resp({ data: { status: 'PUBLISH_COMPLETE' } }));

  const res = await publishToNetwork(account, 'hello', ['https://cdn/v.mp4'], {
    tiktok: { privacyLevel: 'PUBLIC_TO_EVERYONE', disableComment: true, disableDuet: true },
  });

  expect(res.ok).toBe(true);
  expect(res.externalPostId).toBe('pub1');
  const initCall = mockedFetch.mock.calls[1];
  const body = JSON.parse((initCall[1] as any).body);
  expect(body.post_info.privacy_level).toBe('PUBLIC_TO_EVERYONE');
  expect(body.post_info.disable_comment).toBe(true);
  expect(body.post_info.disable_duet).toBe(true);
  expect(body.source_info.source).toBe('PULL_FROM_URL');
});

it('routes a PHOTO post to the content/init endpoint with photo_images', async () => {
  mockedFetch
    .mockResolvedValueOnce(resp({ data: { privacy_level_options: ['SELF_ONLY'], comment_disabled: false, duet_disabled: false, stitch_disabled: false, max_video_post_duration_sec: 0 } }))
    .mockResolvedValueOnce(resp({ data: { publish_id: 'pub2' } }))
    .mockResolvedValueOnce(resp({ data: { status: 'PUBLISH_COMPLETE' } }));

  const res = await publishToNetwork(account, 'pics', ['https://cdn/1.jpg', 'https://cdn/2.jpg'], {
    tiktok: { mediaType: 'PHOTO', coverIndex: 1 },
  });

  expect(res.ok).toBe(true);
  const initCall = mockedFetch.mock.calls[1];
  expect(initCall[0]).toContain('/v2/post/publish/content/init/');
  const body = JSON.parse((initCall[1] as any).body);
  expect(body.media_type).toBe('PHOTO');
  expect(body.post_info.photo_images).toEqual(['https://cdn/1.jpg', 'https://cdn/2.jpg']);
  expect(body.post_info.photo_cover_index).toBe(1);
});

it('clips an unavailable privacy level to the creator-info option set', async () => {
  mockedFetch
    .mockResolvedValueOnce(resp({ data: { privacy_level_options: ['SELF_ONLY'], comment_disabled: false, duet_disabled: false, stitch_disabled: false, max_video_post_duration_sec: 60 } }))
    .mockResolvedValueOnce(resp({ data: { publish_id: 'pub3' } }))
    .mockResolvedValueOnce(resp({ data: { status: 'PUBLISH_COMPLETE' } }));
  await publishToNetwork(account, 'x', ['https://cdn/v.mp4'], { tiktok: { privacyLevel: 'PUBLIC_TO_EVERYONE' } });
  const body = JSON.parse((mockedFetch.mock.calls[1][1] as any).body);
  expect(body.post_info.privacy_level).toBe('SELF_ONLY'); // clipped
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest social-planner/network-adapters.tiktok`
Expected: FAIL — `publishToNetwork` does not accept a 4th arg / privacy not clipped.

- [ ] **Step 3: Edit `network-adapters.ts`**

Add the imports + option type at the top:

```typescript
import { queryCreatorInfo, validatePrivacyLevel } from './tiktok-creator-info.util';

export interface TikTokPostOptions {
  privacyLevel?: string;
  disableComment?: boolean;
  disableDuet?: boolean;
  disableStitch?: boolean;
  mediaType?: 'VIDEO' | 'PHOTO';
  coverIndex?: number;
}
export interface PublishOptions {
  tiktok?: TikTokPostOptions;
}
```

Replace the whole `publishTikTok` function with:

```typescript
async function publishTikTok(
  account: AccountRow,
  content: string,
  mediaUrls: string[],
  options?: TikTokPostOptions,
): Promise<PublishResult> {
  if (!isNetworkConfigured('TIKTOK')) {
    return { ok: false, error: 'TikTok not configured: set TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET' };
  }
  const token = revealToken(account);
  if (!token) return { ok: false, error: 'accessToken could not be decrypted' };
  if (mediaUrls.length === 0) {
    return { ok: false, error: 'TikTok requires at least one media URL' };
  }

  try {
    // Step 0 — creator info governs the allowed privacy options + interaction caps.
    const info = await queryCreatorInfo(token);
    const privacy = validatePrivacyLevel(options?.privacyLevel, info);
    const isPhoto = options?.mediaType === 'PHOTO';

    let initUrl: string;
    let initBody: Record<string, any>;
    if (isPhoto) {
      initUrl = 'https://open.tiktokapis.com/v2/post/publish/content/init/';
      initBody = {
        media_type: 'PHOTO',
        post_mode: 'DIRECT_POST',
        post_info: {
          title: content.slice(0, 90),
          description: content.slice(0, 4000),
          privacy_level: privacy,
          disable_comment: options?.disableComment ?? info.commentDisabled,
          photo_images: mediaUrls.slice(0, 35),
          photo_cover_index: Math.min(options?.coverIndex ?? 0, mediaUrls.length - 1),
        },
        source_info: { source: 'PULL_FROM_URL' },
      };
    } else {
      initUrl = 'https://open.tiktokapis.com/v2/post/publish/video/init/';
      initBody = {
        post_info: {
          title: content.slice(0, 2200),
          privacy_level: privacy,
          disable_comment: options?.disableComment ?? info.commentDisabled,
          disable_duet: options?.disableDuet ?? info.duetDisabled,
          disable_stitch: options?.disableStitch ?? info.stitchDisabled,
        },
        source_info: { source: 'PULL_FROM_URL', video_url: mediaUrls[0] },
      };
    }

    const initRes = await safeFetch(initUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=UTF-8' },
      body: JSON.stringify(initBody),
      timeoutMs: 15_000,
    });
    const initJson = (await initRes.json()) as Record<string, any>;
    const publishId = initJson?.data?.publish_id;
    if (!initRes.ok || !publishId) {
      const err = String(initJson?.error?.message ?? initJson?.error?.code ?? initRes.status);
      logger.warn(`TikTok publish init failed (${account.externalId}): ${err}`);
      return { ok: false, error: err.slice(0, 500) };
    }

    for (let i = 0; i < 5; i++) {
      await sleep(2_000);
      const statusRes = await safeFetch('https://open.tiktokapis.com/v2/post/publish/status/fetch/', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({ publish_id: publishId }),
        timeoutMs: 10_000,
      });
      const statusJson = (await statusRes.json()) as Record<string, any>;
      const status = statusJson?.data?.status;
      if (status === 'PUBLISH_COMPLETE') return { ok: true, externalPostId: String(publishId) };
      if (status === 'FAILED') {
        const reason = String(statusJson?.data?.fail_reason ?? 'TikTok rejected the media');
        return { ok: false, error: reason.slice(0, 500) };
      }
    }
    return { ok: true, externalPostId: String(publishId) };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    logger.warn(`TikTok publish error (${account.externalId}): ${msg}`);
    return { ok: false, error: msg.slice(0, 500) };
  }
}
```

Update `publishToNetwork` to accept + forward options:

```typescript
export async function publishToNetwork(
  account: AccountRow,
  content: string,
  mediaUrls: string[],
  options?: PublishOptions,
): Promise<PublishResult> {
  switch (account.network) {
    case 'FACEBOOK':
      return publishFacebook(account, content, mediaUrls);
    case 'INSTAGRAM':
      return publishInstagram(account, content, mediaUrls);
    case 'LINKEDIN':
      return publishLinkedIn(account, content, mediaUrls);
    case 'TIKTOK':
      return publishTikTok(account, content, mediaUrls, options?.tiktok);
    case 'TWITTER':
      return publishTwitter(account, content, mediaUrls);
    case 'PINTEREST':
      return publishPinterest(account, content, mediaUrls);
    case 'GMB':
      return publishGmb(account, content, mediaUrls);
    default:
      return { ok: false, error: `Unknown network: ${account.network}` };
  }
}
```

> **FILE_UPLOAD note:** the `transferChunks`/`planChunks` helpers from Task 1.2 are wired into the publish path only when a post carries raw bytes instead of a public URL. The social-planner currently stores public `mediaUrls`, so PULL_FROM_URL remains the default and FILE_UPLOAD activates once a byte-upload source exists (out of scope to wire a new media-bytes store here; the helper + its tests land now so the path is ready). If during execution you find the planner already stores raw uploads, add a FILE_UPLOAD branch in `publishTikTok` calling `init` (no `video_url`) → `transferChunks(uploadUrl, bytes, planChunks(bytes.length))`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest social-planner/network-adapters.tiktok`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full social-planner test scope (no regressions)**

Run: `cd backend && npx jest social-planner`
Expected: PASS (existing specs stay green).

- [ ] **Step 6: Commit**

```bash
git add backend/src/modules/marketing/social-planner/network-adapters.ts backend/src/modules/marketing/social-planner/network-adapters.tiktok.spec.ts
git commit -m "feat(tiktok): per-post privacy/interaction controls + photo/carousel publish"
```

### Task 1.5: thread `options` through `publishDuePost`

**Files:**
- Modify: `backend/src/modules/marketing/social-planner/social-planner.service.ts` (method `publishDuePost`)

- [ ] **Step 1: Pass `post.options` into `publishToNetwork`**

In `publishDuePost`, change the call:

```typescript
const result = await publishToNetwork(
  target.account,
  post.content,
  post.mediaUrls as string[],
  (post.options as any) ?? undefined,
);
```

(The `options` JSON shape is `{ tiktok?: {...} }`, matching `PublishOptions`.)

- [ ] **Step 2: Verify build + service tests**

Run: `cd backend && npm run build && npx jest social-planner`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/src/modules/marketing/social-planner/social-planner.service.ts
git commit -m "feat(social-planner): forward per-post options to the network adapter"
```

### Task 1.6: creator-info endpoint (read-only enrichment)

**Files:**
- Modify: `backend/src/modules/marketing/social-planner/social-planner.service.ts` (add `tiktokCreatorInfo`)
- Modify: `backend/src/modules/marketing/social-planner/social-planner.controller.ts` (add GET route)

- [ ] **Step 1: Service method**

Add to `SocialPlannerService` (reuses the existing sealed consumer `tiktok` SocialAccount token; uses `openSecret` already imported in the service, else import it):

```typescript
async tiktokCreatorInfo(workspaceId: string, accountId: string) {
  const account = await this.prisma.socialAccount.findFirst({
    where: { id: accountId, workspaceId, network: 'TIKTOK' },
  });
  if (!account) throw new NotFoundException('TikTok account not found');
  const token = openSecret(account.accessToken);
  return queryCreatorInfo(token); // from ./tiktok-creator-info.util
}
```

Add imports at the top of the service: `import { openSecret } from '../../../common/crypto/secret-box.helper';` (if not present) and `import { queryCreatorInfo } from './tiktok-creator-info.util';`.

- [ ] **Step 2: Controller route** (mirror the existing `@Get('accounts')` auth pattern)

```typescript
@Get('accounts/:id/tiktok/creator-info')
tiktokCreatorInfo(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
  return this.svc.tiktokCreatorInfo(u.workspaceId, id);
}
```

- [ ] **Step 3: Verify build**

Run: `cd backend && npm run build`
Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git add backend/src/modules/marketing/social-planner/social-planner.service.ts backend/src/modules/marketing/social-planner/social-planner.controller.ts
git commit -m "feat(tiktok): read-only creator-info endpoint for the planner composer"
```

### Task 1.7: frontend — composer TikTok controls

**Files:**
- Modify: `frontend/src/pages/marketing/SocialPlannerPage.tsx` (composer dialog) + its API client (`frontend/src/...social planner service`)

> **Read first:** open `SocialPlannerPage.tsx` and the social-planner API client to match existing form patterns (RHF + Zod, the existing target-account picker). The audit confirmed this page + `OAuthConnectButtons` already exist.

- [ ] **Step 1:** Add an API call `getTiktokCreatorInfo(accountId)` → `GET /api/marketing/social-planner/accounts/:id/tiktok/creator-info`.
- [ ] **Step 2:** When a TikTok target is selected, fetch creator-info and render: a `privacy_level` select populated from `privacyLevelOptions`; toggles for disable comment/duet/stitch (disabled when the corresponding `*Disabled` capability is true); a media-type switch (video vs photo) that, for photo, lets the user pick a cover image. Persist these into `SocialPost.options.tiktok` on save/schedule.
- [ ] **Step 3:** Type-check + test.

Run: `cd frontend && npx tsc --noEmit`
Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/marketing/SocialPlannerPage.tsx frontend/src/<social-planner-service-file>
git commit -m "feat(tiktok): planner composer privacy/interaction/photo controls"
```

---

# PHASE 2 — TikTok-for-Business OAuth → ads + DM (GATED: after Meta merge + G1)

> **Do NOT start until** the Meta session's social-oauth confirm()-dispatcher + `AdAccount.connectedVia` migration are on `main` and `feat/tiktok-integration` is rebased. **Re-gather verbatim source** of `social-oauth.config.ts`, `social-oauth.providers.ts`, `social-oauth.service.ts`, `ad-account.service.ts`, `marketing-ads.controller.ts` (post-merge) before coding — the snippets below are against the documented interfaces, not the merged code.

### Task 2.1: add the `tiktok-business` OAuth provider

**Files:** Modify `social-oauth.config.ts`, `social-oauth.providers.ts` (+ provider spec).

- [ ] Add a `tiktok-business` network config: authorize `https://business-api.tiktok.com/portal/auth`, token `${businessApiBaseUrl()}/oauth2/access_token/`, env `TIKTOK_BUSINESS_APP_ID`/`TIKTOK_BUSINESS_APP_SECRET`, `isConfigured` gated on both.
- [ ] Implement the provider (mirror the existing `tiktok` consumer provider shape — `buildAuthorizeUrl`/`exchangeCode`/`refresh`/`listAssets`):

```typescript
// inside social-oauth.providers.ts, the tiktok-business provider
buildAuthorizeUrl(state, redirectUri) {
  const u = new URL('https://business-api.tiktok.com/portal/auth');
  u.searchParams.set('app_id', process.env.TIKTOK_BUSINESS_APP_ID!);
  u.searchParams.set('state', state);
  u.searchParams.set('redirect_uri', redirectUri);
  return u.toString();
},
async exchangeCode(code, _redirectUri) {
  const res = await safeFetch(`${businessApiBaseUrl()}/oauth2/access_token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: process.env.TIKTOK_BUSINESS_APP_ID,
      secret: process.env.TIKTOK_BUSINESS_APP_SECRET,
      auth_code: code,
      grant_type: 'authorization_code',
    }),
    timeoutMs: 20_000,
  });
  const json = await res.json();
  const data = json?.data ?? {};
  return { accessToken: data.access_token, refreshToken: undefined, expiresAt: undefined,
           assets: await this.listAssets(data.access_token, data.advertiser_ids, data.scope) };
},
async refresh() { /* business token is non-expiring (Gate G1) — no-op */ throw new Error('no refresh for tiktok-business'); },
async listAssets(token, advertiserIds, scope) {
  const assets = [];
  for (const advId of advertiserIds ?? []) {
    // fetch advertiser name via tiktokBusinessFetch('/advertiser/info/', { accessToken: token, query: { advertiser_ids: JSON.stringify([advId]) } })
    assets.push({ externalId: String(advId), displayName: `TikTok Ads ${advId}`, accountType: 'AD_ACCOUNT', token });
  }
  if (Array.isArray(scope) && scope.some((s) => String(s).toLowerCase().includes('messag'))) {
    assets.push({ externalId: `bm-${advertiserIds?.[0] ?? 'biz'}`, displayName: 'TikTok DM', accountType: 'BUSINESS_MESSAGING', token });
  }
  return assets;
}
```

- [ ] `BUSINESS_MESSAGING` is an ADDITIVE member of the Meta-generalized `ConnectableAsset.accountType` union — extend, do not redefine.
- [ ] Tests: `buildAuthorizeUrl` shape; `exchangeCode` parses `advertiser_ids`+`scope`; `listAssets` emits N AD_ACCOUNT + (scope→1 BUSINESS_MESSAGING / no-scope→0).

### Task 2.2: confirm() dispatcher cases + provisioning

**Files:** Modify `social-oauth.service.ts` (confirm dispatcher), `ad-account.service.ts` (`linkFromOAuth`/`markReauth` TIKTOK), `channels.service.ts` (DM provision path), `social-token-refresh.service.ts` (exclude guard).

- [ ] `confirm()`: `AD_ACCOUNT`(provider TIKTOK) → `AdAccountService.linkFromOAuth(workspaceId, pendingId, externalId)`; `BUSINESS_MESSAGING` → `ChannelsService` upsert a `Channel` (type `TIKTOK`, `externalId`=business id, sealed token, `configPublic={connectedVia:'OAUTH', messaging:'granted'}`). Reuse Meta's collision→skip-not-abort.
- [ ] **Provisioning precedence:** messaging scope NECESSARY (no scope → no BUSINESS_MESSAGING asset); UI toggle = explicit opt-in to create the Channel; no toggle → no Channel even if scope present.
- [ ] **Idempotency keys:** AdAccount `(workspaceId, provider, advertiser_id)`; DM Channel `(workspaceId, business-account id)` — exactly one Channel per grant.
- [ ] `ad-account.service`: `pullAccount` TIKTOK branch flags `TOKEN_EXPIRED`+`reauth_required` on `isTiktokBusinessAuthError`. `TOKEN_EXPIRED` here means **revoked/needs-reauth**, not literal expiry — add NO expiry-window check.
- [ ] `social-token-refresh.service.ts`: add a one-line guard EXCLUDING `tiktok-business` from the sweep (consumer `tiktok` keeps refreshing).
- [ ] Tests: confirm routing (AD_ACCOUNT→AdAccount sealed-not-raw; BUSINESS_MESSAGING→Channel; no-scope→no Channel); reauth classification.

### Task 2.3: routes + frontend connect

**Files:** Modify `marketing-ads.controller.ts` (or wherever Meta landed `/ads/oauth/*`), frontend `AdReportingPage`/`ConnectAdAccountDialog`/`ChannelsSettingsPage`.

- [ ] Connect via `POST /ads/oauth/:provider/start` + `/ads/oauth/confirm` with `:provider = TIKTOK` (coarse enum, like Meta's `META`) resolving to network `tiktok-business`.
- [ ] Frontend "Connect TikTok for Business" CTA on Ads + Channels pages; pending dialog lists advertisers + an "also enable TikTok DM" toggle (only when a `BUSINESS_MESSAGING` asset is present); `reauth_required` → Reconnect badge. Keep manual token paste as advanced fallback.
- [ ] Verify: `cd backend && npm run build && npx jest ads social-oauth`; `cd frontend && npx tsc --noEmit`.

---

# PHASE 3 — DM two-way hardening + capability gating (GATED: G2)

> **Do NOT lock the adapter/webhook until Gate G2 passes.** Re-gather verbatim source of `tiktok-dm.adapter.ts`, `tiktok-webhook.controller.ts`, `channels.service.ts`, and a sibling `*-config.util.ts` + spec before coding.

### Task 3.1: verify-first (Gate G2)
- [ ] Confirm against the live TikTok-for-Business portal docs: the BM **send endpoint path**, the **inbound webhook contract**, its **signature scheme**, and **whether a GET-challenge is used**. Record findings in this plan before proceeding.

### Task 3.2: adapter onto the shared client + capability gate
**Files:** Modify `channels/adapters/tiktok-dm.adapter.ts` (+spec).
- [ ] Refactor `send` onto `tiktokBusinessFetch`; source the token from the OAuth-provisioned `Channel.configSealed`; gate `send` on `configPublic.messaging === 'granted'` → when absent, return a graceful "messaging access not granted" `SendResult` while inbound still ingests (two-way with graceful degradation).
- [ ] Live `healthCheck`.
- [ ] Tests: send body shape; capability gate (granted vs not); `parseInbound` normalization + self-echo/non-text filter (regression).

### Task 3.3: webhook alignment
**Files:** Modify `controllers/tiktok-webhook.controller.ts` (+spec).
- [ ] Align signature verification + (if any) GET-challenge to what G2 established; remove the current Meta-style assumptions; keep async-ACK-200 + background `process()` → `ConversationIngressService.ingest()`.
- [ ] Tests: signed fake payload through the raw-body path → assert ingress ran.

### Task 3.4: save-time validation + masking
**Files:** Create `channels/tiktok-config.util.ts` (+spec); modify `channels.service.ts`.
- [ ] `assertTiktokSecrets(config)` mirroring `meta-config.util`/`netgsm-config.util`; call from `create()`+`update()`; `mask()` exposes `webhookUrl` + `messaging` status, never the token.
- [ ] Tests: validation pass/fail; mask hides token.

---

## Self-Review

**Spec coverage:**
- Phase 0 ↔ spec Phase 0 (shared client + config) ✓
- Phase 1 ↔ spec Phase 1 (FILE_UPLOAD util, creator-info, per-post controls, photo/carousel, `SocialPost.options` migration, creator-info endpoint, frontend) ✓
- Phase 2 ↔ spec Phase 2 (tiktok-business provider, confirm dispatcher, AdAccount linkFromOAuth + reauth, refresh-skip guard, routes, frontend) ✓
- Phase 3 ↔ spec Phase 3 (G2 verify-first, adapter+capability gate, webhook alignment, tiktok-config.util) ✓
- Gates G1/G2 + Meta-coordination ↔ spec pre-flight gates ✓

**Placeholder scan:** Phases 0–1 contain complete drop-in code + exact commands. Phases 2–3 are intentionally interface-level because they depend on (a) the Meta session's in-flight merge and (b) external verification gates — re-gather + finalize at execution time, per the explicit gate notes. This is a sequencing reality, not a hand-wave.

**Type consistency:** `PublishResult`/`AccountRow` reused verbatim from the current file; new `TikTokPostOptions`/`PublishOptions` defined in Task 1.4 and consumed in 1.4/1.5; `TiktokBusinessResult`/`TiktokBusinessError`/`isTiktokBusinessAuthError` defined in 0.1 and consumed in 2.1/2.2/3.2; `ChunkPlan`/`planChunks`/`transferChunks` defined in 1.2; `TiktokCreatorInfo`/`queryCreatorInfo`/`validatePrivacyLevel` defined in 1.3 and consumed in 1.4/1.6.
