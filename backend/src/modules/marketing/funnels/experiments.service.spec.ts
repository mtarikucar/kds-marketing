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

  it('trackConversion records a CONVERSION event for a RUNNING experiment + known variant', async () => {
    const { prisma, svc } = makeSvc();
    prisma.experiment.findUnique.mockResolvedValue({ id: 'e1', workspaceId: WS, status: 'RUNNING', variants: [{ key: 'a' }, { key: 'b' }] } as any);
    (prisma.experimentEvent.create as jest.Mock).mockResolvedValue({});
    await svc.trackConversion('e1', 'a');
    expect((prisma.experimentEvent.create as jest.Mock).mock.calls[0][0].data).toMatchObject({ variantKey: 'a', kind: 'CONVERSION' });
  });

  it('trackConversion rejects an unknown variant + a non-RUNNING experiment (no write)', async () => {
    const { prisma, svc } = makeSvc();
    prisma.experiment.findUnique.mockResolvedValue({ id: 'e1', workspaceId: WS, status: 'RUNNING', variants: [{ key: 'a' }] } as any);
    (prisma.experimentEvent.create as jest.Mock).mockResolvedValue({});
    expect(await svc.trackConversion('e1', 'ZZZ')).toEqual({ ok: false });
    prisma.experiment.findUnique.mockResolvedValue({ id: 'e1', workspaceId: WS, status: 'DRAFT', variants: [{ key: 'a' }] } as any);
    expect(await svc.trackConversion('e1', 'a')).toEqual({ ok: false });
    expect(prisma.experimentEvent.create).not.toHaveBeenCalled();
  });

  it('selectVariant honours variant weights (deterministic via mocked RNG)', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.experimentEvent.create as jest.Mock).mockResolvedValue({});
    const running = {
      id: 'e1', workspaceId: WS, status: 'RUNNING',
      variants: [{ key: 'a', weight: 3 }, { key: 'b', weight: 1 }], // total 4
    } as any;

    const rng = jest.spyOn(Math, 'random');
    try {
      // r = 0.1 * 4 = 0.4 → falls in variant 'a' bucket [0,3)
      prisma.experiment.findUnique.mockResolvedValueOnce(running);
      rng.mockReturnValueOnce(0.1);
      expect((await svc.selectVariant('e1') as any).variantKey).toBe('a');

      // r = 0.9 * 4 = 3.6 → falls in variant 'b' bucket [3,4)
      prisma.experiment.findUnique.mockResolvedValueOnce(running);
      rng.mockReturnValueOnce(0.9);
      expect((await svc.selectVariant('e1') as any).variantKey).toBe('b');
    } finally {
      rng.mockRestore();
    }
  });

  it('selectVariant survives legacy/invalid weights without NaN-poisoning the pick', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.experimentEvent.create as jest.Mock).mockResolvedValue({});
    // Bad weights (string + negative) that would make the un-guarded sum NaN
    // and force every pick onto the last variant. safeWeight() coerces both to 1.
    prisma.experiment.findUnique.mockResolvedValueOnce({
      id: 'e1', workspaceId: WS, status: 'RUNNING',
      variants: [{ key: 'a', weight: 'oops' }, { key: 'b', weight: -5 }],
    } as any);
    const rng = jest.spyOn(Math, 'random').mockReturnValue(0.1); // → first variant with equal weights
    try {
      const out: any = await svc.selectVariant('e1');
      expect(out.variantKey).toBe('a'); // not forced to last ('b') by a NaN total
      expect((prisma.experimentEvent.create as jest.Mock).mock.calls[0][0].data.kind).toBe('IMPRESSION');
    } finally {
      rng.mockRestore();
    }
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
