import {
  Injectable,
  Logger,
  OnModuleInit,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { LeadAttributionService } from '../leads/lead-attribution.service';
import { OutboxService } from '../../outbox/outbox.service';
import { EmailService } from '../../../common/services/email.service';
import { LeadAutoAssignerService } from '../services/lead-auto-assigner.service';
import { zonedParts, zonedWallTimeToUtcMs, parseHm, formatInTimeZone } from './timezone-slots';
import { buildIcs } from './ics.util';
import { overlapsBlackout } from './blackout.util';
import { ScheduledJobService } from '../scheduling/scheduled-job.service';
import { ScheduledJobRunnerService, ClaimedJob } from '../scheduling/scheduled-job-runner.service';
import { normalizeEmail, normalizePhone } from '../utils/lead-normalize';
import { MarketingEventTypes } from '../events/marketing-event-types';
import { GoogleCalendarSyncService } from '../integrations/google-calendar-sync.service';
import { OutlookCalendarSyncService } from '../integrations/outlook-calendar-sync.service';

const BOOKING_REMINDER_KIND = 'booking.reminder';
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
    private readonly outbox: OutboxService,
    private readonly email: EmailService,
    private readonly autoAssigner: LeadAutoAssignerService,
    private readonly scheduledJobs: ScheduledJobService,
    private readonly runner: ScheduledJobRunnerService,
    private readonly googleSync: GoogleCalendarSyncService,
    private readonly outlookSync: OutlookCalendarSyncService,
    private readonly leadAttribution: LeadAttributionService,
  ) {}

  onModuleInit(): void {
    this.runner.registerHandler(BOOKING_REMINDER_KIND, (job) => this.remind(job));
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
  create(workspaceId: string, dto: any) {
    return this.prisma.bookingCalendar
      .create({
        data: {
          workspaceId,
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
        },
      })
      // slug is unique per (workspaceId, slug); a duplicate name/slug is a clean
      // 400, not a raw P2002 → 500 (parity with SitesService.create).
      .catch((e) => {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          throw new BadRequestException('A calendar with that slug already exists');
        }
        throw e;
      });
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
    filters: { calendarId?: string; status?: string; from?: string; to?: string } = {},
  ) {
    return this.prisma.booking.findMany({
      where: {
        workspaceId,
        status: filters.status ? filters.status : { not: 'EXTERNAL_BUSY' },
        ...(filters.calendarId ? { calendarId: filters.calendarId } : {}),
        ...(filters.from || filters.to
          ? {
              startAt: {
                ...(filters.from ? { gte: new Date(filters.from) } : {}),
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

      // Link or create a lead.
      const email = dto.email?.trim() || null;
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
      const when = formatInTimeZone(booking.startAt, (cal as any).timezone || 'Europe/Istanbul');
      this.email
        .sendPlainEmail(
          booking.email, `Booking received: ${cal.name || 'Booking'}`,
          `Your booking request for ${when} is pending approval.`,
        )
        .catch(() => undefined);
    }

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
      select: { id: true, status: true, calendarId: true },
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
      await this.prisma.$transaction(async (tx) => {
        await tx.booking.updateMany({
          where: { id: existing.id, workspaceId },
          data: { status: 'CANCELLED' },
        });
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
      });
      // Direct calls stay as a self-healing fallback (the BookingCancelled event
      // also drives both syncs, so a missed direct call recovers).
      this.googleSync.cancelBooking(workspaceId, existing.id).catch(() => undefined);
      this.outlookSync.cancelBooking(workspaceId, existing.id).catch(() => undefined);
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
    booking: {
      id: string;
      email: string | null;
      notes: string | null;
      startAt: Date;
      endAt: Date;
      attendeeTimezone?: string | null;
    },
  ): Promise<void> {
    let meetingUrl: string | null = null;
    const conferencing = cal.conferencing ?? 'NONE';
    if (conferencing === 'GOOGLE_MEET') {
      await this.googleSync.pushBooking(workspaceId, booking.id).catch(() => undefined);
    } else if (conferencing === 'TEAMS') {
      await this.outlookSync.pushBooking(workspaceId, booking.id).catch(() => undefined);
    } else {
      this.googleSync.pushBooking(workspaceId, booking.id).catch(() => undefined);
      this.outlookSync.pushBooking(workspaceId, booking.id).catch(() => undefined);
    }
    if (conferencing !== 'NONE') {
      const fresh = await this.prisma.booking.findFirst({
        where: { id: booking.id, workspaceId },
        select: { meetingUrl: true },
      });
      meetingUrl = fresh?.meetingUrl ?? null;
    }
    if (booking.email) {
      const joinLine = meetingUrl ? `\nJoin: ${meetingUrl}` : '';
      // Render in the attendee's timezone when captured, else the calendar's.
      const when = formatInTimeZone(
        booking.startAt,
        booking.attendeeTimezone || cal.timezone || 'Europe/Istanbul',
      );
      const body =
        `Your booking is confirmed for ${when}.\n` +
        `Calendar: ${cal.name || 'Booking'}${joinLine}`;
      const ics = buildIcs({
        uid: booking.id,
        start: booking.startAt,
        end: booking.endAt,
        summary: cal.name || 'Booking',
        description: booking.notes ?? undefined,
        joinUrl: meetingUrl ?? undefined,
      });
      this.email
        .sendPlainEmailWithIcs(booking.email, `Booking confirmed: ${cal.name || 'Booking'}`, body, ics)
        .catch(() => undefined);
    }
    // One reminder job per configured lead time (default: a single T-1h customer
    // email). dedupKey is per (booking, offset) so re-running approval is safe.
    const reminders = parseReminderConfig((cal as any).reminderConfig);
    for (const r of reminders) {
      const runAt = new Date(booking.startAt.getTime() - r.offsetMinutes * 60_000);
      if (runAt.getTime() <= Date.now()) continue;
      await this.scheduledJobs.schedule({
        workspaceId,
        kind: BOOKING_REMINDER_KIND,
        runAt,
        dedupKey: `${booking.id}:${r.offsetMinutes}`,
        payload: {
          workspaceId,
          bookingId: booking.id,
          offsetMinutes: r.offsetMinutes,
          channels: r.channels,
          audience: r.audience,
        },
      });
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
    await this.prisma.$transaction(async (tx) => {
      await tx.booking.updateMany({ where: { id: existing.id, workspaceId }, data: { status } });
      await this.outbox.append(
        {
          type: MarketingEventTypes.BookingUpdated,
          idempotencyKey: `booking-updated:${existing.id}:${status}`,
          payload: { workspaceId, bookingId: existing.id, calendarId: existing.calendarId, occurredAt: new Date().toISOString() },
        },
        tx as any,
      );
    });
    if (status === 'CONFIRMED' && wasPending) {
      const cal = await this.prisma.bookingCalendar.findFirst({ where: { id: existing.calendarId, workspaceId } });
      if (cal) await this.afterConfirmed(workspaceId, cal, existing);
    }
    return { id: existing.id, status };
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

  private async remind(job: ClaimedJob): Promise<void> {
    const { workspaceId, bookingId, channels, audience } = job.payload as {
      workspaceId: string;
      bookingId: string;
      channels?: string[];
      audience?: string;
    };
    const booking = await this.prisma.booking.findFirst({ where: { id: bookingId, workspaceId } });
    if (!booking || booking.status !== 'CONFIRMED') return;
    const chans = channels ?? ['EMAIL'];
    const aud = audience ?? 'CUSTOMER';
    // Render in the attendee's timezone when captured, else the calendar's (not
    // UTC), matching the confirmation email.
    const cal = await this.prisma.bookingCalendar.findFirst({
      where: { id: booking.calendarId, workspaceId },
      select: { timezone: true },
    });
    const when = formatInTimeZone(
      booking.startAt,
      booking.attendeeTimezone || cal?.timezone || 'Europe/Istanbul',
    );
    const joinLine = booking.meetingUrl ? `\nJoin: ${booking.meetingUrl}` : '';

    if ((aud === 'CUSTOMER' || aud === 'BOTH') && chans.includes('EMAIL') && booking.email) {
      await this.email
        .sendPlainEmail(
          booking.email, 'Reminder: your booking is soon',
          `This is a reminder for your booking at ${when}.${joinLine}`,
        )
        .catch(() => undefined);
    }
    if ((aud === 'HOST' || aud === 'BOTH') && chans.includes('EMAIL') && booking.assigneeUserId) {
      const host = await this.prisma.marketingUser.findFirst({
        where: { id: booking.assigneeUserId, workspaceId },
        select: { email: true },
      });
      if (host?.email) {
        await this.email
          .sendPlainEmail(
            host.email, `Reminder: upcoming appointment with ${booking.name}`,
            `You have an appointment at ${when}.${joinLine}`,
          )
          .catch(() => undefined);
      }
    }
    // SMS reminders (channels includes 'SMS') are delivered by the notification /
    // messaging layer that subscribes to booking events — BookingService does not
    // couple directly to the SMS channel adapter here.
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
