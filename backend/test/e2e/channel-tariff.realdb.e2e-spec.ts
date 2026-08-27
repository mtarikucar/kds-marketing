import { randomUUID } from 'crypto';
import { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ChannelTariffService } from '../../src/modules/marketing/wallet/channel-tariff.service';
import { VendorSpendReportService } from '../../src/modules/marketing/wallet/vendor-spend-report.service';
import { createRealDbTestApp, closeTestApp, realDbEnabled } from '../utils/test-app';

/**
 * Tariff resolution against REAL Postgres.
 *
 * `resolve()` filtered with `workspaceId: { in: [workspaceId, null] }` — which
 * reads exactly like what it means and which Prisma refuses to execute: a
 * nullable String filter accepts a list of strings, or null, never a list with
 * null inside it. So every call threw, `price()` threw, `settle()` caught it and
 * returned null, and no vendor spend was priced from the day the tariffs were
 * seeded (3 July) until this was fixed. The `UNPRICED SPEND` warning meant to
 * make exactly this visible sat in a branch the throw jumped straight over.
 *
 * None of that was visible from the unit tests, and it could not be: they mock
 * `channelTariff.findMany`, and a mock accepts any `where` you hand it. Only the
 * query builder validates the shape, so only a spec that reaches real Postgres
 * can hold this line.
 *
 * The fixtures deliberately sit ALONGSIDE the migration-seeded rows rather than
 * on an empty table, because that is the only state production is ever in.
 * Fixture rows carry a later `effectiveFrom` so precedence ties resolve to them.
 *
 * Opt-in via E2E_REAL_DB=1.
 */
const describeRealDb = realDbEnabled() ? describe : describe.skip;

describeRealDb('ChannelTariff resolution — real DB (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tariffs: ChannelTariffService;
  let report: VendorSpendReportService;

  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const platformId = randomUUID();
  const overrideId = randomUUID();
  const foreignId = randomUUID();
  const agnosticId = randomUUID();
  const LATER = new Date('2026-06-01T00:00:00Z');

  beforeAll(async () => {
    ({ app, prisma } = await createRealDbTestApp());
    tariffs = app.get(ChannelTariffService);
    report = app.get(VendorSpendReportService);

    await prisma.workspace.create({
      data: {
        id: workspaceId,
        slug: `tariff-${workspaceId.slice(0, 8)}`,
        name: 'Tariff',
        productName: 'Tariff',
      } as never,
    });

    await prisma.channelTariff.createMany({
      data: [
        // Platform default that outranks the seeded 0.90 on recency.
        {
          id: platformId,
          workspaceId: null,
          channel: 'SMS',
          unitType: 'SMS_SEGMENT',
          unitCost: '0.1000',
          currency: 'TRY',
          country: 'TR',
          effectiveFrom: LATER,
        },
        {
          id: overrideId,
          workspaceId,
          channel: 'SMS',
          unitType: 'SMS_SEGMENT',
          unitCost: '0.2000',
          currency: 'TRY',
          country: 'TR',
          effectiveFrom: LATER,
        },
        // Another tenant's row, on the one unit no migration seeds.
        {
          id: foreignId,
          workspaceId: otherWorkspaceId,
          channel: 'CONTENT',
          unitType: 'FAL_CREDIT',
          unitCost: '9.9900',
          currency: 'TRY',
          effectiveFrom: LATER,
        },
        // Country-agnostic twin of the seeded TR-only WhatsApp rate.
        {
          id: agnosticId,
          workspaceId: null,
          channel: 'WHATSAPP',
          unitType: 'WA_MARKETING',
          unitCost: '1.5000',
          currency: 'TRY',
          country: null,
          effectiveFrom: LATER,
        },
      ] as never,
    });
  });

  afterAll(async () => {
    await prisma.channelTariff.deleteMany({
      where: { id: { in: [platformId, overrideId, foreignId, agnosticId] } },
    });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await closeTestApp(app);
  });

  it('executes at all — the query every mock happily accepted', async () => {
    // Before the fix this did not return a wrong answer, it threw
    // PrismaClientValidationError on the `in: [id, null]` filter.
    await expect(tariffs.resolve(workspaceId, 'SMS', 'SMS_SEGMENT', 'TR')).resolves.not.toBeNull();
  });

  it('prefers a workspace override over any platform default', async () => {
    const resolved = await tariffs.resolve(workspaceId, 'SMS', 'SMS_SEGMENT', 'TR');
    expect(Number(resolved!.unitCost)).toBe(0.2);
    expect(resolved!.tariffId).toBe(overrideId);
  });

  it('falls back to the platform default for a workspace with no override', async () => {
    const resolved = await tariffs.resolve(otherWorkspaceId, 'SMS', 'SMS_SEGMENT', 'TR');
    expect(Number(resolved!.unitCost)).toBe(0.1);
    expect(resolved!.tariffId).toBe(platformId);
  });

  it('never resolves another tenant’s row', async () => {
    // The only FAL_CREDIT row anywhere belongs to otherWorkspaceId, so this
    // workspace must come back unpriced rather than borrowing it.
    expect(await tariffs.resolve(workspaceId, 'CONTENT', 'FAL_CREDIT', 'TR')).toBeNull();
  });

  it('prefers a country-matched row, and ignores it when no country is asked for', async () => {
    // Seeded WA_MARKETING is TR-only at 0.36 and outranks the agnostic 1.50 on
    // the country point, despite being older.
    expect(Number((await tariffs.resolve(workspaceId, 'WHATSAPP', 'WA_MARKETING', 'TR'))!.unitCost)).toBe(0.36);
    // With no country the TR-only row is filtered out entirely.
    expect(Number((await tariffs.resolve(workspaceId, 'WHATSAPP', 'WA_MARKETING'))!.unitCost)).toBe(1.5);
  });

  it('resolves every seeded research unit — the spend that was silently free', async () => {
    for (const unit of ['FIRECRAWL_PAGE', 'APIFY_RUN'] as const) {
      const resolved = await tariffs.resolve(workspaceId, 'RESEARCH', unit, 'TR');
      expect(resolved).not.toBeNull();
      expect(Number(resolved!.unitCost)).toBeGreaterThan(0);
    }
  });

  it('reports live rates without throwing, and marks the override as workspace scope', async () => {
    const result = await report.report(workspaceId, 30);
    const sms = result.rates.find((r) => r.unitType === 'SMS_SEGMENT')!;
    expect(sms.metered).toBe(true);
    expect(sms.scope).toBe('workspace');
    expect(sms.unitCost).toBe(0.2);

    // fal.ai is the one unit no migration ever seeded, so it is the one the
    // report must call out. Carriers must NOT appear here: they are priced,
    // and reporting them as unmetered would be a false alarm.
    expect(result.unmetered.map((u) => u.unitType)).toEqual(['FAL_CREDIT']);
  });
});
