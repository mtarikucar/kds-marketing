import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomBytes, randomUUID } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { safeFetch, SsrfBlockedError } from '../../../common/util/safe-fetch';
import { withAdvisoryLock } from '../../../common/scheduling/advisory-lock';
import { DomainEventBus, DomainEvent } from '../../outbox/domain-event-bus.service';
import {
  MarketingEventTypes,
  MarketingBookingLifecyclePayload,
} from '../events/marketing-event-types';
import {
  GoogleCalendarService,
  GoogleCalendarConnectionRow,
} from './google-calendar.service';
import { HostResolverService } from './conferencing/host-resolver.service';
import {
  GoogleMeetSpacesService,
  parseMeetSpaceConfig,
  MeetSpace,
} from './conferencing/google-meet-spaces.service';
import { ScheduledJobService } from '../scheduling/scheduled-job.service';
import {
  ScheduledJobRunnerService,
  ClaimedJob,
} from '../scheduling/scheduled-job-runner.service';

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
const CHANNELS_STOP_ENDPOINT = `${CALENDAR_API_BASE}/channels/stop`;
const EXTERNAL_BUSY = 'EXTERNAL_BUSY';
// Durable job that re-fetches a Google Meet link when conferenceData came back
// `pending` on the initial insert (Google provisions the conference async).
const CONFERENCE_RESOLVE_KIND = 'booking.conference.resolve';
// Page cap so one webhook/scheduler tick can't spin forever on a huge backlog.
const MAX_PULL_PAGES = 10;
// We REQUEST a 7-day watch TTL (Google's calendar maximum); Google may return a
// shorter expiration, which we honour. The renewal cron re-registers before it
// lapses so the real-time push never silently stops.
const WATCH_TTL_SECONDS = 7 * 24 * 60 * 60;
// Renew when a channel is within this window of expiring (cron runs every 6h).
const WATCH_RENEW_BEFORE_MS = 24 * 60 * 60 * 1000;
// The path Google POSTs change notifications to (built onto MARKETING_PUBLIC_URL).
const WEBHOOK_PATH = '/api/marketing/integrations/google-calendar/notifications';

interface GoogleEvent {
  id?: string;
  status?: string; // 'confirmed' | 'tentative' | 'cancelled'
  // Google free/busy flag: 'opaque' (default — the time is BUSY) or
  // 'transparent' (the attendee marked it FREE; it must not block availability).
  transparency?: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  // The private props the push stamps (events.list returns them for the owner),
  // so pull can recognise+skip our own mirrors even before googleEventId is saved.
  extendedProperties?: { private?: Record<string, string> };
  // Google Meet conferencing (present when we requested conferenceData). The
  // hangoutLink is the join URL; conferenceData carries the async create status.
  hangoutLink?: string;
  conferenceData?: {
    conferenceId?: string;
    entryPoints?: Array<{ entryPointType?: string; uri?: string }>;
    createRequest?: { status?: { statusCode?: string } };
  };
}

interface EventsListResponse {
  items?: GoogleEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

/** Google events.watch response (the push-channel resource). */
interface WatchResponse {
  id?: string; // echoes our channel id
  resourceId?: string; // opaque Google resource id (sent back on every webhook)
  expiration?: string; // ms-epoch as a string
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

  private readonly bookingCancelledHandler = (event: DomainEvent<unknown>) =>
    this.onBookingCancelled(
      event as DomainEvent<MarketingBookingLifecyclePayload>,
    );

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: DomainEventBus,
    private readonly google: GoogleCalendarService,
    private readonly hostResolver: HostResolverService,
    private readonly scheduledJobs: ScheduledJobService,
    private readonly runner: ScheduledJobRunnerService,
    private readonly meetSpaces: GoogleMeetSpacesService,
  ) {}

  onModuleInit(): void {
    this.bus.on(MarketingEventTypes.BookingCreated, this.bookingCreatedHandler);
    this.bus.on(
      MarketingEventTypes.BookingCancelled,
      this.bookingCancelledHandler,
    );
    this.runner.registerHandler(CONFERENCE_RESOLVE_KIND, (job) =>
      this.resolvePendingConference(job),
    );
  }

  onModuleDestroy(): void {
    this.bus.off(MarketingEventTypes.BookingCreated, this.bookingCreatedHandler);
    this.bus.off(
      MarketingEventTypes.BookingCancelled,
      this.bookingCancelledHandler,
    );
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

  /** Domain-event entrypoint — tear down the Google mirror (and its attached
   * Meet conference) when a booking is cancelled. The direct call in
   * BookingService.cancel stays as a self-healing fallback. */
  private async onBookingCancelled(
    event: DomainEvent<MarketingBookingLifecyclePayload>,
  ): Promise<void> {
    const { workspaceId, bookingId } =
      event.payload ?? ({} as MarketingBookingLifecyclePayload);
    if (!workspaceId || !bookingId) return;
    await this.cancelBooking(workspaceId, bookingId).catch((e) =>
      this.logger.warn(
        `cancel(booking=${bookingId}) failed: ${(e as Error).message}`,
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

    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, workspaceId },
    });
    // Don't echo events we pulled FROM Google back INTO Google.
    if (!booking || booking.status === EXTERNAL_BUSY) return null;

    // Does this booking's calendar attach a Google Meet link? If so the meeting
    // is hosted by the ASSIGNED member's own connection (falling back to the
    // owner's, then the workspace's active one).
    const calCfg = await this.prisma.bookingCalendar.findFirst({
      where: { id: booking.calendarId, workspaceId },
      select: { conferencing: true, conferenceConfig: true },
    });
    const wantsMeet = calCfg?.conferencing === 'GOOGLE_MEET';
    const conn = await this.resolveGoogleConnection(
      workspaceId,
      booking,
      wantsMeet,
    );
    if (!conn) return null;

    // Advanced Meet (Phase 4): when the calendar requests recording/transcript/
    // moderation AND the host connection has the advanced scope, provision a
    // configured Meet space and ATTACH it to the event (instead of the standard
    // conferenceData.createRequest). Inert → null → falls back to the standard.
    let advancedSpace: MeetSpace | null = null;
    if (wantsMeet) {
      const spaceCfg = parseMeetSpaceConfig((calCfg as any)?.conferenceConfig);
      if (spaceCfg && this.meetSpaces.available(conn)) {
        advancedSpace = await this.meetSpaces
          .createConfiguredSpace(conn, spaceCfg)
          .catch(() => null);
      }
    }

    const body: Record<string, unknown> = {
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
      // Advanced: attach the pre-created configured space (no createRequest).
      // Standard: request a fresh Meet (requestId stable per booking ⇒ retries
      // never duplicate). Both need `?conferenceDataVersion=1` on the write.
      ...(wantsMeet && advancedSpace
        ? {
            conferenceData: {
              conferenceId: advancedSpace.meetingCode || undefined,
              conferenceSolution: {
                key: { type: 'hangoutsMeet' },
                name: 'Google Meet',
              },
              entryPoints: [
                { entryPointType: 'video', uri: advancedSpace.meetingUri },
              ],
            },
          }
        : wantsMeet
        ? {
            conferenceData: {
              createRequest: {
                requestId: `bk${booking.id.replace(/-/g, '')}`,
                conferenceSolutionKey: { type: 'hangoutsMeet' },
              },
            },
          }
        : {}),
    };

    try {
      const accessToken = await this.google.getFreshAccessToken(conn);
      const cal = encodeURIComponent(conn.googleCalendarId);
      const confQuery = wantsMeet ? '?conferenceDataVersion=1' : '';
      let event: GoogleEvent;
      if (booking.googleEventId) {
        // PATCH the existing mirror.
        event = await this.apiJson(
          `${CALENDAR_API_BASE}/calendars/${cal}/events/${encodeURIComponent(booking.googleEventId)}${confQuery}`,
          accessToken,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
      } else {
        // Deterministic event id ⇒ the create is IDEMPOTENT. A booking's push
        // can fire twice (BookingService calls pushBooking directly AND the
        // BookingCreated domain event drives it); with a client-supplied id the
        // second create returns 409 instead of minting a DUPLICATE Google event
        // (which pull would otherwise re-import as a phantom EXTERNAL_BUSY block).
        // Booking ids are UUIDs (hex), so stripping hyphens yields a valid
        // base32hex id ([a-v0-9], 5–1024 chars).
        const eventId = `bk${booking.id.replace(/-/g, '')}`;
        try {
          event = await this.apiJson(
            `${CALENDAR_API_BASE}/calendars/${cal}/events${confQuery}`,
            accessToken,
            { method: 'POST', body: JSON.stringify({ ...body, id: eventId }) },
          );
        } catch (e) {
          if (e instanceof GoogleHttpError && e.status === 409) {
            // The sibling push path already created it — adopt the known id.
            event = { id: eventId };
          } else {
            throw e;
          }
        }
        if (event.id) {
          await this.prisma.booking.updateMany({
            where: { id: booking.id, workspaceId },
            data: { googleEventId: event.id },
          });
        }
      }
      // Persist the Meet join link. For an advanced space we already have the
      // configured URI; otherwise read it back (or queue a follow-up when Google
      // is still provisioning a standard conference).
      if (wantsMeet && advancedSpace) {
        await this.prisma.booking.updateMany({
          where: { id: booking.id, workspaceId },
          data: {
            meetingUrl: advancedSpace.meetingUri,
            conferenceProvider: 'GOOGLE_MEET',
            conferenceId: advancedSpace.meetingCode || null,
            conferenceStatus: 'created',
          },
        });
      } else if (wantsMeet) {
        await this.persistConference(workspaceId, booking.id, event);
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

    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, workspaceId },
      select: {
        googleEventId: true,
        status: true,
        calendarId: true,
        assigneeUserId: true,
        conferenceProvider: true,
      },
    });
    if (!booking || !booking.googleEventId || booking.status === EXTERNAL_BUSY) {
      return false;
    }
    // Delete from the SAME connection the event was created on (the host's, for
    // a Meet booking), so the mirror + attached conference are torn down.
    const conn = await this.resolveGoogleConnection(
      workspaceId,
      booking,
      booking.conferenceProvider === 'GOOGLE_MEET',
    );
    if (!conn) return false;

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
  //  WATCH (real-time push channel lifecycle)                             //
  // ===================================================================== //

  /**
   * Ensure the workspace's active connection has a LIVE Google push channel:
   * (re)register one when there's none, or when the current one is within the
   * renewal window. Called after a successful connect and by the renewal cron.
   * Best-effort — returns false (never throws) so connecting/sync is unaffected
   * when push can't be established (e.g. the webhook domain isn't verified).
   */
  async ensureWatch(
    workspaceId: string,
    connectionId?: string,
  ): Promise<boolean> {
    if (!this.google.isConfigured()) return false;
    // Target the specific connection when given (so a freshly-connected SECOND
    // calendar gets its own watch), else the workspace's active connection.
    const conn = connectionId
      ? ((await this.prisma.googleCalendarConnection.findFirst({
          where: { id: connectionId, workspaceId, enabled: true },
        })) as GoogleCalendarConnectionRow | null)
      : await this.activeConnection(workspaceId);
    if (!conn) return false;
    if (!this.watchNeedsRenewal(conn)) return true;
    return this.startWatch(conn);
  }

  /** True when the connection has no channel, or its channel is near expiry. */
  private watchNeedsRenewal(conn: GoogleCalendarConnectionRow): boolean {
    if (!conn.channelId || !conn.channelExpiration) return true;
    return (
      conn.channelExpiration.getTime() - WATCH_RENEW_BEFORE_MS <= Date.now()
    );
  }

  /**
   * Register a fresh events.watch push channel for the connection (stopping any
   * prior one first so channels don't pile up), and persist its id/resource/
   * token/expiration. Returns true on success; on a Google error (commonly a
   * 401 when the webhook domain isn't verified for the project) it logs a clear
   * message and returns false, leaving the connection in manual-sync mode.
   */
  async startWatch(conn: GoogleCalendarConnectionRow): Promise<boolean> {
    if (!this.google.isConfigured()) return false;
    const address = this.webhookAddress();
    if (!address) {
      this.logger.warn(
        'Google Calendar watch skipped: MARKETING_PUBLIC_URL is not an https URL',
      );
      return false;
    }

    // Capture any prior channel so we can retire it AFTER the replacement is
    // live and persisted. Stopping the old channel first (the naive order) would
    // orphan the connection if the new watch POST or its persist then failed —
    // Google would keep firing at a channelId no row matches, and push would be
    // lost until the next connect.
    const prevChannelId = conn.channelId;
    const prevResourceId = conn.resourceId;

    const channelId = randomUUID();
    const channelToken = randomBytes(24).toString('hex');
    const body = {
      id: channelId,
      type: 'web_hook',
      address,
      token: channelToken,
      params: { ttl: String(WATCH_TTL_SECONDS) },
    };

    try {
      const accessToken = await this.google.getFreshAccessToken(conn);
      const cal = encodeURIComponent(conn.googleCalendarId);
      const res = await this.apiJson<WatchResponse>(
        `${CALENDAR_API_BASE}/calendars/${cal}/events/watch`,
        accessToken,
        { method: 'POST', body: JSON.stringify(body) },
      );
      const expMs = Number(res.expiration);
      const expiration = Number.isFinite(expMs)
        ? new Date(expMs)
        : new Date(Date.now() + WATCH_TTL_SECONDS * 1000);
      await this.prisma.googleCalendarConnection.updateMany({
        where: { id: conn.id, workspaceId: conn.workspaceId },
        data: {
          channelId,
          resourceId: res.resourceId ?? null,
          channelToken,
          channelExpiration: expiration,
        },
      });
      // Keep the in-memory row coherent for any follow-on use this request.
      conn.channelId = channelId;
      conn.resourceId = res.resourceId ?? null;
      conn.channelToken = channelToken;
      conn.channelExpiration = expiration;

      // New channel is live AND persisted — now best-effort retire the old one.
      if (prevChannelId) {
        await this.postChannelStop(prevChannelId, prevResourceId, accessToken).catch(
          (e) =>
            this.logger.warn(
              `Google Calendar: failed to stop superseded channel ${prevChannelId}: ${(e as Error).message}`,
            ),
        );
      }
      this.logger.log(
        `Google Calendar watch active for connection ${conn.id} until ${expiration.toISOString()}`,
      );
      return true;
    } catch (e) {
      const status = e instanceof GoogleHttpError ? e.status : 0;
      this.logger.warn(
        `Google Calendar watch failed for connection ${conn.id} (HTTP ${status}) — ` +
          `staying in manual-sync mode. If this is 401, verify the webhook domain ` +
          `for the Google Cloud project. ${(e as Error).message}`,
      );
      return false;
    }
  }

  /**
   * Stop the connection's Google push channel (best-effort) and clear the
   * channel fields. Called on disconnect and before re-registering.
   */
  async stopWatch(conn: GoogleCalendarConnectionRow): Promise<void> {
    if (!conn.channelId) return;
    if (this.google.isConfigured()) {
      try {
        const accessToken = await this.google.getFreshAccessToken(conn);
        await this.postChannelStop(conn.channelId, conn.resourceId, accessToken);
      } catch (e) {
        // A channel that's already gone/expired is fine — just clear our copy.
        this.logger.warn(
          `Google Calendar channels.stop failed for ${conn.id}: ${(e as Error).message}`,
        );
      }
    }
    await this.prisma.googleCalendarConnection.updateMany({
      where: { id: conn.id, workspaceId: conn.workspaceId },
      data: {
        channelId: null,
        resourceId: null,
        channelToken: null,
        channelExpiration: null,
      },
    });
    conn.channelId = null;
    conn.resourceId = null;
    conn.channelToken = null;
    conn.channelExpiration = null;
  }

  /** Low-level Google channels.stop for an arbitrary channel (no DB write). */
  private async postChannelStop(
    channelId: string,
    resourceId: string | null,
    accessToken: string,
  ): Promise<void> {
    await this.apiVoid(CHANNELS_STOP_ENDPOINT, accessToken, {
      method: 'POST',
      body: JSON.stringify({ id: channelId, resourceId }),
    });
  }

  /**
   * Renew push channels that are within the renewal window so the real-time
   * feed never lapses. Runs every 6h. Only touches connections that ALREADY
   * have a channel (a connection whose initial watch failed — e.g. unverified
   * domain — is re-attempted on the next connect, not spammed here).
   *
   * Advisory-locked so a multi-replica deploy renews each due channel ONCE — two
   * replicas firing on the same tick would each mint a fresh watch channel and
   * strand the other's (startWatch is not idempotent; every call creates a new
   * channelId), leaking a live channel that pushes to a channelId no row matches.
   */
  @Cron(CronExpression.EVERY_6_HOURS, { name: 'gcal-watch-renew' })
  async renewWatches(): Promise<{ renewed: number }> {
    if (!this.google.isConfigured()) return { renewed: 0 };
    let renewed = 0;
    await withAdvisoryLock(
      this.prisma,
      'gcal:watch-renew',
      async () => {
        const cutoff = new Date(Date.now() + WATCH_RENEW_BEFORE_MS);
        const due = (await this.prisma.googleCalendarConnection.findMany({
          where: {
            enabled: true,
            channelId: { not: null },
            OR: [
              { channelExpiration: null },
              { channelExpiration: { lte: cutoff } },
            ],
          },
        })) as GoogleCalendarConnectionRow[];
        for (const conn of due) {
          if (await this.startWatch(conn)) renewed++;
        }
        if (renewed) {
          this.logger.log(`Google Calendar: renewed ${renewed} push channel(s)`);
        }
      },
      this.logger,
    );
    return { renewed };
  }

  /** Build the public https webhook address, or null when not deployable. */
  private webhookAddress(): string | null {
    const base = process.env.MARKETING_PUBLIC_URL?.trim();
    if (!base || !base.startsWith('http')) return null;
    return new URL(WEBHOOK_PATH, base).toString();
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
    channelToken?: string,
  ): Promise<PullResult | null> {
    if (!channelId) return null;
    const conn = (await this.prisma.googleCalendarConnection.findFirst({
      where: { channelId },
    })) as GoogleCalendarConnectionRow | null;
    if (!conn) return null;
    // Validate the resource id AND the per-channel token we set at watch time —
    // both must match what we stored, else this is a stale/forged notification.
    if (conn.resourceId && conn.resourceId !== resourceId) return null;
    if (conn.channelToken && conn.channelToken !== channelToken) return null;
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

    // Skip events WE pushed, by the tag the push stamps — the load-bearing echo
    // guard. The googleEventId DB check below MISSES the race where a pull runs
    // between Google-create and the booking.googleEventId write, which would then
    // import our own mirror as a permanent phantom EXTERNAL_BUSY block.
    if (ev.extendedProperties?.private?.kdsWorkspaceId === workspaceId) {
      return { upserted: 0, deleted: 0 };
    }

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

    // Marked FREE at Google ('transparency: transparent') ⇒ it does NOT block
    // time, so it must never create/keep a busy block — importing it would make
    // the rep falsely unavailable (lost bookings) for a slot they left open.
    // Treat it like a cancellation: drop any block we already hold. Absent
    // transparency defaults to 'opaque' (busy), preserving the prior behaviour.
    if (ev.transparency === 'transparent') {
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

  /**
   * Pick the Google connection that hosts a booking's event. For a Meet booking
   * we prefer the assigned member's own connection (so they organise the
   * meeting), falling back to the workspace's active connection; a
   * non-conferencing booking always uses the active connection (unchanged).
   */
  private async resolveGoogleConnection(
    workspaceId: string,
    booking: { calendarId: string; assigneeUserId?: string | null },
    preferHost: boolean,
  ): Promise<GoogleCalendarConnectionRow | null> {
    if (preferHost) {
      const host = await this.hostResolver.resolve(
        workspaceId,
        booking,
        'GOOGLE_MEET',
      );
      if (host) {
        const row = (await this.prisma.googleCalendarConnection.findFirst({
          where: { id: host.connectionId, workspaceId, enabled: true },
        })) as GoogleCalendarConnectionRow | null;
        if (row) return row;
      }
    }
    return this.activeConnection(workspaceId);
  }

  /**
   * Persist the Google Meet link onto the booking. When Google returned the
   * conference as still `pending` (no hangoutLink yet), queue a durable
   * follow-up that re-fetches it. A 409-adopted event carries only an id (the
   * sibling push already persisted the link) — skip it.
   */
  private async persistConference(
    workspaceId: string,
    bookingId: string,
    event: GoogleEvent,
  ): Promise<void> {
    if (!event.hangoutLink && !event.conferenceData) return;
    const link =
      event.hangoutLink ??
      event.conferenceData?.entryPoints?.find(
        (e) => e.entryPointType === 'video',
      )?.uri ??
      null;
    const confId = event.conferenceData?.conferenceId ?? null;
    const pending =
      event.conferenceData?.createRequest?.status?.statusCode === 'pending';
    await this.prisma.booking.updateMany({
      where: { id: bookingId, workspaceId },
      data: {
        meetingUrl: link,
        conferenceProvider: 'GOOGLE_MEET',
        conferenceId: confId,
        conferenceStatus: link ? 'created' : pending ? 'pending' : 'failed',
      },
    });
    if (!link && pending) {
      await this.scheduledJobs.schedule({
        workspaceId,
        kind: CONFERENCE_RESOLVE_KIND,
        runAt: new Date(Date.now() + 30_000),
        dedupKey: `conf:${bookingId}`,
        payload: { workspaceId, bookingId },
      });
    }
  }

  /**
   * Scheduled follow-up: re-fetch the event once Google finished provisioning
   * the conference, then persist the (now available) Meet link. No-op once the
   * link is already recorded.
   */
  private async resolvePendingConference(job: ClaimedJob): Promise<void> {
    if (!this.google.isConfigured()) return;
    const { workspaceId, bookingId } = job.payload as {
      workspaceId: string;
      bookingId: string;
    };
    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, workspaceId },
    });
    if (
      !booking ||
      !booking.googleEventId ||
      booking.conferenceStatus === 'created'
    ) {
      return;
    }
    const conn = await this.resolveGoogleConnection(workspaceId, booking, true);
    if (!conn) return;
    try {
      const accessToken = await this.google.getFreshAccessToken(conn);
      const cal = encodeURIComponent(conn.googleCalendarId);
      const event = await this.apiJson<GoogleEvent>(
        `${CALENDAR_API_BASE}/calendars/${cal}/events/${encodeURIComponent(
          booking.googleEventId,
        )}?conferenceDataVersion=1`,
        accessToken,
        { method: 'GET' },
      );
      await this.persistConference(workspaceId, bookingId, event);
    } catch (e) {
      this.logger.warn(
        `resolvePendingConference(${bookingId}) failed: ${(e as Error).message}`,
      );
    }
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

  /** Authenticated Google API call whose response body is ignored (DELETE / stop). */
  private async apiVoid(
    url: string,
    accessToken: string,
    init: { method: string; body?: string },
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
