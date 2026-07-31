import { z } from 'zod';
import { EntitlementsService } from '../../../billing/entitlements.service';
import { BookingService } from '../../sites/booking.service';
import { assertFeature } from '../mcp-feature-gate';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface SchedulingToolDeps {
  bookings: BookingService;
  entitlements: EntitlementsService;
}

/**
 * Booking tools. There is no `Appointment` model in this schema — the domain is
 * bookings (`BookingCalendar`, `Booking`, `BookingBlackout`) served by
 * `BookingService`. `jeeta.get_booking_availability` uses `availability()` (not
 * `listMemberAvailability` or `publicCalendar`) — it is the method that
 * actually enumerates real bookable slot starts for a date range, honouring the
 * calendar's windows, buffers, min-notice/max-advance policy, existing bookings
 * and blackouts; the other two return raw per-member working-hours config or
 * static calendar metadata, neither of which answers "when is this calendar
 * bookable".
 *
 * ## The `funnels` gate (Faz 5 D5)
 *
 * Every route on `MarketingBookingController` is
 * `@RequiresFeature('funnels')`. The two reads here shipped in Faz 1-2 with no
 * entitlement check at all, which meant a workspace whose package excludes the
 * sites/calendar module could still read its calendar over MCP — the same
 * bypass D3 flagged for the inbox. All three tools now make the same check the
 * REST gate makes, and refuse with the same `FEATURE_NOT_IN_PACKAGE` shape.
 *
 * ## `jeeta.create_booking` is a SEND, not a row write (Faz 5 D5)
 *
 * D4's comment here said booking creation was "a customer-facing flow, not
 * something to wire into server-side MCP". D5's spec line asks for it anyway,
 * and the honest reason it needed thinking about is what `BookingService.book`
 * actually does once the slot is CONFIRMED:
 *
 *  - emails the attendee a confirmation **with an ICS attachment**
 *    (`sendPlainEmailWithIcs`) — or, when the calendar requires approval, a
 *    "pending approval" acknowledgement;
 *  - pushes the event into the workspace's connected Google/Outlook calendar,
 *    with the attendee as an invitee, so they are invited a second time;
 *  - creates or dedupes a **Lead**, auto-assigns an owner and captures
 *    first-touch attribution;
 *  - assigns a real host out of the calendar's members and takes that slot out
 *    of their day;
 *  - schedules reminder jobs, emits `booking.created` (which fires workflows)
 *    and posts to Slack.
 *
 * So a wrong call reaches a customer's inbox AND a teammate's calendar, and
 * cancelling afterwards sends a second message rather than undoing the first.
 * That is the `SEND` shape exactly — the same treatment `jeeta.send_message`,
 * `jeeta.send_email` and `jeeta.click_to_dial` get — so it is queued for a
 * human in APPROVAL mode. It is not `SPEND` (no money leaves) and not
 * `DESTRUCTIVE` (the booking can be cancelled).
 *
 * The supersede key is `calendarId@start`: the natural identity of a booking
 * request is the SLOT, so a retried turn cannot leave two live approval cards
 * that would each take the same slot.
 *
 * Cancel/reschedule are deliberately NOT exposed. Both message the attendee
 * again and, unlike creating, they act on a commitment a human already made —
 * an agent removing a customer's appointment is a support incident, not an
 * automation win.
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
    handler: async (ctx, args) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'funnels');
      return deps.bookings.listBookings(ctx.workspaceId, {
        calendarId: typeof args.calendarId === 'string' ? args.calendarId : undefined,
        status: typeof args.status === 'string' ? args.status : undefined,
        from: typeof args.from === 'string' ? args.from : undefined,
        to: typeof args.to === 'string' ? args.to : undefined,
      });
    },
  });

  registry.register({
    name: 'jeeta.get_booking_availability',
    description:
      'List available slot start times (ISO 8601) for a booking calendar within a date range, honouring its hours, buffers, min-notice/max-advance policy, existing bookings and blackouts. Pass one of these straight to jeeta.create_booking. Read-only.',
    domain: 'scheduling',
    // Deferred in D4 (spec §3): a slot grid is only actionable once a booking
    // can be CREATED. D5 adds that verb — but `jeeta.create_booking` is itself
    // deferred, so the pair stays discovered together rather than costing two
    // advertised slots. `jeeta.list_bookings` remains the domain's listed read.
    defer: true,
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
    handler: async (ctx, args) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'funnels');
      return deps.bookings.availability(
        ctx.workspaceId,
        String(args.calendarId ?? ''),
        String(args.from ?? ''),
        String(args.to ?? ''),
      );
    },
  });

  registry.register({
    name: 'jeeta.create_booking',
    description:
      'Book a real appointment on a calendar. This is not a draft: it takes the slot out of a teammate\'s day, emails the attendee a confirmation with a calendar invite, mirrors the event into the connected Google/Outlook calendar, and creates or updates a contact record for them. Because it reaches the customer, it is queued for a human approval before anything is booked. Use a slot start from jeeta.get_booking_availability — an off-grid, past, too-soon or too-far time is refused. Cancelling later sends the customer another message; it does not undo the first.',
    domain: 'scheduling',
    // Deferred (spec §3): a gated, occasional action, discovered alongside the
    // availability read it depends on.
    defer: true,
    // Mirrors `MarketingBookingController`'s staff-booking route
    // (`@RequirePermission('settings.manage')` + MANAGER). The read tools'
    // `tasks.read` would have been a widening: viewing a calendar and taking a
    // slot on it are not the same authority.
    scopes: ['settings.manage'],
    risk: 'WRITE',
    requiresApproval: true,
    approvalKind: 'SEND',
    resourceType: 'booking_slot',
    // The identity of a booking REQUEST is the slot it wants, not a row id that
    // does not exist yet — so a retried turn supersedes instead of stacking two
    // cards that would each claim the same time.
    resourceIdFrom: (args) =>
      typeof args.calendarId === 'string' && typeof args.start === 'string'
        ? `${args.calendarId}@${args.start}`
        : undefined,
    inputSchema: z.object({
      calendarId: z.string().min(1).describe('Booking calendar id to book on.'),
      start: z
        .string()
        .min(1)
        .max(40)
        .describe(
          'Slot start, ISO 8601 datetime. Must be an exact slot start from jeeta.get_booking_availability.',
        ),
      name: z.string().min(1).max(120).describe("Attendee's name."),
      email: z
        .string()
        .email()
        .max(200)
        .optional()
        .describe('Attendee email. Without it they get no confirmation, invite or reminder.'),
      phone: z.string().max(40).optional().describe('Attendee phone number.'),
      notes: z.string().max(2000).optional().describe('What the meeting is about.'),
      attendeeTimezone: z
        .string()
        .max(64)
        .optional()
        .describe("Attendee's IANA timezone (e.g. Europe/Istanbul), used for the times they are shown."),
    }),
    handler: async (ctx, args) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'funnels');
      // Projected field by field rather than spread. `book()`'s dto type also
      // accepts `landingUrl`/`referrerUrl`, which feed first-touch attribution
      // — not fields an agent should be able to write, and not fields this
      // schema declares. The MCP transport strict-parses, but the approval
      // executor re-invokes with a STORED payload, so this is the layer that
      // must not trust it.
      return deps.bookings.book(ctx.workspaceId, String(args.calendarId ?? ''), {
        start: String(args.start ?? ''),
        name: String(args.name ?? ''),
        ...(args.email !== undefined ? { email: String(args.email) } : {}),
        ...(args.phone !== undefined ? { phone: String(args.phone) } : {}),
        ...(args.notes !== undefined ? { notes: String(args.notes) } : {}),
        ...(args.attendeeTimezone !== undefined
          ? { attendeeTimezone: String(args.attendeeTimezone) }
          : {}),
      });
    },
  });
}
