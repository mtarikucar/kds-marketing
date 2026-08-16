import { PageViewStatsService } from './page-view-stats.service';

/**
 * The counter's whole value is that it is safe to leave on. That means the
 * route it stores can never carry a record id (leaking data into analytics and
 * blowing up cardinality), and a failure here can never surface to the user.
 */
describe('PageViewStatsService', () => {
  const WS = 'ws-1';
  let prisma: any;
  let svc: PageViewStatsService;

  beforeEach(() => {
    prisma = { pageViewStat: { upsert: jest.fn().mockResolvedValue({}), groupBy: jest.fn() } };
    svc = new PageViewStatsService(prisma);
  });

  describe('normalise', () => {
    it('keeps a plain route pattern', () => {
      expect(PageViewStatsService.normalise('/leads')).toBe('/leads');
      expect(PageViewStatsService.normalise('/settings/custom-fields')).toBe('/settings/custom-fields');
    });

    it('collapses id-shaped segments, whatever the id looks like', () => {
      // The client is supposed to send the pattern; this is what happens when
      // it sends the real URL instead. Both the leak and the cardinality
      // explosion have to die here, not in the database.
      expect(PageViewStatsService.normalise('/leads/9f2c1d4e-1111-4222-8333-444455556666')).toBe('/leads/:id');
      expect(PageViewStatsService.normalise('/leads/12345/edit')).toBe('/leads/:id/edit');
      expect(PageViewStatsService.normalise('/memberships/courses/ckq1x8p2h0000qwer1234asdf')).toBe(
        '/memberships/courses/:id',
      );
      expect(PageViewStatsService.normalise('/leads/:id')).toBe('/leads/:id');
    });

    it('drops the query string and fragment — that is where the PII would be', () => {
      expect(PageViewStatsService.normalise('/leads?email=a@b.com&q=ali')).toBe('/leads');
      expect(PageViewStatsService.normalise('/inbox#thread-9')).toBe('/inbox');
    });

    it('refuses anything that is not a rooted path', () => {
      expect(PageViewStatsService.normalise('https://evil.example/x')).toBeNull();
      expect(PageViewStatsService.normalise('leads')).toBeNull();
      expect(PageViewStatsService.normalise('')).toBeNull();
      expect(PageViewStatsService.normalise(null)).toBeNull();
      expect(PageViewStatsService.normalise(42)).toBeNull();
    });

    it('treats one absurdly long segment as an id rather than storing it', () => {
      // Unbounded text in a path segment is data by definition, so it collapses
      // like any other id — that is the cardinality guarantee, not the length cap.
      expect(PageViewStatsService.normalise('/' + 'a'.repeat(200))).toBe('/:id');
    });

    it('refuses a path made of many short segments — the length cap still bites', () => {
      expect(PageViewStatsService.normalise('/ab'.repeat(50))).toBeNull();
    });
  });

  describe('periodOf / recentPeriods', () => {
    it('buckets by UTC month', () => {
      expect(PageViewStatsService.periodOf(new Date('2026-08-17T22:00:00Z'))).toBe('2026-08');
      expect(PageViewStatsService.periodOf(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01');
    });

    it('walks back across a year boundary', () => {
      expect(PageViewStatsService.recentPeriods(3, new Date('2026-01-15T00:00:00Z'))).toEqual([
        '2026-01',
        '2025-12',
        '2025-11',
      ]);
    });

    it('clamps the window rather than trusting the caller', () => {
      expect(PageViewStatsService.recentPeriods(0)).toHaveLength(1);
      expect(PageViewStatsService.recentPeriods(999)).toHaveLength(24);
    });
  });

  describe('record', () => {
    it('increments one counter per workspace, route and month', async () => {
      await svc.record(WS, '/leads', new Date('2026-08-17T10:00:00Z'));
      expect(prisma.pageViewStat.upsert).toHaveBeenCalledWith({
        where: { workspaceId_route_period: { workspaceId: WS, route: '/leads', period: '2026-08' } },
        create: { workspaceId: WS, route: '/leads', period: '2026-08', count: 1 },
        update: { count: { increment: 1 } },
      });
    });

    it('writes nothing at all for a route it could not make safe', async () => {
      await svc.record(WS, 'https://evil.example/x');
      expect(prisma.pageViewStat.upsert).not.toHaveBeenCalled();
    });

    it('swallows a database failure — analytics must never break a navigation', async () => {
      prisma.pageViewStat.upsert.mockRejectedValue(new Error('db down'));
      await expect(svc.record(WS, '/leads')).resolves.toBeUndefined();
    });
  });

  describe('summary', () => {
    it('sums across the window and returns busiest first', async () => {
      prisma.pageViewStat.groupBy.mockResolvedValue([
        { route: '/order-forms', _sum: { count: 0 } },
        { route: '/leads', _sum: { count: 91 } },
        { route: '/inbox', _sum: { count: 12 } },
      ]);
      const out = await svc.summary(WS, 3);
      expect(out.routes.map((r) => r.route)).toEqual(['/leads', '/inbox', '/order-forms']);
      expect(out.periods).toHaveLength(3);
      expect(prisma.pageViewStat.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ workspaceId: WS }) }),
      );
    });
  });
});
