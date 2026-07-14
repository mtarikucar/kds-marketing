import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DialerService } from './dialer.service';
import { mockPrismaClient } from '../../../common/test/prisma-mock.service';

const WS = 'ws-1';
const USER = 'rep-1';

function makeSvc() {
  const prisma = mockPrismaClient();
  const salesCalls = { startCall: jest.fn(), logCall: jest.fn() };
  return { prisma, salesCalls, svc: new DialerService(prisma as any, salesCalls as any) };
}

describe('DialerService', () => {
  describe('createSession', () => {
    it('rejects when no callable leads match', async () => {
      const { prisma, svc } = makeSvc();
      prisma.lead.findMany.mockResolvedValue([] as any);
      await expect(svc.createSession(WS, USER, 'MANAGER', {})).rejects.toBeInstanceOf(BadRequestException);
    });

    it('queues callable leads (phone present, scoped) and seeds items in order', async () => {
      const { prisma, svc } = makeSvc();
      prisma.lead.findMany.mockResolvedValue([{ id: 'l1' }, { id: 'l2' }] as any);
      (prisma.dialSession.create as jest.Mock).mockResolvedValue({ id: 'sess-1' });
      // getSession reads back
      prisma.dialSession.findFirst.mockResolvedValue({ id: 'sess-1', status: 'ACTIVE', currentIndex: 0, total: 2 } as any);
      prisma.dialSessionItem.findFirst.mockResolvedValue({ id: 'it-0', callId: null, position: 0, leadId: 'l1' } as any);
      prisma.lead.findFirst.mockResolvedValue({ id: 'l1', businessName: 'A', phone: '+90555', contactPerson: null, status: 'NEW', city: null } as any);
      (prisma.dialSessionItem.count as jest.Mock).mockResolvedValue(0);
      const out: any = await svc.createSession(WS, USER, 'MANAGER', { status: 'NEW' });
      // leads query is workspace-scoped, requires a phone, excludes deleted/merged
      const where = prisma.lead.findMany.mock.calls[0][0].where;
      expect(where).toMatchObject({ workspaceId: WS, status: 'NEW', deletedAt: null, mergedIntoId: null });
      expect(where.phone).toEqual({ not: null });
      expect(out).toMatchObject({ id: 'sess-1', total: 2, currentIndex: 0 });
      expect(out.current.lead.id).toBe('l1');
    });

    it('clamps a REP to their own assigned leads', async () => {
      const { prisma, svc } = makeSvc();
      prisma.lead.findMany.mockResolvedValue([{ id: 'l1' }] as any);
      (prisma.dialSession.create as jest.Mock).mockResolvedValue({ id: 'sess-1' });
      prisma.dialSession.findFirst.mockResolvedValue({ id: 'sess-1', status: 'ACTIVE', currentIndex: 0, total: 1 } as any);
      prisma.dialSessionItem.findFirst.mockResolvedValue(null as any);
      (prisma.dialSessionItem.count as jest.Mock).mockResolvedValue(0);
      await svc.createSession(WS, USER, 'REP', { assignedToId: 'someone-else' });
      // the REP clamp overrides any passed assignedToId
      expect(prisma.lead.findMany.mock.calls[0][0].where.assignedToId).toBe(USER);
    });
  });

  describe('dial', () => {
    it('404s a session that is not the rep\'s own', async () => {
      const { prisma, svc } = makeSvc();
      prisma.dialSession.findFirst.mockResolvedValue(null as any);
      await expect(svc.dial(WS, 'sess-x', USER)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('click-to-dials the current lead and records the call id on the item', async () => {
      const { prisma, salesCalls, svc } = makeSvc();
      prisma.dialSession.findFirst.mockResolvedValue({ id: 'sess-1', status: 'ACTIVE', currentIndex: 0, total: 2 } as any);
      prisma.dialSessionItem.findFirst.mockResolvedValue({ id: 'it-0', callId: null, position: 0, leadId: 'l1' } as any);
      prisma.lead.findFirst.mockResolvedValue({ id: 'l1', phone: '+90555', businessName: 'A', contactPerson: null, status: 'NEW', city: null } as any);
      salesCalls.startCall.mockResolvedValue({ call: { id: 'call-1' }, dialUri: 'tel:+90555', mode: 'softphone' });
      (prisma.dialSessionItem.update as jest.Mock).mockResolvedValue({});
      const out: any = await svc.dial(WS, 'sess-1', USER);
      expect(salesCalls.startCall).toHaveBeenCalledWith(WS, USER, { toPhone: '+90555', leadId: 'l1' });
      expect(out.dialUri).toBe('tel:+90555');
      expect(prisma.dialSessionItem.update.mock.calls[0][0]).toMatchObject({ where: { id: 'it-0' }, data: { callId: 'call-1' } });
    });
  });

  describe('logOutcome', () => {
    it('atomically claims the item, logs the call (mirrors timeline) and CAS-advances', async () => {
      const { prisma, salesCalls, svc } = makeSvc();
      prisma.dialSession.findFirst.mockResolvedValue({ id: 'sess-1', status: 'ACTIVE', currentIndex: 0, total: 2 } as any);
      prisma.dialSessionItem.findFirst.mockResolvedValue({ id: 'it-0', callId: 'call-1', position: 0, leadId: 'l1' } as any);
      prisma.lead.findFirst.mockResolvedValue({ id: 'l1', phone: '+90555', businessName: 'A', contactPerson: null, status: 'NEW', city: null } as any);
      salesCalls.logCall.mockResolvedValue({});
      (prisma.dialSessionItem.updateMany as jest.Mock).mockResolvedValue({ count: 1 }); // claim wins
      (prisma.dialSession.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.dialSessionItem.count as jest.Mock).mockResolvedValue(1);
      await svc.logOutcome(WS, 'sess-1', USER, { status: 'CONNECTED', durationSec: 60 });
      expect(salesCalls.logCall).toHaveBeenCalledWith(WS, 'call-1', USER, { status: 'CONNECTED', durationSec: 60, notes: undefined });
      // item claim is keyed on outcome:null (idempotency gate), scoped
      expect((prisma.dialSessionItem.updateMany as jest.Mock).mock.calls[0][0].where).toEqual({ id: 'it-0', workspaceId: WS, outcome: null });
      // advance is a CAS keyed on the expected currentIndex
      const adv = (prisma.dialSession.updateMany as jest.Mock).mock.calls[0][0];
      expect(adv.where).toMatchObject({ id: 'sess-1', status: 'ACTIVE', currentIndex: 0 });
      expect(adv.data.currentIndex).toBe(1);
    });

    it('idempotent: a second log whose item is already claimed does not re-log, and the CAS-advance no-ops', async () => {
      const { prisma, salesCalls, svc } = makeSvc();
      prisma.dialSession.findFirst.mockResolvedValue({ id: 'sess-1', status: 'ACTIVE', currentIndex: 0, total: 2 } as any);
      prisma.dialSessionItem.findFirst.mockResolvedValue({ id: 'it-0', callId: 'call-1', position: 0, leadId: 'l1' } as any);
      prisma.lead.findFirst.mockResolvedValue({ id: 'l1', phone: '+90', businessName: 'A', contactPerson: null, status: 'NEW', city: null } as any);
      (prisma.dialSessionItem.updateMany as jest.Mock).mockResolvedValue({ count: 0 }); // already claimed
      (prisma.dialSession.updateMany as jest.Mock).mockResolvedValue({ count: 0 }); // CAS no-ops (index already moved)
      (prisma.dialSessionItem.count as jest.Mock).mockResolvedValue(1);
      await svc.logOutcome(WS, 'sess-1', USER, { status: 'CONNECTED' });
      expect(salesCalls.logCall).not.toHaveBeenCalled(); // not re-logged
      // the self-heal advance is a CAS guarded on currentIndex — it can't double-advance
      const adv = (prisma.dialSession.updateMany as jest.Mock).mock.calls[0][0];
      expect(adv.where).toMatchObject({ id: 'sess-1', status: 'ACTIVE', currentIndex: 0 });
    });

    it('marks the session DONE when the last lead is logged', async () => {
      const { prisma, salesCalls, svc } = makeSvc();
      prisma.dialSession.findFirst.mockResolvedValue({ id: 'sess-1', status: 'ACTIVE', currentIndex: 1, total: 2 } as any);
      prisma.dialSessionItem.findFirst.mockResolvedValue({ id: 'it-1', callId: 'call-2', position: 1, leadId: 'l2' } as any);
      prisma.lead.findFirst.mockResolvedValue({ id: 'l2', phone: '+90', businessName: 'B', contactPerson: null, status: 'NEW', city: null } as any);
      salesCalls.logCall.mockResolvedValue({});
      (prisma.dialSessionItem.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.dialSession.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.dialSessionItem.count as jest.Mock).mockResolvedValue(2);
      await svc.logOutcome(WS, 'sess-1', USER, { status: 'NO_ANSWER' });
      expect((prisma.dialSession.updateMany as jest.Mock).mock.calls[0][0].data).toMatchObject({ currentIndex: 2, status: 'DONE' });
    });

    it('rejects logging on a terminal (CANCELLED) session', async () => {
      const { prisma, svc } = makeSvc();
      prisma.dialSession.findFirst.mockResolvedValue({ id: 'sess-1', status: 'CANCELLED', currentIndex: 0, total: 2 } as any);
      await expect(svc.logOutcome(WS, 'sess-1', USER, { status: 'CONNECTED' })).rejects.toThrow(/not active/i);
    });
  });

  describe('skip', () => {
    it('claims the item SKIPPED and advances without dialing', async () => {
      const { prisma, salesCalls, svc } = makeSvc();
      prisma.dialSession.findFirst.mockResolvedValue({ id: 'sess-1', status: 'ACTIVE', currentIndex: 0, total: 2 } as any);
      prisma.dialSessionItem.findFirst.mockResolvedValue({ id: 'it-0', callId: null, position: 0, leadId: 'l1' } as any);
      prisma.lead.findFirst.mockResolvedValue({ id: 'l1', phone: '+90', businessName: 'A', contactPerson: null, status: 'NEW', city: null } as any);
      (prisma.dialSessionItem.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.dialSession.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.dialSessionItem.count as jest.Mock).mockResolvedValue(1);
      await svc.skip(WS, 'sess-1', USER);
      expect(salesCalls.logCall).not.toHaveBeenCalled();
      expect((prisma.dialSessionItem.updateMany as jest.Mock).mock.calls[0][0].data).toEqual({ outcome: 'SKIPPED' });
    });

    it('rejects skip on a terminal session (no cursor mutation)', async () => {
      const { prisma, svc } = makeSvc();
      prisma.dialSession.findFirst.mockResolvedValue({ id: 'sess-1', status: 'DONE', currentIndex: 2, total: 2 } as any);
      await expect(svc.skip(WS, 'sess-1', USER)).rejects.toThrow(/not active/i);
      expect(prisma.dialSession.updateMany).not.toHaveBeenCalled();
    });

    it('skipping an already-DIALED lead cancels the linked call (frees the single line)', async () => {
      const { prisma, salesCalls, svc } = makeSvc();
      prisma.dialSession.findFirst.mockResolvedValue({ id: 'sess-1', status: 'ACTIVE', currentIndex: 0, total: 2 } as any);
      prisma.dialSessionItem.findFirst.mockResolvedValue({ id: 'it-0', callId: 'call-1', position: 0, leadId: 'l1' } as any);
      prisma.lead.findFirst.mockResolvedValue({ id: 'l1', phone: '+90', businessName: 'A', contactPerson: null, status: 'NEW', city: null } as any);
      (prisma.dialSessionItem.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.dialSession.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.dialSessionItem.count as jest.Mock).mockResolvedValue(1);
      salesCalls.logCall.mockResolvedValue({});
      await svc.skip(WS, 'sess-1', USER);
      // Without this, the INITIATED call holds the workspace's single sales
      // line until the 30-min stale sweep and every subsequent Dial 409s.
      expect(salesCalls.logCall).toHaveBeenCalledWith(WS, 'call-1', USER, { status: 'CANCELLED' });
    });

    it('does NOT cancel the call when the item was already claimed (concurrent log owns it)', async () => {
      const { prisma, salesCalls, svc } = makeSvc();
      prisma.dialSession.findFirst.mockResolvedValue({ id: 'sess-1', status: 'ACTIVE', currentIndex: 0, total: 2 } as any);
      prisma.dialSessionItem.findFirst.mockResolvedValue({ id: 'it-0', callId: 'call-1', position: 0, leadId: 'l1' } as any);
      prisma.lead.findFirst.mockResolvedValue({ id: 'l1', phone: '+90', businessName: 'A', contactPerson: null, status: 'NEW', city: null } as any);
      (prisma.dialSessionItem.updateMany as jest.Mock).mockResolvedValue({ count: 0 }); // lost the claim race
      (prisma.dialSession.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
      (prisma.dialSessionItem.count as jest.Mock).mockResolvedValue(1);
      await svc.skip(WS, 'sess-1', USER);
      expect(salesCalls.logCall).not.toHaveBeenCalled();
    });
  });

  describe('cancel', () => {
    it('cancelling a session mid-call cancels the linked INITIATED call (frees the single line)', async () => {
      const { prisma, salesCalls, svc } = makeSvc();
      prisma.dialSession.findFirst.mockResolvedValue({ id: 'sess-1', status: 'ACTIVE', currentIndex: 0, total: 2 } as any);
      prisma.dialSessionItem.findFirst.mockResolvedValue({ id: 'it-0', callId: 'call-1', position: 0, leadId: 'l1' } as any);
      prisma.lead.findFirst.mockResolvedValue({ id: 'l1', phone: '+90', businessName: 'A', contactPerson: null, status: 'NEW', city: null } as any);
      (prisma.dialSession.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      salesCalls.logCall.mockResolvedValue({});
      const out = await svc.cancel(WS, 'sess-1', USER);
      expect(out).toEqual({ id: 'sess-1', status: 'CANCELLED' });
      expect(salesCalls.logCall).toHaveBeenCalledWith(WS, 'call-1', USER, { status: 'CANCELLED' });
    });

    it('a second cancel (already-CANCELLED session) is a no-op — no call mutation', async () => {
      const { prisma, salesCalls, svc } = makeSvc();
      prisma.dialSession.findFirst.mockResolvedValue({ id: 'sess-1', status: 'CANCELLED', currentIndex: 0, total: 2 } as any);
      (prisma.dialSession.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
      await svc.cancel(WS, 'sess-1', USER);
      expect(salesCalls.logCall).not.toHaveBeenCalled();
    });
  });
});
