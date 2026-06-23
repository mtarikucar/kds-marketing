import {
  Injectable,
  Logger,
  OnModuleInit,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { OutboxService } from '../../outbox/outbox.service';
import { EmailService } from '../../../common/services/email.service';
import { LeadAutoAssignerService } from '../services/lead-auto-assigner.service';
import { zonedParts, zonedWallTimeToUtcMs, parseHm } from './timezone-slots';
import { ScheduledJobService } from '../scheduling/scheduled-job.service';
import { ScheduledJobRunnerService, ClaimedJob } from '../scheduling/scheduled-job-runner.service';
import { normalizeEmail, normalizePhone } from '../utils/lead-normalize';
import { MarketingEventTypes } from '../events/marketing-event-types';
import { GoogleCalendarSyncService } from '../integrations/google-calendar-sync.service';

const BOOKING_REMINDER_KIND = 'booking.reminder';
const MAX_RANGE_DAYS = 21;
const CALENDAR_TYPES = ['SINGLE', 'ROUND_ROBIN', 'COLLECTIVE', 'CLASS'];

/**
 * Booking calendars + slot picking. Availability windows (per weekday, HH:mm)
 * are interpreted in UTC for v1 (timezone-aware slicing is a later refinement);
 * bookable slots = windows sliced into slotMinutes minus existing CONFIRMED
 * bookings. Booking mints/links a lead, emits booking.created (a workflow
 * trigger), emails a confirmation, and schedules a reminder.
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
    return this.prisma.bookingCalendar.create({
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
      },
    });
  }
  async update(workspaceId: string, id: string, dto: any) {
    const existing = await this.prisma.bookingCalendar.findFirst({ where: { id, workspaceId } });
    if (!existing) throw new NotFoundException('Calendar not found');
    const data: any = {};
    for (const k of ['name', 'ownerUserId', 'availability', 'slotMinutes', 'bufferMinutes', 'timezone', 'active'] as const) {
      if (dto[k] !== undefined) data[k] = dto[k];
    }
    if (dto.type !== undefined && CALENDAR_TYPES.includes(dto.type)) data.type = dto.type;
    if (dto.capacity !== undefined) data.capacity = this.normCapacity(dto.capacity);
    if (dto.slug !== undefined) data.slug = this.slugify(dto.slug);
    return this.prisma.bookingCalendar.update({ where: { id: existing.id }, data });
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
    const cap = new Date(from.getTime() + MAX_RANGE_DAYS * 86400_000);
    if (to > cap) to = cap;
    const now = Date.now();

    const memberCount = await this.prisma.bookingCalendarMember.count({
      where: { workspaceId, calendarId: calId },
    });
    const capacity = this.effectiveCapacity(cal, memberCount);

    // CONFIRMED bookings on THIS calendar are COUNTED against the slot capacity;
    // EXTERNAL_BUSY blocks (Google-pulled, workspace-wide) are a HARD block that
    // ignores capacity. Fetch them separately so capacity only applies to ours.
    const ours = await this.prisma.booking.findMany({
      where: {
        workspaceId,
        calendarId: calId,
        status: 'CONFIRMED',
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
    const avail = (cal.availability ?? {}) as Record<string, Array<{ start: string; end: string }>>;
    const slotMs = cal.slotMinutes * 60_000;
    const stepMs = (cal.slotMinutes + cal.bufferMinutes) * 60_000;
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
          if (s < now) continue;
          if (extIv.some(([bs, be]) => s < be && e > bs)) continue; // hard block
          const taken = ourIv.filter(([bs, be]) => s < be && e > bs).length;
          if (taken >= capacity) continue; // at capacity
          out.push(new Date(s).toISOString());
        }
      }
    }
    return out;
  }

  /** Public: book a slot. */
  async book(
    workspaceId: string, calId: string,
    dto: { start: string; name: string; email?: string; phone?: string; notes?: string },
  ) {
    const cal = await this.prisma.bookingCalendar.findFirst({ where: { id: calId, workspaceId, active: true } });
    if (!cal) throw new NotFoundException('Calendar not found');
    const start = new Date(dto.start);
    if (isNaN(start.getTime()) || start.getTime() < Date.now()) throw new BadRequestException('Invalid or past slot');
    // Reject an off-grid / out-of-hours timestamp: a direct API call must not be
    // able to book a slot the public picker (availability()) would never offer.
    if (!this.isAlignedSlot(cal, start)) {
      throw new BadRequestException('Slot is outside the calendar availability or not aligned to the grid');
    }
    const end = new Date(start.getTime() + cal.slotMinutes * 60_000);

    const booking = await this.prisma.$transaction(async (tx) => {
      // Serialize concurrent reservations for THIS calendar so the overlap
      // check below is race-free. Without it, two simultaneous public reserve
      // calls for the same slot both pass the (non-locking) conflict SELECT and
      // both insert — double-booking one slot. There is no DB-level
      // unique/exclusion constraint to catch it (Prisma can't model a partial/
      // range-exclude index without breaking migrate-parity), so a transaction-
      // scoped advisory lock is the clean fix; it auto-releases at commit.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`booking:${calId}`}))`;
      // Any EXTERNAL_BUSY (Google-pulled, workspace-wide) overlap is a HARD block
      // regardless of capacity — a visitor must not book over a Google-busy time
      // the slot picker had already hidden.
      const external = await tx.booking.findFirst({
        where: { workspaceId, status: 'EXTERNAL_BUSY', startAt: { lt: end }, endAt: { gt: start } },
        select: { id: true },
      });
      if (external) throw new BadRequestException('That slot was just taken');

      // Capacity-aware check: count our CONFIRMED bookings overlapping the slot
      // and reject once they reach the calendar's effective capacity (SINGLE/
      // COLLECTIVE→1, CLASS→capacity, ROUND_ROBIN→member count). Mirrors
      // availability() exactly so a direct reserve can't exceed what's offered.
      const overlapping = await tx.booking.findMany({
        where: { workspaceId, calendarId: calId, status: 'CONFIRMED', startAt: { lt: end }, endAt: { gt: start } },
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
                status: 'CONFIRMED',
                assigneeUserId: { in: memberIds },
                startAt: { lt: end },
                endAt: { gt: start },
              },
              select: { assigneeUserId: true },
            })
          : [];
        const taken = new Set(busyRows.map((o) => o.assigneeUserId).filter(Boolean) as string[]);
        assigneeUserId = members.find((m) => !taken.has(m.marketingUserId))?.marketingUserId ?? null;
      } else if (cal.type === 'CLASS') {
        assigneeUserId = null;
      }

      // Link or create a lead.
      const email = dto.email?.trim() || null;
      const phone = dto.phone?.trim() || null;
      const emailNormalized = normalizeEmail(email);
      const phoneNormalized = normalizePhone(phone);
      let leadId: string | null = null;
      if (emailNormalized || phoneNormalized) {
        // Dedup on the NORMALIZED keys (cross-path with manual/form leads) and
        // skip tombstoned (merged-away) leads.
        const existing = await tx.lead.findFirst({
          where: {
            workspaceId,
            mergedIntoId: null,
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
      }
      const created = await tx.booking.create({
        data: {
          workspaceId, calendarId: calId, leadId, startAt: start, endAt: end,
          name: dto.name, email, phone, notes: dto.notes ?? null,
          assigneeUserId,
          token: `bk_${randomBytes(16).toString('hex')}`,
        },
      });
      await this.outbox.append(
        {
          type: MarketingEventTypes.BookingCreated,
          idempotencyKey: `booking-created:${created.id}`,
          payload: { workspaceId, leadId, bookingId: created.id, calendarId: calId, startAt: start.toISOString(), occurredAt: new Date().toISOString() },
        },
        tx as any,
      );
      return created;
    });

    // Confirmation email + reminder (best-effort, outside the tx).
    if (booking.email) {
      this.email.sendPlainEmail(
        booking.email, `Booking confirmed: ${cal.name}`,
        `Your booking is confirmed for ${start.toUTCString()}.\nCalendar: ${cal.name}`,
      ).catch(() => undefined);
    }
    const remindAt = new Date(start.getTime() - 3600_000);
    if (remindAt.getTime() > Date.now()) {
      await this.scheduledJobs.schedule({
        workspaceId, kind: BOOKING_REMINDER_KIND, runAt: remindAt, dedupKey: booking.id,
        payload: { workspaceId, bookingId: booking.id },
      });
    }
    // Push the new booking to a connected Google Calendar (best-effort, inert
    // when the integration is unconfigured); the BookingCreated domain event
    // also drives this, so a missed direct call self-heals on the next pull.
    this.googleSync.pushBooking(workspaceId, booking.id).catch(() => undefined);

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
      select: { id: true, status: true },
    });
    if (!existing) throw new NotFoundException('Booking not found');
    if (existing.status === 'EXTERNAL_BUSY') {
      // External Google blocks are owned by Google; cancel them THERE.
      throw new BadRequestException('Cannot cancel an external calendar block');
    }
    if (existing.status !== 'CANCELLED') {
      await this.prisma.booking.updateMany({
        where: { id: existing.id, workspaceId },
        data: { status: 'CANCELLED' },
      });
      // Remove the Google mirror so the slot frees up on both sides.
      this.googleSync.cancelBooking(workspaceId, existing.id).catch(() => undefined);
    }
    return { id: existing.id, status: 'CANCELLED' };
  }

  private async remind(job: ClaimedJob): Promise<void> {
    const { workspaceId, bookingId } = job.payload;
    const booking = await this.prisma.booking.findFirst({ where: { id: bookingId, workspaceId } });
    if (!booking || booking.status !== 'CONFIRMED' || !booking.email) return;
    await this.email.sendPlainEmail(
      booking.email, 'Reminder: your booking is soon',
      `This is a reminder for your booking at ${booking.startAt.toUTCString()}.`,
    ).catch(() => undefined);
  }

  /**
   * True when `start` is a real bookable slot for this calendar: inside a
   * weekday availability window AND aligned to the slot+buffer grid — the same
   * enumeration availability() uses to offer slots. Closes the gap where a
   * direct reserve call could pass an arbitrary off-grid / out-of-hours time.
   */
  private isAlignedSlot(
    cal: { availability: unknown; slotMinutes: number; bufferMinutes: number; timezone?: string },
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
    const stepMs = (cal.slotMinutes + cal.bufferMinutes) * 60_000;
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
