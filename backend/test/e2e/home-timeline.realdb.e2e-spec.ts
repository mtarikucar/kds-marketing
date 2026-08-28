import { randomUUID } from 'crypto';
import { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../../src/prisma/prisma.service';
import { HomeTimelineService } from '../../src/modules/marketing/analytics/home-timeline.service';
import { createRealDbTestApp, closeTestApp, realDbEnabled } from '../utils/test-app';

/**
 * The home calendar's five source reads against REAL Postgres.
 *
 * Every unit test of this service hands `findMany` a mock, and a mock accepts
 * ANY `where` you give it. So the unit suite proves the argument we passed and
 * nothing about whether Postgres will execute it. That gap is not theoretical:
 * `ChannelTariffService.resolve()` shipped `workspaceId: { in: [id, null] }` —
 * a shape Prisma refuses (a nullable String filter takes a list of strings, or
 * null, never a list with null inside) — and threw on every call for eight
 * weeks behind a fully green suite. The symptom was "no vendor spend was ever
 * priced", not an error.
 *
 * `timeline()` fails the same quiet way by design: a rejected source is caught
 * by `soft`, named in `unread`, and the list simply comes back shorter. So the
 * load-bearing assertion here is `unread === []` — that is the eight-week bug
 * guard, and it can only be made against a real query planner.
 *
 * Beyond execution, this pins the three filter shapes that only real SQL can
 * settle: the status filters (`in`, `not`) actually exclude, the date window
 * actually bounds, and neither ever reaches across the tenant line.
 *
 * Fixtures sit ALONGSIDE whatever the migrations seeded rather than on an empty
 * table, because that is the only state production is ever in; assertions look
 * for our own titles rather than counting rows.
 *
 * Opt-in via E2E_REAL_DB=1.
 */
const describeRealDb = realDbEnabled() ? describe : describe.skip;

describeRealDb('Home timeline — real DB (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let svc: HomeTimelineService;

  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const SEED = `home-${randomUUID().slice(0, 8)}`;

  /**
   * The window sits ~400 days out, ANCHORED ON NOW rather than hard-coded.
   *
   * Anchored, because the `system` lane reads the live SchedulerRegistry and
   * every cron's `nextAt` is within a day of the wall clock: a fixed literal
   * date would quietly start catching real cron entries once the calendar
   * reached it, and the suite would begin flaking years after it was written.
   * Far out, so no cron can land inside it today either — leaving `items` made
   * of exactly the rows this spec seeded.
   *
   * Two assertions DEPEND on that emptiness: the exact-title set below and the
   * neighbour's exact-title set in the isolation test. Shorten this offset and
   * a real cron drifts into the window, and the failure presents as a bogus
   * tenant-isolation bug rather than as what it is.
   */
  const from = new Date(Date.now() + 400 * 86_400_000);
  const to = new Date(from.getTime() + 7 * 86_400_000);
  const inside = new Date(from.getTime() + 86_400_000);
  /**
   * A day either side of the window. EVERY source gets a row at BOTH — with a
   * row on only one side, deleting half a range filter (`lte` but not `gte`)
   * passes the whole suite, and a source with no out-of-window row at all is
   * simply unguarded. Eight rows for eight bounds.
   */
  const before = new Date(from.getTime() - 86_400_000);
  const outside = new Date(to.getTime() + 86_400_000);

  const titles = (items: Array<{ title: string }>) => items.map((i) => i.title);

  beforeAll(async () => {
    if (!realDbEnabled()) return;

    ({ app, prisma } = await createRealDbTestApp());
    svc = app.get(HomeTimelineService);

    await prisma.workspace.createMany({
      data: [
        { id: workspaceId, slug: `${SEED}-a`, name: 'Home A', productName: 'Home A' },
        { id: otherWorkspaceId, slug: `${SEED}-b`, name: 'Home B', productName: 'Home B' },
      ],
    });

    // MarketingTask.assignedTo is a hard FK (onDelete: Restrict), so each
    // workspace needs a real rep before it can own a task.
    await prisma.marketingUser.createMany({
      data: [
        {
          id: userId,
          workspaceId,
          email: `rep-a-${SEED}@example.com`,
          password: 'seed-not-a-real-hash',
          firstName: 'Remy',
          lastName: 'Rep',
          role: 'REP',
        },
        {
          id: otherUserId,
          workspaceId: otherWorkspaceId,
          email: `rep-b-${SEED}@example.com`,
          password: 'seed-not-a-real-hash',
          firstName: 'Rita',
          lastName: 'Rakip',
          role: 'REP',
        },
      ],
    });

    await prisma.marketingTask.createMany({
      data: [
        // Kept: PENDING, inside the window.
        { workspaceId, assignedToId: userId, title: 'Bizim görev', type: 'CALL', status: 'PENDING', dueDate: inside },
        // Dropped by `status: { in: ['PENDING', 'IN_PROGRESS'] }`.
        { workspaceId, assignedToId: userId, title: 'Tamamlanan görev', type: 'CALL', status: 'COMPLETED', dueDate: inside },
        // Dropped by the window: PENDING, but a day either side of it.
        { workspaceId, assignedToId: userId, title: 'Pencere dışı görev', type: 'CALL', status: 'PENDING', dueDate: outside },
        { workspaceId, assignedToId: userId, title: 'Pencere öncesi görev', type: 'CALL', status: 'PENDING', dueDate: before },
        // Another tenant's, otherwise identical to the kept one.
        { workspaceId: otherWorkspaceId, assignedToId: otherUserId, title: 'Yabancı görev', type: 'CALL', status: 'PENDING', dueDate: inside },
      ],
    });

    // `Booking.calendarId` carries no FK (unlike BookingCalendarMember's and
    // BookingAvailability's, which do reference BookingCalendar), so a bare uuid
    // stands in for a calendar this spec never needs to read.
    const calendarId = randomUUID();
    await prisma.booking.createMany({
      data: [
        { workspaceId, calendarId, name: 'Bizim randevu', startAt: inside, endAt: new Date(inside.getTime() + 1800_000), status: 'CONFIRMED', token: randomUUID() },
        { workspaceId, calendarId, name: 'İptal randevu', startAt: inside, endAt: new Date(inside.getTime() + 1800_000), status: 'CANCELLED', token: randomUUID() },
        { workspaceId, calendarId, name: 'Pencere dışı randevu', startAt: outside, endAt: new Date(outside.getTime() + 1800_000), status: 'CONFIRMED', token: randomUUID() },
        { workspaceId, calendarId, name: 'Pencere öncesi randevu', startAt: before, endAt: new Date(before.getTime() + 1800_000), status: 'CONFIRMED', token: randomUUID() },
        { workspaceId: otherWorkspaceId, calendarId, name: 'Yabancı randevu', startAt: inside, endAt: new Date(inside.getTime() + 1800_000), status: 'CONFIRMED', token: randomUUID() },
      ],
    });

    const social = {
      brief: {},
      cadence: { daysOfWeek: [1], timeOfDay: '09:00' },
      automationMode: 'APPROVAL',
      planningMode: 'USER_TOPICS',
      createdById: userId,
    } as const;
    await prisma.socialCampaign.createMany({
      data: [
        // DRAFT survives on purpose: a draft whose date has arrived is exactly
        // the anomaly the calendar exists to surface.
        { ...social, workspaceId, name: 'Sosyal taslak', status: 'DRAFT', startDate: inside },
        { ...social, workspaceId, name: 'Sosyal iptal', status: 'CANCELLED', startDate: inside },
        { ...social, workspaceId, name: 'Sosyal pencere dışı', status: 'ACTIVE', startDate: outside },
        { ...social, workspaceId, name: 'Sosyal pencere öncesi', status: 'ACTIVE', startDate: before },
        { ...social, workspaceId: otherWorkspaceId, createdById: otherUserId, name: 'Yabancı sosyal', status: 'ACTIVE', startDate: inside },
      ],
    });

    await prisma.campaign.createMany({
      data: [
        { workspaceId, name: 'Taslak kampanya', channel: 'EMAIL', body: 'gövde', status: 'DRAFT', scheduledAt: inside },
        { workspaceId, name: 'İptal kampanya', channel: 'EMAIL', body: 'gövde', status: 'CANCELLED', scheduledAt: inside },
        { workspaceId, name: 'Pencere dışı kampanya', channel: 'EMAIL', body: 'gövde', status: 'DRAFT', scheduledAt: outside },
        { workspaceId, name: 'Pencere öncesi kampanya', channel: 'EMAIL', body: 'gövde', status: 'DRAFT', scheduledAt: before },
        // `scheduledAt` is nullable. An unscheduled campaign MUST be excluded by
        // the range filter — the mapper dereferences `scheduledAt!`, so one that
        // slipped through would not shorten the list, it would reject the whole
        // timeline outside the per-source catch.
        { workspaceId, name: 'Zamansız kampanya', channel: 'EMAIL', body: 'gövde', status: 'DRAFT', scheduledAt: null },
        { workspaceId: otherWorkspaceId, name: 'Yabancı kampanya', channel: 'EMAIL', body: 'gövde', status: 'SCHEDULED', scheduledAt: inside },
      ],
    });
  });

  afterAll(async () => {
    if (!realDbEnabled() || !prisma) return;
    // FK-safe order: tasks hold a Restrict FK to users, so they go first.
    //
    // Tolerance here buys "teardown never throws", NOT "no rows leak" — under
    // that Restrict FK a failed task delete GUARANTEES the user delete fails
    // too, and swallowing both makes the leak silent rather than preventing it.
    // What actually keeps a stranded run harmless is that both workspace ids
    // are freshly minted, so leftovers can never collide with a later run.
    const ids = { in: [workspaceId, otherWorkspaceId] };
    const del = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch {
        /* best-effort cleanup — never let teardown throw */
      }
    };
    try {
      await del(() => prisma.marketingTask.deleteMany({ where: { workspaceId: ids } }));
      await del(() => prisma.booking.deleteMany({ where: { workspaceId: ids } }));
      await del(() => prisma.socialCampaign.deleteMany({ where: { workspaceId: ids } }));
      await del(() => prisma.campaign.deleteMany({ where: { workspaceId: ids } }));
      await del(() => prisma.marketingUser.deleteMany({ where: { workspaceId: ids } }));
      await del(() => prisma.workspace.deleteMany({ where: { id: ids } }));
    } finally {
      await closeTestApp(app);
    }
  });

  it('executes every source query against real Postgres', async () => {
    const out = await svc.timeline(workspaceId, from, to);

    // THE assertion. A `where` Postgres rejects does not throw out of here — it
    // is caught, named, and the calendar comes back quietly short. An empty
    // `unread` is the only proof all five sources actually answered.
    expect(out.unread).toEqual([]);
    expect(out.truncated).toEqual([]);
    expect(out.from).toBe(from.toISOString());
    expect(out.to).toBe(to.toISOString());
  });

  it('returns one row from each of the four database sources', async () => {
    const out = await svc.timeline(workspaceId, from, to);

    expect(titles(out.items).sort()).toEqual(
      ['Bizim görev', 'Bizim randevu', 'Sosyal taslak', 'Taslak kampanya'].sort(),
    );
    expect(out.items.map((i) => i.kind).sort()).toEqual(
      ['appointment', 'campaign', 'campaign', 'task'].sort(),
    );
  });

  it('never returns another tenant’s row, from any source', async () => {
    const out = await svc.timeline(workspaceId, from, to);
    const seen = titles(out.items);

    // Every foreign row is an in-window, non-cancelled twin of one we keep, so
    // only the workspaceId filter can be what excludes it.
    expect(seen).toContain('Bizim görev');
    expect(seen).not.toContain('Yabancı görev');
    expect(seen).not.toContain('Yabancı randevu');
    expect(seen).not.toContain('Yabancı sosyal');
    expect(seen).not.toContain('Yabancı kampanya');

    // And the other side of the line: the neighbour sees its own four and none
    // of ours, so this is a filter rather than a hard-coded exclusion.
    const theirs = titles((await svc.timeline(otherWorkspaceId, from, to)).items);
    expect(theirs.sort()).toEqual(['Yabancı görev', 'Yabancı kampanya', 'Yabancı randevu', 'Yabancı sosyal']);
  });

  it('applies the status filters in SQL, keeping DRAFT and dropping CANCELLED/COMPLETED', async () => {
    const out = await svc.timeline(workspaceId, from, to);
    const seen = titles(out.items);

    // `status: { in: ['PENDING', 'IN_PROGRESS'] }`
    expect(seen).not.toContain('Tamamlanan görev');
    // `status: 'CONFIRMED'`
    expect(seen).not.toContain('İptal randevu');
    // `status: { not: 'CANCELLED' }` over a native PG enum…
    expect(seen).toContain('Sosyal taslak');
    expect(seen).not.toContain('Sosyal iptal');
    // …and over a plain String column.
    expect(seen).toContain('Taslak kampanya');
    expect(seen).not.toContain('İptal kampanya');

    // The kept rows carry the status through to the item, not a rewritten one.
    const statuses = Object.fromEntries(out.items.map((i) => [i.title, i.status]));
    expect(statuses['Bizim görev']).toBe('PENDING');
    expect(statuses['Sosyal taslak']).toBe('DRAFT');
    expect(statuses['Taslak kampanya']).toBe('DRAFT');
  });

  it('bounds the window at BOTH ends for all four sources, and excludes rows with no date at all', async () => {
    const out = await svc.timeline(workspaceId, from, to);
    const seen = titles(out.items);

    // One qualifying row per source a day PAST `to`…
    expect(seen).not.toContain('Pencere dışı görev');
    expect(seen).not.toContain('Pencere dışı randevu');
    expect(seen).not.toContain('Sosyal pencere dışı');
    expect(seen).not.toContain('Pencere dışı kampanya');
    // …and one per source a day BEFORE `from`. Both halves of all four ranges
    // are pinned: with a row on one side only, dropping the other bound is a
    // mutation the whole suite survives.
    expect(seen).not.toContain('Pencere öncesi görev');
    expect(seen).not.toContain('Pencere öncesi randevu');
    expect(seen).not.toContain('Sosyal pencere öncesi');
    expect(seen).not.toContain('Pencere öncesi kampanya');

    // Widening past all eight lets every one of them in — proof the exclusions
    // above are the range doing its job rather than the rows failing to seed.
    // Absence asserted on its own is a tautology: a typo'd title satisfies it.
    const wide = await svc.timeline(
      workspaceId,
      new Date(before.getTime() - 86_400_000),
      new Date(outside.getTime() + 86_400_000),
    );
    expect(titles(wide.items)).toEqual(
      expect.arrayContaining([
        'Pencere dışı görev',
        'Pencere dışı randevu',
        'Sosyal pencere dışı',
        'Pencere dışı kampanya',
        'Pencere öncesi görev',
        'Pencere öncesi randevu',
        'Sosyal pencere öncesi',
        'Pencere öncesi kampanya',
      ]),
    );
    // The unscheduled campaign stays out of ANY window — it has no date to be in.
    expect(titles(wide.items)).not.toContain('Zamansız kampanya');
    expect(wide.unread).toEqual([]);
  });
});
