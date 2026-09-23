import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { ImapFlow } from 'imapflow';
import { simpleParser, ParsedMail } from 'mailparser';
import { PrismaService } from '../../../prisma/prisma.service';
import { withAdvisoryLock } from '../../../common/scheduling/advisory-lock';
import { ChannelAdapterRegistry } from './channel-adapter.registry';
import { ConversationIngressService } from './conversation-ingress.service';
import { imapConnectOptions, imapTarget } from './imap-target';
import { stripQuotedReply } from './email-reply-text';
import { MailClassification, classifyMail } from './inbound/mail-classify';
import { authVerdict } from './inbound/mail-auth';
import {
  InboundSkipReason,
  MAX_BODY_DOWNLOAD_BYTES,
  RawAttachment,
  RawMail,
  isOversize,
  isTooOldToIngest,
  rawMailFromParsed,
  synthesizeAttachmentBody,
} from './inbound/inbound-mail.types';
import {
  InboundItemFacts,
  InboundItemKey,
  InboundItemService,
  InboundReplayTarget,
} from './inbound/inbound-item.service';
import { shouldIngest } from './inbound/inbound-policy';
import { parseDeliveryReport, suppressibleRecipients } from './inbound/delivery-report';
import { SuppressionService } from '../compliance/suppression.service';
import { MailboxHealthService } from './mailbox-health.service';
import { sweepHeartbeatError } from './ops/mail-ops.service';

/** The minimal Channel-row shape this poller reads — an explicit `select` that
 *  keeps `workspaceId` a query-arg literal for workspace-scoping.arch.spec.ts,
 *  mirroring NetgsmMoPollService. */
interface ChannelRow {
  id: string;
  workspaceId: string;
  type: string;
  externalId: string | null;
  configSealed: string | null;
  configPublic: unknown;
}

/** The ledger source this poller writes under. `imap-sent` is a different one. */
const IMAP_SOURCE = 'imap';

/** Blast-radius bounds, not correctness mechanisms — `ingress.ingest` dedup is
 *  what makes a re-read harmless. See the class docstring. */
const MAX_PER_TICK = 50;
const FIRST_RUN_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 20_000;

/**
 * How many ticks one uid may hold the cursor before the poller steps over it.
 *
 * Stopping on a throw is what stops mail being lost; stopping FOREVER on one
 * throw is how a single malformed message freezes every later reply to that
 * mailbox. Three is not arbitrary: `EmailImapIdleService` re-triggers
 * `pollOne` on every announcement, so a busy mailbox spends them in minutes
 * and a quiet one in a quarter of an hour.
 */
const MAX_UID_ATTEMPTS = 3;

/** Enough of a body to be a message; a cap the AI prompt already applies too. */
const MAX_BODY_CHARS = 8000;

/** The cursor and the one uid currently holding it up. */
interface PollCursor {
  lastUid: number;
  uidValidity: string;
}
interface FailState {
  uid: number;
  count: number;
}

/** One sweep, counted the three ways the heartbeat needs (§A5). */
interface PollSweep {
  ingested: number;
  /** Mailboxes drained without an error. */
  ok: number;
  /** Mailboxes that threw. */
  failed: number;
  /** Mailboxes this poller is not meant to read — never a heartbeat signal. */
  skipped: number;
  /** The failures' own words, for `CronHeartbeat.lastError`. */
  reasons: string[];
}

/** Why this uid was not ingested — a ledger code plus the line for the log. */
interface IngestSkip {
  ingested: false;
  reason: InboundSkipReason;
  detail: string;
}
type IngestOutcome = { ingested: true } | IngestSkip;

/**
 * A failure that will fail the same way on every retry.
 *
 * A malformed MIME body parses identically forever, so spending three ticks
 * (and the inbound latency of every message behind it) discovering that is
 * pure cost. Everything else is assumed retriable: an unknown error that
 * advances the cursor is an unknown error that lost somebody's mail, and
 * `MAX_UID_ATTEMPTS` already bounds how long a wrong guess can cost.
 */
class DeterministicMailError extends Error {
  constructor(
    readonly reason: InboundSkipReason,
    cause: unknown,
  ) {
    super(String((cause as any)?.message ?? cause ?? reason));
  }
}

/**
 * Pull replies out of a workspace's OWN mailbox over IMAP.
 *
 * ## Why this exists
 *
 * Email is the only two-way channel in this product whose inbound half needed
 * something the workspace does not have. `EmailWebhookController` works, is
 * signed, and is live — but it is a destination, and something has to POST to
 * it. That something is an inbound-parse provider (Mailgun / SendGrid /
 * Postmark), which means an ESP account, a DNS change pointing MX at the ESP,
 * and a person to do both. Until then a workspace could send from its own
 * address and never see a single reply: the customer answers, the mail lands
 * in the mailbox, and the panel shows silence.
 *
 * A mailbox that can send over SMTP can almost always be READ over IMAP with
 * the same password, which the workspace has already given us and which
 * `lastVerifiedAt` proves is correct. So this poller closes the loop with no
 * account to open, no MX record to move, and nobody to wait for. The webhook
 * remains the better path where an ESP exists — it is push, not poll — and the
 * two coexist by design (see "Both paths, one identity" below).
 *
 * ## It never writes to the mailbox
 *
 * The mailbox is opened READ-ONLY and the cursor lives in our own database.
 * That is deliberate twice over. A human reads this inbox: marking mail
 * `\Seen` as a side effect of polling would quietly change what their mail
 * client shows them. And the inverse — relying on `\Seen` to know what we have
 * already taken — would break the moment that human read a message first, and
 * a customer's reply would be lost with nothing to show for it.
 *
 * ## Both paths, one identity
 *
 * `externalMessageId` is the raw `Message-ID`, angle brackets stripped, which
 * is exactly what an inbound-parse provider posts. That is not incidental: a
 * workspace that later adds an ESP will briefly have BOTH paths delivering the
 * same mail, and identical ids make `ConversationIngressService.ingest`'s own
 * dedup collapse them into one message. Namespacing this path (as the NetGSM
 * MO poller does, for the opposite reason — there the ids come from different
 * endpoints and genuinely differ) would instead give every customer two.
 *
 * Dedup being the correctness mechanism is what lets the UID cursor be an
 * optimisation rather than a ledger: lose it, reset it, run two ticks at once,
 * and the worst case is re-read bytes, never a duplicate message.
 *
 * ## Never lose mail
 *
 * The cursor advances INSIDE the try, after the ingest has returned. A
 * deliberate skip advances it (otherwise the first newsletter in the box pins
 * it forever); a THROW does not, and the drain stops there rather than walking
 * on over messages the cursor has already been moved past. That one ordering
 * is the difference between "a socket drop costs one re-read" and "a socket
 * drop permanently skips up to fifty customer replies".
 *
 * Stopping has its own failure mode, so it is bounded: `imapFailUid` /
 * `imapFailCount` count the attempts one uid has cost, and after
 * `MAX_UID_ATTEMPTS` the poller steps over it, says so at `error`, and leaves
 * the item PARKED in the `EmailInboundItem` ledger where a human can retry it.
 * Every examined uid leaves a ledger row — that is what turns a `logger.warn`
 * nobody reads into an answer to "where did my customer's mail go?".
 *
 * ## What it deliberately does not ingest
 *
 * A first run does not swallow the mailbox's history. Ingesting years of old
 * mail would create a lead per correspondent and hand each one to the auto-
 * reply engine — a reply storm to conversations that ended long ago. The first
 * tick therefore takes only the last `FIRST_RUN_LOOKBACK_MS`, and every tick
 * is capped at `MAX_PER_TICK`; the rest simply arrive on the following tick.
 * On the RESUME path the same risk arrives differently — somebody un-archives
 * three hundred old mails into INBOX — so anything older than
 * `MAX_INGEST_AGE_MS` by the server's own INTERNALDATE is skipped there.
 *
 * Automated mail is skipped outright by `classifyMail` (RFC 3834
 * `Auto-Submitted`, `Precedence`, `List-*`, unattended senders, and this
 * platform's OWN address). Without it a bounce or an out-of-office becomes a
 * lead the AI then answers — and two auto-responders introduced to each other
 * do not stop. Those rules were lifted out of this file so the webhook path
 * could share them; the two of them that were written after the first live run
 * caught senders no header rule would have.
 *
 * ## What it deliberately DOES ingest
 *
 * A mail over `MAX_SOURCE_BYTES` is not skipped, it is read selectively: size,
 * then headers (so the classification above still runs BEFORE any body is
 * pulled), then one bounded `download` of the first real text part. Attachments
 * are named in the body rather than read, in so many words, because the AI
 * answers whatever is ingested and "they sent the contract" is a sentence it
 * must not be able to write about a file nobody opened.
 *
 * ## Inert by default
 *
 * A channel with no resolvable IMAP host is skipped, not guessed at.
 * `imapTarget()` answers with a host only for providers we recognise (or the
 * `imapHost` the workspace typed itself) and refuses everything else BY NAME,
 * so a skip is a debug line rather than a five-minutely login against a host
 * nobody proved. A consent-connected (OAuth) mailbox is one of those refusals
 * — its tokens are owned by EmailOAuthRefreshCron, and a second service
 * authenticating with them would be the only place in this module that reads
 * another service's credentials.
 */
@Injectable()
export class EmailImapPollService implements OnModuleInit {
  private readonly logger = new Logger(EmailImapPollService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ChannelAdapterRegistry,
    private readonly ingress: ConversationIngressService,
    /**
     * A DSN that lands in the tenant's OWN mailbox is the only bounce source
     * this deployment actually has — prod sends over SMTP, so there is no ESP
     * webhook and no platform feedback loop for it. It is workspace-scoped
     * mail, so it goes to the tenant writer, never `EspFeedbackService`.
     */
    private readonly suppression: SuppressionService,
    /** Optional so a unit test — or a deployment that has not wired the ledger
     *  — still polls. A missing ledger costs the audit trail, never the mail. */
    @Optional() private readonly items?: InboundItemService,
    /** Optional for the same reason: the receive lane's health is a description
     *  of this sweep, and a sweep must never depend on being described. */
    @Optional() private readonly health?: MailboxHealthService,
  ) {}

  onModuleInit(): void {
    // The retry job knows WHICH item to fetch again; only this service knows
    // how to fetch one uid out of one mailbox.
    this.items?.registerReplayer(IMAP_SOURCE, (target) => this.replay(target));
  }

  /**
   * The SAFETY NET, not the primary path. `EmailImapIdleService` delivers mail
   * within a second of it arriving; this catches what a dropped IDLE
   * connection, an unsupported server or a restarted process missed. Five
   * minutes is chosen for that job — often enough that a gap is a gap and not
   * an outage, cheap enough to run against every mailbox on the platform.
   *
   * It is also the ONLY place the sweep is allowed to fail. `withAdvisoryLock`
   * rethrows into `CronHeartbeat.lastError` and flips `failing: true` for the
   * MCP tool that reads it, so a throw here IS the heartbeat — and it happens
   * only when every mailbox that was attempted failed (`sweepHeartbeatError`).
   * The partial case is carried per mailbox, in `Channel.configPublic.health`,
   * where the only person who can fix it can see it.
   *
   * `poll()` itself stays non-throwing: it is the drain, and a caller asking
   * for the counts should not have to catch one tenant's bad password.
   */
  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'email-imap-poll' })
  async pollDue(): Promise<void> {
    await withAdvisoryLock(
      this.prisma,
      'email-imap-poll',
      async () => {
        const sweep = await this.sweep();
        const failure = sweepHeartbeatError(sweep, sweep.reasons);
        if (failure) throw new Error(failure);
      },
      this.logger,
    );
  }

  async poll(): Promise<{ ingested: number; mailboxes: number }> {
    const { ingested, ok } = await this.sweep();
    return { ingested, mailboxes: ok };
  }

  /**
   * One pass over every pollable mailbox, counted three ways.
   *
   * `skipped` is a mailbox this poller is not meant to read at all (no
   * resolvable IMAP host, an ESP-webhook workspace) — it is not evidence of
   * anything and must never colour the heartbeat. `ok` and `failed` are the
   * two that do.
   */
  private async sweep(): Promise<PollSweep> {
    const sweep: PollSweep = { ingested: 0, ok: 0, failed: 0, skipped: 0, reasons: [] };
    if (!this.registry.has('EMAIL')) return sweep;
    const channels = (await this.prisma.channel.findMany({
      // `lastVerifiedAt` is written only when a health check PASSED, so this is
      // a mailbox whose password has actually been accepted. Trying IMAP with
      // credentials nobody proved would produce a login failure every five
      // minutes, forever, against a mail host that counts them.
      where: { type: 'EMAIL', status: 'ACTIVE', lastVerifiedAt: { not: null } },
      select: {
        id: true,
        workspaceId: true,
        type: true,
        externalId: true,
        configSealed: true,
        configPublic: true,
      },
    })) as ChannelRow[];

    for (const channel of channels) {
      try {
        const n = await this.pollChannel(channel);
        if (n === null) {
          sweep.skipped++;
          continue;
        }
        sweep.ok++;
        sweep.ingested += n;
        await this.recordReceive(channel, null);
      } catch (e: any) {
        const message = String(e?.message ?? e).slice(0, 300);
        sweep.failed++;
        sweep.reasons.push(message);
        this.logger.warn(`email-imap-poll: channel=${channel.id} failed: ${message}`);
        // Persisted, not only warned: only the tenant knows the new password,
        // and a log line on our side has never once reached them.
        await this.recordReceive(channel, message);
      }
    }
    return sweep;
  }

  /** Per-mailbox receive truth, best-effort. The IDLE hold writes the same
   *  block; a deployment whose server has no IDLE support would otherwise have
   *  nothing writing it at all. Optional so a unit test still polls. */
  private async recordReceive(channel: ChannelRow, error: string | null): Promise<void> {
    if (!this.health) return;
    const ref = { id: channel.id, workspaceId: channel.workspaceId };
    try {
      if (error === null) await this.health.recordOk(ref, 'receive', { polled: true });
      else await this.health.recordFailure(ref, 'receive', { error, reason: 'POLL_FAILED' });
    } catch {
      // MailboxHealthService already swallows its own writes; this is the belt
      // for a mock that does not. Health is a description, never a reason for
      // the poll to have gone differently (G2).
    }
  }

  /**
   * Fetch one mailbox NOW, by id.
   *
   * The tick is every five minutes, which is the wrong latency for a customer
   * waiting on a reply and the right cost for a safety net. `EmailImapIdleService`
   * holds an IDLE connection and calls this the moment the mail server says a
   * message landed, so the poll stops being the thing that finds mail and
   * becomes the thing that catches what IDLE missed.
   *
   * Deliberately a second, short-lived connection rather than draining on the
   * idling one: an IDLE client that starts fetching stops idling, and getting
   * it back into that state correctly on every path — including the ones that
   * throw — is a lifecycle bug waiting to happen. One extra connection for a
   * few seconds is the cheaper mistake.
   */
  async pollOne(workspaceId: string, channelId: string): Promise<number | null> {
    const channel = await this.findChannel(workspaceId, channelId);
    if (!channel) return null;
    try {
      return await this.pollChannel(channel);
    } catch (e: any) {
      this.logger.warn(
        `email-imap-poll: on-demand fetch failed for channel=${channelId}: ${String(e?.message ?? e).slice(0, 300)}`,
      );
      return null;
    }
  }

  /**
   * Fetch back exactly ONE item the ledger is still holding.
   *
   * Registered as the `imap` replayer, so it honours that contract: it settles
   * the row itself (`ingestUid` writes DONE or SKIPPED) and it THROWS when it
   * cannot, because the job runner's backoff IS the retry schedule and a
   * replayer that swallows its error reports success for mail that never
   * landed.
   *
   * The stored `uidValidity` is re-checked against the live mailbox before
   * anything is fetched: after a renumbering that uid points at somebody else's
   * mail, or at nothing, and "that uid and no other" is the whole contract.
   * Throwing there costs a bounded number of pointless retries and then parks
   * the item where a human can see it, which is the honest end state — the
   * mail is still in the mailbox, but no automated path can reach it.
   */
  async replay(target: InboundReplayTarget): Promise<void> {
    const [uidValidity, rawUid] = String(target.itemKey ?? '').split(':');
    const uid = Number(rawUid);
    if (!uidValidity || !Number.isFinite(uid) || uid <= 0) {
      throw new Error(`email-imap-poll: unusable item key "${target.itemKey}"`);
    }

    const channel = await this.findChannel(target.workspaceId, target.channelId);
    if (!channel) throw new Error(`email-imap-poll: channel=${target.channelId} is no longer pollable`);
    const opened = await this.open(channel);
    if (!opened) throw new Error(`email-imap-poll: channel=${target.channelId} is no longer IMAP-readable`);
    const { client, config } = opened;

    try {
      const lock = await client.getMailboxLock('INBOX', { readOnly: true } as any);
      try {
        const live = String((client as any).mailbox?.uidValidity ?? '');
        if (live !== uidValidity) {
          throw new Error(
            `email-imap-poll: mailbox renumbered (UIDVALIDITY ${uidValidity} → ${live}), uid ${uid} no longer names this mail`,
          );
        }
        await this.ingestUid(client, channel, config, uid, {
          // A replay is a second look at one named item, never a resume of a
          // cursor, so the age bound must not apply: the whole point is to
          // recover a mail that has been sitting in the ledger for a while.
          resuming: false,
          key: this.itemKey(channel, uidValidity, uid),
        });
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  private async findChannel(workspaceId: string, channelId: string): Promise<ChannelRow | null> {
    return (await this.prisma.channel.findFirst({
      // Scoped by workspace even though the caller holds a primary key. The id
      // came from another service's enumeration, and a read that carries the
      // tenant is one fewer place where a wrong id becomes a cross-tenant one.
      where: { id: channelId, workspaceId, type: 'EMAIL', status: 'ACTIVE', lastVerifiedAt: { not: null } },
      select: {
        id: true,
        workspaceId: true,
        type: true,
        externalId: true,
        configSealed: true,
        configPublic: true,
      },
    })) as ChannelRow | null;
  }

  /** Poll one mailbox. Null means "not an IMAP-pollable channel" (no host, or
   *  a consent-connected mailbox) as opposed to "polled and found nothing". */
  private async pollChannel(channel: ChannelRow): Promise<number | null> {
    const opened = await this.open(channel);
    if (!opened) return null;
    const { client, config } = opened;

    let ingested = 0;
    try {
      // READ-ONLY: this is the guarantee that polling never changes what the
      // human who reads this inbox sees.
      const lock = await client.getMailboxLock('INBOX', { readOnly: true } as any);
      try {
        ingested = await this.drain(client, channel, config);
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => undefined);
    }
    return ingested;
  }

  /**
   * Connect, or answer null for a channel this poller is not meant to read.
   *
   * Host, port and TLS all come out of the shared `imapTarget()` so this
   * service and the IDLE hold cannot drift on what a mailbox even is — the
   * pair of them disagreeing about `secure` is how port 143 came to fail every
   * poll while the dialog claimed the mailbox was configured.
   */
  private async open(channel: ChannelRow): Promise<{ client: ImapFlow; config: any } | null> {
    const config = this.registry.resolveConfig(channel as any);
    const resolved = imapTarget((config.secrets ?? {}) as Record<string, string | undefined>);
    if (resolved.kind !== 'ok') {
      // Debug, not warn: an unrecognised provider is the expected state for a
      // workspace that will use an ESP webhook instead, and a five-minute cron
      // must not turn that into a standing wall of warnings.
      this.logger.debug(
        `email-imap-poll: channel=${channel.id} is not IMAP-pollable (${resolved.reason}) — skipping`,
      );
      return null;
    }

    // The poller is always talking, so a dead socket should be cut off; the
    // IDLE hold deliberately asks for no socket timeout at all.
    const client = new ImapFlow(
      imapConnectOptions(resolved.target, { socketTimeoutMs: CONNECT_TIMEOUT_MS }) as any,
    );

    await client.connect();
    return { client, config };
  }

  private async drain(client: ImapFlow, channel: ChannelRow, config: any): Promise<number> {
    const mailbox: any = (client as any).mailbox;
    const uidValidity = String(mailbox?.uidValidity ?? '');
    const cursor = this.readCursor(channel.configPublic);

    // UIDVALIDITY changing means the server has renumbered the mailbox and
    // every stored UID now points at a different message — or none. Treat it
    // as a first run rather than reading from a meaningless offset.
    const resume = cursor && cursor.uidValidity === uidValidity ? cursor.lastUid : null;

    let uids: number[];
    if (resume !== null) {
      uids = await this.searchUids(client, { uid: `${resume + 1}:*` });
      // `n:*` is never empty in IMAP — a server with nothing newer answers with
      // the highest UID it has, which we have already seen. Drop it explicitly.
      uids = uids.filter((u) => u > resume);
    } else {
      uids = await this.searchUids(client, {
        since: new Date(Date.now() - FIRST_RUN_LOOKBACK_MS),
      });
    }
    if (uids.length === 0) {
      // Nothing newer means the uid that was holding the cursor up is gone from
      // the mailbox, so the counter it owned is meaningless now.
      await this.writeCursor(channel, uidValidity, resume ?? this.highestOf(mailbox), null);
      return 0;
    }

    uids.sort((a, b) => a - b);
    const batch = uids.slice(0, MAX_PER_TICK);

    let ingested = 0;
    /**
     * A first run starts the cursor just BELOW the window, not at zero.
     *
     * The cursor only moves on a uid that finished, so if the very first
     * message of a first run throws, a zero would be written — and the next
     * tick would resume from `1:*` and walk the whole mailbox instead of the
     * `FIRST_RUN_LOOKBACK_MS` window the `since` search just bounded. Seeding
     * from the batch floor says exactly what a first run means: everything
     * older than the window counts as seen.
     */
    let highest = resume ?? Math.max(0, batch[0] - 1);
    const prior = this.readFailState(channel.configPublic, uidValidity);
    let fail: FailState | null = null;

    for (const uid of batch) {
      const key = this.itemKey(channel, uidValidity, uid);
      // Filled in as the examination learns things, so a throw halfway through
      // still leaves a ledger row naming the sender rather than a bare uid.
      const learned: InboundItemFacts = {};
      try {
        const outcome = await this.ingestUid(client, channel, config, uid, {
          resuming: resume !== null,
          firstRun: resume === null,
          key,
          learned,
        });
        if (outcome.ingested) ingested++;
        // INSIDE the try, AFTER the ingest returned. A deliberate `false` still
        // advances — otherwise the first newsletter in the box pins the cursor
        // and is re-read every five minutes forever.
        highest = Math.max(highest, uid);
      } catch (e: any) {
        const message = String(e?.message ?? e).slice(0, 300);
        this.logger.warn(`email-imap-poll: channel=${channel.id} uid=${uid} failed: ${message}`);
        await this.recordFailure(key, message, learned);

        if (e instanceof DeterministicMailError) {
          // It will fail identically next tick. Advance now rather than
          // charging three ticks of inbound latency to everything behind it.
          highest = Math.max(highest, uid);
          continue;
        }

        const attempts = (prior?.uid === uid ? prior.count : 0) + 1;
        if (attempts > MAX_UID_ATTEMPTS) {
          // The escape hatch. Head-of-line blocking is the real risk of
          // stopping, and the item is parked in the ledger — visible and
          // retryable — rather than dropped.
          this.logger.error(
            `email-imap-poll: channel=${channel.id} uid=${uid} parked after ${MAX_UID_ATTEMPTS} attempts: ${message}`,
          );
          highest = Math.max(highest, uid);
          continue;
        }
        fail = { uid, count: attempts };
        break;
      }
    }
    await this.writeCursor(channel, uidValidity, highest, fail);
    return ingested;
  }

  /**
   * Examine one uid and, if it is a person writing to us, ingest it.
   *
   * Returns WHY when it does not — the reason is a ledger code, so a tenant
   * asking "where did my customer's mail go?" gets an answer instead of a line
   * in a debug log nobody reads. A throw means "we could not tell yet", which
   * is the only case that holds the cursor.
   */
  private async ingestUid(
    client: ImapFlow,
    channel: ChannelRow,
    config: any,
    uid: number,
    opts: {
      resuming: boolean;
      key: InboundItemKey;
      learned?: InboundItemFacts;
      /**
       * A mailbox's FIRST tick is a backlog of mail nobody is waiting on an
       * answer to. It is still ingested — the thread and the lead are real —
       * but the automation is held, or connecting a mailbox answers a week of
       * finished conversations at once.
       */
      firstRun?: boolean;
    },
  ): Promise<IngestOutcome> {
    const head: any = await (client as any).fetchOne(
      String(uid),
      // Size and date BEFORE anything else: both decisions below are made
      // without pulling a single byte of body.
      { uid: true, size: true, internalDate: true },
      { uid: true },
    );
    if (!head) return await this.skip(opts.key, 'parse-failed', 'the server no longer has this uid');

    const internalDate: Date | null = head.internalDate instanceof Date ? head.internalDate : null;
    if (isTooOldToIngest(head.internalDate, { resuming: opts.resuming })) {
      return await this.skip(
        opts.key,
        'too-old',
        `INTERNALDATE ${String(head.internalDate)} predates the ingest window`,
        { receivedAt: internalDate },
      );
    }

    const sizeBytes = typeof head.size === 'number' ? head.size : null;
    const loaded = isOversize(sizeBytes)
      ? await this.loadOversize(client, uid, head, opts.key)
      : await this.loadWhole(client, uid, head, opts.key);
    if ('ingested' in loaded) return loaded;

    const { parsed, mail, body } = loaded;
    const facts: InboundItemFacts = {
      // The Message-ID is what a support conversation actually has to hand:
      // the customer forwards their sent copy and the header is in it.
      messageId: mail.messageId,
      fromAddress: mail.from[0]?.address ?? null,
      subject: mail.subject,
      receivedAt: internalDate,
    };
    if (opts.learned) Object.assign(opts.learned, facts);
    await this.ledger((l) => l.open(opts.key, facts));

    /**
     * Own-address mail is NOT filtered here, deliberately.
     * `EmailChannelAdapter.parseInbound` drops it one step later, and it is
     * also where a cross-domain `Reply-To` rescues the contact-form shape whose
     * `From` IS the mailbox itself. Short-circuiting on the address here would
     * take that mail away before the override could run.
     */
    const cls = loaded.classified ?? classifyMail(mail, { platformFrom: this.platformFrom() });
    if (cls.kind === 'BOUNCE_DSN') {
      // The only live bounce source this deployment has. Suppressing the
      // address is what stops the next send; the ledger row is what explains
      // to the tenant why their mail to that person stopped.
      const suppressed = await this.recordDeliveryReport(channel, mail);
      return await this.skip(
        opts.key,
        cls.reason ?? 'dsn',
        suppressed
          ? `${cls.detail ?? 'delivery report'} — suppressed ${suppressed} address(es)`
          : (cls.detail ?? 'delivery report'),
        facts,
      );
    }
    if (cls.kind !== 'HUMAN') {
      return await this.skip(opts.key, cls.reason ?? 'policy-not-a-lead', cls.detail ?? cls.kind, facts);
    }

    const text = stripQuotedReply(body).slice(0, MAX_BODY_CHARS);
    if (!text.trim()) return await this.skip(opts.key, 'empty-body', 'nothing to ingest', facts);

    const adapter = this.registry.get('EMAIL');
    const inbounds = adapter.parseInbound
      ? adapter.parseInbound(config, {
          from: parsed.from?.text ?? '',
          // Carried for the adapter's cross-domain identity override: a
          // contact-form relay writes the submitter here and nowhere else.
          replyTo: parsed.replyTo?.text ?? null,
          subject: mail.subject,
          text,
          // Already through `stripQuotedReply` above — the adapter must not
          // run it a second time on a reply that is now only a few words.
          textIsStripped: true,
          // Brackets stripped so this path and an inbound-parse webhook agree
          // on the id for the same message — see "Both paths, one identity".
          messageId: mail.messageId,
          // Still ingested, still attached to the lead: a 'fail' only suppresses
          // the automation downstream. Silence is the failure mode being removed.
          authVerdict: authVerdict(mail),
        })
      : [];
    let any = false;
    for (const m of inbounds) {
      /**
       * The policy gate, asked on the RESOLVED sender — the adapter has
       * already seen through a contact-form relay by here, so a form
       * submission is judged as the enquirer and not as the website.
       *
       * Under `ALL_SENDERS` (what every channel connected before this knob
       * existed reads as, G3) this makes no query at all.
       */
      const decision = await shouldIngest(
        this.prisma,
        {
          id: channel.id,
          workspaceId: channel.workspaceId,
          configPublic: channel.configPublic,
          ownAddresses: [config.secrets?.fromEmail, config.secrets?.smtpUser, channel.externalId],
        },
        { from: m.externalUserId, inReplyTo: mail.inReplyTo, references: mail.references },
      );
      if (!decision.ingest) {
        // Recorded, not dropped: the ledger row carries a one-click "make this
        // a lead", which is the whole difference between a policy and a hole.
        return await this.skip(
          opts.key,
          decision.reason ?? 'policy-not-a-lead',
          decision.detail ?? decision.policy,
          facts,
        );
      }
      await this.ingress.ingest(
        { id: channel.id, workspaceId: channel.workspaceId, type: channel.type },
        m,
        { suppressAutomation: opts.firstRun === true },
      );
      any = true;
    }
    if (!any) return await this.skip(opts.key, 'own-echo', 'the adapter did not treat it as inbound', facts);
    // A mail read selectively says so on its own row. "We have the text and
    // named the attachments" is a different answer from "we have all of this",
    // and the byte size only ever reached a `warn` line nobody reads.
    await this.ledger((l) =>
      mail.bodyTruncated
        ? l.done(opts.key, facts, 'oversize-truncated')
        : l.done(opts.key, facts),
    );
    return { ingested: true };
  }

  /** The ordinary path: one fetch, the whole message, the real parser. */
  private async loadWhole(
    client: ImapFlow,
    uid: number,
    head: any,
    key: InboundItemKey,
  ): Promise<LoadedMail | IngestSkip> {
    const full: any = await (client as any).fetchOne(String(uid), { uid: true, source: true }, { uid: true });
    if (!full?.source) return await this.skip(key, 'parse-failed', 'the server returned no source');

    const parsed = await this.parse(full.source);
    const mail = rawMailFromParsed(parsed, {
      source: 'imap',
      itemKey: key.itemKey,
      internalDate: head.internalDate instanceof Date ? head.internalDate : null,
      sizeBytes: typeof head.size === 'number' ? head.size : null,
    });
    const body = this.bodyOf(parsed) || synthesizeAttachmentBody(mail.attachments) || '';
    return { parsed, mail, body };
  }

  /**
   * The selective path, for mail too big to pull whole.
   *
   * Order is the whole fix. Mail over the cap is disproportionately image-heavy
   * newsletters, bounce reports carrying the original, and vacation
   * auto-replies — so the headers are fetched and CLASSIFIED before a body byte
   * moves. What used to happen instead was `return false`: a customer replying
   * "signed copy attached" with a 1.8 MB PDF simply never appeared, the AI
   * never answered, and the follow-ups kept firing.
   */
  private async loadOversize(
    client: ImapFlow,
    uid: number,
    head: any,
    key: InboundItemKey,
  ): Promise<LoadedMail | IngestSkip> {
    const meta: any = await (client as any).fetchOne(
      String(uid),
      { uid: true, headers: true, bodyStructure: true },
      { uid: true },
    );
    if (!meta?.headers) return await this.skip(key, 'parse-failed', 'the server returned no headers');

    this.logger.warn(
      `email-imap-poll: channel=${key.channelId} uid=${uid} is ${head.size}B — reading its text part only`,
    );

    const parsed = await this.parse(meta.headers);
    const parts = this.walkStructure(meta.bodyStructure);
    const mail = {
      ...rawMailFromParsed(parsed, {
        source: 'imap',
        itemKey: key.itemKey,
        internalDate: head.internalDate instanceof Date ? head.internalDate : null,
        sizeBytes: typeof head.size === 'number' ? head.size : null,
        bodyTruncated: true,
      }),
      // A header-only parse knows of no attachments; the structure does.
      attachments: parts.attachments,
    };

    // Classified BEFORE the download, on headers alone.
    const cls = classifyMail(mail, { platformFrom: this.platformFrom() });
    if (cls.kind !== 'HUMAN') {
      return await this.skip(key, cls.reason ?? 'policy-not-a-lead', cls.detail ?? cls.kind, {
        messageId: mail.messageId,
        fromAddress: mail.from[0]?.address ?? null,
        subject: mail.subject,
      });
    }

    const node = parts.text[0] ?? parts.html[0] ?? null;
    let body = '';
    if (node) {
      const raw = await this.download(client, uid, node.part ?? '1');
      body = String(node.type ?? '').toLowerCase() === 'text/html' ? this.flattenHtml(raw) : raw;
    }
    const attachmentLine = synthesizeAttachmentBody(parts.attachments);
    // The line is appended even to a body we DID read: the AI answers whatever
    // is ingested, and "they sent the contract" must not be a sentence it can
    // write about a file nobody opened.
    if (attachmentLine) body = body.trim() ? `${body.trim()}\n\n${attachmentLine}` : attachmentLine;
    return { parsed, mail, body, classified: cls };
  }

  /**
   * simpleParser, with its throws named for what they are.
   *
   * A body that does not parse does not parse on the fourth try either, so this
   * failure class advances the cursor immediately instead of holding it.
   */
  private async parse(source: unknown): Promise<ParsedMail> {
    try {
      return await simpleParser(source as any);
    } catch (e) {
      throw new DeterministicMailError('parse-failed', e);
    }
  }

  /**
   * Which part of an oversize message is worth downloading.
   *
   * `message/rfc822` is never descended into: a forwarded mail's body is not
   * this sender's words, and treating it as such would file somebody else's
   * message as the customer's reply. It is named as an attachment instead.
   */
  private walkStructure(node: any, out?: StructureParts): StructureParts {
    const acc: StructureParts = out ?? { text: [], html: [], attachments: [] };
    if (!node || typeof node !== 'object') return acc;
    const type = String(node.type ?? '').toLowerCase();
    const filename =
      node.dispositionParameters?.filename ?? node.parameters?.name ?? node.parameters?.filename ?? null;
    const size = typeof node.size === 'number' ? node.size : null;

    if (type === 'message/rfc822') {
      acc.attachments.push({ filename: filename ?? 'iletilen-mesaj.eml', contentType: type, sizeBytes: size });
      return acc;
    }
    if (Array.isArray(node.childNodes) && node.childNodes.length) {
      for (const child of node.childNodes) this.walkStructure(child, acc);
      return acc;
    }
    if (String(node.disposition ?? '').toLowerCase() === 'attachment') {
      acc.attachments.push({ filename, contentType: type || null, sizeBytes: size });
      return acc;
    }
    if (type === 'text/plain') acc.text.push(node);
    else if (type === 'text/html') acc.html.push(node);
    // An inline image with a filename is still something the sender attached;
    // one without is page furniture and is not worth naming.
    else if (filename) acc.attachments.push({ filename, contentType: type || null, sizeBytes: size });
    return acc;
  }

  /** One bounded part download. imapflow decodes CTE and charset for us, so a
   *  base64 / ISO-8859-9 Turkish body arrives as usable text. */
  private async download(client: ImapFlow, uid: number, part: string): Promise<string> {
    const res: any = await (client as any).download(String(uid), part, {
      uid: true,
      maxBytes: MAX_BODY_DOWNLOAD_BYTES,
    });
    return await streamToString(res?.content);
  }

  /** The address this deployment sends its own mail from — EmailService's
   *  `fromHeader` resolves it in exactly this order. */
  private platformFrom(): string {
    const raw = process.env.EMAIL_FROM || process.env.EMAIL_USER || '';
    const m = /<([^>]+)>/.exec(raw);
    return (m ? m[1] : raw).trim().toLowerCase();
  }

  /** Plain text, falling back to a flattened HTML part for HTML-only mail. */
  private bodyOf(parsed: ParsedMail): string {
    if (parsed.text && parsed.text.trim()) return parsed.text;
    const html = typeof parsed.html === 'string' ? parsed.html : '';
    return html ? this.flattenHtml(html) : '';
  }

  private flattenHtml(html: string): string {
    return String(html ?? '')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)))
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private async searchUids(client: ImapFlow, query: Record<string, unknown>): Promise<number[]> {
    const found = await (client as any).search(query, { uid: true });
    return Array.isArray(found)
      ? found.map((u: any) => Number(u)).filter((u: number) => Number.isFinite(u))
      : [];
  }

  private highestOf(mailbox: any): number {
    const next = Number(mailbox?.uidNext);
    return Number.isFinite(next) && next > 0 ? next - 1 : 0;
  }

  /** `uidValidity:uid` — a uid alone stops meaning anything after a rename. */
  private itemKey(channel: ChannelRow, uidValidity: string, uid: number): InboundItemKey {
    return {
      workspaceId: channel.workspaceId,
      channelId: channel.id,
      source: IMAP_SOURCE,
      itemKey: `${uidValidity}:${uid}`,
    };
  }

  /**
   * A bounce is not a lead. It is an address that has to stop being mailed.
   *
   * Only `5.x.x` and ARF complaints reach the suppression writer — a `4.x.x` is
   * a full mailbox or greylisting, and suppressing on one would stop mailing a
   * perfectly good customer. The mail arrived in the TENANT's mailbox, so it
   * is the workspace-scoped writer, never the platform feedback one.
   *
   * Never throws: a bounce we could not file must not hold the cursor behind
   * it, because the cursor is what is protecting the customer mail queued up
   * after it.
   */
  private async recordDeliveryReport(channel: ChannelRow, mail: RawMail): Promise<number> {
    try {
      const report = parseDeliveryReport(mail);
      const targets = suppressibleRecipients(report);
      let done = 0;
      for (const t of targets) {
        await this.suppression.suppress(channel.workspaceId, t.address, 'EMAIL', t.reason, {
          source: 'dsn',
          note: [t.status, t.diagnostic].filter(Boolean).join(' ').slice(0, 300) || null,
        });
        done++;
      }
      return done;
    } catch (e: any) {
      this.logger.warn(
        `email-imap-poll: channel=${channel.id} delivery report not filed: ${String(e?.message ?? e).slice(0, 200)}`,
      );
      return 0;
    }
  }

  private async skip(
    key: InboundItemKey,
    reason: InboundSkipReason,
    detail: string,
    facts?: InboundItemFacts,
  ): Promise<IngestSkip> {
    this.logger.debug(`email-imap-poll: ${key.itemKey} skipped — ${reason}: ${detail}`);
    await this.ledger((l) => l.skipped(key, reason, facts));
    return { ingested: false, reason, detail };
  }

  /**
   * The ledger's own attempt counter advances here, and the facts already
   * recorded are deliberately NOT re-sent: a retry that dies before parsing
   * knows the uid and nothing else, and overwriting the sender and subject an
   * earlier pass learned would make the row unreadable exactly when somebody
   * is reading it.
   */
  private async recordFailure(
    key: InboundItemKey,
    message: string,
    facts: InboundItemFacts,
  ): Promise<void> {
    await this.ledger((l) => l.failed(key, message, facts));
  }

  /**
   * Every ledger write, swallowed.
   *
   * A bookkeeping failure must never take down the ingest it is bookkeeping
   * for: the row exists to explain where a mail went, and losing the mail to
   * protect the explanation would be exactly backwards (PLAN G2).
   */
  private async ledger<T>(fn: (l: InboundItemService) => Promise<T>): Promise<T | null> {
    if (!this.items) return null;
    try {
      return await fn(this.items);
    } catch (e: any) {
      this.logger.debug(`email-imap-poll: inbound ledger write failed: ${String(e?.message ?? e).slice(0, 200)}`);
      return null;
    }
  }

  private readCursor(configPublic: unknown): PollCursor | null {
    const pub = configPublic && typeof configPublic === 'object' ? (configPublic as any) : null;
    const lastUid = Number(pub?.imapLastUid);
    const uidValidity = pub?.imapUidValidity;
    if (!Number.isFinite(lastUid) || lastUid < 0 || typeof uidValidity !== 'string' || !uidValidity) {
      return null;
    }
    return { lastUid, uidValidity };
  }

  /** The uid currently holding the cursor up, if it is still the same mailbox.
   *  A renumbering resets the count: the old uid is somebody else's mail now. */
  private readFailState(configPublic: unknown, uidValidity: string): FailState | null {
    const pub = configPublic && typeof configPublic === 'object' ? (configPublic as any) : null;
    const uid = Number(pub?.imapFailUid);
    const count = Number(pub?.imapFailCount);
    if (!Number.isFinite(uid) || uid <= 0 || !Number.isFinite(count) || count <= 0) return null;
    if (String(pub?.imapFailUidValidity ?? '') !== uidValidity) return null;
    return { uid, count };
  }

  /** Re-reads the row first (scoped by workspace, as every channel write in
   *  this module is) so a concurrent settings save is not clobbered by a
   *  cursor write holding a stale copy of configPublic. The fail counter rides
   *  along in the SAME update — a second write would be a second chance to
   *  clobber the first. */
  private async writeCursor(
    channel: ChannelRow,
    uidValidity: string,
    lastUid: number,
    fail: FailState | null,
  ): Promise<void> {
    if (!uidValidity) return;
    const fresh = await this.prisma.channel.findFirst({
      where: { id: channel.id, workspaceId: channel.workspaceId },
      select: { configPublic: true },
    });
    const pub =
      fresh?.configPublic && typeof fresh.configPublic === 'object'
        ? (fresh.configPublic as Record<string, unknown>)
        : {};
    await this.prisma.channel.update({
      where: { id: channel.id },
      data: {
        configPublic: {
          ...pub,
          imapLastUid: lastUid,
          imapUidValidity: uidValidity,
          imapFailUid: fail ? fail.uid : null,
          imapFailUidValidity: fail ? uidValidity : null,
          imapFailCount: fail ? fail.count : null,
        } as Prisma.InputJsonValue,
      },
    });
  }
}

/** A message loaded far enough to decide about, whichever path loaded it. */
interface LoadedMail {
  parsed: ParsedMail;
  mail: ReturnType<typeof rawMailFromParsed>;
  body: string;
  /** The selective path has to classify BEFORE it downloads, so it hands the
   *  verdict on rather than making the shared tail ask the same question. */
  classified?: MailClassification;
}

/** What a bodyStructure walk found, in preference order. */
interface StructureParts {
  text: any[];
  html: any[];
  attachments: RawAttachment[];
}

/** imapflow hands back a stream; the tests and a cached part hand back bytes. */
async function streamToString(content: unknown): Promise<string> {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Buffer.isBuffer(content)) return content.toString('utf8');
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of content as AsyncIterable<Buffer | string>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
    }
  } catch {
    // A part that stops mid-download is still worth what arrived: the
    // alternative is dropping a reply because its last kilobyte was missing.
    return Buffer.concat(chunks).toString('utf8');
  }
  return Buffer.concat(chunks).toString('utf8');
}
