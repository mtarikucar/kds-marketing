import { NotFoundException, ConflictException } from '@nestjs/common';
import { EstimatesService } from './estimates.service';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';

describe('EstimatesService', () => {
  let prisma: MockPrismaClient;
  let invoices: { create: jest.Mock };
  let svc: EstimatesService;
  const WS = 'ws-1';

  beforeEach(() => {
    prisma = mockPrismaClient();
    invoices = { create: jest.fn().mockResolvedValue({ id: 'inv-1' }) };
    svc = new EstimatesService(prisma as any, invoices as any);
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

      expect(invoices.create).toHaveBeenCalledWith(
        WS,
        expect.objectContaining({ leadId: 'lead-1', currency: 'TRY' }),
      );
      expect(prisma.estimate.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'e1', workspaceId: WS },
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
  });

  describe('public accept / decline (token-gated)', () => {
    it('accepts via the public token and stamps acceptedAt', async () => {
      prisma.estimate.findUnique.mockResolvedValue({ id: 'e1', status: 'SENT' } as any);
      prisma.estimate.update.mockResolvedValue({ id: 'e1' } as any);
      const res = await svc.publicAccept('es_tok');
      expect(prisma.estimate.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { publicToken: 'es_tok' } }),
      );
      expect(prisma.estimate.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'ACCEPTED' }) }),
      );
      expect(res).toEqual({ status: 'ACCEPTED' });
    });

    it('refuses to accept an already-declined estimate via token', async () => {
      prisma.estimate.findUnique.mockResolvedValue({ id: 'e1', status: 'DECLINED' } as any);
      await expect(svc.publicAccept('es_tok')).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.estimate.update).not.toHaveBeenCalled();
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
