import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { safeFetch, SsrfBlockedError } from '../../../common/util/safe-fetch';
import { DomainEventBus, DomainEvent } from '../../outbox/domain-event-bus.service';
import { MarketingEventTypes } from '../events/marketing-event-types';
import {
  GoogleCalendarService,
  GoogleCalendarConnectionRow,
} from './google-calendar.service';

/**
 * Google Calendar 2-way sync (real logic, both directions).
 *
 *  PUSH (our → Google): when a Booking is created in our system we mirror it as
 *  a Google event and store the event id on the Booking (`googleEventId`) so a
 *  later patch/delete is idempotent. Wired two ways for resilience: the
 *  BookingCreated domain event triggers it automatically, and BookingService
 *  may also call pushBooking()/cancelBooking() directly.
 *
 *  PULL (Google → ours): pullEvents() calls Google events.list with the stored
 *  syncToken (incremental). For EXTERNAL Google events (ones we did not push) it
 *  upserts a "busy" Booking (status EXTERNAL_BUSY) so our availability slicing
 *  respects them; cancelled Google events delete the busy block. The new
 *  nextSyncToken is persisted for the next incremental pull. A scheduler or the
 *  push-webhook receiver calls pullEvents().
 *
 * INERT by design: every method no-ops when the feature is unconfigured (env
 * OAuth client / secret-box missing) — see GoogleCalendarService.isConfigured.
 * Push failures are best-effort (logged, swallowed) so a Google outage never
 * breaks our booking flow; pull surfaces a structured result to the caller.
 */

const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';
const EXTERNAL_BUSY = 'EXTERNAL_BUSY';
// Page cap so one webhook/scheduler tick can't spin forever on a huge backlog.
const MAX_PULL_PAGES = 10;

interface GoogleEvent {
  id?: string;
  status?: string; // 'confirmed' | 'tentative' | 'cancelled'
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
}

interface EventsListResponse {
  items?: GoogleEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

export interface PullResult {
  ok: boolean;
  upserted: number;
  deleted: number;
  /** When true, the stored syncToken was invalid (HTTP 410) and was reset. */
  resyncRequired?: boolean;
  reason?: string;
}

@Injectable()
export class GoogleCalendarSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GoogleCalendarSyncService.name);

  private readonly bookingCreatedHandler = (event: DomainEvent<unknown>) =>
    this.onBookingCreated(event as DomainEvent<BookingCreatedPayload>);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: DomainEventBus,
    private readonly google: GoogleCalendarService,
  ) {}

  onModuleInit(): void {
    this.bus.on(MarketingEventTypes.BookingCreated, this.bookingCreatedHandler);
  }

  onModuleDestroy(): void {
    this.bus.off(MarketingEventTypes.BookingCreated, this.bookingCreatedHandler);
  }

  // ===================================================================== //
  //  PUSH (our → Google)                                                  //
  // ===================================================================== //

  /** Domain-event entrypoint — mirror a freshly-created booking onto Google. */
  private async onBookingCreated(
    event: DomainEvent<BookingCreatedPayload>,
  ): Promise<void> {
    const { workspaceId, bookingId } = event.payload ?? ({} as BookingCreatedPayload);
    if (!workspaceId || !bookingId) return;
    await this.pushBooking(workspaceId, bookingId).catch((e) =>
      this.logger.warn(
        `push(booking=${bookingId}) failed: ${(e as Error).message}`,
      ),
    );
  }

  /**
   * Create (or patch) the Google event mirroring our booking, and store the
   * event id on the booking. No-op when the feature is inert or no enabled
   * connection exists for the workspace. Best-effort: never throws on Google
   * errors (logs + returns null) so the booking flow is unaffected.
   */
  async pushBooking(
    workspaceId: string,
    bookingId: string,
  ): Promise<string | null> {
    if (!this.google.isConfigured()) return null;
    const conn = await this.activeConnection(workspaceId);
    if (!conn) return null;

    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, workspaceId },
    });
    // Don't echo events we pulled FROM Google back INTO Google.
    if (!booking || booking.status === EXTERNAL_BUSY) return null;

    const body = {
      summary: booking.name || 'Booking',
      description: booking.notes || undefined,
      start: { dateTime: booking.startAt.toISOString() },
      end: { dateTime: booking.endAt.toISOString() },
      ...(booking.email
        ? { attendees: [{ email: booking.email }] }
        : {}),
      // Tag our events so pull can recognise+skip them (defence in depth).
      extendedProperties: {
        private: { kdsBookingId: booking.id, kdsWorkspaceId: workspaceId },
      },
    };

    try {
      const accessToken = await this.google.getFreshAccessToken(conn);
      const cal = encodeURIComponent(conn.googleCalendarId);
      let event: GoogleEvent;
      if (booking.googleEventId) {
        // PATCH the existing mirror.
        event = await this.apiJson(
          `${CALENDAR_API_BASE}/calendars/${cal}/events/${encodeURIComponent(booking.googleEventId)}`,
          accessToken,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
      } else {
        event = await this.apiJson(
          `${CALENDAR_API_BASE}/calendars/${cal}/events`,
          accessToken,
          { method: 'POST', body: JSON.stringify(body) },
        );
        if (event.id) {
          await this.prisma.booking.updateMany({
            where: { id: booking.id, workspaceId },
            data: { googleEventId: event.id },
          });
        }
      }
      return event.id ?? booking.googleEventId ?? null;
    } catch (e) {
      this.logger.warn(
        `pushBooking(${bookingId}) Google API failed: ${(e as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Delete the mirrored Google event when our booking is cancelled. Best-effort.
   * Returns true when a delete was issued (or the booking had no mirror).
   */
  async cancelBooking(
    workspaceId: string,
    bookingId: string,
  ): Promise<boolean> {
    if (!this.google.isConfigured()) return false;
    const conn = await this.activeConnection(workspaceId);
    if (!conn) return false;

    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, workspaceId },
      select: { googleEventId: true, status: true },
    });
    if (!booking || !booking.googleEventId || booking.status === EXTERNAL_BUSY) {
      return false;
    }

    try {
      const accessToken = await this.google.getFreshAccessToken(conn);
      const cal = encodeURIComponent(conn.googleCalendarId);
      await this.apiVoid(
        `${CALENDAR_API_BASE}/calendars/${cal}/events/${encodeURIComponent(booking.googleEventId)}`,
        accessToken,
        { method: 'DELETE' },
      );
      return true;
    } catch (e) {
      this.logger.warn(
        `cancelBooking(${bookingId}) Google delete failed: ${(e as Error).message}`,
      );
      return false;
    }
  }

  // ===================================================================== //
  //  PULL (Google → ours)                                                 //
  // ===================================================================== //

  /**
   * Incremental pull from Google for one connection. Upserts EXTERNAL_BUSY
   * Bookings for external Google events so availability respects them; deletes
   * the busy block when the source event is cancelled; persists nextSyncToken.
   *
   * On HTTP 410 (sync token expired) the stored token is cleared and a fresh
   * full pull is performed so we recover automatically.
   */
  async pullEvents(connection: GoogleCalendarConnectionRow): Promise<PullResult> {
    if (!this.google.isConfigured()) {
      return { ok: false, upserted: 0, deleted: 0, reason: 'not-configured' };
    }
    if (!connection.enabled) {
      return { ok: false, upserted: 0, deleted: 0, reason: 'disabled' };
    }

    let accessToken: string;
    try {
      accessToken = await this.google.getFreshAccessToken(connection);
    } catch (e) {
      return {
        ok: false,
        upserted: 0,
        deleted: 0,
        reason: (e as Error).message,
      };
    }

    const cal = encodeURIComponent(connection.googleCalendarId);
    let syncToken = connection.syncToken;
    let pageToken: string | undefined;
    let nextSyncToken: string | undefined;
    let upserted = 0;
    let deleted = 0;
    let resyncRequired = false;

    for (let page = 0; page < MAX_PULL_PAGES; page++) {
      const url = new URL(`${CALENDAR_API_BASE}/calendars/${cal}/events`);
      url.searchParams.set('singleEvents', 'true');
      url.searchParams.set('maxResults', '250');
      url.searchParams.set('showDeleted', 'true');
      if (pageToken) {
        url.searchParams.set('pageToken', pageToken);
      } else if (syncToken) {
        url.searchParams.set('syncToken', syncToken);
      } else {
        // First-ever pull: bound a full sync to a forward window.
        url.searchParams.set('timeMin', new Date().toISOString());
      }

      let res: EventsListResponse;
      try {
        res = await this.apiJson<EventsListResponse>(url.toString(), accessToken, {
          method: 'GET',
        });
      } catch (e) {
        // 410 GONE ⇒ syncToken invalid: clear it and restart a full pull once.
        if (e instanceof GoogleHttpError && e.status === 410 && syncToken) {
          await this.prisma.googleCalendarConnection.updateMany({
            where: { id: connection.id, workspaceId: connection.workspaceId },
            data: { syncToken: null },
          });
          syncToken = null;
          pageToken = undefined;
          nextSyncToken = undefined;
          upserted = 0;
          deleted = 0;
          resyncRequired = true;
          continue;
        }
        return {
          ok: false,
          upserted,
          deleted,
          reason: (e as Error).message,
        };
      }

      for (const ev of res.items ?? []) {
        const r = await this.applyExternalEvent(connection, ev);
        upserted += r.upserted;
        deleted += r.deleted;
      }

      if (res.nextPageToken) {
        pageToken = res.nextPageToken;
        continue;
      }
      nextSyncToken = res.nextSyncToken;
      break;
    }

    if (nextSyncToken) {
      await this.prisma.googleCalendarConnection.updateMany({
        where: { id: connection.id, workspaceId: connection.workspaceId },
        data: { syncToken: nextSyncToken },
      });
    }

    return { ok: true, upserted, deleted, resyncRequired };
  }

  /** Pull every enabled connection in a workspace (scheduler/webhook fan-out). */
  async pullWorkspace(workspaceId: string): Promise<PullResult> {
    const conns = (await this.prisma.googleCalendarConnection.findMany({
      where: { workspaceId, enabled: true },
    })) as GoogleCalendarConnectionRow[];
    let upserted = 0;
    let deleted = 0;
    let ok = true;
    for (const c of conns) {
      const r = await this.pullEvents(c);
      upserted += r.upserted;
      deleted += r.deleted;
      ok = ok && r.ok;
    }
    return { ok, upserted, deleted };
  }

  /**
   * Resolve the connection a Google push-webhook is about (by channel id) and
   * pull it. Returns null when the channel is unknown (the receiver 404s/200s).
   */
  async pullByChannel(
    channelId: string,
    resourceId: string,
  ): Promise<PullResult | null> {
    if (!channelId) return null;
    const conn = (await this.prisma.googleCalendarConnection.findFirst({
      where: { channelId },
    })) as GoogleCalendarConnectionRow | null;
    // Validate the resource id matches what we stored for this channel.
    if (!conn || (conn.resourceId && conn.resourceId !== resourceId)) {
      return null;
    }
    return this.pullEvents(conn);
  }

  // ===================================================================== //
  //  Internals                                                            //
  // ===================================================================== //

  /** Upsert/delete ONE external Google event as an EXTERNAL_BUSY booking. */
  private async applyExternalEvent(
    connection: GoogleCalendarConnectionRow,
    ev: GoogleEvent,
  ): Promise<{ upserted: number; deleted: number }> {
    if (!ev.id) return { upserted: 0, deleted: 0 };
    const workspaceId = connection.workspaceId;

    // Skip events WE pushed (mirrors of our own bookings) to avoid echo loops:
    // a booking with this googleEventId that is NOT an EXTERNAL_BUSY block.
    const ours = await this.prisma.booking.findFirst({
      where: {
        workspaceId,
        googleEventId: ev.id,
        status: { not: EXTERNAL_BUSY },
      },
      select: { id: true },
    });
    if (ours) return { upserted: 0, deleted: 0 };

    // Cancelled at Google ⇒ remove our busy block.
    if (ev.status === 'cancelled') {
      const res = await this.prisma.booking.deleteMany({
        where: { workspaceId, googleEventId: ev.id, status: EXTERNAL_BUSY },
      });
      return { upserted: 0, deleted: res.count };
    }

    const start = parseGoogleTime(ev.start);
    const end = parseGoogleTime(ev.end);
    if (!start || !end || end <= start) {
      // All-day or malformed: skip (can't slice a slot window).
      return { upserted: 0, deleted: 0 };
    }

    const existing = await this.prisma.booking.findFirst({
      where: { workspaceId, googleEventId: ev.id, status: EXTERNAL_BUSY },
      select: { id: true },
    });
    if (existing) {
      await this.prisma.booking.updateMany({
        where: { id: existing.id, workspaceId },
        data: { startAt: start, endAt: end, name: ev.summary || 'Busy' },
      });
    } else {
      // EXTERNAL_BUSY blocks live in the bookings table but are not tied to one
      // of our BookingCalendars; the calendarId mirrors the connection so the
      // row is attributable and the workspace scope is intact.
      await this.prisma.booking.create({
        data: {
          workspaceId,
          calendarId: `gcal:${connection.id}`,
          startAt: start,
          endAt: end,
          name: ev.summary || 'Busy (Google Calendar)',
          status: EXTERNAL_BUSY,
          googleEventId: ev.id,
          token: `gcal_${randomBytes(16).toString('hex')}`,
        },
      });
    }
    return { upserted: 1, deleted: 0 };
  }

  private async activeConnection(
    workspaceId: string,
  ): Promise<GoogleCalendarConnectionRow | null> {
    return (await this.prisma.googleCalendarConnection.findFirst({
      where: { workspaceId, enabled: true },
      orderBy: { createdAt: 'asc' },
    })) as GoogleCalendarConnectionRow | null;
  }

  /** Authenticated Google API call returning parsed JSON; throws on !ok. */
  private async apiJson<T = GoogleEvent>(
    url: string,
    accessToken: string,
    init: { method: string; body?: string },
  ): Promise<T> {
    const res = await this.apiCall(url, accessToken, init);
    return (await res.json()) as T;
  }

  /** Authenticated Google API call where the body is ignored (DELETE). */
  private async apiVoid(
    url: string,
    accessToken: string,
    init: { method: string },
  ): Promise<void> {
    await this.apiCall(url, accessToken, init);
  }

  private async apiCall(
    url: string,
    accessToken: string,
    init: { method: string; body?: string },
  ): Promise<Response> {
    let res: Response;
    try {
      res = await safeFetch(url, {
        method: init.method,
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        ...(init.body ? { body: init.body } : {}),
        timeoutMs: 8000,
      });
    } catch (e) {
      if (e instanceof SsrfBlockedError) {
        throw new GoogleHttpError(0, `blocked: ${e.message}`);
      }
      throw new GoogleHttpError(0, (e as Error).message);
    }
    // 204/200 with empty body (DELETE) is fine.
    if (!res.ok && res.status !== 204) {
      // Drain so the socket can be reused.
      await res.text().catch(() => undefined);
      throw new GoogleHttpError(res.status, `Google API HTTP ${res.status}`);
    }
    return res;
  }
}

// ----------------------------- helpers ----------------------------------- //

class GoogleHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GoogleHttpError';
  }
}

interface BookingCreatedPayload {
  workspaceId: string;
  bookingId: string;
  calendarId?: string;
  leadId?: string | null;
  startAt?: string;
}

/** Google times are {dateTime} (timed) or {date} (all-day, skipped). */
function parseGoogleTime(
  t: { dateTime?: string; date?: string } | undefined,
): Date | null {
  if (!t?.dateTime) return null;
  const d = new Date(t.dateTime);
  return isNaN(d.getTime()) ? null : d;
}
