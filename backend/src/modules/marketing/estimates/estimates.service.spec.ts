import { NotFoundException, ConflictException } from '@nestjs/common';
import { EstimatesService } from './estimates.service';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';

describe('EstimatesService', () => {
  let prisma: MockPrismaClient;
  let invoices: { create: jest.Mock };
  let taxRates: { resolveItemTaxes: jest.Mock };
  let trace: { record: jest.Mock };
  let svc: EstimatesService;
  const WS = 'ws-1';

  beforeEach(() => {
    prisma = mockPrismaClient();
    invoices = { create: jest.fn().mockResolvedValue({ id: 'inv-1' }) };
    // Default: no tax (pct 0) — totals equal the pre-tax subtotal, as before.
    taxRates = { resolveItemTaxes: jest.fn((_ws, items) => Promise.resolve(items ?? [])) };
    trace = { record: jest.fn().mockResolvedValue(undefined) };
    svc = new EstimatesService(prisma as any, invoices as any, taxRates as any, trace as any);
    (prisma.lead.findFirst as jest.Mock).mockResolvedValue({ assignedToId: 'rep-1' } as any);
    (prisma.marketingNotification.create as jest.Mock).mockResolvedValue({ id: 'n1' } as any);
  });

  describe('list', () => {
    it('is workspace-scoped and unfiltered by default', async () => {
      prisma.estimate.findMany.mockResolvedValue([]);
      await svc.list(WS);
      const where = prisma.estimate.findMany.mock.calls[0][0].where;
      expect(where.workspaceId).toBe(WS);
      expect(where.leadId).toBeUndefined();
    });

    // The record card asks for ONE person's quotes. Without a server-side
    // predicate the card would have to pull every estimate in the workspace
    // and sift them in the browser — an unbounded read for a section that
    // usually shows nothing.
    it('narrows to one person when a leadId is given, still workspace-scoped', async () => {
      prisma.estimate.findMany.mockResolvedValue([]);
      await svc.list(WS, 'lead-1');
      const where = prisma.estimate.findMany.mock.calls[0][0].where;
      expect(where.workspaceId).toBe(WS);
      expect(where.leadId).toBe('lead-1');
    });
  });

  describe('create', () => {
    it('computes the minor-unit total and mints number + public token (scoped)', async () => {
      prisma.estimate.create.mockResolvedValue({ id: 'e1' } as any);
      await svc.create(WS, {
        items: [
          { description: 'Setup', qty: 2, unitPrice: 5000 },
          { description: 'Plan', qty: 1, unitPrice: 9900 },
        ],
      } as any);
      const arg = prisma.estimate.create.mock.calls[0][0] as any;
      expect(arg.data.workspaceId).toBe(WS);
      expect(arg.data.total).toBe(2 * 5000 + 9900); // 19900
      expect(arg.data.number).toMatch(/^EST-/);
      expect(arg.data.publicToken).toMatch(/^es_/);
    });
  });

  describe('update', () => {
    it('refuses to edit a non-draft estimate', async () => {
      prisma.estimate.findFirst.mockResolvedValue({ id: 'e1', status: 'SENT' } as any);
      await expect(svc.update(WS, 'e1', { notes: 'x' } as any)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('recomputes the total when items change on a draft', async () => {
      prisma.estimate.findFirst.mockResolvedValue({ id: 'e1', status: 'DRAFT' } as any);
      prisma.estimate.update.mockResolvedValue({ id: 'e1' } as any);
      await svc.update(WS, 'e1', { items: [{ description: 'A', qty: 3, unitPrice: 1000 }] } as any);
      const arg = prisma.estimate.update.mock.calls[0][0] as any;
      expect(arg.data.total).toBe(3000);
    });
  });

  describe('convertToInvoice', () => {
    it('creates an invoice from the items and records convertedInvoiceId', async () => {
      prisma.estimate.findFirst.mockResolvedValue({
        id: 'e1',
        workspaceId: WS,
        status: 'ACCEPTED',
        leadId: 'lead-1',
        currency: 'TRY',
        notes: null,
        items: [{ description: 'Plan', qty: 1, unitPrice: 9900 }],
        convertedInvoiceId: null,
        acceptedAt: new Date(),
      } as any);
      prisma.estimate.updateMany.mockResolvedValue({ count: 1 } as any);

      const res = await svc.convertToInvoice(WS, 'e1');

      // The estimate's snapshotted tax is preserved: invoices.create is told to
      // TRUST the incoming items (preResolvedItems), never re-resolve from
      // CURRENT rates — else an archived/edited rate would bill a total the
      // customer never accepted.
      expect(invoices.create).toHaveBeenCalledWith(
        WS,
        expect.objectContaining({ leadId: 'lead-1', currency: 'TRY', preResolvedItems: true }),
      );
      expect(prisma.estimate.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          // Atomic claim: the where now also guards convertedInvoiceId:null + status.
          where: expect.objectContaining({ id: 'e1', workspaceId: WS, convertedInvoiceId: null }),
          data: expect.objectContaining({ convertedInvoiceId: 'inv-1', status: 'ACCEPTED' }),
        }),
      );
      expect(res).toMatchObject({ id: 'inv-1' });
    });

    it('refuses to convert twice', async () => {
      prisma.estimate.findFirst.mockResolvedValue({
        id: 'e1',
        status: 'ACCEPTED',
        convertedInvoiceId: 'inv-prev',
      } as any);
      await expect(svc.convertToInvoice(WS, 'e1')).rejects.toBeInstanceOf(ConflictException);
      expect(invoices.create).not.toHaveBeenCalled();
    });

    it('refuses to convert a draft estimate', async () => {
      prisma.estimate.findFirst.mockResolvedValue({
        id: 'e1',
        status: 'DRAFT',
        convertedInvoiceId: null,
      } as any);
      await expect(svc.convertToInvoice(WS, 'e1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses to convert an EXPIRED still-SENT estimate (stale price)', async () => {
      prisma.estimate.findFirst.mockResolvedValue({
        id: 'e1', status: 'SENT', convertedInvoiceId: null,
        validUntil: new Date(Date.now() - 86_400_000), // yesterday
      } as any);
      await expect(svc.convertToInvoice(WS, 'e1')).rejects.toThrow(/expired/i);
      expect(invoices.create).not.toHaveBeenCalled();
    });

    it('still converts an ACCEPTED estimate past validUntil (it was accepted in time)', async () => {
      prisma.estimate.findFirst.mockResolvedValue({
        id: 'e1', status: 'ACCEPTED', convertedInvoiceId: null, leadId: null, currency: 'TRY', notes: null,
        items: [{ description: 'x', qty: 1, unitPrice: 100 }], acceptedAt: new Date(),
        validUntil: new Date(Date.now() - 86_400_000),
      } as any);
      prisma.estimate.updateMany.mockResolvedValue({ count: 1 } as any);
      await expect(svc.convertToInvoice(WS, 'e1')).resolves.toMatchObject({ id: 'inv-1' });
    });
  });

  describe('public accept / decline (token-gated)', () => {
    const SENT = {
      id: 'e1',
      workspaceId: WS,
      status: 'SENT',
      leadId: 'lead-1',
      number: 'EST-7',
      total: 125050,
      currency: 'TRY',
      validUntil: null,
    };

    it('accepts via the public token and stamps acceptedAt', async () => {
      prisma.estimate.findUnique.mockResolvedValue(SENT as any);
      prisma.estimate.updateMany.mockResolvedValue({ count: 1 } as any);
      const res = await svc.publicAccept('es_tok');
      expect(prisma.estimate.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { publicToken: 'es_tok' } }),
      );
      expect(prisma.estimate.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'ACCEPTED' }) }),
      );
      expect(res).toEqual({ status: 'ACCEPTED' });
    });

    // The public endpoint allows 20 POSTs/min/IP, and the old guard was
    // evaluated off a STALE read: two concurrent accepts both passed it. The
    // claim is what makes "the customer answered" a single event.
    it('claims the answer with a status-conditional, workspace-scoped updateMany', async () => {
      prisma.estimate.findUnique.mockResolvedValue(SENT as any);
      prisma.estimate.updateMany.mockResolvedValue({ count: 1 } as any);
      await svc.publicAccept('es_tok');
      expect(prisma.estimate.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'e1', workspaceId: WS, status: { in: ['DRAFT', 'SENT'] } },
        }),
      );
      expect(prisma.estimate.update).not.toHaveBeenCalled();
    });

    // `quote-answer-silent`: an acceptance went unnoticed and the deal stalled.
    it('writes the answer onto the person and tells the rep who owns them', async () => {
      prisma.estimate.findUnique.mockResolvedValue(SENT as any);
      prisma.estimate.updateMany.mockResolvedValue({ count: 1 } as any);
      await svc.publicAccept('es_tok');

      const [ws, leadId, row, opts] = trace.record.mock.calls[0];
      expect(ws).toBe(WS);
      expect(leadId).toBe('lead-1');
      expect(row.title).toBe('Quote EST-7 accepted by the customer');
      expect(row.metadata).toMatchObject({ event: 'quote_answered', answer: 'ACCEPTED' });
      // No actor: the CUSTOMER answered, so the row belongs to the workspace
      // SYSTEM sentinel, not to whichever colleague happened to be nearby.
      expect(opts).toBeUndefined();

      const notice = (prisma.marketingNotification.create as jest.Mock).mock.calls[0][0] as any;
      expect(notice.data).toMatchObject({ workspaceId: WS, userId: 'rep-1', type: 'QUOTE_ANSWERED' });
    });

    it('records a decline the same way', async () => {
      prisma.estimate.findUnique.mockResolvedValue(SENT as any);
      prisma.estimate.updateMany.mockResolvedValue({ count: 1 } as any);
      await expect(svc.publicDecline('es_tok')).resolves.toEqual({ status: 'DECLINED' });
      expect(trace.record.mock.calls[0][2].metadata).toMatchObject({ answer: 'DECLINED' });
    });

    // The loser of a double-click writes nothing: one answer, one activity row.
    it('writes no trace when the claim was lost, and reports the real status', async () => {
      prisma.estimate.findUnique
        .mockResolvedValueOnce(SENT as any)
        .mockResolvedValueOnce({ ...SENT, status: 'ACCEPTED' } as any);
      prisma.estimate.updateMany.mockResolvedValue({ count: 0 } as any);

      await expect(svc.publicAccept('es_tok')).resolves.toEqual({ status: 'ACCEPTED' });
      expect(trace.record).not.toHaveBeenCalled();
    });

    it('re-accepting an already-accepted quote stays idempotent and silent', async () => {
      prisma.estimate.findUnique.mockResolvedValue({ ...SENT, status: 'ACCEPTED' } as any);
      await expect(svc.publicAccept('es_tok')).resolves.toEqual({ status: 'ACCEPTED' });
      expect(prisma.estimate.updateMany).not.toHaveBeenCalled();
      expect(trace.record).not.toHaveBeenCalled();
    });

    // A missing timeline row is a missing line in a story; it is not a reason
    // to tell a customer their acceptance failed.
    it('still accepts when the trace or the notification cannot be written', async () => {
      prisma.estimate.findUnique.mockResolvedValue(SENT as any);
      prisma.estimate.updateMany.mockResolvedValue({ count: 1 } as any);
      trace.record.mockRejectedValue(new Error('no sentinel'));
      await expect(svc.publicAccept('es_tok')).resolves.toEqual({ status: 'ACCEPTED' });
    });

    it('refuses to accept an already-declined estimate via token', async () => {
      prisma.estimate.findUnique.mockResolvedValue({ ...SENT, status: 'DECLINED' } as any);
      await expect(svc.publicAccept('es_tok')).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.estimate.updateMany).not.toHaveBeenCalled();
    });

    it('refuses to accept an EXPIRED estimate (past validUntil) — no lock-in at the stale price', async () => {
      prisma.estimate.findUnique.mockResolvedValue({
        ...SENT, validUntil: new Date(Date.now() - 86_400_000 * 2),
      } as any);
      await expect(svc.publicAccept('es_tok')).rejects.toThrow(/expired/i);
      expect(prisma.estimate.updateMany).not.toHaveBeenCalled();
    });

    // The page prints "Valid until 30 September" — the 30th is a day the
    // customer can still accept on, in any timezone.
    it('still accepts on the last stated day', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-09-30T22:30:00.000Z'));
      try {
        prisma.estimate.findUnique.mockResolvedValue({
          ...SENT, validUntil: new Date('2026-09-30T00:00:00.000Z'),
        } as any);
        prisma.estimate.updateMany.mockResolvedValue({ count: 1 } as any);
        await expect(svc.publicAccept('es_tok')).resolves.toEqual({ status: 'ACCEPTED' });
      } finally {
        jest.useRealTimers();
      }
    });

    it('404s an unknown public token', async () => {
      prisma.estimate.findUnique.mockResolvedValue(null);
      await expect(svc.publicView('nope')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('accept / decline', () => {
    it('declining an accepted estimate is rejected', async () => {
      prisma.estimate.findFirst.mockResolvedValue({ id: 'e1', status: 'ACCEPTED' } as any);
      await expect(svc.decline(WS, 'e1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('404s an estimate from another workspace', async () => {
      prisma.estimate.findFirst.mockResolvedValue(null);
      await expect(svc.accept(WS, 'e1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
