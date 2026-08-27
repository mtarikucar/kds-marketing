import { randomUUID } from 'crypto';
import { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../../src/prisma/prisma.service';
import { MediaSpendService } from '../../src/modules/marketing/budget/media-spend.service';
import { VendorSpendReportService } from '../../src/modules/marketing/wallet/vendor-spend-report.service';
import { createRealDbTestApp, closeTestApp, realDbEnabled } from '../utils/test-app';

/**
 * fal.ai was the last vendor whose cost never reached the spend ledger, and it
 * failed for a different reason from all the others: not a broken lookup, but a
 * settle call that was never written. The `CONTENT` ledger channel, the
 * `FAL_CREDIT` tariff unit and `estimateMediaCredits()` had coexisted since
 * media generation shipped with nothing joining them.
 *
 * So the assertion that matters is the last one: `unmetered` comes back EMPTY.
 * Every vendor the platform can spend money with now has a price and a meter.
 *
 * Opt-in via E2E_REAL_DB=1.
 */
const describeRealDb = realDbEnabled() ? describe : describe.skip;

describeRealDb('Media spend settlement — real DB (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let spend: MediaSpendService;
  let report: VendorSpendReportService;

  const workspaceId = randomUUID();

  beforeAll(async () => {
    ({ app, prisma } = await createRealDbTestApp());
    spend = app.get(MediaSpendService);
    report = app.get(VendorSpendReportService);

    await prisma.workspace.create({
      data: {
        id: workspaceId,
        slug: `media-${workspaceId.slice(0, 8)}`,
        name: 'Media',
        productName: 'Media',
      } as never,
    });
  });

  afterAll(async () => {
    await prisma.spendLedger.deleteMany({ where: { workspaceId } });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await closeTestApp(app);
  });

  it('prices a generation from the seeded fal rate and writes the ledger row', async () => {
    const assetId = randomUUID();
    // 15 credits = a 5s Seedance Lite clip at 3 credits/sec.
    const settled = await spend.settle(workspaceId, { assetId, credits: 15 });

    expect(settled).not.toBeNull();
    expect(Number(settled!.amount)).toBeCloseTo(6, 2); // 15 x 0.40 TRY

    const rows = await prisma.spendLedger.findMany({ where: { workspaceId, channel: 'CONTENT' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe('CONTENT_GEN');
    expect(Number(rows[0].delta)).toBeCloseTo(-6, 2);
  });

  it('does not double-bill when the webhook and the poller both finalize', async () => {
    const assetId = randomUUID();
    // Both finalize paths run for real; only the ref stops the second charge.
    await spend.settle(workspaceId, { assetId, credits: 3 });
    await spend.settle(workspaceId, { assetId, credits: 3 });

    const rows = await prisma.spendLedger.findMany({
      where: { workspaceId, ref: `mediagen:${assetId}` },
    });
    expect(rows).toHaveLength(1);
  });

  it('leaves no vendor unmetered', async () => {
    const result = await report.report(workspaceId, 30);

    expect(result.unmetered).toEqual([]);
    expect(result.rates.every((r) => r.metered)).toBe(true);
    // And the CONTENT spend is now visible alongside every other vendor.
    expect(result.byChannel.find((c) => c.channel === 'CONTENT')!.spend).toBeGreaterThan(0);
  });
});
