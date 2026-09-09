import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { ImapFlow } from 'imapflow';
import { simpleParser, ParsedMail } from 'mailparser';
import { PrismaService } from '../../../prisma/prisma.service';
import { withAdvisoryLock } from '../../../common/scheduling/advisory-lock';
import { ChannelAdapterRegistry } from './channel-adapter.registry';
import { ConversationIngressService } from './conversation-ingress.service';
import { imapForSmtpHost } from './smtp-autodiscover';
import { stripQuotedReply } from './email-reply-text';

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

/** Blast-radius bounds, not correctness mechanisms — `ingress.ingest` dedup is
 *  what makes a re-read harmless. See the class docstring. */
const MAX_PER_TICK = 50;
const FIRST_RUN_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const MAX_SOURCE_BYTES = 1_000_000;
const CONNECT_TIMEOUT_MS = 20_000;

/**
 * Local parts that do not accept a reply, so mail from one is not the opening
 * of a conversation. Two groups: delivery machinery, and the unattended
 * addresses products send their notifications from.
 *
 * `notifications@` is the judgement call here and it is deliberate. Someone
 * may genuinely own such an address, but nobody holds a conversation with one
 * — and the cost of being wrong is asymmetric. Letting one through creates a
 * lead, opens a thread and points the auto-reply engine at a mailbox that will
 * never answer; keeping one out costs a line in a debug log.
 */
const DAEMON_LOCAL_PARTS = new Set([
  'mailer-daemon',
  'postmaster',
  'bounce',
  'bounces',
  'no-reply',
  'noreply',
  'donotreply',
  'do-not-reply',
  'notifications',
  'notification',
]);

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
 * Dedup being the correctness mechanism is what lets the UID cursor be a mere
 * optimisation: lose it, reset it, run two ticks at once, and the worst case
 * is re-read bytes, never a duplicate message.
 *
 * ## What it deliberately does not ingest
 *
 * A first run does not swallow the mailbox's history. Ingesting years of old
 * mail would create a lead per correspondent and hand each one to the auto-
 * reply engine — a reply storm to conversations that ended long ago. The first
 * tick therefore takes only the last `FIRST_RUN_LOOKBACK_MS`, and every tick
 * is capped at `MAX_PER_TICK`; the rest simply arrive on the following tick.
 *
 * Automated mail is skipped outright (RFC 3834 `Auto-Submitted`, `Precedence`,
 * `List-*`, unattended senders, and this platform's OWN address). Without it a
 * bounce or an out-of-office becomes a lead the AI then answers — and two
 * auto-responders introduced to each other do not stop.
 *
 * The last two of those rules were written after the first live run, which
 * turned our own daily digest and a `notifications@` newsletter into leads.
 * Neither carried a single header marking it as machine mail; the only thing
 * wrong with either was the sender. Header rules alone are not enough here.
 *
 * ## Inert by default
 *
 * A channel with no resolvable IMAP host is skipped, not guessed at:
 * `imapForSmtpHost` returns a host only for providers we recognise, and
 * `imapHost` in the channel's own secrets overrides it. A consent-connected
 * (OAuth) mailbox is skipped too — its tokens are owned by
 * EmailOAuthRefreshCron, and a second service authenticating with them would
 * be the only place in this module that reads another service's credentials.
 */
@Injectable()
export class EmailImapPollService {
  private readonly logger = new Logger(EmailImapPollService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ChannelAdapterRegistry,
    private readonly ingress: ConversationIngressService,
  ) {}

  /**
   * The SAFETY NET, not the primary path. `EmailImapIdleService` delivers mail
   * within a second of it arriving; this catches what a dropped IDLE
   * connection, an unsupported server or a restarted process missed. Five
   * minutes is chosen for that job — often enough that a gap is a gap and not
   * an outage, cheap enough to run against every mailbox on the platform.
   */
  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'email-imap-poll' })
  async pollDue(): Promise<void> {
    await withAdvisoryLock(
      this.prisma,
      'email-imap-poll',
      async () => {
        await this.poll();
      },
      this.logger,
    );
  }

  async poll(): Promise<{ ingested: number; mailboxes: number }> {
    if (!this.registry.has('EMAIL')) return { ingested: 0, mailboxes: 0 };
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

    let ingested = 0;
    let mailboxes = 0;
    for (const channel of channels) {
      try {
        const n = await this.pollChannel(channel);
        if (n !== null) {
          mailboxes++;
          ingested += n;
        }
      } catch (e: any) {
        this.logger.warn(
          `email-imap-poll: channel=${channel.id} failed: ${String(e?.message ?? e).slice(0, 300)}`,
        );
      }
    }
    return { ingested, mailboxes };
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
    const channel = (await this.prisma.channel.findFirst({
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

  /** Poll one mailbox. Null means "not an IMAP-pollable channel" (no host, or
   *  a consent-connected mailbox) as opposed to "polled and found nothing". */
  private async pollChannel(channel: ChannelRow): Promise<number | null> {
    const config = this.registry.resolveConfig(channel as any);
    const s = (config.secrets ?? {}) as Record<string, string | undefined>;
    if (s.oauthProvider) return null;

    const user = s.smtpUser?.trim();
    const pass = s.smtpPass;
    if (!user || !pass) return null;

    const explicitHost = s.imapHost?.trim();
    const discovered = imapForSmtpHost(s.smtpHost ?? '');
    const host = explicitHost || discovered?.host;
    if (!host) {
      // Debug, not warn: an unrecognised provider is the expected state for a
      // workspace that will use an ESP webhook instead, and a five-minute cron
      // must not turn that into a standing wall of warnings.
      this.logger.debug(
        `email-imap-poll: no IMAP host for channel=${channel.id} (smtpHost=${s.smtpHost ?? 'unset'}) — skipping`,
      );
      return null;
    }
    const port = Number(s.imapPort) || discovered?.port || 993;

    const client = new ImapFlow({
      host,
      port,
      secure: true,
      auth: { user, pass },
      logger: false,
      greetingTimeout: CONNECT_TIMEOUT_MS,
      socketTimeout: CONNECT_TIMEOUT_MS,
      connectionTimeout: CONNECT_TIMEOUT_MS,
    } as any);

    await client.connect();
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
      await this.writeCursor(channel, uidValidity, resume ?? this.highestOf(mailbox));
      return 0;
    }

    uids.sort((a, b) => a - b);
    const batch = uids.slice(0, MAX_PER_TICK);

    let ingested = 0;
    let highest = resume ?? 0;
    for (const uid of batch) {
      // The cursor advances over EVERY examined uid, including ones skipped as
      // automated or oversize. Advancing only past ingested mail would pin the
      // cursor behind the first newsletter in the box and re-read it forever.
      highest = Math.max(highest, uid);
      try {
        if (await this.ingestUid(client, channel, config, uid)) ingested++;
      } catch (e: any) {
        this.logger.warn(
          `email-imap-poll: channel=${channel.id} uid=${uid} skipped: ${String(e?.message ?? e).slice(0, 200)}`,
        );
      }
    }
    await this.writeCursor(channel, uidValidity, highest);
    return ingested;
  }

  private async ingestUid(
    client: ImapFlow,
    channel: ChannelRow,
    config: any,
    uid: number,
  ): Promise<boolean> {
    const head: any = await (client as any).fetchOne(String(uid), { uid: true, size: true }, { uid: true });
    if (!head) return false;
    if (typeof head.size === 'number' && head.size > MAX_SOURCE_BYTES) {
      // Almost always attachments. The text we want is not worth pulling a
      // multi-megabyte body through on every mailbox in the platform.
      this.logger.debug(`email-imap-poll: uid=${uid} is ${head.size}B — over the source cap, skipped`);
      return false;
    }
    const full: any = await (client as any).fetchOne(String(uid), { uid: true, source: true }, { uid: true });
    if (!full?.source) return false;

    const parsed = await simpleParser(full.source);
    const skip = this.skipReason(parsed);
    if (skip) {
      this.logger.debug(`email-imap-poll: uid=${uid} skipped — ${skip}`);
      return false;
    }

    const body = this.bodyOf(parsed);
    if (!body.trim()) return false;

    const adapter = this.registry.get('EMAIL');
    const inbounds = adapter.parseInbound
      ? adapter.parseInbound(config, {
          from: parsed.from?.text ?? '',
          subject: parsed.subject ?? null,
          text: stripQuotedReply(body),
          // Brackets stripped so this path and an inbound-parse webhook agree
          // on the id for the same message — see "Both paths, one identity".
          messageId: parsed.messageId ? parsed.messageId.replace(/^<|>$/g, '') : null,
        })
      : [];
    let any = false;
    for (const m of inbounds) {
      await this.ingress.ingest(
        { id: channel.id, workspaceId: channel.workspaceId, type: channel.type },
        m,
      );
      any = true;
    }
    return any;
  }

  /**
   * Why this mail is not a customer writing to us — or null when it is.
   *
   * Ingesting machine mail creates a lead out of a bounce and points the
   * auto-reply engine at an auto-responder, which is a loop with no natural
   * end. The REASON is returned rather than a boolean so the debug log says
   * which rule fired: the first live run tripped over two senders no
   * header-based rule would ever have caught, and a bare "skipped" would not
   * have told anyone why.
   */
  private skipReason(parsed: ParsedMail): string | null {
    const header = (name: string): string => {
      const v = parsed.headers?.get(name as any);
      if (!v) return '';
      const raw = typeof v === 'string' ? v : String((v as any).value ?? v);
      return raw.toLowerCase();
    };
    // RFC 3834: anything but "no" means the message was generated, not typed.
    const autoSubmitted = header('auto-submitted');
    if (autoSubmitted && autoSubmitted !== 'no') return `Auto-Submitted: ${autoSubmitted}`;
    if (/\b(bulk|list|junk|auto_reply)\b/.test(header('precedence'))) return 'bulk Precedence';
    // NOT 'list-unsubscribe': mailparser folds every RFC 2369 List-* header
    // into one structured `list` key, so asking for the raw name always
    // answers false. Both are checked because the fold is the parser's
    // behaviour, not the format's, and this must stay right if that changes.
    if (parsed.headers?.has?.('list') || parsed.headers?.has?.('list-unsubscribe')) {
      return 'mailing-list headers';
    }
    if (header('x-autoreply') || header('x-autorespond')) return 'auto-responder header';

    const from = (parsed.from?.value?.[0]?.address ?? '').trim().toLowerCase();
    if (!from) return 'no sender address';

    /**
     * OUR OWN product mail. The daily digest is addressed to the workspace
     * owner and leaves from the platform's `EMAIL_FROM`, so it lands in the
     * very mailbox this poller reads — and on the first live run it became a
     * lead named after the platform, with the digest as its opening message.
     *
     * `EmailChannelAdapter.parseInbound` already drops the WORKSPACE's own
     * address; this is that guard one level up, for the platform's. No header
     * would have caught it: the digest is a perfectly ordinary person-shaped
     * email, and the only thing wrong with it is who sent it.
     */
    const platform = this.platformFrom();
    if (platform && from === platform) return 'the platform own notification mail';

    const local = from.split('@')[0] ?? '';
    if (DAEMON_LOCAL_PARTS.has(local)) return `unattended sender (${local}@)`;
    return null;
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
    if (!html) return '';
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
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

  private readCursor(configPublic: unknown): { lastUid: number; uidValidity: string } | null {
    const pub = configPublic && typeof configPublic === 'object' ? (configPublic as any) : null;
    const lastUid = Number(pub?.imapLastUid);
    const uidValidity = pub?.imapUidValidity;
    if (!Number.isFinite(lastUid) || lastUid < 0 || typeof uidValidity !== 'string' || !uidValidity) {
      return null;
    }
    return { lastUid, uidValidity };
  }

  /** Re-reads the row first (scoped by workspace, as every channel write in
   *  this module is) so a concurrent settings save is not clobbered by a
   *  cursor write holding a stale copy of configPublic. */
  private async writeCursor(channel: ChannelRow, uidValidity: string, lastUid: number): Promise<void> {
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
        } as Prisma.InputJsonValue,
      },
    });
  }
}
