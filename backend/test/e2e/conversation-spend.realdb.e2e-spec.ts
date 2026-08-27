import { randomUUID } from 'crypto';
import { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ConversationSpendService } from '../../src/modules/marketing/budget/conversation-spend.service';
import { createRealDbTestApp, closeTestApp, realDbEnabled } from '../utils/test-app';

/**
 * The carrier half of the settle path, against REAL Postgres.
 *
 * This side failed differently from research and is worth pinning separately:
 * `price()` is NOT inside a try/catch here, so the broken `resolve()` threw
 * straight out of `settleSms`. Both callers `.catch()` it by design — "a
 * billing hiccup must NEVER fail a send that already reached the customer" —
 * which was the correct call and also the reason eight weeks of unmetered SMS
 * looked exactly like eight weeks of nothing happening.
 *
 * The country argument carries real weight here: the seeded carrier tariffs are
 * `country = 'TR'`, so resolving without one silently finds nothing.
 *
 * Opt-in via E2E_REAL_DB=1.
 */
const describeRealDb = realDbEnabled() ? describe : describe.skip;

describeRealDb('Conversation spend settlement — real DB (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let spend: ConversationSpendService;

  const workspaceId = randomUUID();

  beforeAll(async () => {
    ({ app, prisma } = await createRealDbTestApp());
    spend = app.get(ConversationSpendService);

    await prisma.workspace.create({
      data: {
        id: workspaceId,
        slug: `convspend-${workspaceId.slice(0, 8)}`,
        name: 'ConvSpend',
        productName: 'ConvSpend',
      } as never,
    });
  });

  afterAll(async () => {
    await prisma.spendLedger.deleteMany({ where: { workspaceId } });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await closeTestApp(app);
  });

  it('prices a campaign SMS at the seeded TR carrier rate and writes the ledger row', async () => {
    const recipientId = randomUUID();
    const settled = await spend.settleCampaignSms(workspaceId, {
      recipientId,
      text: 'Merhaba, kampanyamızdan haberdar olun.',
    });

    // One GSM-7 segment at the seeded 0.90 TRY.
    expect(settled).not.toBeNull();
    expect(settled!.quantity).toBe(1);
    expect(Number(settled!.amount)).toBeCloseTo(0.9, 2);

    const rows = await prisma.spendLedger.findMany({ where: { workspaceId, channel: 'SMS' } });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].delta)).toBeCloseTo(-0.9, 2);
  });

  it('does not double-bill a replayed settlement for the same recipient', async () => {
    const recipientId = randomUUID();
    const opts = { recipientId, text: 'Tekrar denenen gönderim.' };

    await spend.settleCampaignSms(workspaceId, opts);
    await spend.settleCampaignSms(workspaceId, opts);

    // debitOnce is ref-deduped, so the replay must not add a second row.
    const rows = await prisma.spendLedger.findMany({ where: { workspaceId, ref: recipientId } });
    expect(rows).toHaveLength(1);
  });

  it('charges a longer message by segment count, not per message', async () => {
    const recipientId = randomUUID();
    // Turkish characters force UCS-2, which shortens the per-segment budget —
    // so this is deliberately more than one segment.
    const settled = await spend.settleCampaignSms(workspaceId, {
      recipientId,
      text: 'ğüşiöç '.repeat(40),
    });

    expect(settled!.quantity).toBeGreaterThan(1);
    expect(Number(settled!.amount)).toBeCloseTo(0.9 * settled!.quantity, 2);
  });
});
