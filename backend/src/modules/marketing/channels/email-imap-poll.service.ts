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

/** Senders whose mail is machinery answering machinery. */
const DAEMON_LOCAL_PARTS = new Set(['mailer-daemon', 'postmaster', 'bounce', 'bounces']);

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
 * `List-Unsubscribe`, and daemon senders). Without that, a bounce or an
 * out-of-office becomes a lead the AI then answers — and two auto-responders
 * introduced to each other do not stop.
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
    if (this.isAutomated(parsed)) {
      this.logger.debug(`email-imap-poll: uid=${uid} is automated mail — skipped`);
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
   * Mail sent by machinery. Ingesting it would create a lead out of a bounce
   * and let the auto-reply engine answer an auto-responder, which is a loop
   * with no natural end.
   */
  private isAutomated(parsed: ParsedMail): boolean {
    const header = (name: string): string => {
      const v = parsed.headers?.get(name as any);
      if (!v) return '';
      const raw = typeof v === 'string' ? v : String((v as any).value ?? v);
      return raw.toLowerCase();
    };
    // RFC 3834: anything but "no" means the message was generated, not typed.
    const autoSubmitted = header('auto-submitted');
    if (autoSubmitted && autoSubmitted !== 'no') return true;
    if (/\b(bulk|list|junk|auto_reply)\b/.test(header('precedence'))) return true;
    // NOT 'list-unsubscribe': mailparser folds every RFC 2369 List-* header
    // into one structured `list` key, so asking for the raw name always
    // answers false. Both are checked because the fold is the parser's
    // behaviour, not the format's, and this must stay right if that changes.
    if (parsed.headers?.has?.('list') || parsed.headers?.has?.('list-unsubscribe')) return true;
    if (header('x-autoreply') || header('x-autorespond')) return true;

    const from = (parsed.from?.value?.[0]?.address ?? '').toLowerCase();
    const local = from.split('@')[0] ?? '';
    return DAEMON_LOCAL_PARTS.has(local);
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
