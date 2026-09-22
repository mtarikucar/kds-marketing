import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ImapFlow } from 'imapflow';
import { PrismaService } from '../../../prisma/prisma.service';
import { ChannelAdapterRegistry } from './channel-adapter.registry';
import { EmailImapPollService } from './email-imap-poll.service';
import { classifyImapError, imapConnectOptions, imapTarget, ImapTarget } from './imap-target';
import { isMailboxBackedOff, MailboxHealthService } from './mailbox-health.service';

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
 * `imapTarget()` resolver the poller uses, with the same refusal to guess.
 *
 * ## A failing login waits; it never gives up
 *
 * A password changed at the provider used to mean a login attempt every
 * minute, forever — about 1,700 a day, which is how an account gets locked at
 * the provider, SMTP included, with nothing but warn lines to show for it. So
 * a failed HOLD earns a capped exponential wait (`MailboxHealthService`) and
 * records what the server said, where the tenant can see it.
 *
 * Two things that wait deliberately does NOT do. It does not stop on a
 * credential error: one transient `AUTHENTICATIONFAILED` would then kill
 * inbound permanently, and silently missing mail is far worse than log noise.
 * And it does not count a DROPPED socket — those are routine (see above), and
 * charging them would back a healthy mailbox off to the ceiling and degrade
 * the fast path into the five-minute poll for no reason.
 */
@Injectable()
export class EmailImapIdleService implements OnModuleDestroy {
  private readonly logger = new Logger(EmailImapIdleService.name);
  /** channelId -> the connection currently held for it, and the workspace it
   *  belongs to — the fetch it triggers reads the channel workspace-scoped. */
  private readonly held = new Map<string, { client: ImapFlow; workspaceId: string }>();
  /** channelId -> pending debounce timer. */
  private readonly settling = new Map<string, NodeJS.Timeout>();
  /** Channels whose handshake is in flight. The tick is every minute and a
   *  dead host takes twenty seconds to answer, so runs DO overlap: without
   *  this each overlapping run opens another socket for the same mailbox, and
   *  none of them is in `held` to be let go of. */
  private readonly connecting = new Set<string>();
  private closing = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ChannelAdapterRegistry,
    private readonly poller: EmailImapPollService,
    private readonly health: MailboxHealthService,
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
      const resolved = imapTarget(this.registry.resolveConfig(channel).secrets);
      // An unrecognised provider, a half-configured mailbox, or a
      // consent-connected one with no receive credential sealed beside its
      // token. A string discriminant, so this actually narrows under this
      // project's `strictNullChecks: false`.
      if (resolved.kind !== 'ok') continue;
      // `wanted` BEFORE the waiting checks: a mailbox we are deliberately not
      // dialling right now still deserves the socket it already has. A live
      // connection is proof the mailbox answers, and dropping it because the
      // poller wrote a backoff would make the fast path worse than the bug.
      wanted.add(channel.id);
      if (this.held.has(channel.id) || this.connecting.has(channel.id)) continue;
      if (isMailboxBackedOff(channel.configPublic)) continue;

      this.connecting.add(channel.id);
      let holding = false;
      try {
        await this.hold(channel.id, channel.workspaceId, resolved.target);
        holding = true;
      } catch (e) {
        const failure = classifyImapError(e);
        // Recorded where the tenant can read it, not only in a log line nobody
        // is paged for, and the wait it returns is what stops the storm.
        await this.health.recordBackoff(
          { id: channel.id, workspaceId: channel.workspaceId },
          failure,
        );
        this.logger.warn(
          `email-imap-idle: could not hold channel=${channel.id} (${failure.reason}): ${failure.error.slice(0, 200)}`,
        );
      } finally {
        this.connecting.delete(channel.id);
      }
      // Outside the try on purpose: a health-write that went wrong is not a
      // mailbox that went wrong, and must never be recorded as one.
      if (holding) {
        // The hold worked, so whatever wait the failures before it earned is over.
        await this.health.recordOk({ id: channel.id, workspaceId: channel.workspaceId }, 'receive');
      }
    }

    // A mailbox that was disabled, unverified or deleted must not keep a socket.
    for (const [channelId, entry] of [...this.held.entries()]) {
      if (!wanted.has(channelId)) await this.release(channelId, entry.client);
    }
  }

  private async hold(channelId: string, workspaceId: string, target: ImapTarget): Promise<void> {
    // No `socketTimeout`: a held connection is SILENT by design — that is what
    // IDLE is — and bounding the socket would cut off every healthy mailbox
    // every twenty seconds.
    const client = new ImapFlow(imapConnectOptions(target) as any);

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

    try {
      await client.connect();
      // READ-ONLY, for the same reason the poller is: a human reads this inbox,
      // and holding it open must not change what their mail client shows them.
      await (client as any).mailboxOpen('INBOX', { readOnly: true });
    } catch (e) {
      // Connected but INBOX refused is the leak the `close` handler cannot
      // catch: the socket is alive, nothing holds it, and the next minute
      // opens another one.
      await client.logout().catch(() => undefined);
      throw e;
    }
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
