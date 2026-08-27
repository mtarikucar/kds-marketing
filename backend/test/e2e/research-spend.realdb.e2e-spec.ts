import { randomUUID } from 'crypto';
import { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ResearchSpendService } from '../../src/modules/marketing/budget/research-spend.service';
import { VendorSpendReportService } from '../../src/modules/marketing/wallet/vendor-spend-report.service';
import { createRealDbTestApp, closeTestApp, realDbEnabled } from '../utils/test-app';

/**
 * The settle path end to end, against REAL Postgres — money in, ledger row out.
 *
 * Fixing `resolve()` proved a price can be found. It did NOT prove the spend
 * lands anywhere, and the two are separated by `ledger.debit()` inside the same
 * swallowing try/catch that hid the resolve failure for eight weeks: any throw
 * below the price lookup produces the identical symptom — `settle()` returns
 * null, nothing is written, and one WARN line is the only trace.
 *
 * Given that every layer of this chain has now failed silently at least once,
 * the fix is not proven by the fix. It is proven by a row in `spend_ledgers`.
 *
 * Opt-in via E2E_REAL_DB=1.
 */
const describeRealDb = realDbEnabled() ? describe : describe.skip;

describeRealDb('Research spend settlement — real DB (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let spend: ResearchSpendService;
  let report: VendorSpendReportService;

  const workspaceId = randomUUID();
  const runId = randomUUID();

  beforeAll(async () => {
    ({ app, prisma } = await createRealDbTestApp());
    spend = app.get(ResearchSpendService);
    report = app.get(VendorSpendReportService);

    await prisma.workspace.create({
      data: {
        id: workspaceId,
        slug: `spend-${workspaceId.slice(0, 8)}`,
        name: 'Spend',
        productName: 'Spend',
      } as never,
    });
  });

  afterAll(async () => {
    await prisma.spendLedger.deleteMany({ where: { workspaceId } });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await closeTestApp(app);
  });

  it('writes a real ledger row priced from the seeded platform tariff', async () => {
    // 3 pages x the seeded FIRECRAWL_PAGE rate of 0.05 TRY.
    const settled = await spend.settle(workspaceId, {
      unit: 'FIRECRAWL_PAGE',
      quantity: 3,
      ref: runId,
    });

    expect(settled).not.toBeNull();
    expect(Number(settled!.amount)).toBeCloseTo(0.15, 2);

    const rows = await prisma.spendLedger.findMany({ where: { workspaceId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].channel).toBe('RESEARCH');
    expect(Number(rows[0].delta)).toBeCloseTo(-0.15, 2);
    expect(Number(rows[0].quantity)).toBe(3);
    expect(Number(rows[0].unitCost)).toBeCloseTo(0.05, 4);
  });

  it('settles an apify run at its own rate, and both land in the report', async () => {
    await spend.settle(workspaceId, { unit: 'APIFY_RUN', quantity: 2, ref: runId });

    const result = await report.report(workspaceId, 30);
    const research = result.byChannel.find((c) => c.channel === 'RESEARCH')!;

    // 0.15 (firecrawl) + 2 x 0.50 (apify) = 1.15 TRY across two entries.
    expect(research.entries).toBe(2);
    expect(research.spend).toBeCloseTo(1.15, 2);
    expect(result.totalSpend).toBeCloseTo(1.15, 2);
    // This number was 0 for every workspace on the platform until v2.269.0.
    expect(result.totalSpend).toBeGreaterThan(0);
  });

  it('records nothing for a zero quantity, rather than a zero-value row', async () => {
    const before = await prisma.spendLedger.count({ where: { workspaceId } });
    expect(await spend.settle(workspaceId, { unit: 'APIFY_RUN', quantity: 0 })).toBeNull();
    expect(await prisma.spendLedger.count({ where: { workspaceId } })).toBe(before);
  });
});
