import {
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { MarketingOffersService } from './marketing-offers.service';
import {
  mockPrismaClient,
  MockPrismaClient,
} from '../../../common/test/prisma-mock.service';

/**
 * The Offers page exposes Accept / Reject on a SENT offer. These flip the
 * offer's own status (the customer's decision on that quote); Accept also
 * advances the lead OFFER_SENT→WAITING — the "accepted, awaiting provisioning"
 * state the convert() flow consumes (convert allows OFFER_SENT/WAITING). The
 * heavyweight WON + tenant provisioning stays in convert(), untouched here.
 */
describe('MarketingOffersService — accept / reject transitions', () => {
  let prisma: MockPrismaClient;
  let svc: MarketingOffersService;

  beforeEach(() => {
    prisma = mockPrismaClient();
    svc = new MarketingOffersService(prisma as any, { describePlan: jest.fn() } as any);
    // Array-form $transaction: resolve the eagerly-built operation promises.
    (prisma.$transaction as jest.Mock).mockImplementation((ops: any) =>
      Array.isArray(ops) ? Promise.all(ops) : ops(prisma),
    );
  });

  describe('markAccepted', () => {
    it('flips a SENT offer to ACCEPTED and advances the lead OFFER_SENT→WAITING', async () => {
      prisma.leadOffer.findFirst.mockResolvedValue({
        id: 'o1',
        workspaceId: 'ws-1',
        leadId: 'l1',
        createdById: 'rep-1',
        status: 'SENT',
        lead: { status: 'OFFER_SENT', convertedTenantId: null },
      } as any);
      (prisma.leadOffer.update as jest.Mock).mockResolvedValue({ id: 'o1', status: 'ACCEPTED' });
      (prisma.lead.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      const out: any = await svc.markAccepted('ws-1', 'o1', 'mgr-1', 'MANAGER');

      expect(out.status).toBe('ACCEPTED');
      expect((prisma.leadOffer.update as jest.Mock).mock.calls[0][0]).toMatchObject({
        where: { id: 'o1' },
        data: { status: 'ACCEPTED' },
      });
      // Guarded compound WHERE — advances only from OFFER_SENT on an unconverted
      // lead, so a concurrent convert() (→WON) can't be reverted.
      const leadCall = (prisma.lead.updateMany as jest.Mock).mock.calls[0][0];
      expect(leadCall.where).toMatchObject({
        id: 'l1',
        workspaceId: 'ws-1',
        convertedTenantId: null,
        status: 'OFFER_SENT',
      });
      expect(leadCall.data).toEqual({ status: 'WAITING' });
    });

    // markSent refuses an already-expired offer; markAccepted must too. An offer's
    // validUntil can pass BEFORE the 30-min expire cron flips it SENT→EXPIRED, so
    // between those it's still SENT — accepting it would win a deal on stale terms.
    it('refuses to accept an offer whose validUntil has passed (expired quote)', async () => {
      prisma.leadOffer.findFirst.mockResolvedValue({
        id: 'o1',
        workspaceId: 'ws-1',
        leadId: 'l1',
        createdById: 'rep-1',
        status: 'SENT',
        validUntil: new Date(Date.now() - 60_000), // expired 1 min ago; cron not yet run
        lead: { status: 'OFFER_SENT', convertedTenantId: null },
      } as any);
      await expect(svc.markAccepted('ws-1', 'o1', 'mgr-1', 'MANAGER')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.leadOffer.update).not.toHaveBeenCalled();
    });

    it('rejects accepting a non-SENT offer', async () => {
      prisma.leadOffer.findFirst.mockResolvedValue({
        id: 'o1',
        workspaceId: 'ws-1',
        leadId: 'l1',
        createdById: 'rep-1',
        status: 'DRAFT',
        lead: { status: 'OFFER_SENT', convertedTenantId: null },
      } as any);
      await expect(svc.markAccepted('ws-1', 'o1', 'mgr-1', 'MANAGER')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('refuses when the lead is already closed/converted', async () => {
      prisma.leadOffer.findFirst.mockResolvedValue({
        id: 'o1',
        workspaceId: 'ws-1',
        leadId: 'l1',
        createdById: 'rep-1',
        status: 'SENT',
        lead: { status: 'WON', convertedTenantId: 'tenant-1' },
      } as any);
      await expect(svc.markAccepted('ws-1', 'o1', 'mgr-1', 'MANAGER')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('forbids a REP acting on an offer they did not create', async () => {
      prisma.leadOffer.findFirst.mockResolvedValue({
        id: 'o1',
        workspaceId: 'ws-1',
        leadId: 'l1',
        createdById: 'rep-2',
        status: 'SENT',
        lead: { status: 'OFFER_SENT', convertedTenantId: null },
      } as any);
      await expect(svc.markAccepted('ws-1', 'o1', 'rep-1', 'REP')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('404s an offer outside the workspace', async () => {
      prisma.leadOffer.findFirst.mockResolvedValue(null);
      await expect(svc.markAccepted('ws-1', 'o1', 'mgr-1', 'MANAGER')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('markRejected', () => {
    it('flips a SENT offer to REJECTED without touching the lead', async () => {
      prisma.leadOffer.findFirst.mockResolvedValue({
        id: 'o1',
        workspaceId: 'ws-1',
        leadId: 'l1',
        createdById: 'rep-1',
        status: 'SENT',
      } as any);
      (prisma.leadOffer.update as jest.Mock).mockResolvedValue({ id: 'o1', status: 'REJECTED' });

      const out: any = await svc.markRejected('ws-1', 'o1', 'mgr-1', 'MANAGER');

      expect(out.status).toBe('REJECTED');
      expect((prisma.leadOffer.update as jest.Mock).mock.calls[0][0]).toMatchObject({
        where: { id: 'o1' },
        data: { status: 'REJECTED' },
      });
      expect(prisma.lead.updateMany).not.toHaveBeenCalled();
    });

    it('rejects rejecting a non-SENT offer', async () => {
      prisma.leadOffer.findFirst.mockResolvedValue({
        id: 'o1',
        workspaceId: 'ws-1',
        leadId: 'l1',
        createdById: 'rep-1',
        status: 'ACCEPTED',
      } as any);
      await expect(svc.markRejected('ws-1', 'o1', 'mgr-1', 'MANAGER')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('forbids a REP rejecting an offer they did not create', async () => {
      prisma.leadOffer.findFirst.mockResolvedValue({
        id: 'o1',
        workspaceId: 'ws-1',
        leadId: 'l1',
        createdById: 'rep-2',
        status: 'SENT',
      } as any);
      await expect(svc.markRejected('ws-1', 'o1', 'rep-1', 'REP')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });
});
