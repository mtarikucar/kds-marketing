import { McpToolRegistry } from '../mcp-tool-registry';
import { registerSchedulingTools } from './scheduling.tools';

const deps = () => ({
  bookings: {
    listBookings: jest.fn(),
    availability: jest.fn(),
  } as any,
});

describe('scheduling MCP tools', () => {
  it('registers both booking tools ungated under tasks.read', () => {
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

  it('does not register a booking-creation tool', () => {
    const registry = new McpToolRegistry();
    registerSchedulingTools(registry, deps());
    expect(registry.has('jeeta.create_appointment')).toBe(false);
    expect(registry.has('jeeta.create_booking')).toBe(false);
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
