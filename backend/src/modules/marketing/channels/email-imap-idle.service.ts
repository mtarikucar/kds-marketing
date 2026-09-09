import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ImapFlow } from 'imapflow';
import { PrismaService } from '../../../prisma/prisma.service';
import { ChannelAdapterRegistry } from './channel-adapter.registry';
import { EmailImapPollService } from './email-imap-poll.service';
import { imapForSmtpHost } from './smtp-autodiscover';

/** Bounded so a mail host that stops answering cannot hold a socket forever. */
const CONNECT_TIMEOUT_MS = 20_000;

/**
 * Debounce. A mail server can announce several messages in a burst, and each
 * announcement would otherwise open its own fetch connection. One fetch a
 * second after the first announcement collects the lot.
 */
const SETTLE_MS = 1_000;

/**
 * Hold an IMAP connection open so a customer's reply arrives in about a second
 * instead of within five minutes.
 *
 * ## Why a poll was never going to be enough
 *
 * `EmailImapPollService` runs every five minutes, and that is exactly what a
 * customer experiences: they answer, and nothing happens for up to five
 * minutes. Measured on a real thread — a reply sent somewhere after 20:45
 * appeared at 20:50:02, on the tick. Shortening the interval only buys
 * fractions of the same problem while multiplying logins against every mailbox
 * on the platform.
 *
 * IMAP has the right primitive. `IDLE` (RFC 2177) lets a client hold a
 * connection open and the SERVER speaks first when a message lands. This
 * mailbox advertises it — `* OK [CAPABILITY IMAP4rev1 ... IDLE UIDPLUS ...]` —
 * and so does every mainstream provider.
 *
 * ## The poll does not go away, and that is the point
 *
 * IDLE fails quietly. Connections are dropped by middleboxes, servers cap how
 * long they may be held, a process restart takes every connection with it, and
 * a provider that does not advertise IDLE simply never notifies. Every one of
 * those looks identical from here: no event, forever.
 *
 * So this service is the FAST path and the five-minute poll is the GUARANTEE.
 * Neither is trusted alone, and the ingest is idempotent on `Message-ID`, so a
 * message delivered by both costs one wasted fetch and produces one message.
 *
 * ## What it does not do
 *
 * It does not fetch. An idling client that starts fetching stops idling, and
 * restoring that state correctly on every path — including the ones that throw
 * — is a lifecycle bug waiting to happen. On an announcement it calls
 * `pollOne`, which opens its own short-lived connection. One extra connection
 * for a few seconds is the cheaper mistake.
 *
 * It also holds nothing for a mailbox it cannot recognise: the same
 * `imapForSmtpHost` table the poller uses, with the same refusal to guess.
 */
@Injectable()
export class EmailImapIdleService implements OnModuleDestroy {
  private readonly logger = new Logger(EmailImapIdleService.name);
  /** channelId -> the connection currently held for it, and the workspace it
   *  belongs to — the fetch it triggers reads the channel workspace-scoped. */
  private readonly held = new Map<string, { client: ImapFlow; workspaceId: string }>();
  /** channelId -> pending debounce timer. */
  private readonly settling = new Map<string, NodeJS.Timeout>();
  private closing = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ChannelAdapterRegistry,
    private readonly poller: EmailImapPollService,
  ) {}

  /**
   * Reconcile held connections against the mailboxes that should have one.
   *
   * A minute is short enough that a dropped connection is restored before the
   * five-minute poll would have covered for it, and long enough that this is
   * not itself a reconnect storm. Reconciling rather than connecting once at
   * boot is what makes a mailbox added, verified or disabled at 3am work
   * without a deploy.
   */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'email-imap-idle-reconcile' })
  async reconcile(): Promise<void> {
    if (this.closing) return;
    const eligible = await this.prisma.channel.findMany({
      where: { type: 'EMAIL', status: 'ACTIVE', lastVerifiedAt: { not: null } },
      select: { id: true, workspaceId: true, type: true, externalId: true, configSealed: true, configPublic: true },
    });
    const wanted = new Set<string>();

    for (const channel of eligible) {
      const target = this.imapTarget(channel);
      if (!target) continue; // unrecognised provider, or a consent-connected mailbox
      wanted.add(channel.id);
      if (this.held.has(channel.id)) continue;
      await this.hold(channel.id, channel.workspaceId, target).catch((e) =>
        this.logger.warn(
          `email-imap-idle: could not hold channel=${channel.id}: ${String(e?.message ?? e).slice(0, 200)}`,
        ),
      );
    }

    // A mailbox that was disabled, unverified or deleted must not keep a socket.
    for (const [channelId, entry] of [...this.held.entries()]) {
      if (!wanted.has(channelId)) await this.release(channelId, entry.client);
    }
  }

  /** The host/port/credentials for a channel, or null when it is not ours to hold. */
  private imapTarget(
    channel: any,
  ): { host: string; port: number; user: string; pass: string } | null {
    const s = (this.registry.resolveConfig(channel).secrets ?? {}) as Record<string, string | undefined>;
    // Consent-connected mailboxes belong to EmailOAuthRefreshCron, exactly as
    // in the poller — a second service authenticating with those tokens would
    // be the only place in this module that reads another's credentials.
    if (s.oauthProvider) return null;
    const user = s.smtpUser?.trim();
    const pass = s.smtpPass;
    if (!user || !pass) return null;
    const discovered = imapForSmtpHost(s.smtpHost ?? '');
    const host = s.imapHost?.trim() || discovered?.host;
    if (!host) return null;
    return { host, port: Number(s.imapPort) || discovered?.port || 993, user, pass };
  }

  private async hold(
    channelId: string,
    workspaceId: string,
    target: { host: string; port: number; user: string; pass: string },
  ): Promise<void> {
    const client = new ImapFlow({
      host: target.host,
      port: target.port,
      secure: true,
      auth: { user: target.user, pass: target.pass },
      logger: false,
      greetingTimeout: CONNECT_TIMEOUT_MS,
      connectionTimeout: CONNECT_TIMEOUT_MS,
    } as any);

    // Registered BEFORE connect: a socket that dies during the handshake must
    // still drop out of the map, or the reconcile loop will never retry it.
    client.on('close', () => {
      if (this.held.get(channelId)?.client === client) this.held.delete(channelId);
    });
    client.on('error', (e: any) => {
      this.logger.debug(`email-imap-idle: channel=${channelId} socket error: ${e?.message ?? e}`);
    });
    // The announcement. ImapFlow keeps the mailbox idling on its own and emits
    // this when the server reports the message count has grown.
    client.on('exists', () => this.onAnnouncement(channelId));

    await client.connect();
    // READ-ONLY, for the same reason the poller is: a human reads this inbox,
    // and holding it open must not change what their mail client shows them.
    await (client as any).mailboxOpen('INBOX', { readOnly: true });
    this.held.set(channelId, { client, workspaceId });
    this.logger.log(`email-imap-idle: holding ${target.host} for channel=${channelId}`);
  }

  /**
   * A burst of announcements collapses into one fetch. The fetch itself is
   * `pollOne`, which is idempotent on `Message-ID`, so a debounce that fires
   * once too often costs a connection and nothing else.
   */
  private onAnnouncement(channelId: string): void {
    if (this.closing) return;
    clearTimeout(this.settling.get(channelId));
    this.settling.set(
      channelId,
      setTimeout(() => {
        this.settling.delete(channelId);
        const workspaceId = this.held.get(channelId)?.workspaceId;
        if (!workspaceId) return;
        this.poller
          .pollOne(workspaceId, channelId)
          .then((n) => {
            if (n) this.logger.log(`email-imap-idle: fetched ${n} message(s) for channel=${channelId}`);
          })
          .catch((e) =>
            this.logger.warn(`email-imap-idle: fetch after announcement failed: ${e?.message ?? e}`),
          );
      }, SETTLE_MS),
    );
  }

  private async release(channelId: string, client: ImapFlow): Promise<void> {
    this.held.delete(channelId);
    clearTimeout(this.settling.get(channelId));
    this.settling.delete(channelId);
    await client.logout().catch(() => undefined);
  }

  /** Let go of every mailbox on shutdown, so a redeploy does not leave sockets
   *  half-open against the mail host until it times them out itself. */
  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.held.entries()].map(([id, e]) => this.release(id, e.client)));
  }
}
