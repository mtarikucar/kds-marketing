import { NotFoundException } from '@nestjs/common';
import { ComplianceService } from './compliance.service';
import {
  mockPrismaClient,
  MockPrismaClient,
} from '../../../common/test/prisma-mock.service';

const WS = 'ws-1';

function makeSvc() {
  const prisma = mockPrismaClient();
  return { prisma, svc: new ComplianceService(prisma as any) };
}

describe('ComplianceService', () => {
  it('records a marketing consent and syncs the opt-out flag', async () => {
    const { prisma, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as any);
    (prisma.consentRecord.create as jest.Mock).mockResolvedValue({ id: 'cr1' });
    (prisma.lead.update as jest.Mock).mockResolvedValue({});

    await svc.recordConsent(WS, 'lead-1', 'MARKETING_EMAIL', false, { source: 'form' });

    expect(prisma.lead.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'lead-1' }, data: { emailOptOut: true } }),
    );
  });

  it('does not touch opt-out flags for DATA_PROCESSING consent', async () => {
    const { prisma, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as any);
    (prisma.consentRecord.create as jest.Mock).mockResolvedValue({ id: 'cr1' });
    await svc.recordConsent(WS, 'lead-1', 'DATA_PROCESSING', true);
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });

  it('returns the latest consent per type', async () => {
    const { prisma, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as any);
    prisma.consentRecord.findMany.mockResolvedValue([
      { type: 'MARKETING_EMAIL', granted: true, createdAt: new Date('2026-02-01') },
      { type: 'MARKETING_EMAIL', granted: false, createdAt: new Date('2026-01-01') },
    ] as any);
    const out = await svc.getConsents(WS, 'lead-1');
    expect(out).toEqual([{ type: 'MARKETING_EMAIL', granted: true, at: new Date('2026-02-01') }]);
  });

  it('exports a lead bundle and records a COMPLETED request', async () => {
    const { prisma, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1', activities: [], offers: [], tasks: [] } as any);
    prisma.consentRecord.findMany.mockResolvedValue([] as any);
    (prisma.dataRequest.create as jest.Mock).mockResolvedValue({});
    const out: any = await svc.requestExport(WS, 'lead-1', 'u1');
    expect(out.lead.id).toBe('lead-1');
    expect((prisma.dataRequest.create as jest.Mock).mock.calls[0][0].data).toMatchObject({ kind: 'EXPORT', status: 'COMPLETED' });
  });

  it('records an erasure request as PENDING (no deletion)', async () => {
    const { prisma, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as any);
    (prisma.dataRequest.create as jest.Mock).mockResolvedValue({ id: 'dr1', status: 'PENDING' });
    const out: any = await svc.requestErasure(WS, 'lead-1');
    expect(out.status).toBe('PENDING');
    expect(prisma.lead.delete).not.toHaveBeenCalled();
  });

  it('404s for a lead outside the workspace', async () => {
    const { prisma, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue(null as any);
    await expect(svc.recordConsent(WS, 'ghost', 'MARKETING_EMAIL', true)).rejects.toBeInstanceOf(NotFoundException);
  });
});
