import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { SalesCallService } from './sales-call.service';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';
import { verifyRecordingProxyToken } from '../telephony/recording-proxy-token.util';

describe('SalesCallService', () => {
  let prisma: MockPrismaClient;
  let registry: { get: jest.Mock };
  let outbox: { append: jest.Mock };
  let telephonyConfig: { resolveForWorkspace: jest.Mock };
  let provider: any;
  let liteProvider: any;
  let svc: SalesCallService;

  const WS = 'ws-1';
  const REP = 'rep-1';

  beforeAll(() => {
    // getRecordingUrl mints an HMAC proxy token (fix round 1) — needs a key.
    process.env.MARKETING_SECRET_KEY = Buffer.from('k'.repeat(32)).toString('base64');
  });
  afterAll(() => {
    delete process.env.MARKETING_SECRET_KEY;
  });

  beforeEach(() => {
    prisma = mockPrismaClient();
    provider = {
      id: 'netgsm-lite',
      maxConcurrentCalls: 1,
      prepareOutboundCall: jest.fn().mockResolvedValue({
        providerId: 'netgsm-lite',
        dialUri: 'tel:+905551234567',
        mode: 'click-to-dial',
        externalCallId: null,
      }),
    };
    liteProvider = provider;
    registry = { get: jest.fn().mockReturnValue(provider) };
    outbox = { append: jest.fn().mockResolvedValue('ob') };
    telephonyConfig = { resolveForWorkspace: jest.fn().mockResolvedValue(null) };
    svc = new SalesCallService(prisma as any, registry as any, outbox as any, telephonyConfig as any);

    // Support both $transaction(callback) and $transaction([...]) forms.
    (prisma.$transaction as any).mockImplementation(async (arg: any) =>
      typeof arg === 'function' ? arg(prisma) : Promise.all(arg),
    );
    prisma.salesCall.findMany.mockResolvedValue([]); // no active calls by default
    prisma.salesCall.create.mockResolvedValue({ id: 'call-1', status: 'INITIATED' } as any);
    prisma.salesCall.update = jest.fn().mockResolvedValue({}) as any;
    prisma.marketingUser.findFirst.mockResolvedValue(null); // no dahili by default
  });

  describe('startCall', () => {
    it('reserves the line and returns a click-to-dial URI (row born workspace-scoped)', async () => {
      const res = await svc.startCall(WS, REP, { toPhone: '05551234567' } as any);
      expect(res.dialUri).toBe('tel:+905551234567');
      expect(res.mode).toBe('click-to-dial');
      // Line-occupancy check is scoped to the workspace.
      expect(prisma.salesCall.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { workspaceId: WS, status: 'INITIATED' } }),
      );
      expect(prisma.salesCall.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            workspaceId: WS,
            marketingUserId: REP,
            status: 'INITIATED',
            providerId: 'netgsm-lite',
            direction: 'OUTBOUND',
          }),
        }),
      );
    });

    it('rejects when the single line is busy (a fresh INITIATED call exists)', async () => {
      prisma.salesCall.findMany.mockResolvedValue([{ id: 'c0', startedAt: new Date() }] as any);
      await expect(
        svc.startCall(WS, REP, { toPhone: '05551234567' } as any),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.salesCall.create).not.toHaveBeenCalled();
    });

    it('auto-cancels a stale INITIATED call and proceeds', async () => {
      prisma.salesCall.findMany.mockResolvedValue([
        { id: 'c-stale', startedAt: new Date(Date.now() - 60 * 60 * 1000) },
      ] as any);
      prisma.salesCall.updateMany.mockResolvedValue({ count: 1 } as any);

      await svc.startCall(WS, REP, { toPhone: '05551234567' } as any);

      expect(prisma.salesCall.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['c-stale'] }, workspaceId: WS },
          data: expect.objectContaining({ status: 'CANCELLED' }),
        }),
      );
      expect(prisma.salesCall.create).toHaveBeenCalled();
    });

    // ── Per-rep concurrency (NetGSM Phase 3 Task 6) ─────────────────────────
    describe('concurrency scope', () => {
      it('netsantral (maxConcurrentCalls>1): rep A already has an INITIATED call, but rep B can still dial — the occupancy check is scoped to THIS rep, not the whole workspace', async () => {
        const apiProvider = {
          id: 'netgsm-netsantral',
          maxConcurrentCalls: 50,
          prepareOutboundCall: jest.fn().mockResolvedValue({ providerId: 'netgsm-netsantral', dialUri: '', mode: 'api', externalCallId: null }),
        };
        registry.get.mockReturnValue(apiProvider);
        prisma.marketingUser.findFirst.mockResolvedValue({ dahili: null, phone: null } as any);
        telephonyConfig.resolveForWorkspace.mockResolvedValue(null);
        // Rep B's own occupancy query comes back empty — rep A's busy call is
        // irrelevant to it (a real Prisma `where: {marketingUserId: repB}`
        // would never return rep A's row; the mock just simulates that).
        prisma.salesCall.findMany.mockResolvedValue([]);
        prisma.salesCall.create.mockResolvedValue({ id: 'call-repB' } as any);

        await svc.startCall(WS, 'rep-B', { toPhone: '05551234567' } as any);

        expect(prisma.salesCall.findMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: { workspaceId: WS, marketingUserId: 'rep-B', status: 'INITIATED' } }),
        );
        expect(apiProvider.prepareOutboundCall).toHaveBeenCalled();
      });

      it("netsantral: THIS rep is already AT their own cap -> rejects with the per-rep message (a multi-line provider's cap is still enforceable per rep, just at a higher number)", async () => {
        // A synthetic cap of 2 makes "at capacity" reachable in a unit test;
        // the real netsantral value (50) exercises the exact same `perRep`
        // branch — see the "rep A busy, rep B unaffected" test above for that.
        const apiProvider = { id: 'netgsm-netsantral', maxConcurrentCalls: 2, prepareOutboundCall: jest.fn() };
        registry.get.mockReturnValue(apiProvider);
        prisma.marketingUser.findFirst.mockResolvedValue({ dahili: null, phone: null } as any);
        telephonyConfig.resolveForWorkspace.mockResolvedValue(null);
        prisma.salesCall.findMany.mockResolvedValue([
          { id: 'c-own-1', startedAt: new Date() },
          { id: 'c-own-2', startedAt: new Date() },
        ] as any);

        await expect(svc.startCall(WS, REP, { toPhone: '05551234567' } as any)).rejects.toMatchObject({
          message: expect.stringContaining('You already have an active call'),
        });
        expect(apiProvider.prepareOutboundCall).not.toHaveBeenCalled();
      });

      it('lite (maxConcurrentCalls===1): stays scoped to the whole WORKSPACE — one rep busy still blocks another', async () => {
        // Default beforeEach provider is already `netgsm-lite` maxConcurrentCalls:1.
        prisma.salesCall.findMany.mockResolvedValue([{ id: 'c-other-rep', startedAt: new Date() }] as any);

        await expect(svc.startCall(WS, 'rep-other', { toPhone: '05551234567' } as any)).rejects.toBeInstanceOf(ConflictException);
        expect(prisma.salesCall.findMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: { workspaceId: WS, status: 'INITIATED' } }),
        );
      });

      it('per-rep stale-cancel sweep is scoped the same way as the occupancy check', async () => {
        const apiProvider = {
          id: 'netgsm-netsantral',
          maxConcurrentCalls: 50,
          prepareOutboundCall: jest.fn().mockResolvedValue({ providerId: 'netgsm-netsantral', dialUri: '', mode: 'api', externalCallId: null }),
        };
        registry.get.mockReturnValue(apiProvider);
        prisma.marketingUser.findFirst.mockResolvedValue({ dahili: null, phone: null } as any);
        telephonyConfig.resolveForWorkspace.mockResolvedValue(null);
        prisma.salesCall.findMany.mockResolvedValue([
          { id: 'c-stale-rep', startedAt: new Date(Date.now() - 60 * 60 * 1000) },
        ] as any);
        prisma.salesCall.updateMany.mockResolvedValue({ count: 1 } as any);
        prisma.salesCall.create.mockResolvedValue({ id: 'call-new' } as any);

        await svc.startCall(WS, REP, { toPhone: '05551234567' } as any);

        expect(prisma.salesCall.findMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: { workspaceId: WS, marketingUserId: REP, status: 'INITIATED' } }),
        );
        expect(prisma.salesCall.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: { id: { in: ['c-stale-rep'] }, workspaceId: WS } }),
        );
      });
    });

    it('rejects when the linked lead does not exist in the workspace', async () => {
      prisma.lead.findFirst.mockResolvedValue(null);
      await expect(
        svc.startCall(WS, REP, { toPhone: '05551234567', leadId: 'lead-x' } as any),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.lead.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'lead-x', workspaceId: WS } }),
      );
    });

    it('uses netgsm-netsantral with resolved config when the workspace has an ACTIVE config', async () => {
      const apiProvider = { id: 'netgsm-netsantral', maxConcurrentCalls: 50, prepareOutboundCall: jest.fn().mockResolvedValue({ providerId: 'netgsm-netsantral', dialUri: '', mode: 'api', externalCallId: 'u-1' }) };
      registry.get.mockImplementation((id: string) => (id === 'netgsm-netsantral' ? apiProvider : liteProvider));
      // FIX 8: dahili is fetched first, then resolveForWorkspace only when dahili is set
      prisma.marketingUser.findFirst.mockResolvedValue({ dahili: '104' } as any);
      telephonyConfig.resolveForWorkspace.mockResolvedValue({ username: '850', password: 'pw', trunk: '8508407303' });
      prisma.salesCall.findMany.mockResolvedValue([]);
      prisma.salesCall.create.mockResolvedValue({ id: 'call-1' } as any);
      await svc.startCall('ws', 'rep-1', { toPhone: '5551112233' } as any);
      expect(apiProvider.prepareOutboundCall).toHaveBeenCalledWith(expect.objectContaining({
        config: expect.objectContaining({ internalNum: '104', trunk: '8508407303' }),
      }));
    });

    it('falls back to netgsm-lite click-to-dial when no telephony config', async () => {
      registry.get.mockReturnValue(liteProvider);
      // rep has no dahili → resolveForWorkspace is never called
      prisma.marketingUser.findFirst.mockResolvedValue({ dahili: null } as any);
      telephonyConfig.resolveForWorkspace.mockResolvedValue(null);
      prisma.salesCall.findMany.mockResolvedValue([]);
      prisma.salesCall.create.mockResolvedValue({ id: 'call-2' } as any);
      await svc.startCall('ws', 'rep-1', { toPhone: '5551112233' } as any);
      expect(liteProvider.prepareOutboundCall).toHaveBeenCalled();
    });

    it('marks the SalesCall CANCELLED when origination throws', async () => {
      const apiProvider = {
        id: 'netgsm-netsantral',
        maxConcurrentCalls: 50,
        prepareOutboundCall: jest.fn().mockRejectedValue(new Error('network error')),
      };
      registry.get.mockImplementation((id: string) => (id === 'netgsm-netsantral' ? apiProvider : liteProvider));
      prisma.marketingUser.findFirst.mockResolvedValue({ dahili: '104' } as any);
      telephonyConfig.resolveForWorkspace.mockResolvedValue({ username: '850', password: 'pw', trunk: '8508407303' });
      prisma.salesCall.findMany.mockResolvedValue([]);
      prisma.salesCall.create.mockResolvedValue({ id: 'call-99' } as any);

      await expect(svc.startCall('ws', 'rep-1', { toPhone: '5551112233' } as any)).rejects.toThrow('network error');
      expect(prisma.salesCall.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'call-99' },
        data: expect.objectContaining({ status: 'CANCELLED' }),
      }));
    });
  });

  describe('logCall', () => {
    it('still-INITIATED path (unchanged): applies the manual status+duration+endedAt, mirrors a CALL activity, sets outcomeLoggedAt, and emits the event', async () => {
      prisma.salesCall.findFirst.mockResolvedValue({
        id: 'call-1',
        workspaceId: WS,
        marketingUserId: REP,
        status: 'INITIATED',
        leadId: 'lead-1',
      } as any);
      // logCall now claims the row atomically scoped to outcomeLoggedAt (NOT
      // status) then re-reads it, so a concurrent duplicate can't double-mirror.
      prisma.salesCall.updateMany.mockResolvedValue({ count: 1 } as any);
      prisma.salesCall.findUniqueOrThrow.mockResolvedValue({ id: 'call-1', status: 'CONNECTED', durationSec: 120 } as any);

      await svc.logCall(WS, 'call-1', REP, {
        status: 'CONNECTED',
        durationSec: 120,
        notes: 'good chat',
      } as any);

      // The call row is resolved through a workspace-scoped read.
      expect(prisma.salesCall.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'call-1', workspaceId: WS } }),
      );
      expect(prisma.salesCall.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'call-1', workspaceId: WS, outcomeLoggedAt: null },
          data: expect.objectContaining({
            status: 'CONNECTED',
            durationSec: 120,
            endedAt: expect.any(Date),
            outcomeLoggedAt: expect.any(Date),
          }),
        }),
      );
      expect(prisma.leadActivity.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: 'CALL',
            leadId: 'lead-1',
            outcome: 'POSITIVE',
            duration: 2, // 120s → 2 min
            createdById: REP,
          }),
        }),
      );
      expect(outbox.append.mock.calls[0][0]).toMatchObject({
        type: 'marketing.call.logged.v1',
        idempotencyKey: 'call-logged:call-1',
        payload: expect.objectContaining({ callId: 'call-1', status: 'CONNECTED', durationSec: 120 }),
      });
    });

    it("rejects logging another rep's call", async () => {
      prisma.salesCall.findFirst.mockResolvedValue({
        id: 'call-1',
        workspaceId: WS,
        marketingUserId: 'other',
        status: 'INITIATED',
        leadId: null,
      } as any);
      await expect(
        svc.logCall(WS, 'call-1', REP, { status: 'CONNECTED' } as any),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    // ── HIGH-2 fix: merge onto a webhook-finalized row instead of 409ing ──
    it('merges onto a webhook-finalized CONNECTED row: keeps the webhook status/duration as ground truth, attaches notes, sets outcomeLoggedAt, mirrors + emits using the REAL row', async () => {
      prisma.salesCall.findFirst.mockResolvedValue({
        id: 'call-1',
        workspaceId: WS,
        marketingUserId: REP,
        status: 'CONNECTED', // TelephonyEventConsumer already finalized this
        leadId: 'lead-1',
      } as any);
      prisma.salesCall.updateMany.mockResolvedValue({ count: 1 } as any); // outcomeLoggedAt was null -> claimed
      prisma.salesCall.findUniqueOrThrow.mockResolvedValue({ id: 'call-1', status: 'CONNECTED', durationSec: 87 } as any);

      await svc.logCall(WS, 'call-1', REP, {
        status: 'NO_ANSWER', // the rep's guess — must NOT be applied
        durationSec: 999, // ditto
        notes: 'customer wants a callback',
      } as any);

      expect(prisma.salesCall.updateMany).toHaveBeenCalledWith({
        where: { id: 'call-1', workspaceId: WS, outcomeLoggedAt: null },
        data: { notes: 'customer wants a callback', outcomeLoggedAt: expect.any(Date) },
      });
      // Mirror + outbox reflect the REAL (webhook) row, not the rep's dto.
      expect(prisma.leadActivity.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            title: 'Sales call: CONNECTED',
            outcome: 'POSITIVE',
            duration: 1, // 87s -> round(1.45) = 1 min
          }),
        }),
      );
      expect(outbox.append.mock.calls[0][0]).toMatchObject({
        type: 'marketing.call.logged.v1',
        payload: expect.objectContaining({ callId: 'call-1', status: 'CONNECTED', durationSec: 87 }),
      });
    });

    it('a SECOND logCall on an already manually-logged row rejects with Conflict (outcomeLoggedAt claim loses)', async () => {
      prisma.salesCall.findFirst.mockResolvedValue({
        id: 'call-1',
        workspaceId: WS,
        marketingUserId: REP,
        status: 'CONNECTED',
        leadId: null,
      } as any);
      prisma.salesCall.updateMany.mockResolvedValue({ count: 0 } as any); // outcomeLoggedAt already non-null

      await expect(
        svc.logCall(WS, 'call-1', REP, { status: 'NO_ANSWER' } as any),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.leadActivity.create).not.toHaveBeenCalled();
    });

    it('rejects logging a CANCELLED call outright (pre-check — never even attempts the atomic claim)', async () => {
      prisma.salesCall.findFirst.mockResolvedValue({
        id: 'call-1',
        workspaceId: WS,
        marketingUserId: REP,
        status: 'CANCELLED', // startCall's own stale-sweep/origination-failure path
        leadId: null,
      } as any);
      await expect(
        svc.logCall(WS, 'call-1', REP, { status: 'NO_ANSWER' } as any),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.salesCall.updateMany).not.toHaveBeenCalled();
    });

    it('404s a call from another workspace (scoped lookup misses)', async () => {
      prisma.salesCall.findFirst.mockResolvedValue(null);
      await expect(
        svc.logCall(WS, 'call-1', REP, { status: 'CONNECTED' } as any),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('list', () => {
    it('scopes a REP to their own calls within the workspace', async () => {
      prisma.salesCall.findMany.mockResolvedValue([]);
      prisma.salesCall.count.mockResolvedValue(0);
      await svc.list(WS, {} as any, { id: REP, role: 'REP' } as any);
      expect(prisma.salesCall.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { workspaceId: WS, marketingUserId: REP } }),
      );
    });
  });

  // NetGSM Phase 4 Task 3 — in-app recording player URL resolution.
  // Fix round 1 (HIGH privacy finding): an R2-stored recording no longer
  // resolves to R2's public, no-auth, no-TTL URL — it resolves to OUR OWN
  // tokened proxy route instead, so the public bucket URL never reaches the
  // browser.
  describe('getRecordingUrl', () => {
    const MANAGER = { id: 'mgr-1', role: 'MANAGER' } as any;

    it('returns a tokened proxy-route url (never the public R2 url) when the recording is R2-stored', async () => {
      prisma.salesCall.findFirst.mockResolvedValue({
        id: 'call-1',
        workspaceId: WS,
        marketingUserId: REP,
        recordingStorageKey: 'netgsm-recordings/ws-1/call-1.mp3',
        recordingUrl: 'https://netgsm.example.com/token/abc',
      });

      const res = await svc.getRecordingUrl(WS, 'call-1', MANAGER);

      // Shape: <base>/api/public/telephony/recording/<ws>/<callId>/<token>
      // (base is empty here — PUBLIC_BASE_URL is unset in this test env —
      // so the url is root-relative; that's fine, see recordingProxyUrl's
      // own unit coverage for the base-URL-present case).
      const match = res.url.match(/^\/api\/public\/telephony\/recording\/ws-1\/call-1\/(.+)$/);
      expect(match).not.toBeNull();
      const token = match![1];
      expect(verifyRecordingProxyToken(WS, 'call-1', token)).toBe(true);
      // Never the raw provider url, and never a public R2/cdn url.
      expect(res.url).not.toContain('netgsm.example.com');
      expect(res.url).not.toContain('cdn.example.com');
    });

    it('falls back to the provider url when no storage key has been ingested yet', async () => {
      prisma.salesCall.findFirst.mockResolvedValue({
        id: 'call-1',
        workspaceId: WS,
        marketingUserId: REP,
        recordingStorageKey: null,
        recordingUrl: 'https://netgsm.example.com/token/abc',
      });

      const res = await svc.getRecordingUrl(WS, 'call-1', MANAGER);

      expect(res).toEqual({ url: 'https://netgsm.example.com/token/abc' });
    });

    it('404s a call from another workspace (scoped lookup misses)', async () => {
      prisma.salesCall.findFirst.mockResolvedValue(null);
      await expect(svc.getRecordingUrl(WS, 'call-1', MANAGER)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('404s when neither a storage key nor a provider url exists', async () => {
      prisma.salesCall.findFirst.mockResolvedValue({
        id: 'call-1',
        workspaceId: WS,
        marketingUserId: REP,
        recordingStorageKey: null,
        recordingUrl: null,
      });

      await expect(svc.getRecordingUrl(WS, 'call-1', MANAGER)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("forbids a REP from reading a teammate's call recording", async () => {
      prisma.salesCall.findFirst.mockResolvedValue({
        id: 'call-1',
        workspaceId: WS,
        marketingUserId: 'someone-else',
        recordingStorageKey: 'netgsm-recordings/ws-1/call-1.mp3',
        recordingUrl: null,
      });

      await expect(
        svc.getRecordingUrl(WS, 'call-1', { id: REP, role: 'REP' } as any),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
