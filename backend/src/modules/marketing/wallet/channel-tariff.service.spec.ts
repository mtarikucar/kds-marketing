import { Prisma } from '@prisma/client';
import { ChannelTariffService } from './channel-tariff.service';

const D = (n: string | number) => new Prisma.Decimal(n);

function makePrisma(rows: any[]) {
  const findMany = jest.fn().mockResolvedValue(rows);
  return { prisma: { channelTariff: { findMany } } as any, findMany };
}

describe('ChannelTariffService', () => {
  it('returns null when no tariff matches', async () => {
    const { prisma } = makePrisma([]);
    const svc = new ChannelTariffService(prisma);
    expect(await svc.resolve('ws1', 'SMS', 'SMS_SEGMENT')).toBeNull();
  });

  it('prefers a workspace-specific row over a platform default', async () => {
    const eff = new Date('2026-01-01');
    const { prisma } = makePrisma([
      { id: 'global', workspaceId: null, country: null, effectiveFrom: eff, unitCost: D('0.90'), currency: 'TRY' },
      { id: 'ws', workspaceId: 'ws1', country: null, effectiveFrom: eff, unitCost: D('0.75'), currency: 'TRY' },
    ]);
    const svc = new ChannelTariffService(prisma);
    const r = await svc.resolve('ws1', 'SMS', 'SMS_SEGMENT');
    expect(r?.tariffId).toBe('ws');
    expect(r?.unitCost.toString()).toBe('0.75');
  });

  it('prefers a country match, then the most recent effectiveFrom', async () => {
    const { prisma } = makePrisma([
      { id: 'old', workspaceId: null, country: null, effectiveFrom: new Date('2026-01-01'), unitCost: D('0.0109'), currency: 'USD' },
      { id: 'new', workspaceId: null, country: null, effectiveFrom: new Date('2026-06-01'), unitCost: D('0.0120'), currency: 'USD' },
      { id: 'tr', workspaceId: null, country: 'TR', effectiveFrom: new Date('2026-02-01'), unitCost: D('0.0100'), currency: 'USD' },
    ]);
    const svc = new ChannelTariffService(prisma);
    expect((await svc.resolve('ws1', 'WHATSAPP', 'WA_MARKETING', 'TR'))?.tariffId).toBe('tr');
    // With no country, the most-recent default wins.
    expect((await svc.resolve('ws1', 'WHATSAPP', 'WA_MARKETING'))?.tariffId).toBe('new');
  });

  it('prices quantity × unit cost', async () => {
    const { prisma } = makePrisma([
      { id: 'v', workspaceId: null, country: null, effectiveFrom: new Date('2026-01-01'), unitCost: D('0.33'), currency: 'USD' },
    ]);
    const svc = new ChannelTariffService(prisma);
    const p = await svc.price('ws1', 'VOICE', 'VOICE_MINUTE', 3);
    expect(p?.amount.toString()).toBe('0.99');
    expect(p?.quantity.toString()).toBe('3');
  });
});
