import { MarketingHomeController } from './marketing-home.controller';
import { HomeTimelineService } from '../analytics/home-timeline.service';
import { MarketingUserPayload } from '../types';

/**
 * The window is the only logic this controller owns: everything else it does is
 * hand the service a workspaceId. So the spec is entirely about which `from`/`to`
 * the service is handed — constructed directly with a stub, no Nest context,
 * matching the sibling controller specs.
 */
describe('MarketingHomeController — window defaulting', () => {
  const ACTOR = { workspaceId: 'ws-1' } as MarketingUserPayload;
  const DAY = 86_400_000;

  let calls: Array<{ workspaceId: string; from: Date; to: Date }>;
  let controller: MarketingHomeController;

  beforeEach(() => {
    calls = [];
    const stub = {
      timeline: (workspaceId: string, from: Date, to: Date) => {
        calls.push({ workspaceId, from, to });
        return Promise.resolve({ from: '', to: '', items: [], unread: [], truncated: [] });
      },
    } as unknown as HomeTimelineService;
    controller = new MarketingHomeController(stub);
  });

  const only = () => {
    expect(calls).toHaveLength(1);
    return calls[0];
  };

  it('defaults to a 7-day window starting about now when neither bound is given', async () => {
    const before = Date.now();
    await controller.timeline(ACTOR);
    const after = Date.now();

    const { workspaceId, from, to } = only();
    expect(workspaceId).toBe('ws-1');
    expect(from.getTime()).toBeGreaterThanOrEqual(before);
    expect(from.getTime()).toBeLessThanOrEqual(after);
    expect(to.getTime() - from.getTime()).toBe(7 * DAY);
  });

  it('passes both bounds through when both parse', async () => {
    await controller.timeline(ACTOR, '2026-03-01T00:00:00.000Z', '2026-03-05T12:30:00.000Z');

    const { from, to } = only();
    expect(from.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(to.toISOString()).toBe('2026-03-05T12:30:00.000Z');
  });

  it('honours a given `from` and derives `to` from it, not from now', async () => {
    await controller.timeline(ACTOR, '2026-03-01T00:00:00.000Z');

    const { from, to } = only();
    expect(from.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(to.toISOString()).toBe('2026-03-08T00:00:00.000Z');
  });

  it('honours a given `to` while `from` defaults to now', async () => {
    const before = Date.now();
    await controller.timeline(ACTOR, undefined, '2026-03-05T12:30:00.000Z');

    const { from, to } = only();
    expect(from.getTime()).toBeGreaterThanOrEqual(before);
    expect(to.toISOString()).toBe('2026-03-05T12:30:00.000Z');
  });

  // `new Date('banana')` is an Invalid Date whose getTime() is NaN. Reaching the
  // service with one would either throw in Prisma or, worse, read as an empty
  // calendar — "nothing is scheduled" when the truth is "your query was junk".
  it.each(['banana', '', '2026-13-45', 'null'])(
    'falls back to a live now-anchored window for unparseable from=%p',
    async (garbage) => {
      const before = Date.now();
      await controller.timeline(ACTOR, garbage);
      const after = Date.now();

      const { from, to } = only();
      expect(Number.isNaN(from.getTime())).toBe(false);
      expect(from.getTime()).toBeGreaterThanOrEqual(before);
      expect(from.getTime()).toBeLessThanOrEqual(after);
      expect(to.getTime() - from.getTime()).toBe(7 * DAY);
    },
  );

  it('falls back to the +7d default for an unparseable `to`, keeping a valid `from`', async () => {
    await controller.timeline(ACTOR, '2026-03-01T00:00:00.000Z', 'banana');

    const { from, to } = only();
    expect(from.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(to.toISOString()).toBe('2026-03-08T00:00:00.000Z');
  });

  it('returns the service result untouched — `unread` and `truncated` stay separate', async () => {
    const payload = {
      from: 'a',
      to: 'b',
      items: [{ kind: 'task' as const, at: 'c', title: 't', id: '1' }],
      unread: ['görevler'],
      truncated: ['kampanyalar'],
    };
    const controllerWithPayload = new MarketingHomeController({
      timeline: () => Promise.resolve(payload),
    } as unknown as HomeTimelineService);

    await expect(controllerWithPayload.timeline(ACTOR)).resolves.toBe(payload);
  });
});
