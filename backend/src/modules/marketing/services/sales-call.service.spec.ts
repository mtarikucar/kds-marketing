import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { SalesCallService } from './sales-call.service';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';

describe('SalesCallService', () => {
  let prisma: MockPrismaClient;
  let registry: { get: jest.Mock };
  let outbox: { append: jest.Mock };
  let config: { get: jest.Mock };
  let provider: any;
  let svc: SalesCallService;

  const WS = 'ws-1';
  const REP = 'rep-1';

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
    registry = { get: jest.fn().mockReturnValue(provider) };
    outbox = { append: jest.fn().mockResolvedValue('ob') };
    config = { get: jest.fn().mockReturnValue(undefined) };
    svc = new SalesCallService(prisma as any, registry as any, outbox as any, config as any);

    // Support both $transaction(callback) and $transaction([...]) forms.
    (prisma.$transaction as any).mockImplementation(async (arg: any) =>
      typeof arg === 'function' ? arg(prisma) : Promise.all(arg),
    );
    prisma.salesCall.findMany.mockResolvedValue([]); // no active calls by default
    prisma.salesCall.create.mockResolvedValue({ id: 'call-1', status: 'INITIATED' } as any);
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

    it('rejects when the linked lead does not exist in the workspace', async () => {
      prisma.lead.findFirst.mockResolvedValue(null);
      await expect(
        svc.startCall(WS, REP, { toPhone: '05551234567', leadId: 'lead-x' } as any),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.lead.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'lead-x', workspaceId: WS } }),
      );
    });
  });

  describe('logCall', () => {
    it('records the outcome, mirrors a CALL activity onto the lead, and emits the event', async () => {
      prisma.salesCall.findFirst.mockResolvedValue({
        id: 'call-1',
        workspaceId: WS,
        marketingUserId: REP,
        status: 'INITIATED',
        leadId: 'lead-1',
      } as any);
      // logCall now claims the row atomically (updateMany WHERE status=INITIATED)
      // then re-reads it, so a concurrent duplicate can't double-mirror.
      prisma.salesCall.updateMany.mockResolvedValue({ count: 1 } as any);
      prisma.salesCall.findUniqueOrThrow.mockResolvedValue({ id: 'call-1', status: 'CONNECTED' } as any);

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
          where: { id: 'call-1', workspaceId: WS, status: 'INITIATED' },
          data: expect.objectContaining({ status: 'CONNECTED', durationSec: 120, endedAt: expect.any(Date) }),
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

    it('rejects logging an already-logged call', async () => {
      prisma.salesCall.findFirst.mockResolvedValue({
        id: 'call-1',
        workspaceId: WS,
        marketingUserId: REP,
        status: 'CONNECTED',
        leadId: null,
      } as any);
      await expect(
        svc.logCall(WS, 'call-1', REP, { status: 'NO_ANSWER' } as any),
      ).rejects.toBeInstanceOf(ConflictException);
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
});
