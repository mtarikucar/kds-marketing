# NetGSM Netsantral click-to-call — Phase 1 (outbound core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Originate outbound sales calls from a tenant's 0850 trunk via NetGSM Netsantral's call-origination API, multi-tenant, falling back to the existing click-to-dial when a workspace hasn't configured Netsantral.

**Architecture:** Add a workspace-scoped `TelephonyConfig` (sealed creds + trunk) and a per-rep `dahili` extension. A new `NetgsmApiAdapter` (TelephonyProvider) calls a thin `NetsantralClient.originate()`. `SalesCallService.startCall` resolves the provider per workspace: ACTIVE Netsantral config → api-dial; otherwise the existing `netgsm-lite` (tel:) provider. Self-service settings UI lets a manager enter creds and map reps → extensions.

**Tech Stack:** NestJS 11 / Prisma / Postgres backend; React + react-query + react-hook-form + zod frontend; AES-256-GCM `secret-box.helper` for sealing; Vitest (FE) / Jest (BE).

**Design:** `docs/superpowers/specs/2026-06-21-netgsm-netsantral-clicktocall-design.md`

**Flagged dependency (build-ahead, like the SMS integration):** the exact Netsantral origination endpoint URL is isolated in one constant (`NetsantralClient.ORIGINATE_URL`). Confirm it from the official docs (https://www.netgsm.com.tr/netsantraldokuman/) before the first live test. Until a workspace has an ACTIVE `TelephonyConfig`, the adapter never fires, so shipping ahead is safe.

---

## File Structure

**Backend (create):**
- `backend/src/modules/marketing/telephony/netsantral.util.ts` — pure parser `interpretNetsantralOriginate(raw)`.
- `backend/src/modules/marketing/telephony/netsantral.client.ts` — `NetsantralClient.originate()`.
- `backend/src/modules/marketing/telephony/netgsm-api.adapter.ts` — `NetgsmApiAdapter` (TelephonyProvider).
- `backend/src/modules/marketing/telephony/telephony-config.util.ts` — `assertNetsantralConfig()`.
- `backend/src/modules/marketing/telephony/telephony-config.service.ts` — CRUD/seal/mask/resolve/setDahili.
- `backend/src/modules/marketing/controllers/telephony-config.controller.ts` — authenticated CRUD.
- `backend/src/modules/marketing/dto/telephony-config.dto.ts` — DTOs.
- `+ .spec.ts` next to each non-trivial unit.

**Backend (modify):**
- `backend/prisma/schema.prisma` — add `TelephonyConfig` model + `MarketingUser.dahili`.
- `backend/src/modules/marketing/telephony/telephony-provider.interface.ts` — add resolved `config` to `PrepareCallRequest`.
- `backend/src/modules/marketing/services/sales-call.service.ts` — workspace-aware provider selection.
- `backend/src/modules/marketing/marketing.module.ts` — register new providers/service/controller.

**Frontend (create/modify):**
- `frontend/src/pages/marketing/TelephonySettingsPage.tsx` — config + rep→dahili UI (+ test).
- `frontend/src/features/marketing/components/ClickToDialButton.tsx` — handle `mode: 'api'`.
- `frontend/src/features/marketing/navigation.ts` + route registration — add settings entry.

---

## Task 1: Schema — TelephonyConfig + rep dahili

**Files:**
- Modify: `backend/prisma/schema.prisma` (MarketingUser ~line 99; add model after `Channel` ~line 1107)

- [ ] **Step 1: Add `dahili` to MarketingUser**

In `model MarketingUser`, after `phone String?` (line 106) add:

```prisma
  /// Netsantral extension this rep's outbound calls ring (e.g. "104"). Null = no api-dial; falls back to click-to-dial.
  dahili       String?
```

- [ ] **Step 2: Add the TelephonyConfig model** (after the `Channel` model)

```prisma
/// Per-workspace cloud-PBX (NetGSM Netsantral) config for api-dial. One per
/// workspace. Secrets sealed (AES-256-GCM); reads expose only which keys are set.
model TelephonyConfig {
  id           String   @id @default(uuid())
  workspaceId  String   @unique
  provider     String   @default("netgsm-netsantral")
  status       String   @default("ACTIVE") // ACTIVE | DISABLED
  /// Sealed JSON of { username, password } (the NetGSM API sub-user creds).
  configSealed String?  @db.Text
  /// Outbound trunk shown as caller id (the 0850, digits only).
  trunk        String?
  /// PBX number when the account requires it (optional).
  pbxnum       String?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  @@index([workspaceId])
}
```

- [ ] **Step 3: Create the migration**

Run: `cd backend && npx prisma migrate dev --name telephony_config_and_dahili`
Expected: migration created + applied; `npx prisma generate` runs.

- [ ] **Step 4: Commit**

```bash
git add backend/prisma/schema.prisma backend/prisma/migrations
git commit -m "feat(telephony): TelephonyConfig model + rep dahili field"
```

---

## Task 2: Netsantral origination response parser (pure)

**Files:**
- Create: `backend/src/modules/marketing/telephony/netsantral.util.ts`
- Test: `backend/src/modules/marketing/telephony/netsantral.util.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { interpretNetsantralOriginate } from './netsantral.util';

describe('interpretNetsantralOriginate', () => {
  it('parses a JSON success with unique_id', () => {
    const r = interpretNetsantralOriginate('{"status":"success","unique_id":"abc-123"}');
    expect(r).toEqual({ ok: true, callId: 'abc-123' });
  });
  it('parses a plain-text numeric error code', () => {
    const r = interpretNetsantralOriginate('30');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('30');
    expect(r.message).toMatch(/auth/i);
  });
  it('treats an unreadable body as a non-ok no-op (never throws)', () => {
    const r = interpretNetsantralOriginate('<html>nope</html>');
    expect(r.ok).toBe(false);
    expect(r.callId).toBeUndefined();
  });
  it('handles empty body', () => {
    expect(interpretNetsantralOriginate('').ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest src/modules/marketing/telephony/netsantral.util.spec.ts`
Expected: FAIL ("Cannot find module './netsantral.util'").

- [ ] **Step 3: Implement**

```typescript
/**
 * Tolerant parser for the Netsantral origination response. The exact wire shape
 * (JSON vs plain code) is an account/doc-dependent open item; we read JSON when
 * possible and fall back to a leading numeric status code, returning a structured
 * outcome. Any unreadable body → { ok:false } (a safe no-op), never a throw.
 */
export interface NetsantralOriginateOutcome {
  ok: boolean;
  callId?: string;
  code?: string;
  message?: string;
}

const ERROR_MESSAGES: Record<string, string> = {
  '20': 'Netsantral rejected the request (bad parameters, code 20).',
  '30': 'Netsantral authentication failed: verify username/password, API access, and IP allow-list (code 30).',
  '40': 'Netsantral: extension or trunk not authorised (code 40).',
  '60': 'Netsantral: account/sub-user not authorised for this operation (code 60).',
  '70': 'Netsantral: invalid or missing request parameters (code 70).',
  '80': 'Netsantral rate limit exceeded — retry shortly (code 80).',
};

export function interpretNetsantralOriginate(rawBody: string): NetsantralOriginateOutcome {
  const body = (rawBody ?? '').trim();
  if (!body) return { ok: false, message: 'Netsantral returned an empty response.' };

  // JSON shape: { status, unique_id, ... }
  if (body.startsWith('{') || body.startsWith('[')) {
    try {
      const j = JSON.parse(body);
      const obj = Array.isArray(j) ? j[0] : j;
      const id = obj?.unique_id ?? obj?.uniqueid ?? obj?.callid ?? obj?.id;
      const status = String(obj?.status ?? '').toLowerCase();
      if (id && (status === '' || status === 'success' || status === 'ok' || status === '00')) {
        return { ok: true, callId: String(id) };
      }
      const code = obj?.code != null ? String(obj.code) : undefined;
      return { ok: false, code, message: code ? ERROR_MESSAGES[code] : 'Netsantral did not return a call id.' };
    } catch {
      return { ok: false, message: 'Netsantral returned an unreadable JSON body.' };
    }
  }

  // Plain-text: a leading status code (00/01/02 = accepted, else error).
  const code = body.split(/\s+/)[0];
  if (/^0[0-2]$/.test(code)) {
    const rest = body.slice(code.length).trim();
    return rest ? { ok: true, callId: rest } : { ok: true };
  }
  if (/^\d{2}$/.test(code)) {
    return { ok: false, code, message: ERROR_MESSAGES[code] ?? `Netsantral rejected the call (code ${code}).` };
  }
  return { ok: false, message: 'Netsantral returned an unrecognised response.' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest src/modules/marketing/telephony/netsantral.util.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/marketing/telephony/netsantral.util.ts backend/src/modules/marketing/telephony/netsantral.util.spec.ts
git commit -m "feat(telephony): tolerant Netsantral origination response parser"
```

---

## Task 3: NetsantralClient.originate

**Files:**
- Create: `backend/src/modules/marketing/telephony/netsantral.client.ts`
- Test: `backend/src/modules/marketing/telephony/netsantral.client.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { NetsantralClient } from './netsantral.client';

describe('NetsantralClient', () => {
  const creds = { username: '8508407303', password: 'pw' };
  let fetchMock: jest.SpyInstance;
  afterEach(() => fetchMock?.mockRestore());

  it('posts form-encoded params and returns the call id on success', async () => {
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      status: 200, text: async () => '{"status":"success","unique_id":"u-1"}',
    } as any);
    const client = new NetsantralClient();
    const out = await client.originate({ ...creds, customer_num: '5551112233', internal_num: '104', trunk: '8508407303' });
    expect(out).toEqual({ ok: true, callId: 'u-1' });
    const body = (fetchMock.mock.calls[0][1] as any).body as string;
    expect(body).toContain('customer_num=5551112233');
    expect(body).toContain('internal_num=104');
    expect(body).not.toMatch(/\bpassword=pw\b.*\?/); // creds in body, not query
    expect((fetchMock.mock.calls[0][0] as string)).not.toContain('password');
  });

  it('returns ok:false on a provider error code', async () => {
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ status: 200, text: async () => '30' } as any);
    const out = await new NetsantralClient().originate({ ...creds, customer_num: '5551112233', internal_num: '104', trunk: '8508407303' });
    expect(out.ok).toBe(false);
    expect(out.code).toBe('30');
  });

  it('scrubs the password from a thrown error', async () => {
    fetchMock = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('boom password=pw leaked'));
    const out = await new NetsantralClient().originate({ ...creds, customer_num: '5', internal_num: '104', trunk: '850' });
    expect(out.ok).toBe(false);
    expect(out.message).not.toContain('pw');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest src/modules/marketing/telephony/netsantral.client.spec.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { interpretNetsantralOriginate, NetsantralOriginateOutcome } from './netsantral.util';

export interface OriginateParams {
  username: string;
  password: string;
  customer_num: string;
  internal_num: string;
  trunk: string;
  pbxnum?: string;
}

/**
 * Thin client for NetGSM Netsantral call origination ("dış arama" / tıkla-ara).
 * NetGSM rings `internal_num` (the rep's extension), then dials `customer_num`,
 * bridging over `trunk` (the 0850) so the customer sees the business number.
 *
 * ORIGINATE_URL is the one account/doc-dependent open item — confirm the exact
 * path from the official Netsantral docs before the first live test. Inert until
 * a workspace has an ACTIVE TelephonyConfig, so a wrong URL cannot fire in prod.
 * Credentials go in the POST body (never the query string) like the SMS path.
 */
@Injectable()
export class NetsantralClient {
  private readonly logger = new Logger(NetsantralClient.name);
  static readonly ORIGINATE_URL = 'https://api.netgsm.com.tr/netsantral/originate';
  private static readonly TIMEOUT_MS = 15_000;

  async originate(p: OriginateParams): Promise<NetsantralOriginateOutcome> {
    if (!p?.username || !p?.password || !p?.customer_num || !p?.internal_num || !p?.trunk) {
      return { ok: false, message: 'Netsantral originate called with missing parameters.' };
    }
    try {
      const form = new URLSearchParams({
        username: p.username,
        password: p.password,
        customer_num: p.customer_num.replace(/[^\d]/g, ''),
        internal_num: p.internal_num,
        trunk: p.trunk.replace(/[^\d]/g, ''),
      });
      if (p.pbxnum) form.set('pbxnum', p.pbxnum);
      const res = await fetch(NetsantralClient.ORIGINATE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: AbortSignal.timeout(NetsantralClient.TIMEOUT_MS),
      });
      if (typeof res.status === 'number' && res.status >= 400) {
        this.logger.warn(`netsantral originate HTTP ${res.status}`);
        return { ok: false, message: `Netsantral HTTP ${res.status}` };
      }
      return interpretNetsantralOriginate((await res.text()) ?? '');
    } catch (e: any) {
      const timedOut = e?.name === 'AbortError' || e?.name === 'TimeoutError';
      const raw = timedOut ? 'Netsantral request timed out' : (e?.message ?? String(e));
      const scrubbed = raw.replace(/password=[^&\s]+/gi, 'password=***').replace(p.password, '***');
      return { ok: false, message: scrubbed };
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest src/modules/marketing/telephony/netsantral.client.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/marketing/telephony/netsantral.client.ts backend/src/modules/marketing/telephony/netsantral.client.spec.ts
git commit -m "feat(telephony): NetsantralClient.originate (creds-in-body, timeout, scrub)"
```

---

## Task 4: Config validation util

**Files:**
- Create: `backend/src/modules/marketing/telephony/telephony-config.util.ts`
- Test: `backend/src/modules/marketing/telephony/telephony-config.util.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { assertNetsantralConfig } from './telephony-config.util';

describe('assertNetsantralConfig', () => {
  it('passes with username, password, trunk', () => {
    expect(() => assertNetsantralConfig({ username: '8508407303', password: 'pw' }, { trunk: '8508407303' })).not.toThrow();
  });
  it('throws without username', () => {
    expect(() => assertNetsantralConfig({ password: 'pw' }, { trunk: '850' })).toThrow(/username/i);
  });
  it('throws without password', () => {
    expect(() => assertNetsantralConfig({ username: '850' }, { trunk: '850' })).toThrow(/password/i);
  });
  it('throws without a numeric trunk', () => {
    expect(() => assertNetsantralConfig({ username: '850', password: 'pw' }, { trunk: '' })).toThrow(/trunk/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest src/modules/marketing/telephony/telephony-config.util.spec.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```typescript
import { BadRequestException } from '@nestjs/common';

/** Validate Netsantral config at save-time with actionable messages. */
export function assertNetsantralConfig(
  secrets: Record<string, string> | undefined,
  publicCfg: { trunk?: string } | undefined,
): void {
  const s = secrets ?? {};
  const present = (k: string) => typeof s[k] === 'string' && s[k].trim() !== '';
  if (!present('username')) {
    throw new BadRequestException('Netsantral requires a "username" (NetGSM abone no, e.g. 8508407303).');
  }
  if (!present('password')) {
    throw new BadRequestException('Netsantral requires a "password" (the API sub-user password).');
  }
  const trunk = (publicCfg?.trunk ?? '').replace(/[^\d]/g, '');
  if (trunk.length < 7) {
    throw new BadRequestException('Netsantral requires a numeric "trunk" (the 0850 outbound number).');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest src/modules/marketing/telephony/telephony-config.util.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/marketing/telephony/telephony-config.util.ts backend/src/modules/marketing/telephony/telephony-config.util.spec.ts
git commit -m "feat(telephony): Netsantral config validation"
```

---

## Task 5: TelephonyConfigService

**Files:**
- Create: `backend/src/modules/marketing/telephony/telephony-config.service.ts`
- Test: `backend/src/modules/marketing/telephony/telephony-config.service.spec.ts`

- [ ] **Step 1: Write the failing test** (mock prisma + secret-box)

```typescript
import { TelephonyConfigService } from './telephony-config.service';

jest.mock('../../../common/crypto/secret-box.helper', () => ({
  isSecretBoxConfigured: () => true,
  sealSecret: (s: string) => `sealed:${s}`,
  openSecret: (s: string) => s.replace(/^sealed:/, ''),
}));

function prismaMock() {
  return {
    telephonyConfig: { findUnique: jest.fn(), upsert: jest.fn(), update: jest.fn() },
    marketingUser: { update: jest.fn(), findMany: jest.fn() },
  } as any;
}

describe('TelephonyConfigService', () => {
  it('seals secrets on upsert and masks them on read', async () => {
    const prisma = prismaMock();
    prisma.telephonyConfig.upsert.mockResolvedValue({
      id: 'c1', workspaceId: 'ws', provider: 'netgsm-netsantral', status: 'ACTIVE',
      configSealed: 'sealed:{"username":"850","password":"pw"}', trunk: '850', pbxnum: null,
    });
    const svc = new TelephonyConfigService(prisma);
    const out = await svc.upsert('ws', { secrets: { username: '850', password: 'pw' }, trunk: '850' });
    expect(prisma.telephonyConfig.upsert).toHaveBeenCalled();
    expect(out.configuredSecrets.sort()).toEqual(['password', 'username']);
    expect((out as any).configSealed).toBeUndefined();
  });

  it('resolveForWorkspace returns decrypted creds for an ACTIVE config', async () => {
    const prisma = prismaMock();
    prisma.telephonyConfig.findUnique.mockResolvedValue({
      workspaceId: 'ws', status: 'ACTIVE', trunk: '850', pbxnum: null,
      configSealed: 'sealed:{"username":"850","password":"pw"}',
    });
    const svc = new TelephonyConfigService(prisma);
    const r = await svc.resolveForWorkspace('ws');
    expect(r).toEqual({ username: '850', password: 'pw', trunk: '850', pbxnum: undefined });
  });

  it('resolveForWorkspace returns null when no config or DISABLED', async () => {
    const prisma = prismaMock();
    prisma.telephonyConfig.findUnique.mockResolvedValue(null);
    expect(await new TelephonyConfigService(prisma).resolveForWorkspace('ws')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest src/modules/marketing/telephony/telephony-config.service.spec.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```typescript
import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { sealSecret, openSecret, isSecretBoxConfigured } from '../../../common/crypto/secret-box.helper';
import { assertNetsantralConfig } from './telephony-config.util';

export interface UpsertTelephonyInput {
  secrets?: Record<string, string>;
  trunk?: string;
  pbxnum?: string;
  status?: string;
}
export interface ResolvedNetsantral {
  username: string;
  password: string;
  trunk: string;
  pbxnum?: string;
}

@Injectable()
export class TelephonyConfigService {
  constructor(private readonly prisma: PrismaService) {}

  async get(workspaceId: string) {
    const c = await this.prisma.telephonyConfig.findUnique({ where: { workspaceId } });
    return c ? this.mask(c) : null;
  }

  async upsert(workspaceId: string, dto: UpsertTelephonyInput) {
    const existing = await this.prisma.telephonyConfig.findUnique({ where: { workspaceId } });
    let merged: Record<string, string> = {};
    if (existing?.configSealed && isSecretBoxConfigured()) {
      try { merged = JSON.parse(openSecret(existing.configSealed)); } catch { /* replace */ }
    }
    if (dto.secrets && Object.keys(dto.secrets).length) merged = { ...merged, ...dto.secrets };
    const trunk = dto.trunk ?? existing?.trunk ?? undefined;
    assertNetsantralConfig(merged, { trunk });
    if (!isSecretBoxConfigured()) {
      throw new ServiceUnavailableException('MARKETING_SECRET_KEY is not configured — cannot store telephony credentials');
    }
    const data = {
      provider: 'netgsm-netsantral',
      status: dto.status ?? existing?.status ?? 'ACTIVE',
      configSealed: sealSecret(JSON.stringify(merged)),
      trunk: trunk ?? null,
      pbxnum: dto.pbxnum ?? existing?.pbxnum ?? null,
    };
    const c = await this.prisma.telephonyConfig.upsert({
      where: { workspaceId },
      create: { workspaceId, ...data },
      update: data,
    });
    return this.mask(c);
  }

  /** Decrypted creds for an ACTIVE config, or null. Used by SalesCallService. */
  async resolveForWorkspace(workspaceId: string): Promise<ResolvedNetsantral | null> {
    const c = await this.prisma.telephonyConfig.findUnique({ where: { workspaceId } });
    if (!c || c.status !== 'ACTIVE' || !c.configSealed || !c.trunk || !isSecretBoxConfigured()) return null;
    let creds: Record<string, string>;
    try { creds = JSON.parse(openSecret(c.configSealed)); } catch { return null; }
    if (!creds.username || !creds.password) return null;
    return { username: creds.username, password: creds.password, trunk: c.trunk, pbxnum: c.pbxnum ?? undefined };
  }

  /** Set a rep's Netsantral extension (workspace-scoped). */
  async setDahili(workspaceId: string, marketingUserId: string, dahili: string | null) {
    const res = await this.prisma.marketingUser.updateMany({
      where: { id: marketingUserId, workspaceId },
      data: { dahili: dahili?.trim() || null },
    });
    if (res.count === 0) throw new NotFoundException('User not found');
    return { ok: true };
  }

  private mask(c: any) {
    let configuredSecrets: string[] = [];
    if (c.configSealed && isSecretBoxConfigured()) {
      try { configuredSecrets = Object.keys(JSON.parse(openSecret(c.configSealed))); } catch { configuredSecrets = ['(unreadable)']; }
    }
    return {
      id: c.id, workspaceId: c.workspaceId, provider: c.provider, status: c.status,
      trunk: c.trunk, pbxnum: c.pbxnum, configuredSecrets,
      createdAt: c.createdAt, updatedAt: c.updatedAt,
    };
  }
}
```

> Note: `prisma.telephonyConfig.upsert` in the test is asserted but the impl calls `findUnique` first (returns the mock's default `undefined`), then `upsert` — adjust the test's `findUnique` default to `undefined` (already the case). `setDahili` uses `updateMany` for workspace scoping; the test for it is added in Task 9 alongside the controller.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest src/modules/marketing/telephony/telephony-config.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/marketing/telephony/telephony-config.service.ts backend/src/modules/marketing/telephony/telephony-config.service.spec.ts
git commit -m "feat(telephony): TelephonyConfigService (seal/mask/resolve/setDahili)"
```

---

## Task 6: Extend the TelephonyProvider interface

**Files:**
- Modify: `backend/src/modules/marketing/telephony/telephony-provider.interface.ts`

- [ ] **Step 1: Add the resolved config to PrepareCallRequest**

Replace the `PrepareCallRequest` interface with:

```typescript
export interface PrepareCallRequest {
  /** The number being called (customer/lead). */
  toPhone: string;
  /** The rep initiating the call. */
  marketingUserId: string;
  /**
   * Resolved provider config for api-dial providers (Netsantral). The Lite
   * (click-to-dial) provider ignores it. Supplied by SalesCallService after a
   * per-workspace lookup so adapters stay stateless/multi-tenant.
   */
  config?: {
    username: string;
    password: string;
    trunk: string;
    pbxnum?: string;
    /** The rep's extension; api-dial requires it. */
    internalNum: string;
  };
}
```

- [ ] **Step 2: Verify the project still type-checks**

Run: `cd backend && npx tsc --noEmit`
Expected: PASS (the field is optional; existing `NetgsmLiteAdapter` unaffected).

- [ ] **Step 3: Commit**

```bash
git add backend/src/modules/marketing/telephony/telephony-provider.interface.ts
git commit -m "feat(telephony): carry resolved per-workspace config into prepareOutboundCall"
```

---

## Task 7: NetgsmApiAdapter

**Files:**
- Create: `backend/src/modules/marketing/telephony/netgsm-api.adapter.ts`
- Test: `backend/src/modules/marketing/telephony/netgsm-api.adapter.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { NetgsmApiAdapter } from './netgsm-api.adapter';

describe('NetgsmApiAdapter', () => {
  const registry = { register: jest.fn() } as any;

  it('originates via the client and returns mode "api" with the call id', async () => {
    const client = { originate: jest.fn().mockResolvedValue({ ok: true, callId: 'u-9' }) } as any;
    const a = new NetgsmApiAdapter(registry, client);
    const out = await a.prepareOutboundCall({
      toPhone: '+90 555 111 22 33', marketingUserId: 'u',
      config: { username: '850', password: 'pw', trunk: '8508407303', internalNum: '104' },
    });
    expect(client.originate).toHaveBeenCalledWith(expect.objectContaining({
      customer_num: '+90 555 111 22 33', internal_num: '104', trunk: '8508407303', username: '850', password: 'pw',
    }));
    expect(out).toMatchObject({ providerId: 'netgsm-netsantral', mode: 'api', externalCallId: 'u-9' });
  });

  it('throws a BadRequest when config is missing (no api-dial possible)', async () => {
    const a = new NetgsmApiAdapter(registry, { originate: jest.fn() } as any);
    await expect(a.prepareOutboundCall({ toPhone: '5', marketingUserId: 'u' })).rejects.toThrow();
  });

  it('throws when the provider rejects the origination', async () => {
    const client = { originate: jest.fn().mockResolvedValue({ ok: false, code: '30', message: 'auth' }) } as any;
    const a = new NetgsmApiAdapter(registry, client);
    await expect(a.prepareOutboundCall({
      toPhone: '5', marketingUserId: 'u',
      config: { username: '850', password: 'pw', trunk: '850', internalNum: '104' },
    })).rejects.toThrow(/auth|30/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest src/modules/marketing/telephony/netgsm-api.adapter.spec.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```typescript
import { Injectable, Logger, OnModuleInit, BadRequestException } from '@nestjs/common';
import {
  TelephonyProvider, TelephonyCapability, PrepareCallRequest, PreparedCall,
} from './telephony-provider.interface';
import { TelephonyProviderRegistry } from './telephony-provider.registry';
import { NetsantralClient } from './netsantral.client';

/**
 * NetGSM Netsantral (cloud PBX) provider: places the call server-side so it
 * originates from the tenant's 0850 trunk (api-dial), unlike the Lite provider's
 * click-to-dial tel: link. Stateless — SalesCallService passes the resolved
 * per-workspace config (creds + trunk + the rep's extension).
 */
@Injectable()
export class NetgsmApiAdapter implements TelephonyProvider, OnModuleInit {
  readonly id = 'netgsm-netsantral';
  readonly capabilities: readonly TelephonyCapability[] = ['api-dial', 'manual-log'];
  /** Per-rep extensions dial independently — not a single shared line. */
  readonly maxConcurrentCalls = 50;
  private readonly logger = new Logger(NetgsmApiAdapter.name);

  constructor(
    private readonly registry: TelephonyProviderRegistry,
    private readonly client: NetsantralClient,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async prepareOutboundCall(req: PrepareCallRequest): Promise<PreparedCall> {
    const c = req.config;
    if (!c?.username || !c?.password || !c?.trunk || !c?.internalNum) {
      throw new BadRequestException('Netsantral not configured (missing credentials, trunk, or rep extension).');
    }
    const outcome = await this.client.originate({
      username: c.username, password: c.password,
      customer_num: req.toPhone, internal_num: c.internalNum, trunk: c.trunk, pbxnum: c.pbxnum,
    });
    if (!outcome.ok) {
      throw new BadRequestException(outcome.message ?? `Netsantral rejected the call (code ${outcome.code ?? '?'}).`);
    }
    return { providerId: this.id, dialUri: '', mode: 'api', externalCallId: outcome.callId ?? null };
  }

  async healthCheck(): Promise<{ ok: boolean; details?: Record<string, unknown> }> {
    return { ok: true, details: { mode: 'api-dial', provider: this.id } };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest src/modules/marketing/telephony/netgsm-api.adapter.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/marketing/telephony/netgsm-api.adapter.ts backend/src/modules/marketing/telephony/netgsm-api.adapter.spec.ts
git commit -m "feat(telephony): NetgsmApiAdapter (api-dial via Netsantral)"
```

---

## Task 8: Workspace-aware provider selection in SalesCallService

**Files:**
- Modify: `backend/src/modules/marketing/services/sales-call.service.ts`
- Test: `backend/src/modules/marketing/services/sales-call.service.spec.ts` (add cases)

- [ ] **Step 1: Add a failing test** (provider selection)

Add to the existing spec (mirror its existing harness for prisma/registry/outbox/config):

```typescript
it('uses netgsm-netsantral with resolved config when the workspace has an ACTIVE config', async () => {
  const apiProvider = { id: 'netgsm-netsantral', maxConcurrentCalls: 50, prepareOutboundCall: jest.fn().mockResolvedValue({ providerId: 'netgsm-netsantral', dialUri: '', mode: 'api', externalCallId: 'u-1' }) };
  registry.get.mockImplementation((id: string) => (id === 'netgsm-netsantral' ? apiProvider : liteProvider));
  telephonyConfig.resolveForWorkspace.mockResolvedValue({ username: '850', password: 'pw', trunk: '8508407303' });
  prisma.marketingUser.findFirst.mockResolvedValue({ id: 'rep-1', dahili: '104' });
  prisma.salesCall.findMany.mockResolvedValue([]);
  prisma.salesCall.create.mockResolvedValue({ id: 'call-1' });

  await service.startCall('ws', 'rep-1', { toPhone: '5551112233' });

  expect(apiProvider.prepareOutboundCall).toHaveBeenCalledWith(expect.objectContaining({
    config: expect.objectContaining({ internalNum: '104', trunk: '8508407303' }),
  }));
});

it('falls back to netgsm-lite click-to-dial when no telephony config', async () => {
  registry.get.mockReturnValue(liteProvider);
  telephonyConfig.resolveForWorkspace.mockResolvedValue(null);
  prisma.salesCall.findMany.mockResolvedValue([]);
  prisma.salesCall.create.mockResolvedValue({ id: 'call-2' });
  await service.startCall('ws', 'rep-1', { toPhone: '5551112233' });
  expect(liteProvider.prepareOutboundCall).toHaveBeenCalled();
});
```

Add `TelephonyConfigService` (mocked: `{ resolveForWorkspace: jest.fn() }`) to the service's constructor in the test setup, and a `liteProvider` stub.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest src/modules/marketing/services/sales-call.service.spec.ts`
Expected: FAIL (constructor arity / selection not implemented).

- [ ] **Step 3: Implement the selection**

Inject the config service — add to the constructor:

```typescript
    private readonly telephonyConfig: TelephonyConfigService,
```
(import `TelephonyConfigService` from `../telephony/telephony-config.service`.)

Replace the top of `startCall` (the `const provider = this.registry.get(this.providerId());` line) with:

```typescript
    // Per-workspace provider selection: an ACTIVE Netsantral config → api-dial
    // (call originates from the 0850 trunk); otherwise the click-to-dial fallback.
    const netsantral = await this.telephonyConfig.resolveForWorkspace(workspaceId);
    let providerId = 'netgsm-lite';
    let resolvedConfig: PrepareCallRequest['config'] | undefined;
    if (netsantral) {
      const rep = await this.prisma.marketingUser.findFirst({
        where: { id: marketingUserId, workspaceId },
        select: { dahili: true },
      });
      if (rep?.dahili) {
        providerId = 'netgsm-netsantral';
        resolvedConfig = {
          username: netsantral.username, password: netsantral.password,
          trunk: netsantral.trunk, pbxnum: netsantral.pbxnum, internalNum: rep.dahili,
        };
      }
    }
    const provider = this.registry.get(providerId);
```

Then update the `prepareOutboundCall` call (around line 89) to pass the config:

```typescript
    const prepared = await provider.prepareOutboundCall({
      toPhone: dto.toPhone,
      marketingUserId,
      config: resolvedConfig,
    });
```

Import `PrepareCallRequest` from `../telephony/telephony-provider.interface`. The existing SalesCall row creation already stores `provider.id`/`prepared.externalCallId` — leave it.

> Note: a rep with no `dahili` falls back to click-to-dial even when the workspace has Netsantral — so the line never breaks for an unmapped rep.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx jest src/modules/marketing/services/sales-call.service.spec.ts`
Expected: PASS (existing + new cases).

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/marketing/services/sales-call.service.ts backend/src/modules/marketing/services/sales-call.service.spec.ts
git commit -m "feat(telephony): per-workspace provider selection (Netsantral api-dial / Lite fallback)"
```

---

## Task 9: DTOs + controller

**Files:**
- Create: `backend/src/modules/marketing/dto/telephony-config.dto.ts`
- Create: `backend/src/modules/marketing/controllers/telephony-config.controller.ts`

- [ ] **Step 1: DTOs**

```typescript
import { IsOptional, IsString, IsObject, IsIn, MaxLength } from 'class-validator';

export class UpsertTelephonyConfigDto {
  @IsOptional() @IsObject() secrets?: Record<string, string>;
  @IsOptional() @IsString() @MaxLength(20) trunk?: string;
  @IsOptional() @IsString() @MaxLength(20) pbxnum?: string;
  @IsOptional() @IsIn(['ACTIVE', 'DISABLED']) status?: string;
}

export class SetDahiliDto {
  @IsOptional() @IsString() @MaxLength(10) dahili?: string;
}
```

- [ ] **Step 2: Controller** (mirror `MarketingChannelsController` guards)

```typescript
import { Controller, Get, Put, Patch, Body, Param, UseGuards } from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { FeatureGuard, RequiresFeature } from '../guards/feature.guard';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { TelephonyConfigService } from '../telephony/telephony-config.service';
import { UpsertTelephonyConfigDto, SetDahiliDto } from '../dto/telephony-config.dto';

@MarketingRoute()
@Controller('marketing/telephony')
@UseGuards(MarketingGuard, MarketingRolesGuard, FeatureGuard, PermissionsGuard)
@MarketingRoles('MANAGER')
@RequiresFeature('telephony')
export class TelephonyConfigController {
  constructor(private readonly telephony: TelephonyConfigService) {}

  @Get('config')
  get(@CurrentMarketingUser() a: MarketingUserPayload) {
    return this.telephony.get(a.workspaceId);
  }

  @Put('config')
  @RequirePermission('settings.manage')
  upsert(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: UpsertTelephonyConfigDto) {
    return this.telephony.upsert(a.workspaceId, dto);
  }

  @Patch('users/:id/dahili')
  @RequirePermission('settings.manage')
  setDahili(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string, @Body() dto: SetDahiliDto) {
    return this.telephony.setDahili(a.workspaceId, id, dto.dahili ?? null);
  }
}
```

- [ ] **Step 3: Type-check**

Run: `cd backend && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/src/modules/marketing/dto/telephony-config.dto.ts backend/src/modules/marketing/controllers/telephony-config.controller.ts
git commit -m "feat(telephony): telephony config + rep-dahili API"
```

---

## Task 10: Module registration

**Files:**
- Modify: `backend/src/modules/marketing/marketing.module.ts`

- [ ] **Step 1: Register** — add imports + entries

Add imports near the other telephony imports:

```typescript
import { NetgsmApiAdapter } from './telephony/netgsm-api.adapter';
import { NetsantralClient } from './telephony/netsantral.client';
import { TelephonyConfigService } from './telephony/telephony-config.service';
import { TelephonyConfigController } from './controllers/telephony-config.controller';
```

Add `TelephonyConfigController` to the module `controllers: [...]` array (next to `SalesCallController`), and add `NetgsmApiAdapter`, `NetsantralClient`, `TelephonyConfigService` to `providers: [...]` (next to `NetgsmLiteAdapter`).

- [ ] **Step 2: Build + boot check**

Run: `cd backend && npx tsc --noEmit && npx jest src/modules/marketing/telephony`
Expected: PASS; Nest DI resolves (NetgsmApiAdapter registers at init).

- [ ] **Step 3: Commit**

```bash
git add backend/src/modules/marketing/marketing.module.ts
git commit -m "feat(telephony): wire NetgsmApiAdapter + TelephonyConfig into the module"
```

---

## Task 11: Frontend — ClickToDialButton handles api-dial

**Files:**
- Modify: `frontend/src/features/marketing/components/ClickToDialButton.tsx`
- Modify: `frontend/src/features/marketing/types.ts` (StartCallResult.mode)

- [ ] **Step 1: Add `mode` to the result type**

In `types.ts`, ensure `StartCallResult` is:

```typescript
export interface StartCallResult {
  call: SalesCall;
  dialUri: string;
  mode?: 'click-to-dial' | 'api';
}
```

- [ ] **Step 2: Branch on mode in the mutation `onSuccess`**

Replace the `onSuccess` of the `start` mutation with:

```typescript
    onSuccess: (data) => {
      setActiveCall(data.call);
      setLogForm({ status: 'CONNECTED', durationSec: '', notes: '' });
      if (data.mode === 'api') {
        // api-dial: NetGSM rings the rep's extension then the customer — no tel:.
        toast.success('Calling… your extension is ringing');
      } else if (data.dialUri) {
        window.location.href = data.dialUri; // click-to-dial hands off to the device
      }
      queryClient.invalidateQueries({ queryKey: ['marketing', 'calls'] });
    },
```

- [ ] **Step 3: Type-check + lint**

Run: `cd frontend && npx tsc --noEmit && npx eslint src/features/marketing/components/ClickToDialButton.tsx`
Expected: PASS (ignore the pre-existing `a11y.axe.test` tsc error).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/features/marketing/components/ClickToDialButton.tsx frontend/src/features/marketing/types.ts
git commit -m "feat(telephony): ClickToDialButton handles api-dial mode (no tel: redirect)"
```

---

## Task 12: Frontend — TelephonySettingsPage + nav/route

**Files:**
- Create: `frontend/src/pages/marketing/TelephonySettingsPage.tsx`
- Create: `frontend/src/pages/marketing/TelephonySettingsPage.test.tsx`
- Modify: `frontend/src/features/marketing/navigation.ts` (settings area) + the route registry the app uses for `/settings/*`

- [ ] **Step 1: Write the failing test** (mounts + saves)

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import TelephonySettingsPage from './TelephonySettingsPage';

const api = { get: vi.fn(), put: vi.fn(), patch: vi.fn() };
vi.mock('../../features/marketing/api/marketingApi', () => ({ default: { get: (...a:any)=>api.get(...a), put:(...a:any)=>api.put(...a), patch:(...a:any)=>api.patch(...a) } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k:string,d?:any)=> (typeof d==='string'?d:d?.defaultValue)??k, i18n:{language:'en'} }) }));

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>;
}

describe('TelephonySettingsPage', () => {
  beforeEach(() => { vi.clearAllMocks(); api.get.mockResolvedValue({ data: null }); api.put.mockResolvedValue({ data: { configuredSecrets: [] } }); });
  it('mounts and renders the heading', () => {
    render(<TelephonySettingsPage />, { wrapper });
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/pages/marketing/TelephonySettingsPage.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the page** (mirror `ChannelsSettingsPage` structure: react-hook-form + zod + react-query). Minimal version:

```tsx
import { useForm } from 'react-hook-form';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import marketingApi from '../../features/marketing/api/marketingApi';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';

interface TelephonyConfigView { status: string; trunk?: string | null; pbxnum?: string | null; configuredSecrets: string[]; }

export default function TelephonySettingsPage() {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();
  const { data: cfg } = useQuery<TelephonyConfigView | null>({
    queryKey: ['marketing', 'telephony', 'config'],
    queryFn: () => marketingApi.get('/telephony/config').then((r) => r.data),
  });
  const form = useForm<{ username: string; password: string; trunk: string; pbxnum: string }>({
    defaultValues: { username: '', password: '', trunk: cfg?.trunk ?? '', pbxnum: cfg?.pbxnum ?? '' },
  });
  const save = useMutation({
    mutationFn: (v: { username: string; password: string; trunk: string; pbxnum: string }) =>
      marketingApi.put('/telephony/config', {
        secrets: { ...(v.username ? { username: v.username } : {}), ...(v.password ? { password: v.password } : {}) },
        trunk: v.trunk || undefined, pbxnum: v.pbxnum || undefined,
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['marketing', 'telephony', 'config'] }); toast.success(t('telephony.saved', 'Saved')); },
    onError: (e: any) => toast.error(e.response?.data?.message ?? t('telephony.saveFailed', 'Save failed')),
  });

  return (
    <div className="space-y-6">
      <PageHeader title={t('telephony.title', 'Phone (Netsantral)')} description={t('telephony.subtitle', 'Place sales calls from your 0850 line via NetGSM Netsantral.')} />
      <Card><CardContent className="p-5 space-y-4">
        <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="username (abone no)">{({ id }) => <Input id={id} placeholder="8508407303" {...form.register('username')} />}</Field>
            <Field label="password (API sub-user)">{({ id }) => <Input id={id} type="password" placeholder="••••••••" autoComplete="off" {...form.register('password')} />}</Field>
            <Field label="trunk (0850)">{({ id }) => <Input id={id} placeholder="8508407303" {...form.register('trunk')} />}</Field>
            <Field label="pbxnum (optional)">{({ id }) => <Input id={id} {...form.register('pbxnum')} />}</Field>
          </div>
          <p className="text-caption text-muted-foreground">{cfg?.configuredSecrets?.length ? `${t('telephony.credsSet', 'credentials set')}: ${cfg.configuredSecrets.join(', ')}` : t('telephony.noCreds', 'no credentials yet')}</p>
          <Button type="submit" loading={save.isPending}>{t('common.save', 'Save')}</Button>
        </form>
      </CardContent></Card>
    </div>
  );
}
```

> Note: rep→dahili management (a list of users with a dahili input calling `PATCH /telephony/users/:id/dahili`) is added as a second Card mirroring this form once the basic config saves; keep it in this task if time allows, else a follow-up task.

- [ ] **Step 4: Register the route + nav entry**

Add a lazy route for `/settings/telephony` in the app's marketing route registry (same place other `/settings/*` pages are registered), and a nav entry under the Settings area gated by `feature: 'telephony'`. Follow the existing `/settings/*` registration pattern.

- [ ] **Step 5: Run test + lint**

Run: `cd frontend && npx vitest run src/pages/marketing/TelephonySettingsPage.test.tsx && npx eslint src/pages/marketing/TelephonySettingsPage.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/marketing/TelephonySettingsPage.tsx frontend/src/pages/marketing/TelephonySettingsPage.test.tsx frontend/src/features/marketing/navigation.ts
git commit -m "feat(telephony): Netsantral settings page + route/nav"
```

---

## Done criteria (Phase 1)

- A manager can save Netsantral creds + trunk and set a rep's `dahili` via the settings UI.
- Clicking **Call** for a rep with a `dahili` in a workspace with ACTIVE config → `SalesCallService` originates via Netsantral (call rings the rep's extension, then the customer, caller id = 0850); the SalesCall row stores `providerId='netgsm-netsantral'` + `externalCallId`.
- A rep without a `dahili`, or a workspace without config, → existing click-to-dial (`tel:`) — unchanged.
- All new units have passing unit tests; `tsc` + `eslint` clean.
- Inert until a workspace configures Netsantral → safe to ship; outcome via the existing manual log (Phase 2 adds webhook auto-status + recording).

## Before first live test (operator)
1. Confirm `NetsantralClient.ORIGINATE_URL` against the official Netsantral docs.
2. Tenant provisions Netsantral (0850 as trunk + extensions) and enters creds + trunk + each rep's `dahili`.
