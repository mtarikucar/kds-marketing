import { z } from 'zod';
import { BookingService } from '../../sites/booking.service';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface SchedulingToolDeps {
  bookings: BookingService;
}

/**
 * Booking tools: two ungated reads. There is no `Appointment` model in this
 * schema — the domain is bookings (`BookingCalendar`, `Booking`,
 * `BookingBlackout`) served by `BookingService`. `jeeta.get_booking_availability`
 * uses `availability()` (not `listMemberAvailability` or `publicCalendar`) —
 * it is the method that actually enumerates real bookable slot starts for a
 * date range, honouring the calendar's windows, buffers, min-notice/
 * max-advance policy, existing bookings and blackouts; the other two return
 * raw per-member working-hours config or static calendar metadata, neither of
 * which answers "when is this calendar bookable". There is no
 * `jeeta.create_appointment` / booking-creation tool: booking creation is a
 * customer-facing flow, not something to wire into server-side MCP.
 */
export function registerSchedulingTools(registry: McpToolRegistry, deps: SchedulingToolDeps): void {
  registry.register({
    name: 'jeeta.list_bookings',
    description:
      'List bookings (real appointments, excluding external busy blocks) in this workspace, optionally filtered by calendar, status or time range. Read-only.',
    domain: 'scheduling',
    scopes: ['tasks.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({
      calendarId: z.string().optional().describe('Restrict to bookings on this calendar id.'),
      status: z
        .string()
        .optional()
        .describe('Booking status filter, e.g. CONFIRMED, PENDING, CANCELLED, NO_SHOW, COMPLETED.'),
      from: z.string().optional().describe('Inclusive lower bound on start time, ISO 8601.'),
      to: z.string().optional().describe('Inclusive upper bound on start time, ISO 8601.'),
    }),
    handler: async (ctx, args) =>
      deps.bookings.listBookings(ctx.workspaceId, {
        calendarId: typeof args.calendarId === 'string' ? args.calendarId : undefined,
        status: typeof args.status === 'string' ? args.status : undefined,
        from: typeof args.from === 'string' ? args.from : undefined,
        to: typeof args.to === 'string' ? args.to : undefined,
      }),
  });

  registry.register({
    name: 'jeeta.get_booking_availability',
    description:
      'List available slot start times (ISO 8601) for a booking calendar within a date range, honouring its hours, buffers, min-notice/max-advance policy, existing bookings and blackouts. Read-only.',
    domain: 'scheduling',
    scopes: ['tasks.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({
      calendarId: z.string().min(1).describe('Booking calendar id to check.'),
      from: z.string().min(1).describe('Inclusive start of the window to search, ISO 8601 datetime.'),
      to: z
        .string()
        .min(1)
        .describe('Inclusive end of the window to search, ISO 8601 datetime (capped by the calendar\'s max-advance policy).'),
    }),
    handler: async (ctx, args) =>
      deps.bookings.availability(
        ctx.workspaceId,
        String(args.calendarId ?? ''),
        String(args.from ?? ''),
        String(args.to ?? ''),
      ),
  });
}
