# NetGSM Phase 0 — Hub Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the `netgsm` hub module, strangler-move the existing Netsantral/CDR clients into it, add core primitives (REST client, error map, rate budgeter, balance client), a real credential "Verify", the webhook-event table + receiver skeleton, and fold in the Phase-0 quality fixes — all with zero user-visible behavior change except the improved Verify and the new onboarding checklist card.

**Architecture:** New NestJS module `backend/src/modules/netgsm/` provides + exports all NetGSM transport clients; `MarketingModule` imports it and drops those providers from its own array. Clients stay stateless (creds passed per call — the hub-side credentials resolver is deferred to Phase 3 when webhook consumers need it). Spec: `docs/superpowers/specs/2026-07-08-netgsm-full-integration-design.md`.

**Tech Stack:** NestJS 11 / Express 5, Prisma (raw SQL migrations with `migration.sql` + `down.sql`), Jest (backend `npm test`), React + vitest (frontend), i18next TR/EN.

## Global Constraints

- Commits: plain conventional messages. NEVER add Co-Authored-By/Claude/AI markers (hard rule).
- Every migration ships `migration.sql` + `down.sql`, both idempotent (`IF NOT EXISTS` / `IF EXISTS`), down removes exactly what up added.
- Every controller carrying `@RequiresFeature` MUST include `FeatureGuard` in its `@UseGuards(...)` chain.
- Never log URLs containing NetGSM credentials (they ride in query strings on the santral host); scrub `username=`/`password=` from errors (see `netsantral.client.ts` `call()` for the pattern).
- Backend tests: `cd backend && npm test -- --testPathPatterns=<pattern>`. Build: `npm run build`.
- Working branch: `feat/netgsm-hub-phase0` off `main`.

---

### Task 0: Branch

- [ ] **Step 1: Create branch**

```bash
cd /home/tarik/Projects/kds-marketing && git checkout -b feat/netgsm-hub-phase0
```

---

### Task 1: NetgsmModule skeleton

**Files:**
- Create: `backend/src/modules/netgsm/netgsm.module.ts`
- Modify: `backend/src/modules/marketing/marketing.module.ts` (add `NetgsmModule` to `imports`)

**Interfaces:**
- Produces: `NetgsmModule` (empty providers for now; Tasks 2–8 fill it).

- [ ] **Step 1: Create the module**

```typescript
// backend/src/modules/netgsm/netgsm.module.ts
import { Module } from '@nestjs/common';

/**
 * NetGSM hub — owns ALL communication with NetGSM (SMS REST v2, İYS,
 * Netsantral PBX, voice, fax, balance, webhook receivers). Domain modules
 * (marketing channels/campaigns/telephony/compliance) keep the business
 * logic and consume these stateless clients via DI; per-workspace credential
 * resolution stays with the domain services that own the sealed stores.
 * Spec: docs/superpowers/specs/2026-07-08-netgsm-full-integration-design.md
 */
@Module({
  providers: [],
  exports: [],
})
export class NetgsmModule {}
```

- [ ] **Step 2: Import it from MarketingModule**

In `backend/src/modules/marketing/marketing.module.ts`, add to the module's `imports` array (find the `@Module({ imports: [...]` block) and the import statement near the other module imports:

```typescript
import { NetgsmModule } from '../netgsm/netgsm.module';
```
```typescript
  imports: [
    // ...existing entries...
    NetgsmModule,
  ],
```

- [ ] **Step 3: Build to verify wiring**

Run: `cd backend && npm run build`
Expected: compiles clean.

- [ ] **Step 4: Commit**

```bash
git add backend/src/modules/netgsm/netgsm.module.ts backend/src/modules/marketing/marketing.module.ts
git commit -m "feat(netgsm): add hub module skeleton"
```

---

### Task 2: Strangler-move NetsantralClient + util into the hub

**Files:**
- Move: `backend/src/modules/marketing/telephony/netsantral.client.ts` → `backend/src/modules/netgsm/santral/netsantral.client.ts`
- Move: `backend/src/modules/marketing/telephony/netsantral.util.ts` → `backend/src/modules/netgsm/santral/netsantral.util.ts`
- Move: `backend/src/modules/marketing/telephony/netsantral.client.spec.ts` → `backend/src/modules/netgsm/santral/netsantral.client.spec.ts`
- Move: `backend/src/modules/marketing/telephony/netsantral.util.spec.ts` → `backend/src/modules/netgsm/santral/netsantral.util.spec.ts`
- Modify: every importer (find with grep — expected: `telephony/netgsm-api.adapter.ts`, `telephony/recording-sync.service.ts`, `telephony/telephony-config.service.ts` and/or others), `marketing.module.ts`, `netgsm.module.ts`

**Interfaces:**
- Produces: `NetsantralClient` (unchanged API: `originate(p: OriginateParams)`, `callBridge(p: BridgeParams)`, static `ORIGINATE_HOST`) now provided/exported by `NetgsmModule`. Import path: `../../netgsm/santral/netsantral.client` (from `marketing/telephony/*`).

- [ ] **Step 1: Move files with git mv**

```bash
cd /home/tarik/Projects/kds-marketing/backend
mkdir -p src/modules/netgsm/santral
git mv src/modules/marketing/telephony/netsantral.client.ts src/modules/netgsm/santral/netsantral.client.ts
git mv src/modules/marketing/telephony/netsantral.util.ts src/modules/netgsm/santral/netsantral.util.ts
git mv src/modules/marketing/telephony/netsantral.client.spec.ts src/modules/netgsm/santral/netsantral.client.spec.ts
git mv src/modules/marketing/telephony/netsantral.util.spec.ts src/modules/netgsm/santral/netsantral.util.spec.ts
```

- [ ] **Step 2: Fix relative imports inside the moved files**

In `netsantral.client.ts`: `'../../../common/util/safe-fetch'` stays valid (same depth: modules/netgsm/santral → common). Verify: both `marketing/telephony/` and `netgsm/santral/` are 3 levels below `src/`, so `../../../common/...` is unchanged. The `./netsantral.util` import is unchanged.

- [ ] **Step 3: Update all importers**

```bash
grep -rln "telephony/netsantral" src --include="*.ts"
```
For each hit, rewrite the import path, e.g. in `src/modules/marketing/telephony/netgsm-api.adapter.ts`:

```typescript
import { NetsantralClient } from '../../netgsm/santral/netsantral.client';
import { interpretNetsantralOriginate } from '../../netgsm/santral/netsantral.util'; // only if imported
```

In `marketing.module.ts`: delete the `import { NetsantralClient } ...` line and remove `NetsantralClient,` from the `providers` array (it now comes from the imported `NetgsmModule`).

- [ ] **Step 4: Provide + export from the hub**

```typescript
// netgsm.module.ts
import { NetsantralClient } from './santral/netsantral.client';

@Module({
  providers: [NetsantralClient],
  exports: [NetsantralClient],
})
```

- [ ] **Step 5: Build + run the moved specs**

Run: `npm run build && npm test -- --testPathPatterns='netgsm/santral'`
Expected: build clean; the two moved spec files PASS unchanged.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "refactor(netgsm): move NetsantralClient into the hub module"
```

---

### Task 3: Strangler-move NetgsmCdrClient into the hub

**Files:**
- Move: `backend/src/modules/marketing/telephony/netgsm-cdr.client.ts` → `backend/src/modules/netgsm/santral/netgsm-cdr.client.ts`
- Modify: importers (`telephony/call-cdr-sync.service.ts`, others via grep), `marketing.module.ts`, `netgsm.module.ts`

**Interfaces:**
- Produces: `NetgsmCdrClient` (unchanged: `fetchRaw(creds, startdate, stopdate)`, `fetchCdr(...)`, `normalizeRecords(body)`) exported by `NetgsmModule`.

- [ ] **Step 1: Move + update imports** (same recipe as Task 2)

```bash
git mv src/modules/marketing/telephony/netgsm-cdr.client.ts src/modules/netgsm/santral/netgsm-cdr.client.ts
grep -rln "telephony/netgsm-cdr" src --include="*.ts"
```
Update each importer to `'../../netgsm/santral/netgsm-cdr.client'`; remove `NetgsmCdrClient` from `marketing.module.ts` providers + import; add to `NetgsmModule` providers + exports.

- [ ] **Step 2: Build + targeted tests**

Run: `npm run build && npm test -- --testPathPatterns='call-cdr-sync|cdr'`
Expected: PASS (call-cdr-sync spec still green).

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "refactor(netgsm): move NetgsmCdrClient into the hub module"
```

---

### Task 4: Delete the dead recording-retrieval path

**Files:**
- Delete: `backend/src/modules/marketing/telephony/recording-sync.service.ts`
- Delete: `backend/src/modules/marketing/telephony/recording-sync.service.spec.ts`
- Modify: `backend/src/modules/netgsm/santral/netsantral.client.ts` (remove `recordingEnabled()` + `fetchRecordingUrl()`), `marketing.module.ts` (remove provider + import)

Rationale (spec §8): the sweep is double-dead — gated on unset `NETGSM_RECORDING_BASE_URL` AND filtered on `externalCallId != null` which never matches because `wait_response=0` acceptances return no unique_id. Recordings arrive via CDR `recording` / webhook `seskaydi` (Phase 3/4).

- [ ] **Step 1: Delete + detach**

```bash
git rm src/modules/marketing/telephony/recording-sync.service.ts src/modules/marketing/telephony/recording-sync.service.spec.ts
```
In `marketing.module.ts` remove the `RecordingSyncService` import + provider entry. In `netsantral.client.ts` delete the `recordingEnabled()` and `fetchRecordingUrl()` methods and the now-unused `safeFetch` import if nothing else uses it.

- [ ] **Step 2: Confirm nothing references it**

Run: `grep -rn "RecordingSyncService\|fetchRecordingUrl\|recordingEnabled\|NETGSM_RECORDING_BASE_URL" src --include="*.ts"`
Expected: no hits (fix any stragglers — e.g. the netsantral.client.spec may cover fetchRecordingUrl; delete those test cases).

- [ ] **Step 3: Build + tests + commit**

Run: `npm run build && npm test -- --testPathPatterns='netgsm/santral|telephony'`
Expected: PASS.

```bash
git add -A && git commit -m "refactor(telephony): remove dead recording-retrieval sweep (superseded by CDR/webhook recording fields)"
```

---

### Task 5: `NetgsmRestClient` (Basic Auth JSON core)

**Files:**
- Create: `backend/src/modules/netgsm/core/netgsm-rest.client.ts`
- Test: `backend/src/modules/netgsm/core/netgsm-rest.client.spec.ts`
- Modify: `netgsm.module.ts` (provide + export)

**Interfaces:**
- Produces: `NetgsmRestClient.request<T>(opts: NetgsmRestRequest): Promise<NetgsmRestResult<T>>` — used by BalanceClient (Task 7) and every Phase-1+ client.

- [ ] **Step 1: Write the failing test**

```typescript
// backend/src/modules/netgsm/core/netgsm-rest.client.spec.ts
import { NetgsmRestClient } from './netgsm-rest.client';

describe('NetgsmRestClient', () => {
  const client = new NetgsmRestClient();
  const creds = { usercode: '8503021234', password: 'p@ss&w=rd' };

  afterEach(() => jest.restoreAllMocks());

  it('sends Basic Auth and JSON body, parses a JSON response', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      status: 200,
      text: async () => '{"balance":"1234.56"}',
    } as any);
    const res = await client.request<{ balance: string }>({
      path: '/balance', method: 'POST', creds, body: { stip: 1 },
    });
    expect(res.httpStatus).toBe(200);
    expect(res.body).toEqual({ balance: '1234.56' });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.netgsm.com.tr/balance');
    expect(init.headers['Authorization']).toBe(
      'Basic ' + Buffer.from('8503021234:p@ss&w=rd').toString('base64'),
    );
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('returns rawText with body=null on a non-JSON response', async () => {
    jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      status: 200, text: async () => '30',
    } as any);
    const res = await client.request({ path: '/balance', method: 'POST', creds, body: {} });
    expect(res.body).toBeNull();
    expect(res.rawText).toBe('30');
  });

  it('scrubs credentials from thrown transport errors', async () => {
    jest.spyOn(global, 'fetch' as any).mockRejectedValue(new Error('connect fail p@ss&w=rd'));
    await expect(
      client.request({ path: '/x', method: 'POST', creds, body: {} }),
    ).rejects.toThrow(/\*\*\*/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- --testPathPatterns='netgsm-rest.client'`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```typescript
// backend/src/modules/netgsm/core/netgsm-rest.client.ts
import { Injectable, Logger } from '@nestjs/common';

export interface NetgsmRestRequest {
  /** Path under https://api.netgsm.com.tr, e.g. '/sms/rest/v2/send'. */
  path: string;
  method: 'GET' | 'POST';
  creds: { usercode: string; password: string };
  /** JSON body for POST. */
  body?: unknown;
  timeoutMs?: number;
}

export interface NetgsmRestResult<T> {
  httpStatus: number;
  /** Parsed JSON, or null when the body isn't JSON (NetGSM sometimes answers a bare code). */
  body: T | null;
  rawText: string;
}

/**
 * Core HTTP client for NetGSM's REST surface (api.netgsm.com.tr, TLS
 * mandatory). Auth is HTTP Basic (usercode:password) per the v2 docs. The
 * response is parsed tolerantly: JSON when possible, else rawText is kept so
 * callers can interpret legacy bare-code answers. Credentials are scrubbed
 * from any thrown error message — same discipline as NetsantralClient.
 */
@Injectable()
export class NetgsmRestClient {
  private readonly logger = new Logger(NetgsmRestClient.name);
  static readonly BASE = 'https://api.netgsm.com.tr';
  private static readonly TIMEOUT_MS = 15_000;

  async request<T = unknown>(req: NetgsmRestRequest): Promise<NetgsmRestResult<T>> {
    const url = `${NetgsmRestClient.BASE}${req.path}`;
    const auth = Buffer.from(`${req.creds.usercode}:${req.creds.password}`).toString('base64');
    try {
      const res = await fetch(url, {
        method: req.method,
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
        },
        body: req.method === 'POST' ? JSON.stringify(req.body ?? {}) : undefined,
        signal: AbortSignal.timeout(req.timeoutMs ?? NetgsmRestClient.TIMEOUT_MS),
      });
      const rawText = ((await res.text()) ?? '').trim();
      let body: T | null = null;
      try {
        body = rawText ? (JSON.parse(rawText) as T) : null;
      } catch {
        body = null;
      }
      return { httpStatus: res.status, body, rawText };
    } catch (e: any) {
      const timedOut = e?.name === 'AbortError' || e?.name === 'TimeoutError';
      const raw = timedOut ? 'NetGSM request timed out' : (e?.message ?? String(e));
      const escaped = req.creds.password.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const scrubbed = raw
        .replace(new RegExp(escaped, 'g'), '***')
        .replace(new RegExp(req.creds.usercode, 'g'), '***');
      throw new Error(scrubbed);
    }
  }
}
```

- [ ] **Step 4: Run tests, provide in module, build**

Run: `npm test -- --testPathPatterns='netgsm-rest.client'` → PASS.
Add `NetgsmRestClient` to `NetgsmModule` providers + exports. `npm run build` → clean.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(netgsm): core Basic-Auth REST client"
```

---

### Task 6: Unified error map + `AccountRateBudgeter`

**Files:**
- Create: `backend/src/modules/netgsm/core/netgsm-error.map.ts`
- Create: `backend/src/modules/netgsm/core/account-rate-budgeter.ts`
- Test: `backend/src/modules/netgsm/core/netgsm-error.map.spec.ts`, `backend/src/modules/netgsm/core/account-rate-budgeter.spec.ts`
- Modify: `netgsm.module.ts` (provide + export the budgeter)

**Interfaces:**
- Produces: `netgsmErrorMessage(code: string): string`, `class NetgsmError extends Error { code: string }`, `AccountRateBudgeter.tryTake(usercode: string, bucket: string, limit: number, perMs: number): boolean`.

- [ ] **Step 1: Failing tests**

```typescript
// netgsm-error.map.spec.ts
import { netgsmErrorMessage, NetgsmError } from './netgsm-error.map';

describe('netgsm error map', () => {
  it('maps the documented codes', () => {
    expect(netgsmErrorMessage('30')).toMatch(/kimlik|IP/i);
    expect(netgsmErrorMessage('40')).toMatch(/başlık/i);
    expect(netgsmErrorMessage('60')).toMatch(/paket|yetki/i);
    expect(netgsmErrorMessage('80')).toMatch(/hız|limit/i);
  });
  it('falls back for unknown codes', () => {
    expect(netgsmErrorMessage('999')).toContain('999');
  });
  it('NetgsmError carries the code', () => {
    const e = new NetgsmError('30');
    expect(e.code).toBe('30');
    expect(e.message).toBe(netgsmErrorMessage('30'));
  });
});
```

```typescript
// account-rate-budgeter.spec.ts
import { AccountRateBudgeter } from './account-rate-budgeter';

describe('AccountRateBudgeter', () => {
  it('enforces the window per account+bucket independently', () => {
    const b = new AccountRateBudgeter();
    expect(b.tryTake('acc1', 'report', 2, 60_000)).toBe(true);
    expect(b.tryTake('acc1', 'report', 2, 60_000)).toBe(true);
    expect(b.tryTake('acc1', 'report', 2, 60_000)).toBe(false); // acc1 exhausted
    expect(b.tryTake('acc2', 'report', 2, 60_000)).toBe(true);  // acc2 unaffected
    expect(b.tryTake('acc1', 'iys', 2, 60_000)).toBe(true);     // other bucket unaffected
  });
  it('refills after the window elapses', () => {
    jest.useFakeTimers();
    const b = new AccountRateBudgeter();
    expect(b.tryTake('a', 'x', 1, 1000)).toBe(true);
    expect(b.tryTake('a', 'x', 1, 1000)).toBe(false);
    jest.advanceTimersByTime(1001);
    expect(b.tryTake('a', 'x', 1, 1000)).toBe(true);
    jest.useRealTimers();
  });
});
```

- [ ] **Step 2: Run → FAIL**, then implement:

```typescript
// backend/src/modules/netgsm/core/netgsm-error.map.ts
/**
 * Unified NetGSM error vocabulary. One place for user-facing (Turkish)
 * messages across the send/report/balance/santral/İYS surfaces so every
 * settings card and toast explains a bare provider code the same way.
 * Legacy send codes are documented in netgsm-send.util.ts (English,
 * operator-facing); these are the tenant-facing Turkish equivalents.
 */
const MESSAGES: Record<string, string> = {
  '20': 'Mesaj reddedildi: metin boş, çok uzun veya desteklenmeyen karakter içeriyor (kod 20).',
  '30': 'NetGSM kimlik doğrulaması başarısız: API kullanıcı adı/şifresini, API erişiminin açık olduğunu ve sunucu IP adresinin izin listesinde olduğunu kontrol edin (kod 30).',
  '40': 'Gönderici başlığı (msgheader) hesapta tanımlı veya İYS onaylı değil (kod 40).',
  '50': 'İYS: alıcının ticari ileti izni yok veya ret kaydı var (kod 50).',
  '51': 'İYS: gönderici marka/başlık İYS\'de ticari ileti için kayıtlı değil (kod 51).',
  '60': 'NetGSM hesabında bu işlem için yetki veya tanımlı paket yok (kod 60).',
  '70': 'NetGSM\'e eksik veya hatalı parametre gönderildi (kod 70).',
  '80': 'NetGSM hız limiti aşıldı — kısa bir bekleme sonrası yeniden deneyin (kod 80).',
  '85': 'Aynı alıcıya aynı içerik çok kısa aralıkla gönderildi (mükerrer limit, kod 85).',
  '100': 'NetGSM sistem hatası — daha sonra yeniden deneyin (kod 100).',
};

export function netgsmErrorMessage(code: string): string {
  return MESSAGES[code] ?? `NetGSM işlemi reddetti (kod ${code}).`;
}

export class NetgsmError extends Error {
  constructor(public readonly code: string, message?: string) {
    super(message ?? netgsmErrorMessage(code));
    this.name = 'NetgsmError';
  }
}
```

```typescript
// backend/src/modules/netgsm/core/account-rate-budgeter.ts
import { Injectable } from '@nestjs/common';

/**
 * Per-ACCOUNT (usercode) sliding-window budgets for NetGSM's per-account rate
 * limits (report 60/min, İYS 10/min, autocall 10/min, statistics 2/min, ...).
 * Replaces global per-tick caps that starved multi-tenant polling. In-memory
 * per instance — the same accepted limitation as the entitlements cache; the
 * limits are safety margins, not exact accounting.
 */
@Injectable()
export class AccountRateBudgeter {
  private readonly windows = new Map<string, number[]>();

  /** True and consumes one slot when under `limit` calls in the trailing `perMs` window. */
  tryTake(usercode: string, bucket: string, limit: number, perMs: number): boolean {
    const key = `${usercode}:${bucket}`;
    const now = Date.now();
    const stamps = (this.windows.get(key) ?? []).filter((t) => now - t < perMs);
    if (stamps.length >= limit) {
      this.windows.set(key, stamps);
      return false;
    }
    stamps.push(now);
    this.windows.set(key, stamps);
    return true;
  }
}
```

- [ ] **Step 3: Run tests → PASS; add `AccountRateBudgeter` to module providers/exports; build; commit**

```bash
git add -A && git commit -m "feat(netgsm): unified error map and per-account rate budgeter"
```

---

### Task 7: `BalanceClient` (live credential probe + credit readout)

**Files:**
- Create: `backend/src/modules/netgsm/balance/balance.client.ts`
- Test: `backend/src/modules/netgsm/balance/balance.client.spec.ts`
- Modify: `netgsm.module.ts`

**Interfaces:**
- Consumes: `NetgsmRestClient.request` (Task 5).
- Produces: `BalanceClient.fetchBalance(creds: { usercode: string; password: string }): Promise<BalanceResult>` where `BalanceResult = { ok: boolean; credsValid: boolean | null; code: string | null; credit: string | null; packages: Array<{ name: string; remaining: string | null }>; message: string | null }`. Semantics: `credsValid=true` when NetGSM authenticated (success OR code 60 "no package"); `false` on code 30; `null` on transport error.

- [ ] **Step 1: Failing test**

```typescript
// balance.client.spec.ts
import { BalanceClient } from './balance.client';
import { NetgsmRestClient } from '../core/netgsm-rest.client';

describe('BalanceClient', () => {
  const rest = new NetgsmRestClient();
  const client = new BalanceClient(rest);
  const creds = { usercode: 'u', password: 'p' };
  afterEach(() => jest.restoreAllMocks());

  it('parses a package/credit response', async () => {
    jest.spyOn(rest, 'request').mockResolvedValue({
      httpStatus: 200,
      body: [{ balance_name: 'OTP SMS', amount: '5000' }, { balance_name: 'TL', amount: '123.45' }],
      rawText: 'x',
    } as any);
    const r = await client.fetchBalance(creds);
    expect(r.ok).toBe(true);
    expect(r.credsValid).toBe(true);
    expect(r.packages.length).toBeGreaterThan(0);
  });

  it('code 30 → creds invalid', async () => {
    jest.spyOn(rest, 'request').mockResolvedValue({ httpStatus: 406, body: { code: '30' }, rawText: '30' } as any);
    const r = await client.fetchBalance(creds);
    expect(r.ok).toBe(false);
    expect(r.credsValid).toBe(false);
    expect(r.code).toBe('30');
    expect(r.message).toMatch(/kimlik|IP/i);
  });

  it('code 60 (no package) still proves creds', async () => {
    jest.spyOn(rest, 'request').mockResolvedValue({ httpStatus: 200, body: { code: '60' }, rawText: '60' } as any);
    const r = await client.fetchBalance(creds);
    expect(r.ok).toBe(false);
    expect(r.credsValid).toBe(true);
  });

  it('transport error → credsValid null', async () => {
    jest.spyOn(rest, 'request').mockRejectedValue(new Error('down'));
    const r = await client.fetchBalance(creds);
    expect(r.ok).toBe(false);
    expect(r.credsValid).toBeNull();
  });
});
```

- [ ] **Step 2: Run → FAIL, implement**

```typescript
// backend/src/modules/netgsm/balance/balance.client.ts
import { Injectable, Logger } from '@nestjs/common';
import { NetgsmRestClient } from '../core/netgsm-rest.client';
import { netgsmErrorMessage } from '../core/netgsm-error.map';

export interface BalanceResult {
  ok: boolean;
  /** true = NetGSM authenticated the creds (even if no package, code 60);
   *  false = rejected (code 30); null = couldn't reach NetGSM. */
  credsValid: boolean | null;
  code: string | null;
  credit: string | null;
  packages: Array<{ name: string; remaining: string | null }>;
  message: string | null;
}

/**
 * POST /balance — package + TL credit readout, and the cheapest LIVE
 * credential probe NetGSM offers (unlike /netsantral/report it is not
 * IP-allow-listed, so "Verify" works from anywhere). stip=3 asks for both
 * package list and TL credit; the response shape varies by account type, so
 * parsing is tolerant: array of {balance_name|paket, amount|miktar} rows,
 * or {code} error envelope, or a bare-code text body.
 */
@Injectable()
export class BalanceClient {
  private readonly logger = new Logger(BalanceClient.name);

  constructor(private readonly rest: NetgsmRestClient) {}

  async fetchBalance(creds: { usercode: string; password: string }): Promise<BalanceResult> {
    let httpStatus: number, body: any, rawText: string;
    try {
      ({ httpStatus, body, rawText } = await this.rest.request({
        path: '/balance', method: 'POST', creds, body: { stip: 3 },
      }));
    } catch (e: any) {
      return { ok: false, credsValid: null, code: null, credit: null, packages: [], message: e?.message ?? 'NetGSM erişilemedi' };
    }
    const code = typeof body?.code === 'string' ? body.code : /^\d{2,3}$/.test(rawText) ? rawText : null;
    if (code && code !== '00') {
      return {
        ok: false,
        credsValid: code === '30' ? false : code === '60' ? true : null,
        code, credit: null, packages: [], message: netgsmErrorMessage(code),
      };
    }
    const rows: any[] = Array.isArray(body) ? body : Array.isArray(body?.balance) ? body.balance : [];
    const packages = rows.map((r) => ({
      name: String(r?.balance_name ?? r?.paket ?? r?.name ?? 'paket'),
      remaining: r?.amount != null ? String(r.amount) : r?.miktar != null ? String(r.miktar) : null,
    }));
    const tl = packages.find((p) => /tl|kredi|bakiye/i.test(p.name));
    return {
      ok: httpStatus === 200 && (packages.length > 0 || body != null),
      credsValid: true, code: null,
      credit: tl?.remaining ?? null, packages,
      message: null,
    };
  }
}
```

- [ ] **Step 3: Run tests → PASS; provide+export in module; build; commit**

```bash
git add -A && git commit -m "feat(netgsm): balance client — live credential probe + credit readout"
```

---

### Task 8: Real Verify — SMS adapter healthCheck + telephony verify endpoint

**Files:**
- Modify: `backend/src/modules/marketing/channels/adapters/netgsm-sms.adapter.ts` (healthCheck → live balance probe; constructor gains `BalanceClient`)
- Modify: `backend/src/modules/marketing/channels/adapters/netgsm-sms.adapter.spec.ts`
- Modify: `backend/src/modules/marketing/controllers/telephony-config.controller.ts` (add `POST verify`)
- Modify: `backend/src/modules/marketing/telephony/telephony-config.service.ts` (add `verify(workspaceId)` method)
- Modify: `frontend/src/pages/marketing/accounts/TelephonyCard.tsx` (Verify button calls `/telephony/verify`, renders disambiguated result)
- Modify: `frontend/src/locales/*/translation.json` (or the repo's i18n resource files — locate with `grep -rn "accounts.tel.test" frontend/src`) for new keys

**Interfaces:**
- Consumes: `BalanceClient.fetchBalance` (Task 7), `TelephonyConfigService.resolveForWorkspace(workspaceId)` (existing — returns `{ username, password, trunk, ... } | null`), `CallCdrSyncService.testFetch` (existing).
- Produces: `POST /marketing/telephony/verify` → `{ balance: BalanceResult; cdr: { httpStatus: number; body: any } | { skipped: string } }`.

- [ ] **Step 1: Failing adapter test** — in `netgsm-sms.adapter.spec.ts` add (adapt to the file's existing setup — it constructs the adapter with a registry; add a `BalanceClient` stub):

```typescript
describe('healthCheck', () => {
  it('probes NetGSM live and reports credsValid', async () => {
    const balance = { fetchBalance: jest.fn().mockResolvedValue({ ok: true, credsValid: true, credit: '100', packages: [], code: null, message: null }) };
    const adapter = new NetgsmSmsAdapter(registryStub as any, balance as any);
    const res = await adapter.healthCheck({ secrets: { usercode: 'u', password: 'p', msgheader: 'HDR' } } as any);
    expect(balance.fetchBalance).toHaveBeenCalledWith({ usercode: 'u', password: 'p' });
    expect(res.ok).toBe(true);
    expect(res.details).toMatchObject({ credsValid: true });
  });
  it('missing secrets → ok:false without probing', async () => {
    const balance = { fetchBalance: jest.fn() };
    const adapter = new NetgsmSmsAdapter(registryStub as any, balance as any);
    const res = await adapter.healthCheck({ secrets: {} } as any);
    expect(res.ok).toBe(false);
    expect(balance.fetchBalance).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run → FAIL, implement adapter change**

```typescript
// netgsm-sms.adapter.ts — constructor + healthCheck
import { BalanceClient } from '../../../netgsm/balance/balance.client';
// ...
constructor(
  private readonly registry: ChannelAdapterRegistry,
  private readonly balance: BalanceClient,
) {}

/** Live verify: presence check, then a real /balance auth probe (not IP-gated). */
async healthCheck(
  config: ResolvedChannelConfig,
): Promise<{ ok: boolean; details?: Record<string, unknown> }> {
  const { usercode, password, msgheader } = config.secrets;
  if (!usercode || !password || !msgheader) {
    return { ok: false, details: { hasUsercode: !!usercode, hasHeader: !!msgheader } };
  }
  const probe = await this.balance.fetchBalance({ usercode, password });
  return {
    ok: probe.credsValid === true,
    details: {
      credsValid: probe.credsValid,
      credit: probe.credit,
      code: probe.code,
      message: probe.message,
      hasHeader: true,
    },
  };
}
```

- [ ] **Step 3: Telephony verify service + endpoint**

In `telephony-config.service.ts` add (imports: `BalanceClient`; `CallCdrSyncService` must NOT be injected here — it already depends on this service; the controller composes instead):

```typescript
/** Live verify of the santral creds via /balance (works off-prod, unlike CDR). */
async verifyCreds(workspaceId: string) {
  const cfg = await this.resolveForWorkspace(workspaceId);
  if (!cfg) return { configured: false as const, balance: null };
  const balance = await this.balanceClient.fetchBalance({ usercode: cfg.username, password: cfg.password });
  return { configured: true as const, balance };
}
```
(add `private readonly balanceClient: BalanceClient` to the constructor)

In `telephony-config.controller.ts`:

```typescript
/** Live verify: /balance auth probe (anywhere) + CDR fetch (prod IP only). */
@Post('verify')
@RequirePermission('settings.manage')
async verify(@CurrentMarketingUser() a: MarketingUserPayload) {
  const creds = await this.telephony.verifyCreds(a.workspaceId);
  let cdr: unknown = { skipped: 'no active config' };
  if (creds.configured) {
    try { cdr = await this.cdr.testFetch(a.workspaceId); } catch (e: any) { cdr = { error: e?.message }; }
  }
  return { ...creds, cdr };
}
```

- [ ] **Step 4: Frontend — TelephonyCard verify UX**

In `TelephonyCard.tsx`, change the existing test mutation (`line ~165`) to `marketingApi.post('/telephony/verify', {})` and render: `balance.credsValid === true` → green "Kimlik doğrulandı" + credit; `false` → red with `balance.message`; `null`/cdr error → amber "NetGSM'e ulaşılamadı / CDR yalnızca prod IP'den doğrulanır". Add i18n keys `accounts.tel.verify.ok`, `accounts.tel.verify.badCreds`, `accounts.tel.verify.unreachable`, `accounts.tel.verify.cdrProdOnly` (TR + EN files).

- [ ] **Step 5: Tests + build both sides**

Run: `cd backend && npm test -- --testPathPatterns='netgsm-sms.adapter|telephony-config' && npm run build`
Run: `cd ../frontend && npm run build`
Expected: PASS / clean builds.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(telephony,channels): real NetGSM credential verify via live balance probe"
```

---

### Task 9: `NetgsmWebhookEvent` table + webhook receiver skeleton

**Files:**
- Modify: `backend/prisma/schema.prisma` (new model)
- Create: `backend/prisma/migrations/20260708120000_netgsm_webhook_events/migration.sql` + `down.sql`
- Create: `backend/src/modules/netgsm/webhooks/netgsm-webhook.util.ts`
- Create: `backend/src/modules/netgsm/webhooks/netgsm-events.controller.ts`
- Test: `backend/src/modules/netgsm/webhooks/netgsm-webhook.util.spec.ts`, `backend/src/modules/netgsm/webhooks/netgsm-events.controller.spec.ts`
- Modify: `netgsm.module.ts` (controller + util provider)

**Interfaces:**
- Produces: `netgsmWebhookToken(workspaceId, purpose)`, `verifyNetgsmWebhookToken(workspaceId, purpose, token)`, `netgsmWebhookUrl(baseUrl, workspaceId, purpose)`; route `POST /api/public/netgsm/:workspaceId/:token/events` (archives + dedupes, 202; consumers land in Phase 3). Purposes union: `'events' | 'iys' | 'voice-report' | 'autocall-report'`.

- [ ] **Step 1: Prisma model** (append near SalesCall models):

```prisma
/// NetGSM hub — raw inbound webhook archive + idempotency guard. One row per
/// received provider event; duplicates (NetGSM retries) upsert onto the same
/// row via the unique key instead of double-processing. `processedAt` is
/// stamped by the domain consumers (Phase 3+); Phase 0 only archives.
model NetgsmWebhookEvent {
  id          String    @id @default(uuid())
  workspaceId String
  purpose     String // 'events' | 'iys' | 'voice-report' | 'autocall-report'
  /// Provider-side unique id (unique_id/gorevid/transactionid); a sha256 of the
  /// raw body when the payload carries no id.
  externalId  String
  payload     Json
  receivedAt  DateTime  @default(now())
  processedAt DateTime?

  @@unique([workspaceId, purpose, externalId])
  @@index([workspaceId, receivedAt])
  @@map("netgsm_webhook_events")
}
```

- [ ] **Step 2: Migration up/down**

```sql
-- migration.sql
CREATE TABLE IF NOT EXISTS "netgsm_webhook_events" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    CONSTRAINT "netgsm_webhook_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "netgsm_webhook_events_workspaceId_purpose_externalId_key"
  ON "netgsm_webhook_events"("workspaceId", "purpose", "externalId");
CREATE INDEX IF NOT EXISTS "netgsm_webhook_events_workspaceId_receivedAt_idx"
  ON "netgsm_webhook_events"("workspaceId", "receivedAt");
```

```sql
-- down.sql
DROP TABLE IF EXISTS "netgsm_webhook_events";
```

- [ ] **Step 3: Token util** (mirror `netgsm-callback.util.ts`, domain-separated label):

```typescript
// netgsm-webhook.util.ts
import { createHmac, timingSafeEqual, createHash } from 'crypto';

export type NetgsmWebhookPurpose = 'events' | 'iys' | 'voice-report' | 'autocall-report';
const LABEL = 'netgsm-hub';

function hmacKey(): Buffer {
  const raw = process.env.MARKETING_SECRET_KEY;
  if (!raw) throw new Error('MARKETING_SECRET_KEY is not configured');
  return Buffer.from(raw, 'base64');
}

/** token = HMAC-SHA256(masterKey, "netgsm-hub:<workspaceId>:<purpose>") hex. */
export function netgsmWebhookToken(workspaceId: string, purpose: NetgsmWebhookPurpose): string {
  return createHmac('sha256', hmacKey()).update(`${LABEL}:${workspaceId}:${purpose}`).digest('hex');
}

export function verifyNetgsmWebhookToken(
  workspaceId: string, purpose: NetgsmWebhookPurpose, token: string,
): boolean {
  let expected: string;
  try { expected = netgsmWebhookToken(workspaceId, purpose); } catch { return false; }
  const a = Buffer.from(token ?? '', 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function netgsmWebhookUrl(
  baseUrl: string | undefined, workspaceId: string, purpose: NetgsmWebhookPurpose,
): string | null {
  if (!baseUrl) return null;
  let token: string;
  try { token = netgsmWebhookToken(workspaceId, purpose); } catch { return null; }
  return `${baseUrl.replace(/\/+$/, '')}/api/public/netgsm/${workspaceId}/${token}/${purpose}`;
}

/** Fallback external id when the payload carries none: sha256 of the raw body. */
export function payloadDigest(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? {})).digest('hex');
}
```

Spec (`netgsm-webhook.util.spec.ts`): token differs per purpose+workspace; verify accepts the minted token, rejects tampering/empty; url embeds path; both under a `beforeAll` that sets `process.env.MARKETING_SECRET_KEY = Buffer.from('k'.repeat(32)).toString('base64')`.

- [ ] **Step 4: Controller skeleton** (archive-only; 404-on-bad-token like the MO controller — check `netgsm-public.controller.ts` for its status-code idiom and match it):

```typescript
// netgsm-events.controller.ts
import { Body, Controller, HttpCode, NotFoundException, Param, Post } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { payloadDigest, verifyNetgsmWebhookToken } from './netgsm-webhook.util';

/**
 * Unified public receiver for NetGSM pushes (santral events, İYS, voice/
 * autocall reports). NetGSM signs nothing, so the URL carries an HMAC token
 * only MARKETING_SECRET_KEY holders can mint. Phase 0: verify + archive +
 * dedupe (202). Domain consumers (screen-pop, CDR upsert, İYS apply) attach
 * in Phases 2/3/5 by reading NetgsmWebhookEvent / subscribing to bus events.
 */
@Controller('public/netgsm')
export class NetgsmEventsController {
  constructor(private readonly prisma: PrismaService) {}

  @Post(':workspaceId/:token/events')
  @HttpCode(202)
  async events(
    @Param('workspaceId') workspaceId: string,
    @Param('token') token: string,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    if (!verifyNetgsmWebhookToken(workspaceId, 'events', token)) throw new NotFoundException();
    const b = (body ?? {}) as Record<string, unknown>;
    const externalId =
      (typeof b.unique_id === 'string' && b.unique_id) ||
      (typeof b.uniqueid === 'string' && b.uniqueid) ||
      payloadDigest(body);
    await this.prisma.netgsmWebhookEvent.upsert({
      where: { workspaceId_purpose_externalId: { workspaceId, purpose: 'events', externalId } },
      create: { workspaceId, purpose: 'events', externalId, payload: (body ?? {}) as object },
      update: {}, // duplicate delivery — keep the first archive row
    });
    return { ok: true };
  }
}
```

Controller spec: valid token → 202 + row created (PrismaService stubbed with `upsert` jest.fn); duplicate externalId → upsert with `update: {}`; bad token → NotFoundException and NO prisma call.

- [ ] **Step 5: Wire + migrate + test**

Add controller to `NetgsmModule` `controllers: [...]`. Run migration up→down→up against the dev DB (repo convention — check how prior migrations were applied; `npx prisma migrate deploy` applies pending, then `psql $DATABASE_URL -f prisma/migrations/20260708120000_netgsm_webhook_events/down.sql`, then deploy again) and `npx prisma generate`.
Run: `npm test -- --testPathPatterns='netgsm/webhooks' && npm run build` → PASS.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(netgsm): webhook event archive table + unified public receiver skeleton"
```

---

### Task 10: Voice-AI credit literals → cost map

**Files:**
- Modify: `backend/src/modules/marketing/ai/ai-credit-costs.ts` (add `voice.analysis`, `voice.copilot`)
- Modify: `backend/src/modules/marketing/ai/ai-credit-costs.tripwire.spec.ts` (pin the two new keys)
- Modify: `backend/src/modules/marketing/voice-ai/call-analysis.service.ts` (literal 3 → `creditCost('voice.analysis')`)
- Modify: `backend/src/modules/marketing/voice-ai/copilot.service.ts` (literal 1 → `creditCost('voice.copilot')`)
- Modify: `backend/src/modules/marketing/voice-ai/voice-ai-bridge.service.ts` (literal → `creditCost('voice.turn')`)

- [ ] **Step 1: Add map entries**

```typescript
  'voice.turn': { credits: 2, tier: 'default' as AiModelTier },
  // Voice-AI Phase 5.2 cost decisions (were numeric literals in the services):
  'voice.analysis': { credits: 3, tier: 'default' as AiModelTier },
  'voice.copilot': { credits: 1, tier: 'conversation' as AiModelTier },
```

- [ ] **Step 2: Update the three services** — replace each literal with `creditCost('<action>')` (import from `../ai/ai-credit-costs`), delete the "Phase 5.2 literal" comments. Update the tripwire spec's pinned key list (it will fail until updated — that's the tripwire working).

- [ ] **Step 3: Test + commit**

Run: `npm test -- --testPathPatterns='ai-credit-costs|call-analysis|copilot|voice-ai-bridge'` → PASS.

```bash
git add -A && git commit -m "refactor(voice-ai): move credit literals into the tripwired cost map"
```

---

### Task 11: CDR sync — iterate only telephony-configured workspaces

**Files:**
- Modify: `backend/src/modules/marketing/telephony/call-cdr-sync.service.ts` (the `workspace.findMany` at ~line 40)
- Modify: its spec accordingly

- [ ] **Step 1: Failing/adjusted test** — in the cron-tick spec, assert the tick queries `channel.findMany`-derived workspace ids (or `telephonyConfig`) instead of ALL active workspaces; a workspace without an ACTIVE SMS channel must not be synced.

- [ ] **Step 2: Implement** — replace the all-workspaces query with:

```typescript
// Only workspaces that can possibly have CDR creds: an ACTIVE SMS channel
// (getCreds reads its sealed usercode/password). Saves a linear scan over
// every workspace each 5-min tick.
const channels = await this.prisma.channel.findMany({
  where: { type: 'SMS', status: 'ACTIVE' },
  select: { workspaceId: true },
  distinct: ['workspaceId'],
});
const workspaces = channels.map((c) => ({ id: c.workspaceId }));
```
(keep the rest of the tick identical; match the actual field names used by the existing query it replaces — inspect the current `findMany` select/where before editing.)

- [ ] **Step 3: Test + commit**

Run: `npm test -- --testPathPatterns='call-cdr-sync'` → PASS.

```bash
git add -A && git commit -m "perf(telephony): CDR sweep only iterates SMS-channel workspaces"
```

---

### Task 12: FeatureGuard presence meta-test

**Files:**
- Create: `backend/src/modules/marketing/guards/feature-guard-presence.tripwire.spec.ts`

**Interfaces:** Source-scanning fitness test (idiom: `entitlements.tripwire.spec.ts`).

- [ ] **Step 1: Write the test**

```typescript
// feature-guard-presence.tripwire.spec.ts
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Tripwire: FeatureGuard is per-controller (not global). A controller that
 * declares @RequiresFeature but forgets FeatureGuard in its @UseGuards chain
 * silently skips entitlement checks. This scans every *.controller.ts under
 * src/modules and fails the build for that gap.
 */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.controller.ts') ? [p] : [];
  });
}

describe('FeatureGuard presence tripwire', () => {
  const root = join(__dirname, '..', '..');
  it('every @RequiresFeature controller wires FeatureGuard', () => {
    const offenders: string[] = [];
    for (const file of walk(root)) {
      const src = readFileSync(file, 'utf8');
      if (!src.includes('@RequiresFeature(')) continue;
      // Every class block that carries @RequiresFeature must also carry a
      // @UseGuards(...) mention of FeatureGuard somewhere in the same file
      // AND the file must not use @RequiresFeature more times than classes
      // covered by a FeatureGuard chain.
      const classCount = (src.match(/@Controller\(/g) ?? []).length;
      const guardedCount = (src.match(/@UseGuards\([^)]*FeatureGuard[^)]*\)/g) ?? []).length;
      const requiresOnClasses = (src.match(/@RequiresFeature\(/g) ?? []).length;
      if (guardedCount === 0 || (classCount > 1 && guardedCount < Math.min(classCount, requiresOnClasses))) {
        offenders.push(file.replace(root, 'src/modules'));
      }
    }
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it** — `npm test -- --testPathPatterns='feature-guard-presence'`. If it exposes REAL offenders, fix them (add `FeatureGuard` to the chain) in this task and list them in the commit body.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "test(guards): tripwire — @RequiresFeature controllers must wire FeatureGuard"
```

---

### Task 13: Onboarding checklist (backend + Account Center card)

**Files:**
- Create: `backend/src/modules/marketing/controllers/netgsm-onboarding.controller.ts`
- Create: `backend/src/modules/marketing/services/netgsm-onboarding.service.ts`
- Test: `backend/src/modules/marketing/services/netgsm-onboarding.service.spec.ts`
- Create: `frontend/src/pages/marketing/accounts/NetgsmOnboardingCard.tsx`
- Modify: `frontend/src/pages/marketing/accounts/AccountCenterPage.tsx` (render card in `<TabsContent value="integrations">`)
- Modify: i18n resources (locate via `grep -rn "accounts.tab.integrations" frontend/src`)
- Modify: `marketing.module.ts` (controller + service)

**Interfaces:**
- Consumes: `TelephonyConfigService` (`get`, `resolveForWorkspace`), `BalanceClient`, `netgsmWebhookUrl` (Task 9), `netgsmMoCallbackUrl` (existing), Prisma (`channel`, `marketingUser` counts).
- Produces: `GET /marketing/netgsm/onboarding` → `{ items: Array<{ key: string; state: 'ok' | 'missing' | 'unknown'; detail?: string; url?: string }> }` with keys: `smsChannel`, `smsCredsLive`, `moUrl`, `telephonyConfig`, `santralCredsLive`, `repsWithDahili`, `eventsWebhookUrl`.

- [ ] **Step 1: Failing service test** — stub prisma/config/balance; expect: no SMS channel → `smsChannel: 'missing'`; ACTIVE channel + `credsValid:true` → `smsCredsLive: 'ok'`; TelephonyConfig ACTIVE + dahili count 2 → `repsWithDahili: 'ok', detail: '2'`; `eventsWebhookUrl` carries the minted URL.

- [ ] **Step 2: Implement service**

```typescript
// netgsm-onboarding.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { TelephonyConfigService } from '../telephony/telephony-config.service';
import { BalanceClient } from '../../netgsm/balance/balance.client';
import { netgsmWebhookUrl } from '../../netgsm/webhooks/netgsm-webhook.util';
import { netgsmMoCallbackUrl } from '../channels/netgsm-callback.util';

export interface OnboardingItem {
  key: string;
  state: 'ok' | 'missing' | 'unknown';
  detail?: string;
  url?: string;
}

/**
 * NetGSM onboarding checklist — the manual portal steps a tenant must click
 * through (NetGSM exposes no provisioning API), each with a live check where
 * an API read exists. Rendered by NetgsmOnboardingCard in Account Center.
 */
@Injectable()
export class NetgsmOnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly telephony: TelephonyConfigService,
    private readonly balance: BalanceClient,
  ) {}

  async checklist(workspaceId: string): Promise<{ items: OnboardingItem[] }> {
    const base = process.env.PUBLIC_BASE_URL;
    const items: OnboardingItem[] = [];

    const sms = await this.prisma.channel.findFirst({
      where: { workspaceId, type: 'SMS', status: 'ACTIVE' },
      select: { id: true },
    });
    items.push({ key: 'smsChannel', state: sms ? 'ok' : 'missing' });
    items.push({
      key: 'moUrl', state: sms ? 'ok' : 'missing',
      url: sms ? netgsmMoCallbackUrl(base, sms.id) ?? undefined : undefined,
    });

    let smsCreds: OnboardingItem = { key: 'smsCredsLive', state: 'unknown' };
    // Reuse the santral creds when SMS secrets are unavailable to this service;
    // the live probe below covers the shared-account case.
    const cfg = await this.telephony.resolveForWorkspace(workspaceId);
    if (cfg) {
      const probe = await this.balance.fetchBalance({ usercode: cfg.username, password: cfg.password });
      smsCreds = {
        key: 'smsCredsLive',
        state: probe.credsValid === true ? 'ok' : probe.credsValid === false ? 'missing' : 'unknown',
        detail: probe.credit ?? probe.message ?? undefined,
      };
    }
    items.push(smsCreds);

    items.push({ key: 'telephonyConfig', state: cfg ? 'ok' : 'missing' });
    items.push({ key: 'santralCredsLive', state: smsCreds.state });

    const dahiliCount = await this.prisma.marketingUser.count({
      where: { workspaceId, dahili: { not: null } },
    });
    items.push({ key: 'repsWithDahili', state: dahiliCount > 0 ? 'ok' : 'missing', detail: String(dahiliCount) });

    items.push({
      key: 'eventsWebhookUrl', state: 'unknown',
      url: netgsmWebhookUrl(base, workspaceId, 'events') ?? undefined,
      detail: 'Netsantral panel > Ayarlar > Genel Ayarlar > API Talep Ayarları',
    });
    return { items };
  }
}
```
(Adjust the `marketingUser.dahili` field name to the actual schema — verify with `grep -n "dahili" backend/prisma/schema.prisma`.)

- [ ] **Step 3: Controller** (guards per Global Constraints):

```typescript
// netgsm-onboarding.controller.ts
import { Controller, Get, UseGuards } from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { FeatureGuard, RequiresFeature } from '../guards/feature.guard';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { NetgsmOnboardingService } from '../services/netgsm-onboarding.service';

@MarketingRoute()
@Controller('marketing/netgsm')
@UseGuards(MarketingGuard, MarketingRolesGuard, FeatureGuard)
@MarketingRoles('MANAGER')
@RequiresFeature('telephony')
export class NetgsmOnboardingController {
  constructor(private readonly onboarding: NetgsmOnboardingService) {}

  @Get('onboarding')
  checklist(@CurrentMarketingUser() a: MarketingUserPayload) {
    return this.onboarding.checklist(a.workspaceId);
  }
}
```

- [ ] **Step 4: Frontend card** — `NetgsmOnboardingCard.tsx`: react-query GET `/netgsm/onboarding`; render each item as a row (state icon: ok=green check, missing=red x, unknown=gray dash; label from i18n `accounts.netgsm.<key>`; copy-to-clipboard button when `url` present). Mount inside `<TabsContent value="integrations">` in AccountCenterPage. Add TR/EN i18n keys for the 7 item labels + card title `accounts.netgsm.title` ("NetGSM Kurulum Kontrol Listesi" / "NetGSM Setup Checklist").

- [ ] **Step 5: Tests + builds + commit**

Run: `cd backend && npm test -- --testPathPatterns='netgsm-onboarding' && npm run build && cd ../frontend && npm run build`
Expected: PASS / clean.

```bash
git add -A && git commit -m "feat(netgsm): onboarding checklist card with live verifies"
```

---

### Task 14: Full verification + PR

- [ ] **Step 1: Full suite**

Run: `cd backend && npm test && npm run build && cd ../frontend && npm test && npm run build && npm run lint`
Expected: all green (note pre-existing failures if any — do not paper over new ones).

- [ ] **Step 2: Migration round-trip once more on a clean state** (up → down → up per repo rule).

- [ ] **Step 3: Push + PR**

```bash
git push -u origin feat/netgsm-hub-phase0
gh pr create --title "feat(netgsm): Phase 0 — hub foundation, live verify, webhook archive, quality fixes" --body "$(cat <<'EOF'
Phase 0 of the NetGSM full-integration program (spec: docs/superpowers/specs/2026-07-08-netgsm-full-integration-design.md).

- New netgsm hub module; NetsantralClient/NetgsmCdrClient strangler-moved in
- Core: Basic-Auth REST client, unified error map, per-account rate budgeter
- BalanceClient + real credential Verify (balance probe; error-30 disambiguation)
- NetgsmWebhookEvent archive table (reversible migration) + unified public receiver skeleton
- Dead recording-retrieval path removed; CDR sweep scoped to SMS-channel workspaces
- Voice-AI credit literals moved into the tripwired cost map
- FeatureGuard-presence tripwire test
- NetGSM onboarding checklist card (Account Center)

No user-visible behavior change except the improved Verify + the new checklist card.
EOF
)"
```

---

## Self-review notes (spec §Phase 0 coverage)

| Spec item | Task |
|---|---|
| Hub skeleton + core | 1, 5, 6 |
| Strangler moves | 2, 3 |
| BalanceClient + real Verify (both cards) | 7, 8 |
| NetgsmWebhookEvent + receiver skeleton | 9 |
| Dead-code cleanup (RecordingSync, capabilities comment, credit literals, CDR scan) | 4, 10, 11 (capabilities: keep `delivery-receipts` — receipts DO exist via the poller; fix is the doc comment in Task 4's sweep if touched, else defer to Phase 1 DLR rework) |
| Onboarding checklist card | 13 |
| FeatureGuard meta-test (spec §6) | 12 |
| Credentials resolver | deliberately deferred to Phase 3 (clients stay stateless; documented in header) |
