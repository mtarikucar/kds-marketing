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
import { DomainEventBus, DomainEvent } from '../../outbox/domain-event-bus.service';
import { MarketingEventTypes } from '../events/marketing-event-types';
import {
  OutlookCalendarService,
  OutlookConnectionRow,
} from './outlook-calendar.service';

/**
 * Outlook/O365 (Microsoft Graph) 2-way calendar sync — the Graph analogue of
 * GoogleCalendarSyncService, same shape and guarantees.
 *
 *  PUSH (our → Graph): a freshly-created Booking is mirrored as a Graph event;
 *  the event id is stored on the Booking (`outlookEventId`) so a later
 *  patch/delete is idempotent. Driven two ways for resilience: the
 *  BookingCreated domain event AND direct BookingService calls. Graph has no
 *  client-supplied event ids (unlike Google), so the initial create is guarded
 *  by an atomic DB claim (`pending:<uuid>`) — two concurrent push paths can't
 *  mint duplicate Graph events.
 *
 *  PULL (Graph → our): pullEvents() runs Graph's calendarView delta query with
 *  the stored deltaLink (incremental). EXTERNAL Graph events (ones we didn't
 *  push) become EXTERNAL_BUSY Bookings so availability slicing respects them;
 *  cancelled/removed events delete the busy block. The new deltaLink is
 *  persisted for the next pull. A change-notification subscription (or the
 *  admin sync button) drives pulls.
 *
 * INERT by design: every method no-ops when unconfigured (Azure AD OAuth client
 * / secret-box missing) — see OutlookCalendarService.isConfigured. Push failures
 * are best-effort (logged, swallowed) so a Graph outage never breaks bookings;
 * pull surfaces a structured result to the caller.
 */

const GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0';
const SUBSCRIPTIONS_ENDPOINT = `${GRAPH_API_BASE}/subscriptions`;
const EXTERNAL_BUSY = 'EXTERNAL_BUSY';
// A transient outlookEventId value claiming an in-flight create.
const PENDING_PREFIX = 'pending:';
// Page cap so one notification/scheduler tick can't spin forever on a backlog.
const MAX_PULL_PAGES = 10;
// Graph caps `me/events` subscription expiry at 4230 minutes (~70.5h); request
// a hair under so clock skew never makes Graph reject the create.
const SUB_TTL_MINUTES = 4000;
// Renew when a subscription is within this window of expiring (cron runs 6-hourly).
const SUB_RENEW_BEFORE_MS = 12 * 60 * 60 * 1000;
// calendarView delta window: catch recent edits + the booking-relevant future.
const DELTA_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const DELTA_LOOKAHEAD_MS = 60 * 24 * 60 * 60 * 1000;
// The path Graph POSTs change notifications to (built onto MARKETING_PUBLIC_URL).
const WEBHOOK_PATH = '/api/marketing/integrations/outlook-calendar/notifications';

interface GraphEvent {
  id?: string;
  subject?: string;
  isCancelled?: boolean;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  '@removed'?: { reason?: string };
}

interface DeltaResponse {
  value?: GraphEvent[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

interface SubscriptionResponse {
  id?: string;
  expirationDateTime?: string;
}

export interface OutlookPullResult {
  ok: boolean;
  upserted: number;
  deleted: number;
  /** True when the stored deltaLink was invalid (HTTP 410) and was reset. */
  resyncRequired?: boolean;
  reason?: string;
}

@Injectable()
export class OutlookCalendarSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutlookCalendarSyncService.name);

  private readonly bookingCreatedHandler = (event: DomainEvent<unknown>) =>
    this.onBookingCreated(event as DomainEvent<BookingCreatedPayload>);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: DomainEventBus,
    private readonly outlook: OutlookCalendarService,
  ) {}

  onModuleInit(): void {
    this.bus.on(MarketingEventTypes.BookingCreated, this.bookingCreatedHandler);
  }

  onModuleDestroy(): void {
    this.bus.off(MarketingEventTypes.BookingCreated, this.bookingCreatedHandler);
  }

  // ===================================================================== //
  //  PUSH (our → Graph)                                                   //
  // ===================================================================== //

  /** Domain-event entrypoint — mirror a freshly-created booking onto Graph. */
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
   * Create (or patch) the Graph event mirroring our booking, storing its id on
   * the booking. No-op when inert or no enabled connection exists. The initial
   * create is claimed atomically (`pending:<uuid>`) so a concurrent push can't
   * duplicate it. Best-effort: never throws on Graph errors (logs + returns
   * null) so the booking flow is unaffected.
   */
  async pushBooking(
    workspaceId: string,
    bookingId: string,
  ): Promise<string | null> {
    if (!this.outlook.isConfigured()) return null;
    const conn = await this.activeConnection(workspaceId);
    if (!conn) return null;

    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, workspaceId },
    });
    // Don't echo events we pulled FROM Graph back INTO Graph.
    if (!booking || booking.status === EXTERNAL_BUSY) return null;

    const linked =
      booking.outlookEventId && !booking.outlookEventId.startsWith(PENDING_PREFIX)
        ? booking.outlookEventId
        : null;

    try {
      const accessToken = await this.outlook.getFreshAccessToken(conn);
      if (linked) {
        // PATCH the existing mirror.
        await this.apiVoid(
          `${GRAPH_API_BASE}/me/events/${encodeURIComponent(linked)}`,
          accessToken,
          { method: 'PATCH', body: JSON.stringify(this.eventBody(booking)) },
        );
        return linked;
      }

      // Claim the create so a sibling push path (direct call vs BookingCreated
      // domain event) can't mint a SECOND Graph event for the same booking.
      const claim = await this.prisma.booking.updateMany({
        where: { id: booking.id, workspaceId, outlookEventId: null },
        data: { outlookEventId: `${PENDING_PREFIX}${randomUUID()}` },
      });
      if (claim.count === 0) {
        // Sibling owns the in-flight create (or it's already linked).
        const fresh = await this.prisma.booking.findFirst({
          where: { id: booking.id, workspaceId },
          select: { outlookEventId: true },
        });
        return fresh?.outlookEventId &&
          !fresh.outlookEventId.startsWith(PENDING_PREFIX)
          ? fresh.outlookEventId
          : null;
      }

      try {
        const event = await this.apiJson<GraphEvent>(
          `${GRAPH_API_BASE}/${this.eventsCollectionPath(conn)}`,
          accessToken,
          { method: 'POST', body: JSON.stringify(this.eventBody(booking)) },
        );
        if (event.id) {
          await this.prisma.booking.updateMany({
            where: { id: booking.id, workspaceId },
            data: { outlookEventId: event.id },
          });
          return event.id;
        }
        await this.releaseClaim(booking.id, workspaceId);
        return null;
      } catch (e) {
        // Release the claim so a later pull/retry can re-create the mirror.
        await this.releaseClaim(booking.id, workspaceId);
        throw e;
      }
    } catch (e) {
      this.logger.warn(
        `pushBooking(${bookingId}) Graph API failed: ${(e as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Delete the mirrored Graph event when our booking is cancelled. Best-effort.
   * Returns true when a delete was issued.
   */
  async cancelBooking(
    workspaceId: string,
    bookingId: string,
  ): Promise<boolean> {
    if (!this.outlook.isConfigured()) return false;
    const conn = await this.activeConnection(workspaceId);
    if (!conn) return false;

    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, workspaceId },
      select: { outlookEventId: true, status: true },
    });
    if (
      !booking ||
      !booking.outlookEventId ||
      booking.outlookEventId.startsWith(PENDING_PREFIX) ||
      booking.status === EXTERNAL_BUSY
    ) {
      return false;
    }

    try {
      const accessToken = await this.outlook.getFreshAccessToken(conn);
      await this.apiVoid(
        `${GRAPH_API_BASE}/me/events/${encodeURIComponent(booking.outlookEventId)}`,
        accessToken,
        { method: 'DELETE' },
      );
      return true;
    } catch (e) {
      this.logger.warn(
        `cancelBooking(${bookingId}) Graph delete failed: ${(e as Error).message}`,
      );
      return false;
    }
  }

  private releaseClaim(bookingId: string, workspaceId: string): Promise<unknown> {
    return this.prisma.booking.updateMany({
      where: {
        id: bookingId,
        workspaceId,
        outlookEventId: { startsWith: PENDING_PREFIX },
      },
      data: { outlookEventId: null },
    });
  }

  // ===================================================================== //
  //  SUBSCRIPTION (real-time change-notification lifecycle)               //
  // ===================================================================== //

  /**
   * Ensure the workspace's connection has a LIVE Graph subscription: create one
   * when there's none, or renew when within the renewal window. Called after a
   * successful connect and by the renewal cron. Best-effort — returns false
   * (never throws) so connecting/sync is unaffected when push can't be set up
   * (e.g. the webhook isn't publicly reachable).
   */
  async ensureSubscription(
    workspaceId: string,
    connectionId?: string,
  ): Promise<boolean> {
    if (!this.outlook.isConfigured()) return false;
    const conn = connectionId
      ? ((await this.prisma.outlookCalendarConnection.findFirst({
          where: { id: connectionId, workspaceId, enabled: true },
        })) as OutlookConnectionRow | null)
      : await this.activeConnection(workspaceId);
    if (!conn) return false;
    if (!this.subscriptionNeedsRenewal(conn)) return true;
    return conn.subscriptionId
      ? this.renewSubscription(conn)
      : this.startSubscription(conn);
  }

  /** True when the connection has no subscription, or one near expiry. */
  private subscriptionNeedsRenewal(conn: OutlookConnectionRow): boolean {
    if (!conn.subscriptionId || !conn.subscriptionExpiration) return true;
    return (
      conn.subscriptionExpiration.getTime() - SUB_RENEW_BEFORE_MS <= Date.now()
    );
  }

  /**
   * Create a fresh Graph change-notification subscription and persist its id /
   * clientState / expiration. Any PRIOR subscription is retired AFTER the new
   * one is live + persisted (stopping it first would orphan the connection if
   * the create then failed). Returns true on success; on a Graph error it logs
   * and returns false, leaving the connection in manual-sync mode.
   */
  async startSubscription(conn: OutlookConnectionRow): Promise<boolean> {
    if (!this.outlook.isConfigured()) return false;
    const address = this.webhookAddress();
    if (!address) {
      this.logger.warn(
        'Outlook subscription skipped: MARKETING_PUBLIC_URL is not an https URL',
      );
      return false;
    }

    const prevSubId = conn.subscriptionId;
    const clientState = randomBytes(24).toString('hex');
    const requested = new Date(Date.now() + SUB_TTL_MINUTES * 60 * 1000);
    const body = {
      changeType: 'created,updated,deleted',
      notificationUrl: address,
      resource: this.subscriptionResource(conn),
      expirationDateTime: requested.toISOString(),
      clientState,
    };

    try {
      const accessToken = await this.outlook.getFreshAccessToken(conn);
      const res = await this.apiJson<SubscriptionResponse>(
        SUBSCRIPTIONS_ENDPOINT,
        accessToken,
        { method: 'POST', body: JSON.stringify(body) },
      );
      if (!res.id) {
        this.logger.warn(
          `Outlook subscription create returned no id for connection ${conn.id}`,
        );
        return false;
      }
      const expMs = Date.parse(res.expirationDateTime ?? '');
      const expiration = Number.isFinite(expMs) ? new Date(expMs) : requested;
      await this.prisma.outlookCalendarConnection.updateMany({
        where: { id: conn.id, workspaceId: conn.workspaceId },
        data: {
          subscriptionId: res.id,
          clientState,
          subscriptionExpiration: expiration,
        },
      });
      conn.subscriptionId = res.id;
      conn.clientState = clientState;
      conn.subscriptionExpiration = expiration;

      // New subscription is live + persisted — now retire any superseded one.
      if (prevSubId && prevSubId !== res.id) {
        await this.apiVoid(
          `${SUBSCRIPTIONS_ENDPOINT}/${prevSubId}`,
          accessToken,
          { method: 'DELETE' },
        ).catch((e) =>
          this.logger.warn(
            `Outlook: failed to delete superseded subscription ${prevSubId}: ${(e as Error).message}`,
          ),
        );
      }
      this.logger.log(
        `Outlook subscription active for connection ${conn.id} until ${expiration.toISOString()}`,
      );
      return true;
    } catch (e) {
      const status = e instanceof GraphHttpError ? e.status : 0;
      this.logger.warn(
        `Outlook subscription failed for connection ${conn.id} (HTTP ${status}) — ` +
          `staying in manual-sync mode. Verify the webhook is publicly reachable. ` +
          `${(e as Error).message}`,
      );
      return false;
    }
  }

  /**
   * Extend the connection's subscription (PATCH expirationDateTime). When the
   * subscription is gone/expired (Graph 404), recreate it instead.
   */
  async renewSubscription(conn: OutlookConnectionRow): Promise<boolean> {
    if (!conn.subscriptionId) return this.startSubscription(conn);
    const requested = new Date(Date.now() + SUB_TTL_MINUTES * 60 * 1000);
    try {
      const accessToken = await this.outlook.getFreshAccessToken(conn);
      const res = await this.apiJson<SubscriptionResponse>(
        `${SUBSCRIPTIONS_ENDPOINT}/${conn.subscriptionId}`,
        accessToken,
        {
          method: 'PATCH',
          body: JSON.stringify({ expirationDateTime: requested.toISOString() }),
        },
      );
      const expMs = Date.parse(res.expirationDateTime ?? '');
      const expiration = Number.isFinite(expMs) ? new Date(expMs) : requested;
      await this.prisma.outlookCalendarConnection.updateMany({
        where: { id: conn.id, workspaceId: conn.workspaceId },
        data: { subscriptionExpiration: expiration },
      });
      conn.subscriptionExpiration = expiration;
      return true;
    } catch (e) {
      this.logger.warn(
        `Outlook subscription renew failed for ${conn.id} — recreating: ${(e as Error).message}`,
      );
      // Drop the stale id so startSubscription mints a clean one.
      conn.subscriptionId = null;
      return this.startSubscription(conn);
    }
  }

  /**
   * Stop the connection's Graph subscription (best-effort) and clear its fields.
   * Called on disconnect.
   */
  async stopSubscription(conn: OutlookConnectionRow): Promise<void> {
    if (!conn.subscriptionId) return;
    if (this.outlook.isConfigured()) {
      try {
        const accessToken = await this.outlook.getFreshAccessToken(conn);
        await this.apiVoid(
          `${SUBSCRIPTIONS_ENDPOINT}/${conn.subscriptionId}`,
          accessToken,
          { method: 'DELETE' },
        );
      } catch (e) {
        // A subscription that's already gone is fine — just clear our copy.
        this.logger.warn(
          `Outlook subscription delete failed for ${conn.id}: ${(e as Error).message}`,
        );
      }
    }
    await this.prisma.outlookCalendarConnection.updateMany({
      where: { id: conn.id, workspaceId: conn.workspaceId },
      data: {
        subscriptionId: null,
        clientState: null,
        subscriptionExpiration: null,
      },
    });
    conn.subscriptionId = null;
    conn.clientState = null;
    conn.subscriptionExpiration = null;
  }

  /**
   * Renew subscriptions within the renewal window so the real-time feed never
   * lapses. Runs every 6h; only touches connections that ALREADY have one.
   * Single-replica assumption (mirrors the other marketing @Cron jobs).
   */
  @Cron(CronExpression.EVERY_6_HOURS, { name: 'outlook-subscription-renew' })
  async renewSubscriptions(): Promise<{ renewed: number }> {
    if (!this.outlook.isConfigured()) return { renewed: 0 };
    const cutoff = new Date(Date.now() + SUB_RENEW_BEFORE_MS);
    const due = (await this.prisma.outlookCalendarConnection.findMany({
      where: {
        enabled: true,
        subscriptionId: { not: null },
        OR: [
          { subscriptionExpiration: null },
          { subscriptionExpiration: { lte: cutoff } },
        ],
      },
    })) as OutlookConnectionRow[];

    let renewed = 0;
    for (const conn of due) {
      if (await this.renewSubscription(conn)) renewed++;
    }
    if (renewed) {
      this.logger.log(`Outlook: renewed ${renewed} subscription(s)`);
    }
    return { renewed };
  }

  /** Build the public https webhook address, or null when not deployable. */
  private webhookAddress(): string | null {
    const base = process.env.MARKETING_PUBLIC_URL?.trim();
    if (!base || !base.startsWith('http')) return null;
    return new URL(WEBHOOK_PATH, base).toString();
  }

  // ===================================================================== //
  //  PULL (Graph → our)                                                   //
  // ===================================================================== //

  /**
   * Incremental delta pull for one connection. Upserts EXTERNAL_BUSY Bookings
   * for external Graph events; deletes the busy block when the source event is
   * cancelled/removed; persists the new deltaLink.
   *
   * On HTTP 410 (delta token expired) the stored token is cleared and a fresh
   * full delta is performed so we recover automatically.
   */
  async pullEvents(connection: OutlookConnectionRow): Promise<OutlookPullResult> {
    if (!this.outlook.isConfigured()) {
      return { ok: false, upserted: 0, deleted: 0, reason: 'not-configured' };
    }
    if (!connection.enabled) {
      return { ok: false, upserted: 0, deleted: 0, reason: 'disabled' };
    }

    let accessToken: string;
    try {
      accessToken = await this.outlook.getFreshAccessToken(connection);
    } catch (e) {
      return { ok: false, upserted: 0, deleted: 0, reason: (e as Error).message };
    }

    let url = connection.deltaToken || this.initialDeltaUrl(connection);
    let upserted = 0;
    let deleted = 0;
    let nextDeltaLink: string | undefined;
    let resyncRequired = false;

    for (let page = 0; page < MAX_PULL_PAGES; page++) {
      let res: DeltaResponse;
      try {
        res = await this.apiJson<DeltaResponse>(url, accessToken, {
          method: 'GET',
          prefer: 'outlook.timezone="UTC"',
        });
      } catch (e) {
        // 410 GONE ⇒ deltaLink invalid: clear it and restart a full delta once.
        if (
          e instanceof GraphHttpError &&
          e.status === 410 &&
          connection.deltaToken
        ) {
          await this.prisma.outlookCalendarConnection.updateMany({
            where: { id: connection.id, workspaceId: connection.workspaceId },
            data: { deltaToken: null },
          });
          connection.deltaToken = null;
          url = this.initialDeltaUrl(connection);
          upserted = 0;
          deleted = 0;
          resyncRequired = true;
          continue;
        }
        return { ok: false, upserted, deleted, reason: (e as Error).message };
      }

      for (const ev of res.value ?? []) {
        const r = await this.applyExternalEvent(connection, ev);
        upserted += r.upserted;
        deleted += r.deleted;
      }

      if (res['@odata.nextLink']) {
        url = res['@odata.nextLink'];
        continue;
      }
      nextDeltaLink = res['@odata.deltaLink'];
      break;
    }

    if (nextDeltaLink) {
      await this.prisma.outlookCalendarConnection.updateMany({
        where: { id: connection.id, workspaceId: connection.workspaceId },
        data: { deltaToken: nextDeltaLink },
      });
    }

    return { ok: true, upserted, deleted, resyncRequired };
  }

  /** Pull every enabled connection in a workspace (button/fan-out). */
  async pullWorkspace(workspaceId: string): Promise<OutlookPullResult> {
    const conns = (await this.prisma.outlookCalendarConnection.findMany({
      where: { workspaceId, enabled: true },
    })) as OutlookConnectionRow[];
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
   * Resolve the connection a Graph notification is about (by subscription id),
   * validate the clientState nonce, and pull it. Returns null when the
   * subscription is unknown or the nonce mismatches (forged/stale notification).
   */
  async pullBySubscription(
    subscriptionId: string,
    clientState?: string,
  ): Promise<OutlookPullResult | null> {
    if (!subscriptionId) return null;
    const conn = (await this.prisma.outlookCalendarConnection.findFirst({
      where: { subscriptionId },
    })) as OutlookConnectionRow | null;
    if (!conn) return null;
    if (conn.clientState && conn.clientState !== clientState) return null;
    return this.pullEvents(conn);
  }

  // ===================================================================== //
  //  Internals                                                            //
  // ===================================================================== //

  /** Upsert/delete ONE external Graph event as an EXTERNAL_BUSY booking. */
  private async applyExternalEvent(
    connection: OutlookConnectionRow,
    ev: GraphEvent,
  ): Promise<{ upserted: number; deleted: number }> {
    if (!ev.id) return { upserted: 0, deleted: 0 };
    const workspaceId = connection.workspaceId;

    // Skip events WE pushed (mirrors of our own bookings) to avoid echo loops.
    const ours = await this.prisma.booking.findFirst({
      where: {
        workspaceId,
        outlookEventId: ev.id,
        status: { not: EXTERNAL_BUSY },
      },
      select: { id: true },
    });
    if (ours) return { upserted: 0, deleted: 0 };

    // Removed (delta tombstone) or cancelled ⇒ remove our busy block.
    if (ev['@removed'] || ev.isCancelled === true) {
      const res = await this.prisma.booking.deleteMany({
        where: { workspaceId, outlookEventId: ev.id, status: EXTERNAL_BUSY },
      });
      return { upserted: 0, deleted: res.count };
    }

    const start = parseGraphTime(ev.start);
    const end = parseGraphTime(ev.end);
    if (!start || !end || end <= start) {
      // All-day or malformed: skip (can't slice a slot window).
      return { upserted: 0, deleted: 0 };
    }

    const existing = await this.prisma.booking.findFirst({
      where: { workspaceId, outlookEventId: ev.id, status: EXTERNAL_BUSY },
      select: { id: true },
    });
    if (existing) {
      await this.prisma.booking.updateMany({
        where: { id: existing.id, workspaceId },
        data: { startAt: start, endAt: end, name: ev.subject || 'Busy' },
      });
    } else {
      await this.prisma.booking.create({
        data: {
          workspaceId,
          calendarId: `outlook:${connection.id}`,
          startAt: start,
          endAt: end,
          name: ev.subject || 'Busy (Outlook)',
          status: EXTERNAL_BUSY,
          outlookEventId: ev.id,
          token: `ocal_${randomBytes(16).toString('hex')}`,
        },
      });
    }
    return { upserted: 1, deleted: 0 };
  }

  private async activeConnection(
    workspaceId: string,
  ): Promise<OutlookConnectionRow | null> {
    return (await this.prisma.outlookCalendarConnection.findFirst({
      where: { workspaceId, enabled: true },
      orderBy: { createdAt: 'asc' },
    })) as OutlookConnectionRow | null;
  }

  /** Graph events-collection path for a connection (primary vs named calendar). */
  private eventsCollectionPath(conn: OutlookConnectionRow): string {
    return conn.outlookCalendarId && conn.outlookCalendarId !== 'primary'
      ? `me/calendars/${encodeURIComponent(conn.outlookCalendarId)}/events`
      : 'me/events';
  }

  /** Graph subscription resource for a connection (no leading slash, per Graph). */
  private subscriptionResource(conn: OutlookConnectionRow): string {
    return conn.outlookCalendarId && conn.outlookCalendarId !== 'primary'
      ? `me/calendars/${conn.outlookCalendarId}/events`
      : 'me/events';
  }

  /** First-ever delta URL: a bounded calendarView window (delta tracks it onward). */
  private initialDeltaUrl(conn: OutlookConnectionRow): string {
    const path =
      conn.outlookCalendarId && conn.outlookCalendarId !== 'primary'
        ? `me/calendars/${encodeURIComponent(conn.outlookCalendarId)}/calendarView/delta`
        : 'me/calendarView/delta';
    const u = new URL(`${GRAPH_API_BASE}/${path}`);
    u.searchParams.set(
      'startDateTime',
      new Date(Date.now() - DELTA_LOOKBACK_MS).toISOString(),
    );
    u.searchParams.set(
      'endDateTime',
      new Date(Date.now() + DELTA_LOOKAHEAD_MS).toISOString(),
    );
    return u.toString();
  }

  /** Graph event body mirroring our booking (UTC times, optional attendee). */
  private eventBody(booking: {
    name: string | null;
    notes: string | null;
    startAt: Date;
    endAt: Date;
    email: string | null;
  }): Record<string, unknown> {
    return {
      subject: booking.name || 'Booking',
      ...(booking.notes
        ? { body: { contentType: 'text', content: booking.notes } }
        : {}),
      start: { dateTime: utcNoZ(booking.startAt), timeZone: 'UTC' },
      end: { dateTime: utcNoZ(booking.endAt), timeZone: 'UTC' },
      ...(booking.email
        ? {
            attendees: [
              { emailAddress: { address: booking.email }, type: 'required' },
            ],
          }
        : {}),
    };
  }

  /** Authenticated Graph call returning parsed JSON; throws on !ok. */
  private async apiJson<T>(
    url: string,
    accessToken: string,
    init: { method: string; body?: string; prefer?: string },
  ): Promise<T> {
    const res = await this.apiCall(url, accessToken, init);
    return (await res.json()) as T;
  }

  /** Authenticated Graph call whose body is ignored (DELETE / PATCH). */
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
    init: { method: string; body?: string; prefer?: string },
  ): Promise<Response> {
    let res: Response;
    try {
      res = await safeFetch(url, {
        method: init.method,
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
          ...(init.prefer ? { prefer: init.prefer } : {}),
        },
        ...(init.body ? { body: init.body } : {}),
        timeoutMs: 8000,
      });
    } catch (e) {
      if (e instanceof SsrfBlockedError) {
        throw new GraphHttpError(0, `blocked: ${e.message}`);
      }
      throw new GraphHttpError(0, (e as Error).message);
    }
    // 204/200 with empty body (DELETE) is fine.
    if (!res.ok && res.status !== 204) {
      await res.text().catch(() => undefined);
      throw new GraphHttpError(res.status, `Graph API HTTP ${res.status}`);
    }
    return res;
  }
}

// ----------------------------- helpers ----------------------------------- //

class GraphHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GraphHttpError';
  }
}

interface BookingCreatedPayload {
  workspaceId: string;
  bookingId: string;
  calendarId?: string;
  leadId?: string | null;
  startAt?: string;
}

/** A UTC Date as Graph's "no-offset" dateTime (paired with timeZone:"UTC"). */
function utcNoZ(d: Date): string {
  return d.toISOString().replace(/Z$/, '');
}

/**
 * Graph times are {dateTime, timeZone}. We request `Prefer: outlook.timezone=
 * "UTC"`, so dateTime is UTC wall-clock with no offset; normalise to a Date.
 * All-day events (no dateTime) and malformed values return null (skipped).
 */
function parseGraphTime(
  t: { dateTime?: string; timeZone?: string } | undefined,
): Date | null {
  if (!t?.dateTime) return null;
  let s = t.dateTime.trim();
  // Graph emits up to 7 fractional-second digits; trim to 3 for JS Date.
  s = s.replace(/(\.\d{3})\d+$/, '$1');
  // Ensure a UTC marker when none is present (Prefer header gave us UTC).
  if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) s += 'Z';
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
