import { randomUUID } from 'crypto';
import { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../../src/prisma/prisma.service';
import { EstimatesService } from '../../src/modules/marketing/estimates/estimates.service';
import { BookingService } from '../../src/modules/marketing/sites/booking.service';
import { createRealDbTestApp, closeTestApp, realDbEnabled } from '../utils/test-app';

/**
 * The person record card's two NEW reads, against REAL Postgres.
 *
 * `Estimate.leadId` and `Booking.leadId` are plain nullable columns with NO
 * Prisma relation to `Lead` — they are soft references, the multi-tenant
 * pattern this schema uses throughout. That is exactly why these two filters
 * cannot be trusted to a mocked Prisma: a mock will happily accept
 * `where: { leadId }` on a column that does not exist, or a `workspaceId`
 * predicate that the real query planner would ignore. The card shows one
 * person's money and one person's meetings, so "whose row is this" has to be
 * answered by the database.
 *
 * Every `workspaceId` predicate gets its OWN assertion here. Deleting either
 * one from the service must drop a named test rather than quietly widening a
 * read to the whole cluster — the two filters are separate code paths in
 * separate services, and a shared "isolation" test would let one of them rot
 * behind the other.
 *
 * Opt-in via E2E_REAL_DB=1, like the other real-DB suites.
 */
const describeRealDb = realDbEnabled() ? describe : describe.skip;

describeRealDb('Person record card reads — real DB (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let estimates: EstimatesService;
  let booking: BookingService;

  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const leadId = randomUUID();
  const otherLeadId = randomUUID();
  const calendarId = randomUUID();
  const otherCalendarId = randomUUID();

  beforeAll(async () => {
    ({ app, prisma } = await createRealDbTestApp());
    estimates = app.get(EstimatesService);
    booking = app.get(BookingService);

    for (const [id, ws] of [
      [leadId, workspaceId],
      [otherLeadId, otherWorkspaceId],
    ]) {
      await prisma.lead.create({
        data: {
          id,
          workspaceId: ws,
          businessName: `biz-${id.slice(0, 6)}`,
          contactPerson: 'Test',
          businessType: 'CAFE',
          source: 'OTHER',
        },
      });
    }

    const estimate = (ws: string, lead: string | null, number: string) =>
      prisma.estimate.create({
        data: {
          workspaceId: ws,
          leadId: lead,
          number,
          items: [],
          total: 1000,
          publicToken: `es_${randomUUID()}`,
        },
      });
    await estimate(workspaceId, leadId, 'EST-MINE-1');
    await estimate(workspaceId, leadId, 'EST-MINE-2');
    // Same workspace, a DIFFERENT person — the leadId predicate's own job.
    await estimate(workspaceId, null, 'EST-NOBODY');
    // The cross-tenant trap: another workspace holding a row that carries THIS
    // workspace's leadId. Only the workspaceId predicate keeps it out.
    await estimate(otherWorkspaceId, leadId, 'EST-OTHER-WS');

    for (const [id, ws] of [
      [calendarId, workspaceId],
      [otherCalendarId, otherWorkspaceId],
    ]) {
      await prisma.bookingCalendar.create({
        data: {
          id,
          workspaceId: ws,
          name: `cal-${id.slice(0, 6)}`,
          slug: `s-${id.slice(0, 8)}`,
          availability: {},
        },
      });
    }

    const book = (ws: string, cal: string, lead: string | null, name: string, daysFromNow: number) =>
      prisma.booking.create({
        data: {
          workspaceId: ws,
          calendarId: cal,
          leadId: lead,
          name,
          startAt: new Date(Date.now() + daysFromNow * 86_400_000),
          endAt: new Date(Date.now() + daysFromNow * 86_400_000 + 1_800_000),
          token: randomUUID(),
        },
      });
    // A meeting that ALREADY HAPPENED, well outside the list screen's rolling
    // 24h window. The record card is a history, so this row is the point.
    await book(workspaceId, calendarId, leadId, 'BK-PAST', -30);
    await book(workspaceId, calendarId, leadId, 'BK-FUTURE', 7);
    await book(workspaceId, calendarId, null, 'BK-NOBODY', 7);
    await book(otherWorkspaceId, otherCalendarId, leadId, 'BK-OTHER-WS', 7);
  });

  afterAll(async () => {
    for (const ws of [workspaceId, otherWorkspaceId]) {
      await prisma.booking.deleteMany({ where: { workspaceId: ws } });
      await prisma.bookingCalendar.deleteMany({ where: { workspaceId: ws } });
      await prisma.estimate.deleteMany({ where: { workspaceId: ws } });
      await prisma.lead.deleteMany({ where: { workspaceId: ws } });
    }
    await closeTestApp(app);
  });

  describe('estimates', () => {
    it('returns only this person’s quotes', async () => {
      const rows = await estimates.list(workspaceId, leadId);

      expect(rows.map((e) => e.number).sort()).toEqual(['EST-MINE-1', 'EST-MINE-2']);
    });

    // The estimates `workspaceId` predicate, on its own assertion.
    it('does not reach into another workspace holding the same leadId', async () => {
      const rows = await estimates.list(workspaceId, leadId);

      expect(rows.map((e) => e.number)).not.toContain('EST-OTHER-WS');
    });
  });

  describe('appointments', () => {
    it('returns this person’s appointments, past ones included', async () => {
      const rows = await booking.listBookings(workspaceId, { leadId });

      expect(rows.map((b) => b.name).sort()).toEqual(['BK-FUTURE', 'BK-PAST']);
    });

    // The bookings `workspaceId` predicate, on its own assertion.
    it('does not reach into another workspace holding the same leadId', async () => {
      const rows = await booking.listBookings(workspaceId, { leadId });

      expect(rows.map((b) => b.name)).not.toContain('BK-OTHER-WS');
    });
  });
});
