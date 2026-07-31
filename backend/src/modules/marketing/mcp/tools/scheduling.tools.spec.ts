import { McpToolRegistry } from '../mcp-tool-registry';
import { registerSchedulingTools } from './scheduling.tools';

const deps = () => ({
  bookings: {
    listBookings: jest.fn(),
    availability: jest.fn(),
    book: jest.fn(),
  } as any,
  entitlements: { getEffective: jest.fn(async () => ({ features: { funnels: true } })) } as any,
});

describe('scheduling MCP tools', () => {
  it('registers both booking reads ungated under tasks.read', () => {
    const registry = new McpToolRegistry();
    registerSchedulingTools(registry, deps());

    const list = registry.get('jeeta.list_bookings')!;
    expect(list.risk).toBe('READ');
    expect(list.requiresApproval).toBe(false);
    expect(list.scopes).toEqual(['tasks.read']);
    expect(list.inputSchema).toBeDefined();

    const availability = registry.get('jeeta.get_booking_availability')!;
    expect(availability.risk).toBe('READ');
    expect(availability.requiresApproval).toBe(false);
    expect(availability.scopes).toEqual(['tasks.read']);
    expect(availability.inputSchema).toBeDefined();
  });

  it('is hidden from a caller lacking tasks.read', () => {
    const registry = new McpToolRegistry();
    registerSchedulingTools(registry, deps());
    expect(registry.list(['reports.read']).map((t) => t.name)).toEqual([]);
  });

  it('jeeta.list_bookings forwards filters to BookingService.listBookings', async () => {
    const registry = new McpToolRegistry();
    const d = deps();
    d.bookings.listBookings.mockResolvedValue([{ id: 'bk1' }]);
    registerSchedulingTools(registry, d);
    const out = await registry
      .get('jeeta.list_bookings')!
      .handler(
        { workspaceId: 'ws1', grantedScopes: ['tasks.read'] },
        { calendarId: 'cal1', status: 'CONFIRMED', from: '2026-07-01', to: '2026-07-28' },
      );
    expect(d.bookings.listBookings).toHaveBeenCalledWith('ws1', {
      calendarId: 'cal1',
      status: 'CONFIRMED',
      from: '2026-07-01',
      to: '2026-07-28',
    });
    expect(out).toEqual([{ id: 'bk1' }]);
  });

  it('jeeta.get_booking_availability forwards to BookingService.availability', async () => {
    const registry = new McpToolRegistry();
    const d = deps();
    d.bookings.availability.mockResolvedValue(['2026-07-29T09:00:00.000Z']);
    registerSchedulingTools(registry, d);
    const out = await registry
      .get('jeeta.get_booking_availability')!
      .handler(
        { workspaceId: 'ws1', grantedScopes: ['tasks.read'] },
        { calendarId: 'cal1', from: '2026-07-29T00:00:00.000Z', to: '2026-08-05T00:00:00.000Z' },
      );
    expect(d.bookings.availability).toHaveBeenCalledWith(
      'ws1',
      'cal1',
      '2026-07-29T00:00:00.000Z',
      '2026-08-05T00:00:00.000Z',
    );
    expect(out).toEqual(['2026-07-29T09:00:00.000Z']);
  });
});

/**
 * Faz 5 D5 — `jeeta.create_booking`, and the `funnels` gate the two reads
 * shipped without.
 */
describe('jeeta.create_booking', () => {
  const ctx = { workspaceId: 'ws1', grantedScopes: ['settings.manage'] };
  const args = {
    calendarId: 'cal1',
    start: '2026-08-03T09:00:00.000Z',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
  };

  /**
   * The classification, pinned by name. `BookingService.book()` is not a row
   * write: on a CONFIRMED booking it emails the attendee a confirmation with an
   * ICS attachment, pushes the event into the workspace's connected Google or
   * Outlook calendar (which invites the attendee again), creates or dedupes a
   * Lead and auto-assigns an owner, schedules reminder jobs, fires the
   * `booking.created` workflow trigger and posts to Slack. Every one of those
   * is visible to somebody outside the workspace or to a teammate's calendar,
   * and the slot itself is taken from a real person's day. It is gated.
   */
  it('is approval-gated as a SEND, with the exact slot as the supersede key', () => {
    const registry = new McpToolRegistry();
    registerSchedulingTools(registry, deps());
    const tool = registry.get('jeeta.create_booking')!;
    expect(tool.risk).toBe('WRITE');
    expect(tool.requiresApproval).toBe(true);
    expect(tool.approvalKind).toBe('SEND');
    expect(tool.scopes).toEqual(['settings.manage']);
    expect(tool.domain).toBe('scheduling');
    expect(tool.defer).toBe(true);
    // A retried turn must not book the same person into the same slot twice.
    expect(tool.resourceType).toBe('booking_slot');
    expect(tool.resourceIdFrom!(args)).toBe('cal1@2026-08-03T09:00:00.000Z');
  });

  it('books through BookingService.book with the caller workspace and calendar', async () => {
    const registry = new McpToolRegistry();
    const d = deps();
    d.bookings.book.mockResolvedValue({ id: 'bk9', startAt: new Date(), token: 'bk_x' });
    registerSchedulingTools(registry, d);
    await registry.get('jeeta.create_booking')!.handler(ctx, { ...args, notes: 'brought by MCP' });
    expect(d.bookings.book).toHaveBeenCalledWith('ws1', 'cal1', {
      start: args.start,
      name: args.name,
      email: args.email,
      notes: 'brought by MCP',
    });
  });

  it('requires a real slot start and an attendee name', () => {
    const registry = new McpToolRegistry();
    registerSchedulingTools(registry, deps());
    const schema = registry.get('jeeta.create_booking')!.inputSchema;
    expect(schema.safeParse({ calendarId: 'c', start: args.start }).success).toBe(false);
    expect(schema.safeParse({ calendarId: 'c', name: 'A' }).success).toBe(false);
    expect(schema.safeParse({ calendarId: 'c', start: args.start, name: 'A' }).success).toBe(true);
  });
});

/**
 * The gap D3 flagged for the inbox, in its scheduling form: over REST every
 * booking route is `@RequiresFeature('funnels')` on `MarketingBookingController`,
 * but the MCP tools shipped with no entitlement check at all — so a workspace
 * whose package excludes the funnels/calendar module could still read and
 * (from D5) write its calendar over MCP.
 */
describe('scheduling feature gate', () => {
  const unentitled = () => {
    const d = deps();
    d.entitlements.getEffective = jest.fn(async () => ({ features: {} }));
    const registry = new McpToolRegistry();
    registerSchedulingTools(registry, d);
    return { registry, d };
  };

  it.each([
    ['jeeta.list_bookings', {}],
    ['jeeta.get_booking_availability', { calendarId: 'c', from: 'a', to: 'b' }],
    ['jeeta.create_booking', { calendarId: 'c', start: '2026-08-03T09:00:00.000Z', name: 'A' }],
  ])('%s refuses cleanly without the funnels feature', async (name, args) => {
    const { registry, d } = unentitled();
    await expect(
      registry.get(name)!.handler({ workspaceId: 'ws1', grantedScopes: [] }, args),
    ).rejects.toMatchObject({ response: { code: 'FEATURE_NOT_IN_PACKAGE', feature: 'funnels' } });
    expect(d.bookings.listBookings).not.toHaveBeenCalled();
    expect(d.bookings.availability).not.toHaveBeenCalled();
    expect(d.bookings.book).not.toHaveBeenCalled();
  });
});
