# In-app WebRTC webphone — Phase A (foundation / de-risk) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove a browser SIP.js client registers to NetGSM's `wss://sip5.netsantral.com:8089/ws` and places a test call with audio, from inside our HTTPS app — the vertical slice that de-risks the whole webphone before building full UX.

**Architecture:** Per-workspace `TelephonyConfig` gains `wssUrl`/`sipDomain`; each rep gets a sealed dahili SIP password. An authenticated `GET /marketing/telephony/webphone-config` returns the calling rep's `{wssUrl, sipDomain, dahili, sipPassword, displayName}`. A minimal frontend store wraps SIP.js `SimpleUser` (register + outbound call + status), surfaced as a small "Test webphone" panel on the telephony settings page.

**Tech Stack:** NestJS 11 / Prisma / Postgres; React + react-query; **SIP.js** (WebRTC over WSS); secret-box (AES-256-GCM); Jest (BE) / Vitest (FE).

**Spec:** `docs/superpowers/specs/2026-06-22-netgsm-inapp-webphone-design.md`

**Live-validation note:** The SIP.js↔NetGSM connection cannot be unit-tested — unit tests cover the store state machine (mocked SIP.js) + the backend config/endpoint. The real proof is Task 8 (manual, over the deployed HTTPS app). If signalling registers but audio is silent, that's the STUN/TURN risk → contact teknikdestek@netgsm.com.tr.

---

## File Structure

**Backend (modify):**
- `backend/prisma/schema.prisma` — `TelephonyConfig.wssUrl` + `.sipDomain`; `MarketingUser.dahiliSecret`.
- `backend/src/modules/marketing/telephony/telephony-config.service.ts` — store wssUrl/sipDomain; `setDahili` seals SIP password; `webphoneConfigFor()`.
- `backend/src/modules/marketing/dto/telephony-config.dto.ts` — `wssUrl`/`sipDomain` on upsert; `sipPassword` on SetDahili.
- `backend/src/modules/marketing/controllers/telephony-config.controller.ts` — `GET webphone-config`.

**Frontend (create):**
- `frontend/src/features/marketing/webphone/webphone.store.ts` — SIP.js SimpleUser lifecycle (register/call/hangup/status).
- `frontend/src/features/marketing/webphone/webphone.store.test.ts` — state machine, mocked SIP.js.
- `frontend/src/features/marketing/webphone/TestWebphonePanel.tsx` — minimal status + dial + call UI (on the settings page).

**Frontend (modify):**
- `frontend/package.json` — add `sip.js`.
- `frontend/src/pages/marketing/TelephonySettingsPage.tsx` — mount `<TestWebphonePanel/>`.

---

## Task 1: Schema — wssUrl/sipDomain + per-rep sealed SIP password

**Files:**
- Modify: `backend/prisma/schema.prisma` (`TelephonyConfig`, `MarketingUser`)

- [ ] **Step 1: Add fields to TelephonyConfig**

In `model TelephonyConfig`, after `pbxnum String?` add:
```prisma
  /// WebRTC websocket endpoint for the in-app webphone, e.g.
  /// wss://sip5.netsantral.com:8089/ws (from the dahili edit screen).
  wssUrl       String?
  /// SIP domain/realm for AOR + targets, e.g. sip5.netsantral.com.
  sipDomain    String?
```

- [ ] **Step 2: Add the sealed per-rep SIP password to MarketingUser**

In `model MarketingUser`, right after the `dahili String?` field add:
```prisma
  /// AES-256-GCM sealed SIP password for this rep's dahili (in-app webphone).
  /// Served only to the owning rep over HTTPS; never returned raw.
  dahiliSecret String?
```

- [ ] **Step 3: Generate the Prisma client (no DB needed)**

Run: `cd backend && npx prisma generate`
Expected: "Generated Prisma Client". (The migration SQL is produced in Task 1b via a throwaway postgres — there is no local dev DB.)

- [ ] **Step 1b: Generate the migration via a throwaway postgres**

Run:
```bash
cd backend
docker rm -f kds-mig-pg >/dev/null 2>&1
docker run -d --name kds-mig-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_USER=dev -e POSTGRES_DB=marketing -p 5469:5432 postgres:16
sleep 6
DATABASE_URL="postgresql://dev:dev@localhost:5469/marketing?schema=public" npx prisma migrate dev --name webphone_wss_and_dahili_secret --skip-generate
docker rm -f kds-mig-pg
```
Expected: a new `prisma/migrations/<ts>_webphone_wss_and_dahili_secret/migration.sql` adding the 3 columns; container removed.

- [ ] **Step 4: Commit**

```bash
cd /home/tarik/Projects/kds-marketing
git add backend/prisma/schema.prisma backend/prisma/migrations
git commit -m "feat(webphone): schema — TelephonyConfig wssUrl/sipDomain + MarketingUser dahiliSecret"
```

---

## Task 2: Config DTOs — wssUrl/sipDomain + sipPassword

**Files:**
- Modify: `backend/src/modules/marketing/dto/telephony-config.dto.ts`

- [ ] **Step 1: Replace the DTO file contents**

```typescript
import { IsOptional, IsString, IsObject, IsIn, MaxLength, ValidateIf } from 'class-validator';

export class UpsertTelephonyConfigDto {
  @IsOptional() @IsObject() secrets?: Record<string, string>;
  @IsOptional() @IsString() @MaxLength(20) trunk?: string;
  @IsOptional() @IsString() @MaxLength(20) pbxnum?: string;
  @IsOptional() @IsIn(['ACTIVE', 'DISABLED']) status?: string;
  @IsOptional() @IsString() @MaxLength(255) wssUrl?: string;
  @IsOptional() @IsString() @MaxLength(120) sipDomain?: string;
}

export class SetDahiliDto {
  @IsOptional() @IsString() @ValidateIf((_, v) => v !== null) @MaxLength(10) dahili?: string | null;
  /** The dahili's SIP password (sealed at rest, served only to the owning rep). */
  @IsOptional() @IsString() @MaxLength(120) sipPassword?: string;
}
```

- [ ] **Step 2: Type-check**

Run: `cd backend && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add backend/src/modules/marketing/dto/telephony-config.dto.ts
git commit -m "feat(webphone): DTOs for wssUrl/sipDomain + dahili sipPassword"
```

---

## Task 3: TelephonyConfigService — store wss/domain, seal SIP password, webphoneConfigFor

**Files:**
- Modify: `backend/src/modules/marketing/telephony/telephony-config.service.ts`
- Test: `backend/src/modules/marketing/telephony/telephony-config.service.spec.ts` (add cases)

- [ ] **Step 1: Add failing tests** (append inside the existing `describe`)

```typescript
it('upsert stores wssUrl + sipDomain', async () => {
  const prisma = prismaMock();
  prisma.telephonyConfig.upsert.mockResolvedValue({ id: 'c1', workspaceId: 'ws', provider: 'netgsm-netsantral', status: 'ACTIVE', configSealed: 'sealed:{"username":"850","password":"pw"}', trunk: '8508407303', pbxnum: null, wssUrl: 'wss://sip5.netsantral.com:8089/ws', sipDomain: 'sip5.netsantral.com' });
  const svc = new TelephonyConfigService(prisma);
  const out = await svc.upsert('ws', { secrets: { username: '850', password: 'pw' }, trunk: '8508407303', wssUrl: 'wss://sip5.netsantral.com:8089/ws', sipDomain: 'sip5.netsantral.com' });
  expect((out as any).wssUrl).toBe('wss://sip5.netsantral.com:8089/ws');
  const data = prisma.telephonyConfig.upsert.mock.calls[0][0].update;
  expect(data.wssUrl).toBe('wss://sip5.netsantral.com:8089/ws');
  expect(data.sipDomain).toBe('sip5.netsantral.com');
});

it('setDahili seals the SIP password', async () => {
  const prisma = prismaMock();
  prisma.marketingUser.updateMany.mockResolvedValue({ count: 1 });
  await new TelephonyConfigService(prisma).setDahili('ws', 'u', '101', 'sip-pw');
  const data = prisma.marketingUser.updateMany.mock.calls[0][0].data;
  expect(data.dahili).toBe('101');
  expect(data.dahiliSecret).toBe('sealed:sip-pw');
});

it('webphoneConfigFor returns the rep webphone config when complete', async () => {
  const prisma = prismaMock();
  prisma.telephonyConfig.findUnique.mockResolvedValue({ workspaceId: 'ws', status: 'ACTIVE', wssUrl: 'wss://x/ws', sipDomain: 'sip5.netsantral.com', trunk: '850', configSealed: 'sealed:{"username":"850","password":"pw"}' });
  prisma.marketingUser.findFirst.mockResolvedValue({ dahili: '101', dahiliSecret: 'sealed:sip-pw', firstName: 'A', lastName: 'B' });
  const r = await new TelephonyConfigService(prisma).webphoneConfigFor('ws', 'u');
  expect(r).toEqual({ wssUrl: 'wss://x/ws', sipDomain: 'sip5.netsantral.com', dahili: '101', sipPassword: 'sip-pw', displayName: 'A B' });
});

it('webphoneConfigFor returns null when the rep has no dahili/secret or config inactive', async () => {
  const prisma = prismaMock();
  prisma.telephonyConfig.findUnique.mockResolvedValue({ workspaceId: 'ws', status: 'ACTIVE', wssUrl: 'wss://x/ws', sipDomain: 'd', trunk: '850', configSealed: 'sealed:{}' });
  prisma.marketingUser.findFirst.mockResolvedValue({ dahili: null, dahiliSecret: null, firstName: 'A', lastName: 'B' });
  expect(await new TelephonyConfigService(prisma).webphoneConfigFor('ws', 'u')).toBeNull();
});
```

Also extend `prismaMock()` (top of the spec) so `marketingUser` has `findFirst: jest.fn()` and `telephonyConfig.findUnique` defaults to `undefined`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx jest src/modules/marketing/telephony/telephony-config.service.spec.ts`
Expected: FAIL (new methods/fields not implemented).

- [ ] **Step 3: Implement**

In `UpsertTelephonyInput` add `wssUrl?: string; sipDomain?: string;`. In `upsert`, add to the `data` object: `wssUrl: dto.wssUrl ?? existing?.wssUrl ?? null,` and `sipDomain: dto.sipDomain ?? existing?.sipDomain ?? null,`. Add `wssUrl`/`sipDomain` to the `mask()` return.

Change `setDahili` signature + body to:
```typescript
  async setDahili(workspaceId: string, marketingUserId: string, dahili: string | null, sipPassword?: string) {
    const data: { dahili: string | null; dahiliSecret?: string | null } = { dahili: dahili?.trim() || null };
    if (sipPassword !== undefined) {
      if (sipPassword && !isSecretBoxConfigured()) {
        throw new ServiceUnavailableException('MARKETING_SECRET_KEY is not configured — cannot store the SIP password');
      }
      data.dahiliSecret = sipPassword ? sealSecret(sipPassword) : null;
    }
    const res = await this.prisma.marketingUser.updateMany({ where: { id: marketingUserId, workspaceId }, data });
    if (res.count === 0) throw new NotFoundException('User not found');
    return { ok: true };
  }
```

Add the new method:
```typescript
  /** Webphone config for the AUTHENTICATED rep's own dahili, or null. */
  async webphoneConfigFor(workspaceId: string, marketingUserId: string) {
    const c = await this.prisma.telephonyConfig.findUnique({ where: { workspaceId } });
    if (!c || c.status !== 'ACTIVE' || !c.wssUrl || !c.sipDomain || !isSecretBoxConfigured()) return null;
    const rep = await this.prisma.marketingUser.findFirst({
      where: { id: marketingUserId, workspaceId },
      select: { dahili: true, dahiliSecret: true, firstName: true, lastName: true },
    });
    if (!rep?.dahili || !rep?.dahiliSecret) return null;
    let sipPassword: string;
    try { sipPassword = openSecret(rep.dahiliSecret); } catch { return null; }
    return {
      wssUrl: c.wssUrl, sipDomain: c.sipDomain, dahili: rep.dahili,
      sipPassword, displayName: `${rep.firstName} ${rep.lastName}`.trim(),
    };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx jest src/modules/marketing/telephony/telephony-config.service.spec.ts`
Expected: PASS (existing + new).

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/marketing/telephony/telephony-config.service.ts backend/src/modules/marketing/telephony/telephony-config.service.spec.ts
git commit -m "feat(webphone): config service — wss/domain, sealed SIP password, webphoneConfigFor"
```

---

## Task 4: Controller — GET webphone-config (own rep) + wire setDahili sipPassword

**Files:**
- Modify: `backend/src/modules/marketing/controllers/telephony-config.controller.ts`

- [ ] **Step 1: Update the controller**

Add a SECOND controller class in the same file for the rep-self endpoint (no MANAGER/settings.manage gate — a rep reads their OWN webphone config), and pass `sipPassword` through `setDahili`. Replace the file with:

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
    return this.telephony.setDahili(a.workspaceId, id, dto.dahili ?? null, dto.sipPassword);
  }
}

/** Rep-self webphone config: any authenticated telephony user reads their OWN dahili creds. */
@MarketingRoute()
@Controller('marketing/telephony')
@UseGuards(MarketingGuard, FeatureGuard)
@RequiresFeature('telephony')
export class WebphoneConfigController {
  constructor(private readonly telephony: TelephonyConfigService) {}

  @Get('webphone-config')
  webphone(@CurrentMarketingUser() a: MarketingUserPayload) {
    return this.telephony.webphoneConfigFor(a.workspaceId, a.id);
  }
}
```

- [ ] **Step 2: Register the new controller**

In `backend/src/modules/marketing/marketing.module.ts`, update the telephony controller import to `import { TelephonyConfigController, WebphoneConfigController } from './controllers/telephony-config.controller';` and add `WebphoneConfigController` to the `controllers: [...]` array next to `TelephonyConfigController`.

- [ ] **Step 3: Type-check**

Run: `cd backend && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add backend/src/modules/marketing/controllers/telephony-config.controller.ts backend/src/modules/marketing/marketing.module.ts
git commit -m "feat(webphone): GET /telephony/webphone-config (rep-self) + setDahili sipPassword"
```

---

## Task 5: Frontend — add SIP.js

**Files:**
- Modify: `frontend/package.json`

- [ ] **Step 1: Install SIP.js**

Run: `cd frontend && npm install sip.js@0.21.2`
Expected: `sip.js` added to dependencies; lockfile updated.

- [ ] **Step 2: Commit**

```bash
git add frontend/package.json frontend/package-lock.json
git commit -m "feat(webphone): add sip.js dependency"
```

---

## Task 6: Frontend — webphone store (SIP.js SimpleUser)

**Files:**
- Create: `frontend/src/features/marketing/webphone/webphone.store.ts`
- Test: `frontend/src/features/marketing/webphone/webphone.store.test.ts`

- [ ] **Step 1: Write the failing test** (mock SIP.js `SimpleUser`)

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const connect = vi.fn().mockResolvedValue(undefined);
const register = vi.fn().mockResolvedValue(undefined);
const call = vi.fn().mockResolvedValue(undefined);
const hangup = vi.fn().mockResolvedValue(undefined);
let captured: any;
vi.mock('sip.js/lib/platform/web', () => ({
  SimpleUser: vi.fn().mockImplementation((server: string, opts: any) => {
    captured = { server, opts };
    return { connect, register, call, hangup, delegate: opts.delegate };
  }),
}));

import { createWebphone } from './webphone.store';

const cfg = { wssUrl: 'wss://sip5.netsantral.com:8089/ws', sipDomain: 'sip5.netsantral.com', dahili: '101', sipPassword: 'pw', displayName: 'A B' };

describe('webphone store', () => {
  beforeEach(() => { connect.mockClear(); register.mockClear(); call.mockClear(); hangup.mockClear(); });

  it('builds the SimpleUser with the right server, AOR and auth, and registers', async () => {
    const wp = createWebphone(document.createElement('audio'));
    await wp.start(cfg);
    expect(captured.server).toBe('wss://sip5.netsantral.com:8089/ws');
    expect(captured.opts.aor).toBe('sip:101@sip5.netsantral.com');
    expect(captured.opts.userAgentOptions.authorizationUsername).toBe('101');
    expect(captured.opts.userAgentOptions.authorizationPassword).toBe('pw');
    expect(connect).toHaveBeenCalled();
    expect(register).toHaveBeenCalled();
    expect(wp.getState().status).toBe('registered');
  });

  it('dials a number as a sip: target on the domain', async () => {
    const wp = createWebphone(document.createElement('audio'));
    await wp.start(cfg);
    await wp.call('+90 555 111 22 33');
    expect(call).toHaveBeenCalledWith('sip:905551112233@sip5.netsantral.com');
    expect(wp.getState().status).toBe('incall');
  });

  it('reports failed status when connect rejects', async () => {
    connect.mockRejectedValueOnce(new Error('boom'));
    const wp = createWebphone(document.createElement('audio'));
    await wp.start(cfg);
    expect(wp.getState().status).toBe('failed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/features/marketing/webphone/webphone.store.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```typescript
import { SimpleUser } from 'sip.js/lib/platform/web';

export type WebphoneStatus = 'idle' | 'registering' | 'registered' | 'incall' | 'failed';
export interface WebphoneConfig {
  wssUrl: string; sipDomain: string; dahili: string; sipPassword: string; displayName?: string;
}
export interface WebphoneState { status: WebphoneStatus; error?: string; lastNumber?: string }

/**
 * Thin wrapper over SIP.js SimpleUser: register a rep's dahili to NetGSM's WSS
 * WebRTC endpoint and place an outbound call. Phase A — register + outbound only;
 * inbound + full controls come in Phase B. `remoteAudio` is the <audio> element
 * SIP.js renders the remote stream into.
 */
export function createWebphone(remoteAudio: HTMLAudioElement) {
  let user: SimpleUser | null = null;
  let state: WebphoneState = { status: 'idle' };
  const listeners = new Set<(s: WebphoneState) => void>();
  const set = (s: Partial<WebphoneState>) => { state = { ...state, ...s }; listeners.forEach((l) => l(state)); };

  /** Turkish-friendly E.164-ish digit normalisation, then a sip: target. */
  const toTarget = (raw: string, domain: string) => `sip:${(raw ?? '').replace(/[^\d]/g, '')}@${domain}`;

  return {
    getState: () => state,
    subscribe(l: (s: WebphoneState) => void) { listeners.add(l); return () => listeners.delete(l); },

    async start(cfg: WebphoneConfig) {
      set({ status: 'registering', error: undefined });
      try {
        user = new SimpleUser(cfg.wssUrl, {
          aor: `sip:${cfg.dahili}@${cfg.sipDomain}`,
          media: { remote: { audio: remoteAudio } },
          userAgentOptions: {
            authorizationUsername: cfg.dahili,
            authorizationPassword: cfg.sipPassword,
            displayName: cfg.displayName,
          },
          delegate: {
            onCallHangup: () => set({ status: 'registered' }),
          },
        });
        await user.connect();
        await user.register();
        set({ status: 'registered' });
        (this as any)._domain = cfg.sipDomain;
      } catch (e: any) {
        set({ status: 'failed', error: e?.message ?? 'register failed' });
      }
    },

    async call(number: string) {
      if (!user) throw new Error('webphone not started');
      const domain = (this as any)._domain as string;
      await user.call(toTarget(number, domain));
      set({ status: 'incall', lastNumber: number });
    },

    async hangup() {
      if (user) await user.hangup();
      set({ status: 'registered' });
    },

    async stop() {
      try { await user?.unregister(); await user?.disconnect(); } catch { /* ignore */ }
      user = null; set({ status: 'idle' });
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/features/marketing/webphone/webphone.store.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/marketing/webphone/webphone.store.ts frontend/src/features/marketing/webphone/webphone.store.test.ts
git commit -m "feat(webphone): SIP.js webphone store (register + outbound call, Phase A)"
```

---

## Task 7: Frontend — minimal Test Webphone panel on the settings page

**Files:**
- Create: `frontend/src/features/marketing/webphone/TestWebphonePanel.tsx`
- Modify: `frontend/src/pages/marketing/TelephonySettingsPage.tsx`

- [ ] **Step 1: Implement the panel** (no new unit test — it's a thin UI over the tested store + an authenticated fetch; validated live in Task 8)

```tsx
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import marketingApi from '../api/marketingApi';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { createWebphone, type WebphoneState, type WebphoneConfig } from './webphone.store';

export default function TestWebphonePanel() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const wpRef = useRef<ReturnType<typeof createWebphone> | null>(null);
  const [state, setState] = useState<WebphoneState>({ status: 'idle' });
  const [number, setNumber] = useState('');

  const { data: cfg } = useQuery<WebphoneConfig | null>({
    queryKey: ['marketing', 'telephony', 'webphone-config'],
    queryFn: () => marketingApi.get('/telephony/webphone-config').then((r) => r.data),
  });

  useEffect(() => {
    if (!cfg || !audioRef.current || wpRef.current) return;
    const wp = createWebphone(audioRef.current);
    wpRef.current = wp;
    const unsub = wp.subscribe(setState);
    wp.start(cfg);
    return () => { unsub(); wp.stop(); wpRef.current = null; };
  }, [cfg]);

  if (!cfg) {
    return (
      <Card><CardContent className="p-5">
        <p className="text-caption text-muted-foreground">Webphone config yok — önce Netsantral creds + WSS adresi + bu kullanıcıya dahili/şifre atayın.</p>
      </CardContent></Card>
    );
  }

  return (
    <Card><CardContent className="p-5 space-y-3">
      <div className="flex items-center gap-2">
        <span className="font-medium">Test Webphone</span>
        <span className="text-caption text-muted-foreground">durum: {state.status}{state.error ? ` (${state.error})` : ''}</span>
      </div>
      <div className="flex items-center gap-2">
        <Input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="+90 5xx xxx xx xx" />
        <Button
          disabled={state.status !== 'registered' || !number.trim()}
          onClick={() => wpRef.current?.call(number).catch((e) => toast.error(e?.message ?? 'call failed'))}
        >Ara</Button>
        <Button variant="outline" disabled={state.status !== 'incall'} onClick={() => wpRef.current?.hangup()}>Kapat</Button>
      </div>
      <audio ref={audioRef} autoPlay />
    </CardContent></Card>
  );
}
```

- [ ] **Step 2: Mount it on the settings page**

In `frontend/src/pages/marketing/TelephonySettingsPage.tsx`, add `import TestWebphonePanel from '../../features/marketing/webphone/TestWebphonePanel';` and render `<TestWebphonePanel />` after the existing config `Card` (inside the page's root `<div className="space-y-6">`).

- [ ] **Step 3: Type-check + lint**

Run: `cd frontend && npx tsc --noEmit` (ignore the pre-existing `a11y.axe.test` errors) and `npx eslint src/features/marketing/webphone src/pages/marketing/TelephonySettingsPage.tsx --ext ts,tsx`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/features/marketing/webphone/TestWebphonePanel.tsx frontend/src/pages/marketing/TelephonySettingsPage.tsx
git commit -m "feat(webphone): minimal Test Webphone panel on the telephony settings page"
```

---

## Task 8: Live validation (manual — the actual de-risk)

**Not code.** After the above merges + a prod deploy (telephony migration auto-applies on deploy):

- [ ] **Step 1: Operator prep (NetGSM panel):** dahili `101` set to **WSS**; note its SIP password. In the app settings: save `wssUrl=wss://sip5.netsantral.com:8089/ws`, `sipDomain=sip5.netsantral.com`, trunk `8508407303`; assign the logged-in rep `dahili=101` + that SIP password.
- [ ] **Step 2:** Open the telephony settings page over the HTTPS app → grant mic → confirm the Test Webphone shows **durum: registered**.
- [ ] **Step 3:** Enter your own mobile → **Ara** → confirm: phone rings, **caller id = 0850**, two-way audio.
- [ ] **Step 4 (if registered but no audio):** ICE/media is blocked → NetGSM TURN needed. Email `teknikdestek@netgsm.com.tr` for TURN/STUN server details; add them to `userAgentOptions.sessionDescriptionHandlerOptionsReconfigure`/`iceServers` (Phase B follow-up).

**Phase A is proven when Step 3 succeeds.** Then proceed to Phase B (full dock + inbound + click-to-call + SalesCall logging) as a separate spec→plan.

---

## Done criteria (Phase A)
- Backend: `wssUrl`/`sipDomain` stored; per-rep SIP password sealed; `GET /telephony/webphone-config` returns the rep's own creds (telephony-gated); all unit tests green; `tsc` clean.
- Frontend: SIP.js store registers + dials (unit-tested with mock); Test Webphone panel renders + drives the store; `tsc`/`eslint` clean.
- Live: webphone registers to NetGSM WSS and an outbound call connects with audio from the HTTPS app (the de-risk).
