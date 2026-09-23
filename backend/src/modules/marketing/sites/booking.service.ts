import {
  Injectable,
  Logger,
  OnModuleInit,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { EntitlementsService } from '../../billing/entitlements.service';
import { LeadAttributionService } from '../leads/lead-attribution.service';
import { OutboxService } from '../../outbox/outbox.service';
import { MailCopyKey, resolveMailLang, t } from '../../../common/i18n/mail-copy';
import { OutboundMailService } from '../channels/outbound/outbound-mail.service';
import { MailReceipt, OutboundMail } from '../channels/outbound/outbound-mail.types';
import { ReplyIdentity, SenderIdentityService } from '../channels/outbound/sender-identity.service';
import { LeadAutoAssignerService } from '../services/lead-auto-assigner.service';
import { zonedParts, zonedWallTimeToUtcMs, parseHm, formatInTimeZone } from './timezone-slots';
import { buildIcs, icsSequence, IcsMethod } from './ics.util';
import { overlapsBlackout } from './blackout.util';
import { ScheduledJobService } from '../scheduling/scheduled-job.service';
import { ScheduledJobRunnerService, ClaimedJob } from '../scheduling/scheduled-job-runner.service';
import { normalizeEmail, normalizePhone } from '../utils/lead-normalize';
import { MarketingEventTypes } from '../events/marketing-event-types';
import { GoogleCalendarSyncService } from '../integrations/google-calendar-sync.service';
import { OutlookCalendarSyncService } from '../integrations/outlook-calendar-sync.service';

const BOOKING_REMINDER_KIND = 'booking.reminder';
/** The retry lane for a booking mail the relay could not take right now. */
const BOOKING_MAIL_KIND = 'booking.mail';
/** First retry of a deferred booking mail; the runner backs off from there. */
const BOOKING_MAIL_RETRY_MS = 2 * 60_000;
/**
 * How many bookings ONE address may make on ONE calendar in 24h.
 *
 * The public reserve endpoint is throttled per IP, which places no bound at all
 * on how much mail a single victim receives (`booking-public-abuse`): a script
 * rotating IPs can book, cancel and re-book forever, and every cycle mails the
 * address a platform-branded invite. Generous enough for a parent booking a
 * class for several children.
 */
const MAX_BOOKINGS_PER_ADDRESS_PER_DAY = 10;
/** …and how many of those may actually be MAILED. Mail is the thing with a
 *  reputation to lose, so it stops well before the calendar does. */
const MAX_BOOKING_MAILS_PER_ADDRESS_PER_DAY = 3;
/** An unassigned booking notifies the workspace's managers, not a mailing list. */
const MAX_HOST_RECIPIENTS = 5;

/**
 * One booking lifecycle event = one mail.
 *
 * The event picks the copy, the ICS method and the idempotency key together, so
 * "the customer was told their appointment moved" cannot drift apart from "the
 * invite in their calendar moved".
 */
type BookingMailEvent =
  | 'received'
  | 'confirmed'
  | 'cancelled'
  | 'declined'
  | 'rescheduled'
  | 'reschedulePending'
  | 'reminder'
  | 'hostNew'
  | 'hostReminder';

const BOOKING_COPY: Record<BookingMailEvent, { subject: MailCopyKey; body: MailCopyKey }> = {
  received: { subject: 'booking.received.subject', body: 'booking.received.body' },
  confirmed: { subject: 'booking.confirmed.subject', body: 'booking.confirmed.body' },
  cancelled: { subject: 'booking.cancelled.subject', body: 'booking.cancelled.body' },
  declined: { subject: 'booking.declined.subject', body: 'booking.declined.body' },
  rescheduled: { subject: 'booking.rescheduled.subject', body: 'booking.rescheduled.body' },
  // A request that moved while it is still waiting on a human says exactly
  // that, and carries no invite — it never had one to update.
  reschedulePending: { subject: 'booking.rescheduled.subject', body: 'booking.received.body' },
  reminder: { subject: 'booking.reminder.subject', body: 'booking.reminder.body' },
  hostNew: { subject: 'booking.hostNew.subject', body: 'booking.hostNew.body' },
  hostReminder: { subject: 'booking.hostReminder.subject', body: 'booking.hostReminder.body' },
};

/**
 * Which events carry an invite, and what it says.
 *
 * Only these three: a reminder duplicates an invite the customer already
 * holds, a `received` request has not been granted yet, and a DECLINED request
 * never produced an invite to withdraw — a CANCEL for a uid the client has
 * never seen is an appointment appearing in a calendar just to disappear.
 */
const ICS_METHOD: Partial<Record<BookingMailEvent, IcsMethod>> = {
  confirmed: 'REQUEST',
  rescheduled: 'REQUEST',
  cancelled: 'CANCEL',
};

/** Mail we send to OUR OWN user about a booking, never to the customer. */
const HOST_EVENTS: readonly BookingMailEvent[] = ['hostNew', 'hostReminder'];

/** The events an unauthenticated stranger can trigger, and so the ones the
 *  per-address mail budget applies to. */
const PUBLICLY_TRIGGERED_EVENTS: readonly BookingMailEvent[] = ['received', 'confirmed'];

/** What a caller knows that the booking row does not: which reminder this is,
 *  and (for a host mail) which of our own users is being written to. */
interface BookingMailExtra {
  offsetMinutes?: number;
  to?: string;
}

/**
 * A real, reachable person. The research sentinel is a `SYSTEM` MarketingUser
 * that owns records but has no mailbox, and a suspended user is not somebody to
 * send an appointment to.
 */
function pickAddress(
  user: { email: string | null; status: string; role: string } | null | undefined,
): string | null {
  if (!user?.email || user.status !== 'ACTIVE' || user.role === 'SYSTEM') return null;
  return user.email;
}
const MAX_RANGE_DAYS = 21;
const CALENDAR_TYPES = ['SINGLE', 'ROUND_ROBIN', 'COLLECTIVE', 'CLASS'];
const CONFERENCING = ['NONE', 'GOOGLE_MEET', 'TEAMS'];
// Statuses that HOLD a slot (count against capacity / block an assignee). A
// PENDING approval hold occupies the slot just like a CONFIRMED booking.
const ACTIVE_STATUSES = ['CONFIRMED', 'PENDING'];
// Terminal/administrative transitions an admin can set on a booking.
const SETTABLE_STATUSES = ['CONFIRMED', 'NO_SHOW', 'COMPLETED', 'CANCELLED'];

/**
 * Total per-slot buffer minutes: before + after (Phase 2), falling back to the
 * legacy single `bufferMinutes` when both before/after are zero. Used as the
 * spacing padding added to slotMinutes when stepping the offered-slot grid.
 */
function bufferTotal(cal: {
  bufferMinutes?: number;
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
}): number {
  const beforeAfter =
    (cal.bufferBeforeMinutes ?? 0) + (cal.bufferAfterMinutes ?? 0);
  return beforeAfter || (cal.bufferMinutes ?? 0);
}

/** One reminder rule: fire `offsetMinutes` before the start, over `channels`,
 *  to `audience`. */
interface ReminderEntry {
  offsetMinutes: number;
  channels: string[]; // EMAIL | SMS
  audience: string; // CUSTOMER | HOST | BOTH
}
const DEFAULT_REMINDERS: ReminderEntry[] = [
  { offsetMinutes: 60, channels: ['EMAIL'], audience: 'CUSTOMER' },
];

/** Validate + normalise a calendar's reminderConfig JSON, falling back to the
 *  single T-1h customer email when it is absent or malformed. */
function parseReminderConfig(raw: unknown): ReminderEntry[] {
  if (!Array.isArray(raw) || raw.length === 0) return DEFAULT_REMINDERS;
  const out: ReminderEntry[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const offsetMinutes = Number((e as any).offsetMinutes);
    if (!Number.isFinite(offsetMinutes) || offsetMinutes <= 0) continue;
    const rawChannels = Array.isArray((e as any).channels) ? (e as any).channels : ['EMAIL'];
    const channels = rawChannels.filter((c: unknown) => c === 'EMAIL' || c === 'SMS');
    const audience = ['CUSTOMER', 'HOST', 'BOTH'].includes((e as any).audience)
      ? (e as any).audience
      : 'CUSTOMER';
    out.push({ offsetMinutes, channels: channels.length ? channels : ['EMAIL'], audience });
  }
  return out.length ? out : DEFAULT_REMINDERS;
}

/** True when a member's custom weekly hours cover the slot [s, s+slotMs).
 *  `windows` is the member's weekday->[{start,end}] map, read in `tz`. */
function memberCoversSlot(
  windows: Record<string, Array<{ start: string; end: string }>>,
  tz: string,
  s: number,
  slotMs: number,
): boolean {
  const { y, mo, d, weekday } = zonedParts(s, tz);
  const wins = windows[String(weekday)] ?? [];
  for (const w of wins) {
    const hs = parseHm(w.start);
    const he = parseHm(w.end);
    if (!hs || !he) continue;
    const ws = zonedWallTimeToUtcMs(y, mo, d, hs[0], hs[1], tz);
    const we = zonedWallTimeToUtcMs(y, mo, d, he[0], he[1], tz);
    if (s >= ws && s + slotMs <= we) return true;
  }
  return false;
}

/**
 * Booking calendars + slot picking. Availability windows (per weekday, HH:mm)
 * are wall-clock times interpreted in the calendar's IANA TIMEZONE (DST-safe via
 * timezone-slots.ts); bookable slots = windows sliced into slotMinutes (stepping
 * by slotMinutes + buffers) minus existing CONFIRMED bookings, EXTERNAL_BUSY
 * blocks and blackout windows, bounded by the calendar's min-notice /
 * max-advance policy. Booking mints/links a lead, emits booking.created (a
 * workflow trigger), emails a confirmation (+ICS), and schedules reminders.
 */
@Injectable()
export class BookingService implements OnModuleInit {
  private readonly logger = new Logger(BookingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly outbox: OutboxService,
    private readonly outboundMail: OutboundMailService,
    private readonly senderIdentity: SenderIdentityService,
    private readonly config: ConfigService,
    private readonly autoAssigner: LeadAutoAssignerService,
    private readonly scheduledJobs: ScheduledJobService,
    private readonly runner: ScheduledJobRunnerService,
    private readonly googleSync: GoogleCalendarSyncService,
    private readonly outlookSync: OutlookCalendarSyncService,
    private readonly leadAttribution: LeadAttributionService,
  ) {}

  onModuleInit(): void {
    this.runner.registerHandler(BOOKING_REMINDER_KIND, (job) => this.remind(job));
    this.runner.registerHandler(BOOKING_MAIL_KIND, (job) => this.retryBookingMail(job));
  }

  // ── booking mail ───────────────────────────────────────────────────────────

  /**
   * Booking mail is still NOT awaited by the request that triggers it: the
   * relay waits up to 25s, and a customer pressing "book" must not sit through
   * that (the reason the old fire-and-forget existed).
   *
   * What changed is that the ANSWER is no longer thrown away. The gateway
   * writes a `MailLog` row for every attempt, a refusal is logged with the
   * reason it was refused, and a TRANSIENT failure books a retry job — so a
   * five-minute relay hiccup no longer silently drops a confirmation or a
   * reminder the customer is waiting on (`booking-mail-no-retry`).
   */
  private dispatchBookingMail(
    workspaceId: string,
    bookingId: string,
    event: BookingMailEvent,
    extra: BookingMailExtra = {},
  ): void {
    void this.sendBookingMail(workspaceId, bookingId, event, extra)
      .then((receipt) => this.afterBookingMail(workspaceId, bookingId, event, extra, receipt))
      .catch((e) =>
        this.logger.warn(`booking ${event} email failed: ${(e as Error)?.message ?? e}`),
      );
  }

  /** What the receipt means for the booking: nothing, a log line, or a retry. */
  private async afterBookingMail(
    workspaceId: string,
    bookingId: string,
    event: BookingMailEvent,
    extra: BookingMailExtra,
    receipt: MailReceipt | null,
  ): Promise<void> {
    if (!receipt || receipt.ok) return;
    const why = receipt.reason ?? receipt.outcome;
    if (!receipt.retriable) {
      // REFUSED and FAILED_PERMANENT are terminal ANSWERS, not failures to
      // paper over: retrying a suppressed address or an exhausted quota just
      // spends the same refusal again.
      this.logger.warn(
        `booking ${event} email NOT delivered (${why})${receipt.error ? `: ${receipt.error}` : ''}`,
      );
      return;
    }
    this.logger.warn(`booking ${event} email deferred (${why}) — retrying`);
    await this.scheduledJobs
      .schedule({
        workspaceId,
        kind: BOOKING_MAIL_KIND,
        runAt: receipt.retryAt ?? new Date(Date.now() + BOOKING_MAIL_RETRY_MS),
        // Per (booking, event, recipient): one host's undelivered reminder must
        // not collapse onto another's.
        dedupKey: this.mailJobKey(bookingId, event, extra),
        payload: { workspaceId, bookingId, event, ...extra },
      })
      .catch((e) =>
        this.logger.warn(`booking ${event} email retry not queued: ${(e as Error)?.message ?? e}`),
      );
  }

  /** The retry lane. Throwing hands the row back to the runner's backoff. */
  private async retryBookingMail(job: ClaimedJob): Promise<void> {
    const { workspaceId, bookingId, event, offsetMinutes, to } = job.payload as {
      workspaceId: string;
      bookingId: string;
      event: BookingMailEvent;
      offsetMinutes?: number;
      to?: string;
    };
    if (!workspaceId || !bookingId || !BOOKING_COPY[event]) return;
    const receipt = await this.sendBookingMail(workspaceId, bookingId, event, {
      ...(offsetMinutes === undefined ? {} : { offsetMinutes }),
      ...(to ? { to } : {}),
    });
    if (receipt && !receipt.ok && receipt.retriable) {
      throw new Error(
        `booking ${event} email still undeliverable (${receipt.reason ?? receipt.outcome})${
          receipt.error ? `: ${receipt.error}` : ''
        }`,
      );
    }
  }

  /**
   * Compose and send one booking mail, from the CURRENT state of the booking.
   *
   * It re-reads rather than trusting a snapshot on purpose: conferencing is
   * pushed asynchronously, so `meetingUrl` frequently lands after the caller
   * had its copy of the row, and a retry minutes later must send what is true
   * then — not what was true when the relay first refused.
   *
   * Returns `null` when there was nothing to send (no address, a booking that
   * has since gone, an address over its daily mail budget). It never throws:
   * every caller is either a public request the customer is waiting on or a
   * job whose other leg already succeeded.
   */
  private async sendBookingMail(
    workspaceId: string,
    bookingId: string,
    event: BookingMailEvent,
    extra: BookingMailExtra = {},
  ): Promise<MailReceipt | null> {
    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, workspaceId },
      select: {
        id: true, calendarId: true, leadId: true, name: true, email: true, token: true,
        startAt: true, endAt: true, meetingUrl: true, attendeeTimezone: true, createdAt: true,
      },
    });
    if (!booking) return null;
    const host = HOST_EVENTS.includes(event);
    const to = (host ? extra.to : booking.email)?.trim();
    if (!to) return null;
    if (!host && PUBLICLY_TRIGGERED_EVENTS.includes(event) && (await this.overMailBudget(workspaceId, to))) {
      this.logger.warn(
        `booking ${event} email skipped — ${MAX_BOOKING_MAILS_PER_ADDRESS_PER_DAY}+ bookings for this address in 24h`,
      );
      return null;
    }

    const cal = await this.prisma.bookingCalendar.findFirst({
      where: { id: booking.calendarId, workspaceId },
      select: { name: true, timezone: true },
    });
    const { lang, business, replyTo } = await this.mailIdentity(workspaceId);
    const calendarName = cal?.name || 'Booking';
    // The customer reads their own timezone; the host reads the calendar's —
    // the host's mail used to render in the ATTENDEE's timezone, which is the
    // one time of day the host is not working in.
    const when = formatInTimeZone(
      booking.startAt,
      (host ? cal?.timezone : booking.attendeeTimezone || cal?.timezone) || 'Europe/Istanbul',
    );
    const vars = { calendar: calendarName, when, name: booking.name, business };
    const copy = BOOKING_COPY[event];
    const manageUrl = host ? undefined : this.manageUrl(booking.token);
    const withdrawn = event === 'cancelled' || event === 'declined';

    const lines = [t(lang, copy.body, vars)];
    if (!host) lines.push(t(lang, 'booking.calendarLine', { calendar: calendarName }));
    if (booking.meetingUrl && !withdrawn) {
      lines.push(t(lang, 'booking.joinLine', { url: booking.meetingUrl }));
    }
    // Nothing left to manage once the appointment is gone.
    if (manageUrl && !withdrawn) lines.push(t(lang, 'booking.manageLine', { url: manageUrl }));
    // Who this is from, in the mail itself — the platform From address cannot
    // say it (G4), so the body does (`booking-no-manage-link`).
    if (!host && business) lines.push(t(lang, 'booking.fromBusiness', { business }));

    const method = ICS_METHOD[event];
    const mail: OutboundMail = {
      workspaceId,
      // A host notice is mail about OUR product to OUR user: no tenant
      // Reply-To, no lead, and never metered against the tenant's plan.
      mailClass: host ? 'INTERNAL' : 'TRANSACTIONAL',
      to,
      subject: t(lang, copy.subject, vars),
      text: lines.join('\n'),
      ...(host ? {} : { leadId: booking.leadId }),
      ...(method
        ? {
            ics: {
              method,
              content: buildIcs({
                uid: booking.id,
                start: booking.startAt,
                end: booking.endAt,
                // The brand, not just the calendar name: an invite reading
                // "Booking" tells the customer nothing about who they are
                // meeting.
                summary: business ? `${business} — ${calendarName}` : calendarName,
                // NOT `booking.notes`: that is visitor-authored text, and
                // putting it in the attendee invite let a script mail
                // arbitrary content to arbitrary addresses
                // (`booking-public-abuse`). The host still sees the notes on
                // the booking and in the mirrored calendar event.
                ...(manageUrl ? { description: t(lang, 'booking.manageLine', { url: manageUrl }) } : {}),
                ...(booking.meetingUrl ? { joinUrl: booking.meetingUrl } : {}),
                // The mailbox the business actually reads — the same address
                // the gateway puts in Reply-To.
                ...(replyTo ? { organizerEmail: replyTo } : {}),
                ...(business ? { organizerName: business } : {}),
                attendeeEmail: to,
                attendeeName: booking.name,
                method,
                sequence: icsSequence(booking.createdAt),
              }),
              filename: 'invite.ics',
            },
          }
        : {}),
      ...(lang ? { lang } : {}),
      source: `booking:${booking.id}`,
      // The same lifecycle event twice — a repeated approval, a retried job, a
      // double-clicked cancel — is ONE mail.
      idempotencyKey: this.mailKey(booking, event, extra, to),
    };
    return this.outboundMail.send(mail);
  }

  /** The key that makes one lifecycle event one mail, however often it fires. */
  private mailKey(
    booking: { id: string; startAt: Date },
    event: BookingMailEvent,
    extra: BookingMailExtra,
    to: string,
  ): string {
    const addr = normalizeEmail(to) ?? to.toLowerCase();
    switch (event) {
      // A booking can move more than once, and each move is its own mail.
      case 'rescheduled':
      case 'reschedulePending':
        return `booking:${booking.id}:rescheduled:${booking.startAt.getTime()}`;
      case 'reminder':
        return `booking:${booking.id}:reminder:${extra.offsetMinutes ?? 0}`;
      case 'hostReminder':
        return `booking:${booking.id}:host-reminder:${extra.offsetMinutes ?? 0}:${addr}`;
      case 'hostNew':
        return `booking:${booking.id}:host-new:${addr}`;
      default:
        return `booking:${booking.id}:${event}`;
    }
  }

  /** The retry job's dedup key — same granularity as the mail's own key. */
  private mailJobKey(bookingId: string, event: BookingMailEvent, extra: BookingMailExtra): string {
    const parts = [bookingId, event];
    if (extra.offsetMinutes !== undefined) parts.push(String(extra.offsetMinutes));
    if (extra.to) parts.push(normalizeEmail(extra.to) ?? extra.to.toLowerCase());
    return parts.join(':');
  }

  /**
   * How many bookings this address already made here in the last 24h.
   *
   * CANCELLED rows count, which is the whole point: `cancelByToken` frees the
   * slot, so `book → cancel → book` re-runs the confirmation send forever
   * (`booking-public-abuse`).
   */
  private async overMailBudget(workspaceId: string, email: string): Promise<boolean> {
    const since = new Date(Date.now() - 86400_000);
    try {
      const count = await this.prisma.booking.count({
        where: { workspaceId, email: { equals: email, mode: 'insensitive' }, createdAt: { gte: since } },
      });
      return count > MAX_BOOKING_MAILS_PER_ADDRESS_PER_DAY;
    } catch (e) {
      // A budget read that fails must not silence a real customer's mail.
      this.logger.warn(`booking mail budget check failed: ${(e as Error)?.message ?? e}`);
      return false;
    }
  }

  /** Whose name is on the mail, in which language, and where a reply goes. */
  private async mailIdentity(
    workspaceId: string,
  ): Promise<{ lang: string | null; business: string; replyTo?: string }> {
    const [identity, ws] = await Promise.all([
      this.senderIdentity.replyIdentity(workspaceId).catch((): ReplyIdentity => ({ name: '' })),
      this.prisma.workspace
        .findUnique({ where: { id: workspaceId }, select: { name: true, defaultLanguage: true } })
        .catch(() => null),
    ]);
    return {
      lang: ws?.defaultLanguage ?? null,
      business: identity.name || ws?.name || '',
      ...(identity.replyTo ? { replyTo: identity.replyTo } : {}),
    };
  }

  /**
   * The customer's own cancel/reschedule page, carrying the booking's existing
   * opaque token. Omitted rather than thrown when `PUBLIC_BASE_URL` is unset:
   * these sends are best-effort, and a booking must not fail to be confirmed
   * because a link could not be built (`booking-no-manage-link`).
   */
  private manageUrl(token: string | null): string | undefined {
    const base = (this.config.get<string>('PUBLIC_BASE_URL') ?? '').replace(/\/$/, '');
    // Under `/api/public`, the same shape `/api/public/ul/<token>` uses. The
    // bare `/book/manage/<token>` this used to build is an SPA path with no
    // route behind it, so every manage link landed on the catch-all redirect —
    // a customer asking to cancel was shown the marketing home page.
    return base && token ? `${base}/api/public/book/manage/${token}` : undefined;
  }

  /**
   * The host's address, resolved through the MEMBERSHIP.
   *
   * `MarketingUser.workspaceId` is the user's HOME workspace, so the old
   * `marketingUser.findFirst({ id, workspaceId })` silently dropped every
   * reminder for a consultant whose home is elsewhere (`host-reminder-multiws`).
   * The workspace filter stays ON the membership: a stale or foreign
   * `assigneeUserId` must resolve to nobody, never to another tenant's user.
   */
  private async hostAddress(workspaceId: string, assigneeUserId: string | null): Promise<string | null> {
    if (!assigneeUserId) return null;
    const membership = await this.prisma.workspaceMembership.findFirst({
      where: { workspaceId, userId: assigneeUserId, status: 'ACTIVE' },
      select: { user: { select: { email: true, status: true, role: true } } },
    });
    return pickAddress(membership?.user);
  }

  /**
   * Who to tell about a new booking: the assignee, or — for a SINGLE calendar
   * with no owner, where `assigneeUserId` is null — the people who can act on
   * it (`host-not-notified`).
   */
  private async hostRecipients(workspaceId: string, assigneeUserId: string | null): Promise<string[]> {
    const assignee = await this.hostAddress(workspaceId, assigneeUserId);
    if (assignee) return [assignee];
    const memberships = await this.prisma.workspaceMembership.findMany({
      where: { workspaceId, status: 'ACTIVE', role: { in: ['OWNER', 'MANAGER'] } },
      select: { user: { select: { email: true, status: true, role: true } } },
    });
    const seen = new Set<string>();
    const out: string[] = [];
    for (const m of memberships) {
      const address = pickAddress(m.user);
      if (!address || seen.has(address.toLowerCase())) continue;
      seen.add(address.toLowerCase());
      out.push(address);
      if (out.length >= MAX_HOST_RECIPIENTS) break;
    }
    return out;
  }

  /** Tell the host (or the managers) that a booking arrived. Best-effort. */
  private async notifyHostOfBooking(
    workspaceId: string,
    booking: { id: string; assigneeUserId: string | null },
  ): Promise<void> {
    const recipients = await this.hostRecipients(workspaceId, booking.assigneeUserId).catch(() => []);
    for (const to of recipients) {
      this.dispatchBookingMail(workspaceId, booking.id, 'hostNew', { to });
    }
  }

  // ---- calendar CRUD (workspace) ----
  list(workspaceId: string) {
    return this.prisma.bookingCalendar.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } });
  }
  async get(workspaceId: string, id: string) {
    const c = await this.prisma.bookingCalendar.findFirst({ where: { id, workspaceId } });
    if (!c) throw new NotFoundException('Calendar not found');
    return c;
  }
  async create(workspaceId: string, dto: any) {
    const effective = await this.entitlements.getEffective(workspaceId);
    const limit = effective.limits.maxCalendars;
    const data = {
      name: dto.name,
      slug: this.slugify(dto.slug || dto.name),
      ownerUserId: dto.ownerUserId ?? null,
      type: CALENDAR_TYPES.includes(dto.type) ? dto.type : 'SINGLE',
      capacity: this.normCapacity(dto.capacity),
      availability: dto.availability ?? {},
      slotMinutes: dto.slotMinutes ?? 30,
      bufferMinutes: dto.bufferMinutes ?? 0,
      timezone: dto.timezone ?? 'Europe/Istanbul',
      conferencing: CONFERENCING.includes(dto.conferencing) ? dto.conferencing : 'NONE',
      minNoticeMinutes: dto.minNoticeMinutes ?? 0,
      maxAdvanceDays: dto.maxAdvanceDays ?? 60,
      bufferBeforeMinutes: dto.bufferBeforeMinutes ?? 0,
      bufferAfterMinutes: dto.bufferAfterMinutes ?? 0,
      requiresApproval: dto.requiresApproval ?? false,
      ...(dto.reminderConfig !== undefined ? { reminderConfig: dto.reminderConfig } : {}),
    };
    // slug is unique per (workspaceId, slug); a duplicate name/slug is a clean
    // 400, not a raw P2002 → 500 (parity with SitesService.create).
    const onError = (e: unknown) => {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new BadRequestException('A calendar with that slug already exists');
      }
      throw e;
    };
    // Unlimited plan — no cap to race against. workspaceId is spread inline at
    // every create call site so the scope is visible to the multi-tenant
    // arch-fitness scanner (not hoisted where the regex can't see it).
    if (limit === -1) {
      return this.prisma.bookingCalendar.create({ data: { workspaceId, ...data } }).catch(onError);
    }
    // Enforce the per-plan maxCalendars cap. Serialize the count-check + create
    // per workspace under an advisory xact-lock so two concurrent creates at
    // (limit-1) can't BOTH pass the cap and exceed it (mirrors SitesService.create
    // and the booking-reserve lock in this file).
    return this.prisma
      .$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`calendars:${workspaceId}`}))`;
        const count = await tx.bookingCalendar.count({ where: { workspaceId } });
        if (count >= limit) {
          throw new BadRequestException(`Calendar limit reached (${limit}) — upgrade your package`);
        }
        return tx.bookingCalendar.create({ data: { workspaceId, ...data } });
      })
      .catch(onError);
  }
  async update(workspaceId: string, id: string, dto: any) {
    const existing = await this.prisma.bookingCalendar.findFirst({ where: { id, workspaceId } });
    if (!existing) throw new NotFoundException('Calendar not found');
    const data: any = {};
    for (const k of [
      'name', 'ownerUserId', 'availability', 'slotMinutes', 'bufferMinutes', 'timezone', 'active',
      'minNoticeMinutes', 'maxAdvanceDays', 'bufferBeforeMinutes', 'bufferAfterMinutes',
      'requiresApproval', 'reminderConfig',
    ] as const) {
      if (dto[k] !== undefined) data[k] = dto[k];
    }
    if (dto.type !== undefined && CALENDAR_TYPES.includes(dto.type)) data.type = dto.type;
    if (dto.conferencing !== undefined && CONFERENCING.includes(dto.conferencing)) data.conferencing = dto.conferencing;
    if (dto.capacity !== undefined) data.capacity = this.normCapacity(dto.capacity);
    if (dto.slug !== undefined) data.slug = this.slugify(dto.slug);
    return this.prisma.bookingCalendar
      .update({ where: { id: existing.id }, data })
      // Renaming a calendar's slug onto a taken one → clean 400, not a raw
      // P2002 → 500 (parity with SitesService.update).
      .catch((e) => {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          throw new BadRequestException('A calendar with that slug already exists');
        }
        throw e;
      });
  }

  private normCapacity(v: unknown): number {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.min(n, 1000); // sane upper bound for a class size
  }

  // ── Team members (ROUND_ROBIN / COLLECTIVE) ─────────────────────────────────

  async listMembers(workspaceId: string, calId: string) {
    await this.get(workspaceId, calId); // ownership 404
    return this.prisma.bookingCalendarMember.findMany({
      where: { workspaceId, calendarId: calId },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /** Replace the calendar's member set (validates each user is in the workspace). */
  async setMembers(
    workspaceId: string,
    calId: string,
    members: Array<{ marketingUserId: string; priority?: number }>,
  ) {
    await this.get(workspaceId, calId); // ownership 404
    const ids = [...new Set(members.map((m) => m.marketingUserId))];
    if (ids.length > 0) {
      const found = await this.prisma.marketingUser.findMany({
        where: { workspaceId, id: { in: ids } },
        select: { id: true },
      });
      if (found.length !== ids.length) {
        throw new BadRequestException('One or more members are not in this workspace');
      }
    }
    await this.prisma.$transaction([
      this.prisma.bookingCalendarMember.deleteMany({ where: { workspaceId, calendarId: calId } }),
      ...(ids.length > 0
        ? [
            this.prisma.bookingCalendarMember.createMany({
              data: members.map((m, i) => ({
                workspaceId,
                calendarId: calId,
                marketingUserId: m.marketingUserId,
                priority: m.priority ?? i,
              })),
              skipDuplicates: true,
            }),
          ]
        : []),
    ]);
    return this.listMembers(workspaceId, calId);
  }
  async remove(workspaceId: string, id: string) {
    const res = await this.prisma.bookingCalendar.deleteMany({ where: { id, workspaceId } });
    if (res.count === 0) throw new NotFoundException('Calendar not found');
    return { message: 'Calendar deleted' };
  }

  // ── Blackout / time-off admin CRUD ─────────────────────────────────────────

  listBlackouts(workspaceId: string, calendarId?: string) {
    return this.prisma.bookingBlackout.findMany({
      where: {
        workspaceId,
        // A specific calendar sees its own windows PLUS workspace-wide ones.
        ...(calendarId ? { OR: [{ calendarId }, { calendarId: null }] } : {}),
      },
      orderBy: { startAt: 'asc' },
    });
  }

  async createBlackout(
    workspaceId: string,
    dto: { calendarId?: string; marketingUserId?: string; startAt: string; endAt: string; reason?: string },
  ) {
    const start = new Date(dto.startAt);
    const end = new Date(dto.endAt);
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) {
      throw new BadRequestException('Invalid blackout window');
    }
    if (dto.calendarId) await this.get(workspaceId, dto.calendarId); // ownership 404
    return this.prisma.bookingBlackout.create({
      data: {
        workspaceId,
        calendarId: dto.calendarId ?? null,
        marketingUserId: dto.marketingUserId ?? null,
        startAt: start,
        endAt: end,
        reason: dto.reason ?? null,
      },
    });
  }

  async deleteBlackout(workspaceId: string, id: string) {
    const res = await this.prisma.bookingBlackout.deleteMany({ where: { id, workspaceId } });
    if (res.count === 0) throw new NotFoundException('Blackout not found');
    return { message: 'Blackout deleted' };
  }

  // ── Per-member working hours (Phase 2 model + CRUD) ─────────────────────────

  listMemberAvailability(workspaceId: string, calId: string) {
    return this.prisma.memberAvailability.findMany({ where: { workspaceId, calendarId: calId } });
  }

  /** Upsert a member's working hours for a calendar (unique per calendar+member). */
  async setMemberAvailability(
    workspaceId: string,
    calId: string,
    marketingUserId: string,
    availability: unknown,
    timezone?: string,
  ) {
    await this.get(workspaceId, calId); // ownership 404
    const existing = await this.prisma.memberAvailability.findFirst({
      where: { calendarId: calId, marketingUserId },
    });
    if (existing) {
      return this.prisma.memberAvailability.update({
        where: { id: existing.id },
        data: { availability: availability as any, timezone: timezone ?? null },
      });
    }
    return this.prisma.memberAvailability.create({
      data: { workspaceId, calendarId: calId, marketingUserId, availability: availability as any, timezone: timezone ?? null },
    });
  }

  // ── Bookings listing (admin appointments view) ──────────────────────────────

  /** List real appointments (excludes EXTERNAL_BUSY busy blocks), newest window
   *  first, optionally filtered by calendar / status / time range. */
  listBookings(
    workspaceId: string,
    filters: {
      calendarId?: string;
      status?: string;
      from?: string;
      to?: string;
      leadId?: string;
    } = {},
  ) {
    // Default the lower bound to the last ~24h when the caller gives no range, so
    // the asc-ordered, 500-capped window covers CURRENT/upcoming appointments. An
    // unbounded asc query returns the 500 OLDEST rows once lifetime bookings exceed
    // the cap, truncating out every future appointment (staff can't see today's).
    // The 24h buffer keeps recent past + handles workspace-timezone edges; an
    // explicit `from`/`to` still queries any range (e.g. a history view).
    //
    // A `leadId` query is ALREADY narrow — one person has a handful of
    // appointments, nowhere near the 500 cap — and the record card's whole job
    // is to show that person's history, including the meeting that already
    // happened. So the rolling window does not apply to it; an explicit
    // `from`/`to` still does, because that caller asked for a range on purpose.
    const rolling = !filters.leadId && !filters.from && !filters.to;
    const gte = filters.from
      ? new Date(filters.from)
      : rolling
        ? new Date(Date.now() - 24 * 60 * 60 * 1000)
        : undefined;
    return this.prisma.booking.findMany({
      where: {
        workspaceId,
        status: filters.status ? filters.status : { not: 'EXTERNAL_BUSY' },
        ...(filters.calendarId ? { calendarId: filters.calendarId } : {}),
        // Narrows the workspace scope, never replaces it: a leadId belonging to
        // another tenant still matches nothing.
        ...(filters.leadId ? { leadId: filters.leadId } : {}),
        ...(gte || filters.to
          ? {
              startAt: {
                ...(gte ? { gte } : {}),
                ...(filters.to ? { lte: new Date(filters.to) } : {}),
              },
            }
          : {}),
      },
      orderBy: { startAt: 'asc' },
      take: 500,
    });
  }

  /** Public: resolve a calendar by (workspaceId, slug) for the booking page. */
  async publicCalendar(workspaceId: string, slug: string) {
    const c = await this.prisma.bookingCalendar.findFirst({ where: { workspaceId, slug, active: true } });
    if (!c) throw new NotFoundException('Calendar not found');
    return { id: c.id, name: c.name, slotMinutes: c.slotMinutes, timezone: c.timezone, type: c.type };
  }

  /**
   * Per-slot capacity by calendar type. SINGLE/COLLECTIVE book one party per
   * slot; CLASS holds `capacity` attendees; ROUND_ROBIN offers a slot while at
   * least one of its members is free, so its capacity is the member count.
   */
  private effectiveCapacity(cal: { type: string; capacity: number }, memberCount: number): number {
    switch (cal.type) {
      case 'CLASS':
        return Math.max(1, cal.capacity);
      case 'ROUND_ROBIN':
        return Math.max(1, memberCount);
      default: // SINGLE | COLLECTIVE
        return 1;
    }
  }

  /** Available slot starts (ISO) in [from, to], capped to MAX_RANGE_DAYS. */
  async availability(workspaceId: string, calId: string, fromISO: string, toISO: string): Promise<string[]> {
    const cal = await this.prisma.bookingCalendar.findFirst({ where: { id: calId, workspaceId } });
    if (!cal) throw new NotFoundException('Calendar not found');
    const from = new Date(fromISO);
    let to = new Date(toISO);
    // The caller's requested end instant, kept BEFORE the maxAdvance clamp: it
    // is the strict slot-level upper bound. `to` below is clamped to the
    // maxAdvance horizon and drives the (day-granular) day loop, which
    // deliberately INCLUDES the cap day — so the slot bound must use the
    // un-clamped requested end, or the cap day's slots would be dropped.
    const toRequestedMs = to.getTime();
    const maxDays = (cal as any).maxAdvanceDays ?? MAX_RANGE_DAYS;
    const cap = new Date(from.getTime() + maxDays * 86400_000);
    if (to > cap) to = cap;
    // Earliest bookable instant = now + the calendar's minimum notice lead time.
    const earliest = Date.now() + ((cal as any).minNoticeMinutes ?? 0) * 60_000;

    const memberCount = await this.prisma.bookingCalendarMember.count({
      where: { workspaceId, calendarId: calId },
    });
    const capacity = this.effectiveCapacity(cal, memberCount);

    // For ROUND_ROBIN, a member with CUSTOM working hours only counts toward a
    // slot's capacity when their hours cover it (members without custom hours
    // inherit the calendar windows). Precompute {windows|null, tz} per member.
    let memberHours: Array<{
      windows: Record<string, Array<{ start: string; end: string }>> | null;
      tz: string;
    }> = [];
    if (cal.type === 'ROUND_ROBIN') {
      const members = await this.prisma.bookingCalendarMember.findMany({
        where: { workspaceId, calendarId: calId },
        select: { marketingUserId: true },
      });
      const rows = await this.prisma.memberAvailability.findMany({
        where: { workspaceId, calendarId: calId },
        select: { marketingUserId: true, availability: true, timezone: true },
      });
      const byUser = new Map(rows.map((r) => [r.marketingUserId, r]));
      const calTz = (cal as any).timezone || 'UTC';
      memberHours = members.map((m) => {
        const row = byUser.get(m.marketingUserId);
        return {
          windows: row ? (row.availability as any) : null,
          tz: row?.timezone || calTz,
        };
      });
    }

    // CONFIRMED bookings on THIS calendar are COUNTED against the slot capacity;
    // EXTERNAL_BUSY blocks (Google-pulled, workspace-wide) are a HARD block that
    // ignores capacity. Fetch them separately so capacity only applies to ours.
    const ours = await this.prisma.booking.findMany({
      where: {
        workspaceId,
        calendarId: calId,
        status: { in: ACTIVE_STATUSES },
        startAt: { lt: to },
        endAt: { gt: from },
      },
      select: { startAt: true, endAt: true },
    });
    const external = await this.prisma.booking.findMany({
      where: {
        workspaceId,
        status: 'EXTERNAL_BUSY',
        startAt: { lt: to },
        endAt: { gt: from },
      },
      select: { startAt: true, endAt: true },
    });
    const ourIv = ours.map((b) => [b.startAt.getTime(), b.endAt.getTime()] as [number, number]);
    const extIv = external.map((b) => [b.startAt.getTime(), b.endAt.getTime()] as [number, number]);
    // Blackout / time-off windows for this calendar (calendarId null = all
    // calendars). Null-scoped windows hide the slot for everyone; owner-scoped
    // windows hide it for a SINGLE/COLLECTIVE calendar's owner. Member-scoped
    // reductions for ROUND_ROBIN are enforced precisely in book().
    const blackouts = await this.prisma.bookingBlackout.findMany({
      where: {
        workspaceId,
        OR: [{ calendarId: null }, { calendarId: calId }],
        endAt: { gt: from },
        startAt: { lt: to },
      },
      select: { startAt: true, endAt: true, marketingUserId: true },
    });
    const ownerId = cal.ownerUserId ?? null;
    const avail = (cal.availability ?? {}) as Record<string, Array<{ start: string; end: string }>>;
    const slotMs = cal.slotMinutes * 60_000;
    const stepMs = (cal.slotMinutes + bufferTotal(cal)) * 60_000;
    const out: string[] = [];

    // Availability windows are wall-clock times in the calendar's TIMEZONE (not
    // UTC) — so a Turkey calendar's "09:00" window is 09:00 in Istanbul. Iterate
    // tz-local calendar days and convert each window to a UTC instant (DST-safe).
    const tz = (cal as any).timezone || 'UTC';
    const startD = zonedParts(from.getTime(), tz);
    for (let n = 0; n < 400; n++) {
      const dayMidnight = zonedWallTimeToUtcMs(startD.y, startD.mo, startD.d + n, 0, 0, tz);
      if (dayMidnight > to.getTime()) break;
      const { y, mo, d, weekday } = zonedParts(dayMidnight + 12 * 3600_000, tz); // noon = DST-safe parts
      const windows = avail[String(weekday)] ?? [];
      for (const w of windows) {
        const hs = parseHm(w.start), he = parseHm(w.end);
        if (!hs || !he) continue;
        const ws = zonedWallTimeToUtcMs(y, mo, d, hs[0], hs[1], tz);
        const we = zonedWallTimeToUtcMs(y, mo, d, he[0], he[1], tz);
        for (let s = ws; s + slotMs <= we; s += stepMs) {
          const e = s + slotMs;
          // Honour the requested [from, to) window at the SLOT level. The day
          // loop only bounds whole tz-local days, so a window on the first/last
          // day would otherwise spill slots BEFORE `from`'s time-of-day or
          // AFTER `to` — and the public availability endpoint passes
          // caller-supplied from/to through verbatim, so a narrow query would
          // wrongly return the whole day's slots.
          if (s < from.getTime()) continue; // before the requested window start
          if (s >= toRequestedMs) break; // at/after the requested end (s ascends here)
          if (s < earliest) continue; // before now + minimum notice
          if (extIv.some(([bs, be]) => s < be && e > bs)) continue; // hard block
          if (overlapsBlackout(blackouts, s, e, ownerId)) continue; // blackout / time-off
          const taken = ourIv.filter(([bs, be]) => s < be && e > bs).length;
          // ROUND_ROBIN with per-member hours: a slot's effective capacity is
          // how many members are actually available at this instant.
          let slotCap = capacity;
          if (cal.type === 'ROUND_ROBIN' && memberHours.length) {
            slotCap = memberHours.filter(
              (mh) => mh.windows == null || memberCoversSlot(mh.windows, mh.tz, s, slotMs),
            ).length;
          }
          if (taken >= slotCap) continue; // at (effective) capacity
          out.push(new Date(s).toISOString());
        }
      }
    }
    return out;
  }

  /** Public: book a slot. */
  async book(
    workspaceId: string, calId: string,
    dto: { start: string; name: string; email?: string; phone?: string; notes?: string; attendeeTimezone?: string; landingUrl?: string; referrerUrl?: string },
  ) {
    const cal = await this.prisma.bookingCalendar.findFirst({ where: { id: calId, workspaceId, active: true } });
    if (!cal) throw new NotFoundException('Calendar not found');
    const start = new Date(dto.start);
    if (isNaN(start.getTime()) || start.getTime() < Date.now()) throw new BadRequestException('Invalid or past slot');
    // Enforce the calendar's booking-policy window so a direct reserve can't beat
    // the min-notice lead time or book beyond the max-advance horizon the picker
    // (availability()) enforces.
    const minNotice = (cal as any).minNoticeMinutes ?? 0;
    const maxDays = (cal as any).maxAdvanceDays ?? MAX_RANGE_DAYS;
    if (start.getTime() < Date.now() + minNotice * 60_000) {
      throw new BadRequestException('Slot is within the minimum notice window');
    }
    if (start.getTime() > Date.now() + maxDays * 86400_000) {
      throw new BadRequestException('Slot is beyond the maximum advance window');
    }
    // Reject an off-grid / out-of-hours timestamp: a direct API call must not be
    // able to book a slot the public picker (availability()) would never offer.
    if (!this.isAlignedSlot(cal, start)) {
      throw new BadRequestException('Slot is outside the calendar availability or not aligned to the grid');
    }
    const end = new Date(start.getTime() + cal.slotMinutes * 60_000);
    const email = dto.email?.trim() || null;
    // Bound the abuse at the source, keyed on the ADDRESS. `@Throttle` on the
    // public reserve endpoint is per IP, which bounds nothing about how much
    // mail one victim receives — a script rotating IPs can book, cancel and
    // re-book the same person forever (`booking-public-abuse`). Counts every
    // status, because a cancelled booking freed its slot and mailed its person.
    if (email) {
      const recent = await this.prisma.booking.count({
        where: {
          workspaceId,
          calendarId: calId,
          email: { equals: email, mode: 'insensitive' },
          createdAt: { gte: new Date(Date.now() - 86400_000) },
        },
      });
      if (recent >= MAX_BOOKINGS_PER_ADDRESS_PER_DAY) {
        throw new BadRequestException('Too many bookings for this email address today');
      }
    }

    const booking = await this.prisma.$transaction(async (tx) => {
      // Serialize concurrent reservations across the WHOLE WORKSPACE so the
      // overlap + assignee checks below are race-free. Without it, two
      // simultaneous public reserve calls both pass the (non-locking) conflict
      // SELECT and both insert — double-booking one slot. The lock is keyed on
      // the WORKSPACE, not the calendar: capacity is per-calendar, but the
      // assignee invariant (don't book one person — a calendar owner or a
      // ROUND_ROBIN member who can serve several calendars — into two
      // overlapping slots) is workspace-wide, and the EXTERNAL_BUSY block is too.
      // A per-calendar key would let two reserves on DIFFERENT calendars assign
      // the same person concurrently. There is no DB-level unique/exclusion
      // constraint to catch it (Prisma can't model a partial/range-exclude index
      // without breaking migrate-parity), so this transaction-scoped advisory
      // lock is the clean fix; it auto-releases at commit. Booking volume per
      // workspace is low, so workspace-wide serialization is negligible.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`booking:${workspaceId}`}))`;
      // Any EXTERNAL_BUSY (Google-pulled, workspace-wide) overlap is a HARD block
      // regardless of capacity — a visitor must not book over a Google-busy time
      // the slot picker had already hidden.
      const external = await tx.booking.findFirst({
        where: { workspaceId, status: 'EXTERNAL_BUSY', startAt: { lt: end }, endAt: { gt: start } },
        select: { id: true },
      });
      if (external) throw new BadRequestException('That slot was just taken');

      // Blackout / time-off: a calendar/workspace-wide window (marketingUserId
      // null) blocks the whole slot; member-scoped windows are applied to the
      // assignee pick below. Loaded under the lock so it's race-free with book.
      const blackouts = await tx.bookingBlackout.findMany({
        where: {
          workspaceId,
          OR: [{ calendarId: null }, { calendarId: calId }],
          endAt: { gt: start },
          startAt: { lt: end },
        },
        select: { startAt: true, endAt: true, marketingUserId: true },
      });
      if (overlapsBlackout(blackouts, start.getTime(), end.getTime(), null)) {
        throw new BadRequestException('That slot is unavailable');
      }

      // Capacity-aware check: count our CONFIRMED bookings overlapping the slot
      // and reject once they reach the calendar's effective capacity (SINGLE/
      // COLLECTIVE→1, CLASS→capacity, ROUND_ROBIN→member count). Mirrors
      // availability() exactly so a direct reserve can't exceed what's offered.
      const overlapping = await tx.booking.findMany({
        where: { workspaceId, calendarId: calId, status: { in: ACTIVE_STATUSES }, startAt: { lt: end }, endAt: { gt: start } },
        select: { assigneeUserId: true },
      });
      // Members are only needed for ROUND_ROBIN (capacity = member count + per-
      // member assignment). COLLECTIVE/SINGLE have capacity 1 and a static owner,
      // CLASS has no assignee — so we don't fetch members for them.
      const members =
        cal.type === 'ROUND_ROBIN'
          ? await tx.bookingCalendarMember.findMany({
              where: { workspaceId, calendarId: calId },
              orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
              select: { marketingUserId: true },
            })
          : [];
      const capacity = this.effectiveCapacity(cal, members.length);
      if (overlapping.length >= capacity) throw new BadRequestException('That slot was just taken');

      // Assignee: ROUND_ROBIN → first member not already booked in this slot;
      // SINGLE/COLLECTIVE → the calendar owner; CLASS → null (group attendee).
      let assigneeUserId: string | null = cal.ownerUserId ?? null;
      if (cal.type === 'ROUND_ROBIN') {
        const memberIds = members.map((m) => m.marketingUserId);
        // A member is busy if they have ANY overlapping CONFIRMED booking in the
        // WORKSPACE (across calendars) — not just this calendar. A user can be a
        // member of several calendars; counting only this one would re-assign a
        // human already booked elsewhere in the same slot (double-booking).
        const busyRows = memberIds.length
          ? await tx.booking.findMany({
              where: {
                workspaceId,
                status: { in: ACTIVE_STATUSES },
                assigneeUserId: { in: memberIds },
                startAt: { lt: end },
                endAt: { gt: start },
              },
              select: { assigneeUserId: true },
            })
          : [];
        const taken = new Set(busyRows.map((o) => o.assigneeUserId).filter(Boolean) as string[]);
        // Per-member custom working hours (if any) further constrain who can take
        // the slot — mirrors availability()'s effective-capacity computation.
        const maRows = await tx.memberAvailability.findMany({
          where: { workspaceId, calendarId: calId },
          select: { marketingUserId: true, availability: true, timezone: true },
        });
        const maByUser = new Map(maRows.map((r) => [r.marketingUserId, r]));
        const calTz = (cal as any).timezone || 'UTC';
        const slotMs = cal.slotMinutes * 60_000;
        // Skip a member who is busy elsewhere, on personal time off (blackout), or
        // outside their own custom working hours.
        assigneeUserId =
          members.find((m) => {
            if (taken.has(m.marketingUserId)) return false;
            if (overlapsBlackout(blackouts, start.getTime(), end.getTime(), m.marketingUserId)) return false;
            const row = maByUser.get(m.marketingUserId);
            if (row && !memberCoversSlot(row.availability as any, row.timezone || calTz, start.getTime(), slotMs)) {
              return false;
            }
            return true;
          })?.marketingUserId ?? null;
      } else if (cal.type === 'CLASS') {
        assigneeUserId = null;
      } else if (assigneeUserId) {
        // SINGLE / COLLECTIVE: the calendar OWNER serves this slot. Enforce the
        // same workspace-wide "one human can't be in two overlapping slots"
        // invariant ROUND_ROBIN enforces above (and the lock comment promises).
        // The per-calendar capacity check can't see a booking the owner has on
        // ANOTHER calendar they serve, so without this an owner of (or assignee
        // on) multiple calendars is silently double-booked. Mirrors the
        // ROUND_ROBIN cross-calendar busy check — reject, like capacity exhaustion.
        const ownerBusy = await tx.booking.findFirst({
          where: {
            workspaceId,
            status: { in: ACTIVE_STATUSES },
            assigneeUserId,
            startAt: { lt: end },
            endAt: { gt: start },
          },
          select: { id: true },
        });
        if (ownerBusy) throw new BadRequestException('That slot was just taken');
        // The owner may be on personal time off (member-scoped blackout).
        if (overlapsBlackout(blackouts, start.getTime(), end.getTime(), assigneeUserId)) {
          throw new BadRequestException('That slot is unavailable');
        }
      }

      // ROUND_ROBIN with no free member: every member is already booked in this
      // slot SOMEWHERE in the workspace (or the calendar has no members at all).
      // The per-calendar capacity check above can't catch this — a member may be
      // busy on ANOTHER calendar — so it would otherwise create an UNASSIGNED
      // booking nobody can serve. Reject it, exactly like capacity exhaustion.
      if (cal.type === 'ROUND_ROBIN' && !assigneeUserId) {
        throw new BadRequestException('That slot was just taken');
      }

      // Link or create a lead (`email` is read above, for the per-address cap).
      const phone = dto.phone?.trim() || null;
      const emailNormalized = normalizeEmail(email);
      const phoneNormalized = normalizePhone(phone);
      let leadId: string | null = null;
      if (emailNormalized || phoneNormalized) {
        // Dedup on the NORMALIZED keys (cross-path with manual/form leads) and
        // skip tombstoned (merged-away) AND soft-deleted (bulk-deleted) leads —
        // otherwise a booking from a previously-deleted contact attaches to that
        // still-hidden record instead of surfacing as a fresh, visible lead.
        const existing = await tx.lead.findFirst({
          where: {
            workspaceId,
            mergedIntoId: null,
            deletedAt: null,
            OR: [
              ...(emailNormalized ? [{ emailNormalized }] : []),
              ...(phoneNormalized ? [{ phoneNormalized }] : []),
            ],
          },
          select: { id: true },
        });
        leadId = existing?.id ?? null;
      }
      if (!leadId) {
        const autoOwner = await this.autoAssigner.pickAssignee(workspaceId, tx);
        const lead = await tx.lead.create({
          data: {
            workspaceId, businessName: dto.name || 'Booking', contactPerson: dto.name || 'Booking',
            businessType: 'OTHER', source: 'WEBSITE', status: 'NEW',
            ...(email ? { email } : {}), ...(phone ? { phone } : {}),
            ...(emailNormalized ? { emailNormalized } : {}),
            ...(phoneNormalized ? { phoneNormalized } : {}),
            ...(autoOwner ? { assignedToId: autoOwner } : {}),
          },
        });
        leadId = lead.id;
        // A booking-born lead is a genuine new prospect — this path even
        // records its first-touch attribution below. Every other inbound path
        // announces one (forms, order forms, webchat/DM, Meta lead ads,
        // research ingest, manual create); without this, booking was a lead
        // source whose leads ran no automation, no Slack alert, no webhook.
        // Appended INSIDE the transaction, like BookingCreated below, so the
        // event cannot outlive a rolled-back lead.
        await this.outbox.append(
          {
            type: MarketingEventTypes.LeadCreated,
            idempotencyKey: `lead-created:${lead.id}`,
            payload: { workspaceId, leadId: lead.id, source: 'WEBSITE', occurredAt: new Date().toISOString() },
          },
          tx as any,
        );
        // First-touch attribution (D10): tie a NEW booking-born lead to the
        // page it booked from. Existing (deduped) leads keep their original
        // first touch. Best-effort; enrolled in this tx.
        if (dto.landingUrl || dto.referrerUrl) {
          await this.leadAttribution.capture(
            workspaceId,
            lead.id,
            {
              ...(dto.landingUrl ? { url: dto.landingUrl } : {}),
              ...(dto.referrerUrl ? { referrer: dto.referrerUrl } : {}),
            },
            {},
            tx,
          );
        }
      }
      // A calendar that requires approval holds the slot as PENDING (which still
      // counts against capacity) until a manager confirms; otherwise CONFIRMED.
      const initialStatus = (cal as any).requiresApproval ? 'PENDING' : 'CONFIRMED';
      const created = await tx.booking.create({
        data: {
          workspaceId, calendarId: calId, leadId, startAt: start, endAt: end,
          name: dto.name, email, phone, notes: dto.notes ?? null,
          attendeeTimezone: dto.attendeeTimezone ?? null,
          assigneeUserId,
          status: initialStatus,
          token: `bk_${randomBytes(16).toString('hex')}`,
        },
      });
      // Only a CONFIRMED booking fires BookingCreated (which drives the calendar
      // push + workflow triggers). A PENDING hold fires it on approval instead.
      if (initialStatus === 'CONFIRMED') {
        await this.outbox.append(
          {
            type: MarketingEventTypes.BookingCreated,
            idempotencyKey: `booking-created:${created.id}`,
            payload: { workspaceId, leadId, bookingId: created.id, calendarId: calId, startAt: start.toISOString(), occurredAt: new Date().toISOString() },
          },
          tx as any,
        );
      }
      return created;
    });

    // A CONFIRMED booking triggers the calendar push, confirmation + reminders; a
    // PENDING (approval-required) booking just acknowledges receipt and defers all
    // of that to approval (setStatus → CONFIRMED). Times render in the calendar's
    // timezone (not UTC) — a 14:00 Istanbul booking must not read "11:00 GMT".
    if (booking.status === 'CONFIRMED') {
      await this.afterConfirmed(workspaceId, cal, booking);
    } else if (booking.email) {
      this.dispatchBookingMail(workspaceId, booking.id, 'received');
    }
    // Somebody has to know a booking arrived — most of all the PENDING one,
    // which sits there until a human approves it (`host-not-notified`).
    await this.notifyHostOfBooking(workspaceId, booking);

    return { id: booking.id, startAt: booking.startAt, token: booking.token };
  }

  /**
   * Cancel a workspace booking: mark it CANCELLED and delete the mirrored
   * Google event (best-effort, inert when the integration is unconfigured).
   * Workspace-scoped; 404s a cross-workspace or unknown id.
   */
  async cancel(workspaceId: string, id: string) {
    const existing = await this.prisma.booking.findFirst({
      where: { id, workspaceId },
      // Wide enough to compose the mail from: the customer has to be TOLD, and
      // a second read after the flip would report the cancelled status rather
      // than the one that decides which mail this is.
      select: { id: true, status: true, calendarId: true, email: true },
    });
    if (!existing) throw new NotFoundException('Booking not found');
    if (existing.status === 'EXTERNAL_BUSY') {
      // External Google blocks are owned by Google; cancel them THERE.
      throw new BadRequestException('Cannot cancel an external calendar block');
    }
    if (existing.status !== 'CANCELLED') {
      // Flip the status and emit BookingCancelled transactionally so downstream
      // teardown (conference + calendar-mirror delete) and workflow automations
      // fire off ONE reliable event via the outbox.
      //
      // The flip is also the CLAIM, which is why the `where` repeats the guard
      // above instead of trusting it. The read-then-check on its own is not
      // one: the manage link is an opaque token a customer can click twice and
      // a browser can prefetch, so two requests can both read CONFIRMED, both
      // pass the guard, and both tell the same person their appointment is
      // off. Whoever does not win the row does nothing at all — no event, no
      // mirror teardown, no mail.
      const claimed = await this.prisma.$transaction(async (tx) => {
        const claim = await tx.booking.updateMany({
          where: { id: existing.id, workspaceId, status: { notIn: ['CANCELLED', 'EXTERNAL_BUSY'] } },
          data: { status: 'CANCELLED' },
        });
        if (claim.count === 0) return false;
        await this.outbox.append(
          {
            type: MarketingEventTypes.BookingCancelled,
            idempotencyKey: `booking-cancelled:${existing.id}`,
            payload: {
              workspaceId,
              bookingId: existing.id,
              calendarId: existing.calendarId,
              occurredAt: new Date().toISOString(),
            },
          },
          tx as any,
        );
        return true;
      });
      if (claimed) {
        // Direct calls stay as a self-healing fallback (the BookingCancelled event
        // also drives both syncs, so a missed direct call recovers).
        this.googleSync.cancelBooking(workspaceId, existing.id).catch(() => undefined);
        this.outlookSync.cancelBooking(workspaceId, existing.id).catch(() => undefined);
        // Inside the claim, so a repeat cancel (or a retried cancelByToken) cannot
        // mail the same person twice. A CONFIRMED booking had an invite, so it is
        // WITHDRAWN (METHOD:CANCEL); a PENDING request never had one, so it is
        // DECLINED in words only — a CANCEL for a uid the client never saw makes
        // an appointment appear just to vanish (`booking-cancel-reschedule-ics`).
        if (existing.email) {
          this.dispatchBookingMail(
            workspaceId,
            existing.id,
            existing.status === 'PENDING' ? 'declined' : 'cancelled',
          );
        }
      }
    }
    return { id: existing.id, status: 'CANCELLED' };
  }

  /**
   * Post-confirmation side effects, shared by book() (immediate CONFIRMED) and
   * setStatus() approval (PENDING→CONFIRMED): create the conference + persist its
   * link (awaited for a conferencing calendar so the email carries it), email the
   * confirmation with an ICS invite, and schedule the reminder. Best-effort.
   */
  private async afterConfirmed(
    workspaceId: string,
    cal: { name: string | null; conferencing?: string; timezone?: string },
    booking: { id: string; email: string | null; startAt: Date },
  ): Promise<void> {
    const conferencing = cal.conferencing ?? 'NONE';
    if (conferencing === 'GOOGLE_MEET') {
      await this.googleSync.pushBooking(workspaceId, booking.id).catch(() => undefined);
    } else if (conferencing === 'TEAMS') {
      await this.outlookSync.pushBooking(workspaceId, booking.id).catch(() => undefined);
    } else {
      this.googleSync.pushBooking(workspaceId, booking.id).catch(() => undefined);
      this.outlookSync.pushBooking(workspaceId, booking.id).catch(() => undefined);
    }
    // The push above is AWAITED for a conferencing calendar so the link is on
    // the row before the mail reads it back — that ordering is why the invite
    // carries a join link at all.
    if (booking.email) this.dispatchBookingMail(workspaceId, booking.id, 'confirmed');
    // One reminder job per configured lead time (default: a single T-1h customer
    // email). dedupKey is per (booking, offset) so re-running approval is safe.
    await this.syncReminders(workspaceId, booking, (cal as any).reminderConfig);
  }

  /**
   * (Re)schedule this booking's reminder jobs from the calendar's reminderConfig.
   * The dedupKey is per (booking, offset), so calling this AGAIN after a reschedule
   * updates each pending reminder's runAt in place (schedule()'s dedup collapses
   * onto the existing PENDING row) instead of duplicating it — keeping every
   * "T-N before start" reminder aligned to the CURRENT start. A rule whose new
   * lead time is already in the past is CANCELLED, so a booking moved earlier
   * can't strand a reminder queued to fire at the stale old time.
   *
   * ONE JOB PER AUDIENCE, not per offset. A single row carrying both legs can
   * only be retried as a whole, so a failed host reminder would re-send the
   * customer reminder that already arrived — a worse bug than the one retrying
   * fixes (`booking-mail-no-retry`). The CUSTOMER leg keeps the bare
   * `<booking>:<offset>` key that rows minted before the split already hold, so
   * no in-flight reminder doubles up.
   */
  private async syncReminders(
    workspaceId: string,
    booking: { id: string; startAt: Date },
    reminderConfig: unknown,
  ): Promise<void> {
    const reminders = parseReminderConfig(reminderConfig);
    for (const r of reminders) {
      const legs: Array<'CUSTOMER' | 'HOST'> =
        r.audience === 'BOTH' ? ['CUSTOMER', 'HOST'] : [r.audience === 'HOST' ? 'HOST' : 'CUSTOMER'];
      const runAt = new Date(booking.startAt.getTime() - r.offsetMinutes * 60_000);
      // A HOST-only rule mints ONLY the `:HOST` key now, so a bare key left on
      // this booking can only be a pre-split row for the same reminder — and
      // leaving it PENDING would fire the host leg twice.
      if (legs.length === 1 && legs[0] === 'HOST') {
        await this.scheduledJobs.cancel(BOOKING_REMINDER_KIND, `${booking.id}:${r.offsetMinutes}`);
      }
      for (const leg of legs) {
        const dedupKey =
          leg === 'HOST'
            ? `${booking.id}:${r.offsetMinutes}:HOST`
            : `${booking.id}:${r.offsetMinutes}`;
        if (runAt.getTime() <= Date.now()) {
          await this.scheduledJobs.cancel(BOOKING_REMINDER_KIND, dedupKey);
          continue;
        }
        await this.scheduledJobs.schedule({
          workspaceId,
          kind: BOOKING_REMINDER_KIND,
          runAt,
          dedupKey,
          payload: {
            workspaceId,
            bookingId: booking.id,
            offsetMinutes: r.offsetMinutes,
            channels: r.channels,
            audience: r.audience,
            leg,
          },
        });
      }
    }
  }

  /**
   * Move a booking to a new start time (in place). Re-validates the new slot
   * (past / min-notice / max-advance / grid) and, under the workspace advisory
   * lock, that it is clear of EXTERNAL_BUSY, blackout and — for an assigned
   * booking — an assignee double-book (excluding itself). Patches the calendar
   * mirror (moving the Meet/Teams meeting) and emits BookingRescheduled. Only an
   * active (CONFIRMED/PENDING) booking can be rescheduled.
   */
  async reschedule(workspaceId: string, bookingId: string, newStartISO: string) {
    const booking = await this.prisma.booking.findFirst({ where: { id: bookingId, workspaceId } });
    if (!booking) throw new NotFoundException('Booking not found');
    if (!ACTIVE_STATUSES.includes(booking.status)) {
      throw new BadRequestException('Only an active booking can be rescheduled');
    }
    const cal = await this.prisma.bookingCalendar.findFirst({ where: { id: booking.calendarId, workspaceId } });
    if (!cal) throw new NotFoundException('Calendar not found');
    const start = new Date(newStartISO);
    if (isNaN(start.getTime()) || start.getTime() < Date.now()) throw new BadRequestException('Invalid or past slot');
    const minNotice = (cal as any).minNoticeMinutes ?? 0;
    const maxDays = (cal as any).maxAdvanceDays ?? MAX_RANGE_DAYS;
    if (start.getTime() < Date.now() + minNotice * 60_000) throw new BadRequestException('Slot is within the minimum notice window');
    if (start.getTime() > Date.now() + maxDays * 86400_000) throw new BadRequestException('Slot is beyond the maximum advance window');
    if (!this.isAlignedSlot(cal, start)) throw new BadRequestException('Slot is outside the calendar availability or not aligned to the grid');
    const end = new Date(start.getTime() + cal.slotMinutes * 60_000);

    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`booking:${workspaceId}`}))`;
      const external = await tx.booking.findFirst({
        where: { workspaceId, status: 'EXTERNAL_BUSY', startAt: { lt: end }, endAt: { gt: start } },
        select: { id: true },
      });
      if (external) throw new BadRequestException('That slot is unavailable');
      const blackouts = await tx.bookingBlackout.findMany({
        where: { workspaceId, OR: [{ calendarId: null }, { calendarId: booking.calendarId }], endAt: { gt: start }, startAt: { lt: end } },
        select: { startAt: true, endAt: true, marketingUserId: true },
      });
      if (overlapsBlackout(blackouts, start.getTime(), end.getTime(), booking.assigneeUserId ?? null)) {
        throw new BadRequestException('That slot is unavailable');
      }
      // Capacity check — MIRRORS book(). Without it, reschedule() enforced only
      // the per-assignee clash below, but a CLASS booking has NO assignee (group
      // attendee), so nothing stopped moving unlimited bookings into a full class
      // slot (over-capacity). ROUND_ROBIN's capacity is per-member and already
      // enforced by the assignee clash (each booking keeps its distinct member),
      // so only the capacity-N / capacity-1 types need this slot-level count.
      if (cal.type !== 'ROUND_ROBIN') {
        const overlapping = await tx.booking.findMany({
          where: {
            workspaceId,
            calendarId: booking.calendarId,
            status: { in: ACTIVE_STATUSES },
            id: { not: booking.id },
            startAt: { lt: end },
            endAt: { gt: start },
          },
          select: { id: true },
        });
        if (overlapping.length >= this.effectiveCapacity(cal, 0)) {
          throw new BadRequestException('That slot is full');
        }
      }
      if (booking.assigneeUserId) {
        const clash = await tx.booking.findFirst({
          where: {
            workspaceId, status: { in: ACTIVE_STATUSES }, assigneeUserId: booking.assigneeUserId,
            id: { not: booking.id }, startAt: { lt: end }, endAt: { gt: start },
          },
          select: { id: true },
        });
        if (clash) throw new BadRequestException('That slot was just taken');
      }
      await tx.booking.updateMany({ where: { id: booking.id, workspaceId }, data: { startAt: start, endAt: end } });
      await this.outbox.append(
        {
          type: MarketingEventTypes.BookingRescheduled,
          idempotencyKey: `booking-rescheduled:${booking.id}:${start.getTime()}`,
          payload: { workspaceId, bookingId: booking.id, calendarId: booking.calendarId, occurredAt: new Date().toISOString() },
        },
        tx as any,
      );
    });

    // Move the mirrored event (PATCH preserves the same Meet/Teams meeting). A
    // PENDING booking has no mirror yet, so nothing to move until it's approved.
    if (booking.status === 'CONFIRMED') {
      this.googleSync.pushBooking(workspaceId, booking.id).catch(() => undefined);
      this.outlookSync.pushBooking(workspaceId, booking.id).catch(() => undefined);
      // Realign reminders to the new start (a PENDING booking has none yet — it
      // gets them at approval in afterConfirmed). Without this the reminder keeps
      // firing relative to the OLD start after a move.
      await this.syncReminders(workspaceId, { id: booking.id, startAt: start }, (cal as any).reminderConfig);
    }
    // Tell the customer, or they turn up at the old time. A CONFIRMED booking
    // gets an UPDATED invite on the same uid with a higher SEQUENCE, which is
    // what moves the appointment already in their calendar; a PENDING request
    // gets words only — shipping it an invite would read as an approval the
    // workspace has not granted (`booking-cancel-reschedule-ics`).
    if (booking.email) {
      this.dispatchBookingMail(
        workspaceId,
        booking.id,
        booking.status === 'CONFIRMED' ? 'rescheduled' : 'reschedulePending',
      );
    }
    return { id: booking.id, startAt: start.toISOString() };
  }

  /**
   * Admin status transition: approve a PENDING booking (→CONFIRMED, running the
   * deferred confirm side-effects), or mark NO_SHOW / COMPLETED / CANCELLED.
   * Emits BookingUpdated; CANCELLED delegates to cancel() (mirror teardown).
   */
  async setStatus(workspaceId: string, bookingId: string, status: string) {
    if (!SETTABLE_STATUSES.includes(status)) throw new BadRequestException('Invalid status');
    if (status === 'CANCELLED') return this.cancel(workspaceId, bookingId);
    const existing = await this.prisma.booking.findFirst({ where: { id: bookingId, workspaceId } });
    if (!existing) throw new NotFoundException('Booking not found');
    if (existing.status === 'EXTERNAL_BUSY') {
      throw new BadRequestException('Cannot change an external calendar block');
    }
    // Only an ACTIVE (PENDING/CONFIRMED) booking can be transitioned. A terminal
    // booking (CANCELLED/NO_SHOW/COMPLETED) has already RELEASED its slot (excluded
    // from ACTIVE_STATUSES capacity/availability) and torn down its conference — so
    // flipping it back to CONFIRMED here would silently re-occupy the slot with NO
    // availability re-check (a double-book, the very thing book()/reschedule() guard)
    // and no meeting link. reschedule() already rejects a non-active source; this is
    // the sibling modify-path that didn't. Re-activating = a fresh book(), not a flip.
    if (!ACTIVE_STATUSES.includes(existing.status)) {
      throw new BadRequestException('Only an active booking can be updated — re-book instead');
    }
    const wasPending = existing.status === 'PENDING';
    // The flip is the CLAIM — conditional on the status this request actually
    // read, the shape `publicSign` uses. Without it two approvals of the same
    // PENDING request (two admins, or one double-click) both see PENDING, both
    // run `afterConfirmed`, and the customer gets two invites for one meeting.
    const claimed = await this.prisma.$transaction(async (tx) => {
      const claim = await tx.booking.updateMany({
        where: { id: existing.id, workspaceId, status: existing.status },
        data: { status },
      });
      if (claim.count === 0) return false;
      await this.outbox.append(
        {
          type: MarketingEventTypes.BookingUpdated,
          idempotencyKey: `booking-updated:${existing.id}:${status}`,
          payload: { workspaceId, bookingId: existing.id, calendarId: existing.calendarId, occurredAt: new Date().toISOString() },
        },
        tx as any,
      );
      return true;
    });
    if (claimed && status === 'CONFIRMED' && wasPending) {
      const cal = await this.prisma.bookingCalendar.findFirst({ where: { id: existing.calendarId, workspaceId } });
      if (cal) await this.afterConfirmed(workspaceId, cal, existing);
    }
    if (!claimed) {
      // Somebody else moved it first. Report what the row SAYS, not what this
      // request asked for — the admin list renders this answer, and two
      // transitions racing to different statuses must not both claim to have
      // won.
      const fresh = await this.prisma.booking.findFirst({
        where: { id: existing.id, workspaceId },
        select: { status: true },
      });
      return { id: existing.id, status: fresh?.status ?? status };
    }
    return { id: existing.id, status };
  }

  /**
   * Public self-service: the booking behind a manage link, and nothing else.
   *
   * Every booking mail now carries `/api/public/book/manage/<token>`, and the
   * two token routes below were the only things that ever read that token —
   * there was no way to SEE the appointment the link was about. This is that
   * read.
   *
   * The projection is a whitelist rather than a `select` with a few fields
   * taken out, because the token is the whole credential and manage links get
   * forwarded: `notes` is whatever the visitor (or a rep) typed, and the lead,
   * the assignee and the attendee's own contact details are the tenant's data,
   * not the link-holder's.
   *
   * `lang` travels with it. The link came out of a booking mail this same
   * workspace's `defaultLanguage` wrote (`dispatchBookingMail` → `mailIdentity`
   * → `mail-copy`), so the page it opens has to answer in that language or the
   * customer is handed a cancel button in a language they never chose. It is
   * resolved HERE, to a `MailLang`, so the controller never sees a raw column
   * value — the same shape `CampaignTrackingService.pageLang` hands the
   * unsubscribe pages.
   */
  async publicByToken(token: string) {
    const booking = await this.prisma.booking.findFirst({
      where: { token },
      select: {
        workspaceId: true,
        calendarId: true,
        startAt: true,
        endAt: true,
        status: true,
        meetingUrl: true,
      },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    // A deleted calendar must not 404 a booking that still exists: the customer
    // can no longer rebook, but they can still see and cancel what they have.
    // Neither read may turn a valid token into a 404, so the workspace lookup
    // falls back to the default language rather than throwing.
    const [cal, ws] = await Promise.all([
      this.prisma.bookingCalendar.findFirst({
        where: { id: booking.calendarId, workspaceId: booking.workspaceId },
        select: { name: true, slug: true, timezone: true },
      }),
      this.prisma.workspace
        .findUnique({
          where: { id: booking.workspaceId },
          select: { defaultLanguage: true },
        })
        .catch(() => null),
    ]);
    return {
      workspaceId: booking.workspaceId,
      calendarName: cal?.name ?? '',
      calendarSlug: cal?.slug ?? null,
      timezone: cal?.timezone ?? 'UTC',
      startAt: booking.startAt.toISOString(),
      endAt: booking.endAt.toISOString(),
      status: booking.status,
      meetingUrl: booking.meetingUrl ?? null,
      lang: resolveMailLang(ws?.defaultLanguage),
    };
  }

  /** Public self-service: reschedule a booking by its opaque token. */
  async rescheduleByToken(token: string, newStartISO: string) {
    const booking = await this.prisma.booking.findFirst({ where: { token }, select: { id: true, workspaceId: true } });
    if (!booking) throw new NotFoundException('Booking not found');
    return this.reschedule(booking.workspaceId, booking.id, newStartISO);
  }

  /** Public self-service: cancel a booking by its opaque token. */
  async cancelByToken(token: string) {
    const booking = await this.prisma.booking.findFirst({ where: { token }, select: { id: true, workspaceId: true } });
    if (!booking) throw new NotFoundException('Booking not found');
    return this.cancel(booking.workspaceId, booking.id);
  }

  /**
   * One reminder leg, and the job is only DONE once the mail is really out.
   *
   * The old handler fired both legs and returned, so the runner marked the row
   * DONE before either send finished: a five-minute relay hiccup dropped the
   * T-1h reminder and the customer no-showed (`booking-mail-no-retry`). It now
   * AWAITS its one leg and throws on a retriable failure, which hands the row
   * back to the runner's backoff instead of losing it.
   */
  private async remind(job: ClaimedJob): Promise<void> {
    const { workspaceId, bookingId, channels, audience, offsetMinutes, leg } = job.payload as {
      workspaceId: string;
      bookingId: string;
      channels?: string[];
      audience?: string;
      offsetMinutes?: number;
      leg?: 'CUSTOMER' | 'HOST';
    };
    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, workspaceId },
      select: { id: true, status: true, startAt: true, email: true, assigneeUserId: true },
    });
    if (!booking || booking.status !== 'CONFIRMED') return;
    // The retry backoff can carry a short-lead rule (a 5- or 15-minute offset)
    // past the appointment itself, and "your booking is soon" delivered after
    // it started is a wrong-content regression the retry would have introduced.
    if (booking.startAt.getTime() <= Date.now()) return;
    // SMS reminders (channels includes 'SMS') are delivered by the notification /
    // messaging layer that subscribes to booking events — BookingService does not
    // couple directly to the SMS channel adapter here.
    if (!(channels ?? ['EMAIL']).includes('EMAIL')) return;

    const aud = audience ?? 'CUSTOMER';
    // A row minted before reminders were split per audience carries no `leg` and
    // owns BOTH sends. Failing it loudly would re-send the leg that already
    // arrived, so such a row keeps exactly today's fire-and-forget behaviour;
    // only a per-leg row is allowed to fail.
    const legs: Array<'CUSTOMER' | 'HOST'> = leg
      ? [leg]
      : aud === 'BOTH'
        ? ['CUSTOMER', 'HOST']
        : [aud === 'HOST' ? 'HOST' : 'CUSTOMER'];

    for (const which of legs) {
      const event = which === 'HOST' ? 'hostReminder' : 'reminder';
      const extra: BookingMailExtra = { ...(offsetMinutes === undefined ? {} : { offsetMinutes }) };
      if (which === 'HOST') {
        const to = await this.hostAddress(workspaceId, booking.assigneeUserId);
        if (!to) {
          this.logger.warn(
            `booking host reminder skipped — no active member ${booking.assigneeUserId ?? '(unassigned)'} in ${workspaceId}`,
          );
          continue;
        }
        extra.to = to;
      } else if (!booking.email) {
        continue;
      }

      if (!leg) {
        this.dispatchBookingMail(workspaceId, bookingId, event, extra);
        continue;
      }
      const receipt = await this.sendBookingMail(workspaceId, bookingId, event, extra);
      if (!receipt || receipt.ok) continue;
      if (receipt.retriable) {
        throw new Error(
          `booking ${event} undeliverable (${receipt.reason ?? receipt.outcome})${
            receipt.error ? `: ${receipt.error}` : ''
          }`,
        );
      }
      // REFUSED / permanent: the job is DONE because there is nothing a retry
      // would change, and the MailLog row carries the reason.
      this.logger.warn(
        `booking ${event} NOT delivered (${receipt.reason ?? receipt.outcome})${
          receipt.error ? `: ${receipt.error}` : ''
        }`,
      );
    }
  }

  /**
   * True when `start` is a real bookable slot for this calendar: inside a
   * weekday availability window AND aligned to the slot+buffer grid — the same
   * enumeration availability() uses to offer slots. Closes the gap where a
   * direct reserve call could pass an arbitrary off-grid / out-of-hours time.
   */
  private isAlignedSlot(
    cal: {
      availability: unknown;
      slotMinutes: number;
      bufferMinutes: number;
      bufferBeforeMinutes?: number;
      bufferAfterMinutes?: number;
      timezone?: string;
    },
    start: Date,
  ): boolean {
    const avail = (cal.availability ?? {}) as Record<
      string,
      Array<{ start: string; end: string }>
    >;
    // Same tz interpretation as availability() so a direct booking is validated
    // against the calendar's wall-clock windows, not UTC.
    const tz = cal.timezone || 'UTC';
    const { y, mo, d, weekday } = zonedParts(start.getTime(), tz);
    const windows = avail[String(weekday)] ?? [];
    const slotMs = cal.slotMinutes * 60_000;
    const stepMs = (cal.slotMinutes + bufferTotal(cal)) * 60_000;
    const target = start.getTime();
    for (const w of windows) {
      const hs = parseHm(w.start), he = parseHm(w.end);
      if (!hs || !he) continue;
      const ws = zonedWallTimeToUtcMs(y, mo, d, hs[0], hs[1], tz);
      const we = zonedWallTimeToUtcMs(y, mo, d, he[0], he[1], tz);
      for (let s = ws; s + slotMs <= we; s += stepMs) {
        if (s === target) return true;
      }
    }
    return false;
  }


  private slugify(s: string): string {
    return (s || 'calendar').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').slice(0, 80) || 'calendar';
  }
}
