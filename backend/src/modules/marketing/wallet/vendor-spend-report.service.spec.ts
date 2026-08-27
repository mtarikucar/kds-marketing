import { VendorSpendReportService, VENDOR_UNITS } from './vendor-spend-report.service';
import { ChannelTariffService } from './channel-tariff.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { Prisma } from '@prisma/client';

const dec = (n: string) => new Prisma.Decimal(n);

function make(opts: {
  ledger?: Array<{ channel: string; delta: string; quantity?: string }>;
  tariffs?: Array<{
    id: string;
    workspaceId: string | null;
    channel: string;
    unitType: string;
    unitCost: string;
  }>;
}) {
  const tariffs = opts.tariffs ?? [];
  const prisma = {
    spendLedger: {
      findMany: jest.fn().mockResolvedValue(
        (opts.ledger ?? []).map((l) => ({
          channel: l.channel,
          delta: dec(l.delta),
          quantity: l.quantity ? dec(l.quantity) : null,
        })),
      ),
    },
    channelTariff: {
      findMany: jest.fn(({ where }: { where: Record<string, unknown> }) => {
        // Serves BOTH callers: resolve()'s channel/unitType lookup and the
        // report's own id lookup.
        const ids = (where.id as { in?: string[] } | undefined)?.in;
        if (ids) {
          return Promise.resolve(
            tariffs.filter((t) => ids.includes(t.id)).map((t) => ({ id: t.id, workspaceId: t.workspaceId })),
          );
        }
        return Promise.resolve(
          tariffs
            .filter((t) => t.channel === where.channel && t.unitType === where.unitType)
            .map((t) => ({
              ...t,
              unitCost: dec(t.unitCost),
              currency: 'TRY',
              country: null,
              effectiveFrom: new Date('2026-01-01T00:00:00Z'),
            })),
        );
      }),
    },
  } as unknown as PrismaService;

  return new VendorSpendReportService(prisma, new ChannelTariffService(prisma));
}

const WS = 'ws-1';

describe('VendorSpendReportService', () => {
  it('reports a vendor with no tariff as unmetered rather than as zero spend', async () => {
    // Only the two research inputs are priced — the carrier units are not,
    // which is the live shape: NetGSM/Meta rates are contracted per operator
    // and no migration can guess them.
    const service = make({
      tariffs: [
        {
          id: 't-fc',
          workspaceId: null,
          channel: 'RESEARCH',
          unitType: 'FIRECRAWL_PAGE',
          unitCost: '0.0500',
        },
        { id: 't-ap', workspaceId: null, channel: 'RESEARCH', unitType: 'APIFY_RUN', unitCost: '0.5000' },
      ],
    });

    const report = await service.report(WS, 30);

    expect(report.rates).toHaveLength(VENDOR_UNITS.length);
    const firecrawl = report.rates.find((r) => r.unitType === 'FIRECRAWL_PAGE')!;
    expect(firecrawl.metered).toBe(true);
    expect(firecrawl.unitCost).toBe(0.05);
    expect(firecrawl.scope).toBe('platform');

    // The whole point: SMS spent real money and shows up NOWHERE in the
    // ledger, because settle() cannot price it. A report that only summed the
    // ledger would call that 0 TRY.
    const sms = report.rates.find((r) => r.unitType === 'SMS_SEGMENT')!;
    expect(sms.metered).toBe(false);
    expect(sms.unitCost).toBeNull();
    expect(report.unmetered.map((u) => u.unitType)).toContain('SMS_SEGMENT');
    expect(report.unmetered.map((u) => u.unitType)).not.toContain('FIRECRAWL_PAGE');
  });

  it('labels a workspace override as such, so a custom price is not read as the platform default', async () => {
    const service = make({
      tariffs: [
        { id: 't-plat', workspaceId: null, channel: 'RESEARCH', unitType: 'APIFY_RUN', unitCost: '0.5000' },
        { id: 't-ws', workspaceId: WS, channel: 'RESEARCH', unitType: 'APIFY_RUN', unitCost: '2.0000' },
      ],
    });

    const apify = (await service.report(WS, 30)).rates.find((r) => r.unitType === 'APIFY_RUN')!;
    expect(apify.unitCost).toBe(2);
    expect(apify.scope).toBe('workspace');
  });

  it('keeps a refund from hiding a spend behind a small net number', async () => {
    const service = make({
      ledger: [
        { channel: 'META', delta: '-100.00', quantity: '1' },
        { channel: 'META', delta: '95.00' },
        { channel: 'SMS', delta: '-20.00', quantity: '4' },
      ],
    });

    const report = await service.report(WS, 30);

    expect(report.totalSpend).toBe(120);
    expect(report.totalRefund).toBe(95);
    const meta = report.byChannel.find((c) => c.channel === 'META')!;
    expect(meta.spend).toBe(100);
    expect(meta.refund).toBe(95);
    expect(meta.entries).toBe(2);
    // Sorted by spend, biggest first.
    expect(report.byChannel[0].channel).toBe('META');
  });
});
