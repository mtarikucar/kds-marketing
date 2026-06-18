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
import { ScheduledJobService } from '../scheduling/scheduled-job.service';
import { ScheduledJobRunnerService, ClaimedJob } from '../scheduling/scheduled-job-runner.service';
import { MarketingEventTypes } from '../events/marketing-event-types';
import { GoogleCalendarSyncService } from '../integrations/google-calendar-sync.service';

const BOOKING_REMINDER_KIND = 'booking.reminder';
const MAX_RANGE_DAYS = 21;

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
    if (dto.slug !== undefined) data.slug = this.slugify(dto.slug);
    return this.prisma.bookingCalendar.update({ where: { id: existing.id }, data });
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
    return { id: c.id, name: c.name, slotMinutes: c.slotMinutes, timezone: c.timezone };
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

    // Slots are blocked by our CONFIRMED bookings AND by EXTERNAL_BUSY blocks
    // pulled from a connected Google Calendar (which are not tied to a specific
    // calendarId — they busy the whole workspace's availability).
    const bookings = await this.prisma.booking.findMany({
      where: {
        workspaceId,
        status: { in: ['CONFIRMED', 'EXTERNAL_BUSY'] },
        // OVERLAP the window, not just start-within it: a block that started
        // before `from` but runs into the window still busies these slots.
        startAt: { lt: to },
        endAt: { gt: from },
        OR: [{ calendarId: calId }, { status: 'EXTERNAL_BUSY' }],
      },
      select: { startAt: true, endAt: true },
    });
    const busy = bookings.map((b) => [b.startAt.getTime(), b.endAt.getTime()] as [number, number]);
    const avail = (cal.availability ?? {}) as Record<string, Array<{ start: string; end: string }>>;
    const slotMs = cal.slotMinutes * 60_000;
    const stepMs = (cal.slotMinutes + cal.bufferMinutes) * 60_000;
    const out: string[] = [];

    for (let day = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())); day <= to; day = new Date(day.getTime() + 86400_000)) {
      const windows = avail[String(day.getUTCDay())] ?? [];
      for (const w of windows) {
        const ws = this.atUtc(day, w.start);
        const we = this.atUtc(day, w.end);
        if (ws == null || we == null) continue;
        for (let s = ws; s + slotMs <= we; s += stepMs) {
          const e = s + slotMs;
          if (s < now) continue;
          if (busy.some(([bs, be]) => s < be && e > bs)) continue;
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
      // Mirror availability() exactly: a slot is taken by a CONFIRMED booking on
      // THIS calendar OR by any EXTERNAL_BUSY block (Google-pulled, workspace-
      // wide, not tied to a calendarId). The old check ignored EXTERNAL_BUSY, so
      // a visitor could book straight over a Google-busy time the slot picker
      // had already hidden.
      const conflict = await tx.booking.findFirst({
        where: {
          workspaceId,
          status: { in: ['CONFIRMED', 'EXTERNAL_BUSY'] },
          startAt: { lt: end },
          endAt: { gt: start },
          OR: [{ calendarId: calId }, { status: 'EXTERNAL_BUSY' }],
        },
        select: { id: true },
      });
      if (conflict) throw new BadRequestException('That slot was just taken');

      // Link or create a lead.
      const email = dto.email?.trim() || null;
      const phone = dto.phone?.trim() || null;
      let leadId: string | null = null;
      if (email || phone) {
        const existing = await tx.lead.findFirst({
          where: { workspaceId, OR: [...(email ? [{ email }] : []), ...(phone ? [{ phone }] : [])] },
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
            ...(autoOwner ? { assignedToId: autoOwner } : {}),
          },
        });
        leadId = lead.id;
      }
      const created = await tx.booking.create({
        data: {
          workspaceId, calendarId: calId, leadId, startAt: start, endAt: end,
          name: dto.name, email, phone, notes: dto.notes ?? null,
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

  private atUtc(day: Date, hhmm: string): number | null {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm ?? '');
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, min);
  }

  private slugify(s: string): string {
    return (s || 'calendar').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').slice(0, 80) || 'calendar';
  }
}
