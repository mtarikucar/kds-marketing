import { BadRequestException } from '@nestjs/common';
import { ExperimentsService } from './experiments.service';
import {
  mockPrismaClient,
  MockPrismaClient,
} from '../../../common/test/prisma-mock.service';

const WS = 'ws-1';

function makeSvc() {
  const prisma = mockPrismaClient();
  return { prisma, svc: new ExperimentsService(prisma as any) };
}

describe('ExperimentsService', () => {
  it('requires at least 2 variants to start', async () => {
    const { prisma, svc } = makeSvc();
    prisma.experiment.findFirst.mockResolvedValue({ id: 'e1', variants: [{ key: 'a' }] } as any);
    await expect(svc.setStatus(WS, 'e1', 'RUNNING')).rejects.toBeInstanceOf(BadRequestException);

    prisma.experiment.findFirst.mockResolvedValue({ id: 'e1', variants: [{ key: 'a' }, { key: 'b' }] } as any);
    (prisma.experiment.update as jest.Mock).mockResolvedValue({ id: 'e1', status: 'RUNNING' });
    const out: any = await svc.setStatus(WS, 'e1', 'RUNNING');
    expect(out.status).toBe('RUNNING');
  });

  it('selectVariant returns null when not running, else picks a variant + records an impression', async () => {
    const { prisma, svc } = makeSvc();
    prisma.experiment.findUnique.mockResolvedValueOnce({ id: 'e1', status: 'DRAFT', variants: [] } as any);
    expect(await svc.selectVariant('e1')).toBeNull();

    prisma.experiment.findUnique.mockResolvedValueOnce({
      id: 'e1', workspaceId: WS, status: 'RUNNING', variants: [{ key: 'a', weight: 1 }, { key: 'b', weight: 1 }],
    } as any);
    (prisma.experimentEvent.create as jest.Mock).mockResolvedValue({});
    const out: any = await svc.selectVariant('e1');
    expect(['a', 'b']).toContain(out.variantKey);
    expect((prisma.experimentEvent.create as jest.Mock).mock.calls[0][0].data.kind).toBe('IMPRESSION');
  });

  it('trackConversion records a CONVERSION event', async () => {
    const { prisma, svc } = makeSvc();
    prisma.experiment.findUnique.mockResolvedValue({ id: 'e1', workspaceId: WS } as any);
    (prisma.experimentEvent.create as jest.Mock).mockResolvedValue({});
    await svc.trackConversion('e1', 'a');
    expect((prisma.experimentEvent.create as jest.Mock).mock.calls[0][0].data).toMatchObject({ variantKey: 'a', kind: 'CONVERSION' });
  });

  it('results aggregates impressions/conversions + rate per variant', async () => {
    const { prisma, svc } = makeSvc();
    prisma.experiment.findFirst.mockResolvedValue({ id: 'e1' } as any);
    (prisma.experimentEvent.groupBy as unknown as jest.Mock).mockResolvedValue([
      { variantKey: 'a', kind: 'IMPRESSION', _count: 100 },
      { variantKey: 'a', kind: 'CONVERSION', _count: 10 },
      { variantKey: 'b', kind: 'IMPRESSION', _count: 100 },
      { variantKey: 'b', kind: 'CONVERSION', _count: 25 },
    ]);
    const out = await svc.results(WS, 'e1');
    expect(out).toContainEqual({ variantKey: 'a', impressions: 100, conversions: 10, conversionRate: 10 });
    expect(out).toContainEqual({ variantKey: 'b', impressions: 100, conversions: 25, conversionRate: 25 });
  });
});
