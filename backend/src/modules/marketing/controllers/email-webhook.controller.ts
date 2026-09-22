import {
  Controller,
  Get,
  Post,
  Param,
  Req,
  Res,
  Logger,
  UnauthorizedException,
  ServiceUnavailableException,
  Optional,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { PublicChannelResolverService } from '../channels/public-channel-resolver.service';
import { ChannelAdapterRegistry } from '../channels/channel-adapter.registry';
import { ConversationIngressService } from '../channels/conversation-ingress.service';
import { SuppressionService } from '../compliance/suppression.service';
import { verifyEmailInboundToken } from '../channels/email-inbound-callback.util';
import { stripQuotedReply, truncateHtmlQuote } from '../channels/email-reply-text';
import { normalizeMessageId } from '../channels/email-message-id';
import {
  MailAddress,
  RawAttachment,
  RawMail,
  RawMailHeaderLine,
  headerLineValue,
  parseAddressList,
  parseContentType,
  preferredRecipients,
  primaryAddress,
  primaryName,
  rawMail,
  synthesizeAttachmentBody,
} from '../channels/inbound/inbound-mail.types';
import { classifyMail } from '../channels/inbound/mail-classify';
import { shouldIngest } from '../channels/inbound/inbound-policy';
import {
  InboundItemFacts,
  InboundItemKey,
  InboundItemService,
} from '../channels/inbound/inbound-item.service';
import { InboundSkipReason } from '../channels/inbound/inbound-mail.types';
import { PrismaService } from '../../../prisma/prisma.service';
import { assessAuth } from '../channels/inbound/mail-auth';
import { parseDeliveryReport, suppressibleRecipients } from '../channels/inbound/delivery-report';
import { EMAIL_INBOUND_THROTTLE } from '../public-throttle.const';

/** A channel row as the resolver hands it back. */
interface ChannelRow {
  id: string;
  workspaceId: string;
  type: string;
  status: string;
  externalId: string | null;
  configSealed?: unknown;
  configPublic?: unknown;
}

/**
 * Inbound email — two doors into the same pipeline.
 *
 * **`POST :channelId/:token/inbound` is the one to use.** The channel id is in
 * the URL and the token is an HMAC of it under `MARKETING_SECRET_KEY`
 * (`email-inbound-callback.util.ts`), exactly the shape that already carries
 * NetGSM's unsigned SMS callbacks. That single move fixes two things the legacy
 * route could not:
 *
 * - A relay needs **no platform secret**. The old route demanded an
 *   `x-email-signature` HMAC over the raw body against a platform-global
 *   `EMAIL_INBOUND_SECRET` that no inbound-parse provider can produce, so every
 *   tenant who followed the dialog got a silent 401 — and the only way to make
 *   it work was to hand one tenant the platform's secret
 *   (`inbound-webhook-unusable`).
 * - **The URL names the tenant.** The old route read the destination workspace
 *   out of the `To:` header, which the sender writes: a Bcc, a list rewrite or a
 *   crafted header delivered one tenant's mail into another's inbox
 *   (`webhook-to-header-routing`). A token holder can now only ever address the
 *   channel their own URL names.
 *
 * `POST webhook` stays, unchanged in how it authenticates, because a custom
 * relay may already sign it. What it gained is an ordered, envelope-PREFERRED
 * recipient list that refuses to guess: if the header tier resolves two
 * different tenants, the mail is dropped and said out loud rather than
 * delivered to whichever row Postgres returned first.
 *
 * Both doors now run the SAME filters the IMAP poller runs — `classifyMail`,
 * `assessAuth`, the delivery-report lane and quote stripping — because a body
 * posted by a provider is not a `ParsedMail` and nothing over here had ever
 * heard of an auto-reply or a bounce (`webhook-no-machine-filter`).
 *
 * And both process **synchronously**. The old route ACKed 200 and then worked
 * in a floating promise, so a database blip was unrecoverable mail loss with a
 * log line for a headstone. A 5xx is a redelivery; an ACK is a decision that the
 * mail never existed.
 *
 * A raw parser is mounted on the whole `/api/public/channels/email` prefix in
 * `app.config.ts` — `app.use` is prefix-matching, and the old `/webhook`-only
 * mount did NOT cover this controller's new path.
 */
@Controller('public/channels/email')
export class EmailWebhookController {
  private readonly logger = new Logger(EmailWebhookController.name);

  constructor(
    private readonly resolver: PublicChannelResolverService,
    private readonly registry: ChannelAdapterRegistry,
    private readonly ingress: ConversationIngressService,
    private readonly suppression: SuppressionService,
    /** The inbound policy's reads. Same function the IMAP poller calls, or the
     *  webhook goes on being the door with none of the poller's rules. */
    private readonly prisma: PrismaService,
    /** Optional so a deployment that has not wired the ledger still receives
     *  mail. A missing ledger costs the audit trail, never the mail. */
    @Optional() private readonly items?: InboundItemService,
  ) {}

  /** This item, as the ledger keys it. `RawMail.itemKey` is the normalised
   *  Message-ID, or a hash of the body when the mail carried none. */
  private itemKey(channel: ChannelRow, mail: RawMail): InboundItemKey {
    return {
      workspaceId: channel.workspaceId,
      channelId: channel.id,
      source: 'webhook',
      itemKey: mail.itemKey,
    };
  }

  private factsOf(mail: RawMail): InboundItemFacts {
    return {
      messageId: mail.messageId,
      fromAddress: primaryAddress(mail.from) || null,
      subject: mail.subject,
      receivedAt: mail.internalDate,
    };
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
      this.logger.debug(`email inbound: ledger write failed: ${String(e?.message ?? e).slice(0, 200)}`);
      return null;
    }
  }

  /** A recorded non-ingest. The tenant asking "where did my customer's mail
   *  go?" gets an answer instead of a line in a debug log nobody reads. */
  private async skip(
    channel: ChannelRow,
    mail: RawMail,
    reason: InboundSkipReason,
    detail: string,
  ): Promise<number> {
    this.logger.debug(`email inbound (channel=${channel.id}) skipped — ${reason}: ${detail}`);
    await this.ledger((l) => l.skipped(this.itemKey(channel, mail), reason, this.factsOf(mail)));
    return 0;
  }

  @Get('webhook')
  health(@Res() res: Response): void {
    res.status(200).send('ok');
  }

  @Post('webhook')
  async receive(@Req() req: Request, @Res() res: Response): Promise<void> {
    const raw: Buffer = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(JSON.stringify(req.body ?? {}));
    if (!this.validSignature(raw, req.headers['x-email-signature'])) {
      // Said out loud, never with the header value: a silent 401 is how an ESP
      // pointed at the wrong path loses every inbound mail without a trace.
      this.logger.warn(
        `inbound email webhook rejected: ${process.env.EMAIL_INBOUND_SECRET ? 'signature did not verify' : 'EMAIL_INBOUND_SECRET is not set'}`,
      );
      res.status(401).send('bad signature');
      return;
    }
    const body = this.parseBody(raw, req.headers['content-type']);
    if (!body) {
      // Unparseable is deterministic — redelivering the same bytes produces the
      // same nothing, so this one really is an ACK.
      res.status(200).send('EVENT_RECEIVED');
      return;
    }
    try {
      // SYNCHRONOUS on purpose: the ACK is the promise that we have the mail.
      await this.process(body);
      res.status(200).send('EVENT_RECEIVED');
    } catch (e: any) {
      this.logger.error(`email webhook processing failed: ${e?.message ?? e}`);
      res.status(503).send('retry');
    }
  }

  /** A relay's own reachability probe. Token-gated so it cannot enumerate ids. */
  @Get(':channelId/:token/inbound')
  async tokenHealth(
    @Param('channelId') channelId: string,
    @Param('token') token: string,
  ): Promise<string> {
    if (!verifyEmailInboundToken(channelId, token)) {
      throw new UnauthorizedException('invalid callback token');
    }
    return 'ok';
  }

  /**
   * The per-channel inbound route.
   *
   * Its own throttle bucket, deliberately not the 20/min public-write one: this
   * is a machine callback, and a busy mailbox behind one relay IP would spend
   * the whole bucket in a minute. A rate-limited inbound mail is a lost mail.
   */
  @Throttle(EMAIL_INBOUND_THROTTLE)
  @Post(':channelId/:token/inbound')
  async inbound(
    @Param('channelId') channelId: string,
    @Param('token') token: string,
    @Req() req: Request,
  ): Promise<{ ok: boolean; received: number }> {
    // Authenticate FIRST — before any DB work, so a forged URL cannot probe
    // which channel ids exist by timing the response.
    if (!verifyEmailInboundToken(channelId, token)) {
      throw new UnauthorizedException('invalid callback token');
    }
    const channel = (await this.resolver.channelForInbound(channelId)) as ChannelRow | null;
    if (
      !channel ||
      channel.type !== 'EMAIL' ||
      channel.status !== 'ACTIVE' ||
      !this.registry.has('EMAIL')
    ) {
      this.logger.warn(`email inbound for unusable channel id=${channelId} — acking empty`);
      return { ok: true, received: 0 };
    }
    const raw: Buffer = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(JSON.stringify(req.body ?? {}));
    const body = this.parseBody(raw, req.headers['content-type']);
    if (!body) return { ok: true, received: 0 };

    const mail = this.buildRawMail(body);
    // The address is a SANITY CHECK here, never a router: aliases, plus-
    // addressing and catch-alls are all legitimate, so a mismatch is worth
    // saying and never worth dropping the mail over.
    this.warnOnRecipientMismatch(channel, mail);
    try {
      const received = await this.ingestMail(channel, mail, body);
      return { ok: true, received };
    } catch (e: any) {
      this.logger.error(
        `email inbound ingest failed (channel=${channel.id}, from=${primaryAddress(mail.from) || 'unknown'}): ${e?.message ?? e}`,
      );
      // 5xx, so the relay redelivers. Swallowing this is how mail disappears.
      throw new ServiceUnavailableException('inbound ingest failed');
    }
  }

  /**
   * Inbound providers POST different encodings: Postmark = JSON, Mailgun =
   * urlencoded/multipart, SendGrid = multipart. Parse by Content-Type (falling
   * back to JSON→urlencoded) so a provider's mail isn't silently dropped. The
   * HMAC stays over the RAW bytes, so this parse never affects verification.
   */
  private parseBody(raw: Buffer, contentType: unknown): Record<string, any> | null {
    const ctRaw = String(contentType ?? '');
    const ct = ctRaw.toLowerCase();
    const text = raw.toString('utf8');
    try {
      if (ct.includes('application/x-www-form-urlencoded')) {
        return Object.fromEntries(new URLSearchParams(text));
      }
      if (ct.includes('multipart/form-data')) {
        // Boundaries are CASE-SENSITIVE — extract from the original header.
        return this.parseMultipart(text, ctRaw);
      }
      if (ct.includes('application/json') || text.trimStart().startsWith('{')) {
        return JSON.parse(text);
      }
      // Unknown content-type: try JSON, then urlencoded.
      try {
        return JSON.parse(text);
      } catch {
        return Object.fromEntries(new URLSearchParams(text));
      }
    } catch {
      this.logger.warn(`email webhook: unparseable body (content-type=${ct || 'none'}) — dropped`);
      return null;
    }
  }

  /** Best-effort extraction of multipart text fields (file parts are skipped). */
  private parseMultipart(text: string, ct: string): Record<string, any> {
    const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
    const boundary = (m?.[1] || m?.[2] || '').trim();
    const out: Record<string, any> = {};
    if (!boundary) return out;
    for (const part of text.split('--' + boundary)) {
      const nameM = /name="([^"]+)"/i.exec(part);
      if (!nameM || /filename="/i.test(part)) continue; // skip non-fields + file parts
      const idx = part.indexOf('\r\n\r\n');
      if (idx === -1) continue;
      out[nameM[1]] = part.slice(idx + 4).replace(/\r\n--\s*$/, '').replace(/\r\n$/, '');
    }
    return out;
  }

  private validSignature(raw: Buffer, sig: unknown): boolean {
    const secret = process.env.EMAIL_INBOUND_SECRET;
    if (!secret || typeof sig !== 'string') return false;
    const provided = sig.includes('s=') ? sig.split('s=').pop()!.trim() : sig.trim();
    const expected = createHmac('sha256', secret).update(raw).digest('hex');
    try {
      const a = Buffer.from(provided);
      const b = Buffer.from(expected);
      return a.length === b.length && timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  /** The legacy route's body, routed by address because it has nothing else. */
  private async process(body: any): Promise<void> {
    if (!this.registry.has('EMAIL')) return;
    const mail = this.buildRawMail(body);
    const channel = await this.resolveLegacyChannel(mail);
    if (!channel) return;
    await this.ingestMail(channel, mail, body);
  }

  /**
   * Which channel a legacy post is for, envelope-PREFERRED and never a guess.
   *
   * Two tiers. The envelope tier is what the receiving server accepted the mail
   * for (`recipient`, `OriginalRecipient`, the SendGrid `envelope` — which is
   * posted as a JSON STRING, which is why `body.envelope?.to` never yielded
   * anything); a sender cannot forge it, so the first hit wins.
   *
   * The header tier — `Delivered-To`, `X-Original-To`, then every `To`/`Cc`
   * address — is the sender's own words. It is used only when no envelope
   * resolved, and if it names TWO tenants the mail is dropped: that is the
   * Bcc/cross-post shape, and picking one of them is the cross-tenant delivery
   * this whole route was rewritten to make impossible.
   */
  private async resolveLegacyChannel(mail: RawMail): Promise<ChannelRow | null> {
    for (const address of mail.envelopeTo) {
      const hit = (await this.resolver.byExternalId('EMAIL', address)) as ChannelRow | null;
      if (hit) return hit;
    }
    const fallback = [...mail.to, ...mail.cc].map((a) => a.address);
    const byId = new Map<string, ChannelRow>();
    for (const address of unique(fallback)) {
      const hit = (await this.resolver.byExternalId('EMAIL', address)) as ChannelRow | null;
      if (hit) byId.set(hit.id, hit);
    }
    if (byId.size === 1) return [...byId.values()][0];
    if (byId.size > 1) {
      this.logger.warn(
        `email inbound addressed to ${byId.size} registered channels (${unique(fallback).join(', ')}) — dropped rather than guessed`,
      );
      return null;
    }
    this.logger.warn(
      `email inbound for unregistered address(es)=${[...mail.envelopeTo, ...unique(fallback)].join(', ') || 'none'} — skipping`,
    );
    return null;
  }

  /**
   * Everything between "a body arrived" and "a message exists", in the order the
   * IMAP path does it: classify, then the report lane, then authenticate, then
   * build the text a human actually typed.
   */
  private async ingestMail(channel: ChannelRow, mail: RawMail, body: any): Promise<number> {
    const adapter = this.registry.get('EMAIL');
    const config = this.registry.resolveConfig(channel as any);
    const ownAddresses = [config.secrets?.fromEmail, config.secrets?.smtpUser, config.externalId]
      .map((v) => parseAddressList(String(v ?? ''))[0]?.address)
      .filter(Boolean) as string[];

    const kind = classifyMail(mail, {
      platformFrom: process.env.EMAIL_FROM || process.env.EMAIL_USER || null,
      ownAddresses,
    });
    if (kind.kind === 'BOUNCE_DSN') {
      const suppressed = await this.recordDeliveryReport(channel, mail);
      return await this.skip(
        channel,
        mail,
        kind.reason ?? 'dsn',
        suppressed ? `delivery report — suppressed ${suppressed} address(es)` : 'delivery report',
      );
    }
    if (kind.kind !== 'HUMAN') {
      return await this.skip(
        channel,
        mail,
        kind.reason ?? 'policy-not-a-lead',
        kind.detail ?? kind.kind,
      );
    }

    const auth = assessAuth(mail);
    if (auth.verdict === 'fail') {
      // Still ingested, still attached to the lead. Silence is the failure mode
      // being removed — `senderVerified:false` is what downgrades the mail.
      this.logger.warn(
        `email inbound (channel=${channel.id}) from=${primaryAddress(mail.from)} failed sender authentication (spf=${auth.spf} dkim=${auth.dkim} dmarc=${auth.dmarc})`,
      );
    }

    const text = this.messageText(mail);
    if (!text) {
      return await this.skip(channel, mail, 'empty-body', 'nothing to ingest');
    }
    await this.ledger((l) => l.open(this.itemKey(channel, mail), this.factsOf(mail)));

    const normalized = {
      // Rebuilt from the PARSED mailbox, so a forged display name cannot smuggle
      // an address into the lead's contact name and the adapter still gets a
      // name to work with (a bare address makes every lead "Channel contact").
      from: this.canonicalFrom(mail.from),
      subject: mail.subject,
      text,
      // `messageText` already stripped the quote and pre-truncated the HTML;
      // the adapter must not strip a second time.
      textIsStripped: true,
      // The contact-form relay's enquirer. The adapter resolves the identity —
      // it is the one place that answers "who is this from" for both doors.
      replyTo: this.canonicalReplyTo(mail),
      messageId: mail.messageId,
      /** Carried onto `Message.meta` for the audit trail and the sender badge. */
      auth: { verdict: auth.verdict, spf: auth.spf, dkim: auth.dkim, dmarc: auth.dmarc, source: auth.source },
      /** The provider's own body, untouched, so nothing is lost in this rewrite. */
      provider: body,
    };
    const inbounds = adapter.parseInbound ? adapter.parseInbound(config, normalized) : [];
    if (!inbounds.length) {
      return await this.skip(channel, mail, 'own-echo', 'the adapter did not treat it as inbound');
    }
    let received = 0;
    try {
      for (const msg of inbounds) {
        /**
         * The SAME policy the IMAP poller applies, asked on the RESOLVED
         * sender. Putting it in only one of the two doors is how the webhook
         * ended up with none of the poller's rules in the first place.
         */
        const decision = await shouldIngest(
          this.prisma,
          {
            id: channel.id,
            workspaceId: channel.workspaceId,
            configPublic: channel.configPublic,
            ownAddresses,
          },
          { from: msg.externalUserId, inReplyTo: mail.inReplyTo, references: mail.references },
        );
        if (!decision.ingest) {
          return await this.skip(
            channel,
            mail,
            decision.reason ?? 'policy-not-a-lead',
            decision.detail ?? decision.policy,
          );
        }
        await this.ingress.ingest(
          { id: channel.id, workspaceId: channel.workspaceId, type: channel.type as any },
          msg,
        );
        received++;
      }
    } catch (e: any) {
      /**
       * Record it, then let it out so the caller answers 5xx and the relay
       * redelivers — redelivery is the primary recovery here, because unlike
       * a mailbox uid these bytes exist nowhere else.
       *
       * The row is what covers the case where redelivery never comes: without
       * it the `open()` above leaves a NEW row nobody will ever settle, which
       * is invisible in exactly the way this ledger exists to stop. A later
       * redelivery re-keys to the same row and flips it to DONE.
       */
      await this.ledger((l) =>
        l.failed(this.itemKey(channel, mail), String(e?.message ?? e), this.factsOf(mail)),
      );
      throw e;
    }
    await this.ledger((l) => l.done(this.itemKey(channel, mail), this.factsOf(mail)));
    return received;
  }

  /**
   * A bounce is not a lead. It is an address that has to stop being mailed.
   *
   * Only 5.x.x and ARF complaints reach `SuppressionService` — a 4.x.x is a full
   * mailbox or greylisting, and suppressing on one would stop mailing a
   * perfectly good customer. The tenant's mailbox has a workspace, so this is
   * the tenant-scoped writer, not the platform-wide feedback one.
   */
  private async recordDeliveryReport(channel: ChannelRow, mail: RawMail): Promise<number> {
    const report = parseDeliveryReport(mail);
    const targets = suppressibleRecipients(report);
    if (!targets.length) {
      this.logger.debug(
        `email inbound (channel=${channel.id}) delivery report kind=${report.kind} suppressed nobody`,
      );
      return 0;
    }
    for (const t of targets) {
      await this.suppression.suppress(channel.workspaceId, t.address, 'EMAIL', t.reason, {
        source: 'dsn',
        note: [t.status, t.diagnostic].filter(Boolean).join(' ').slice(0, 300) || null,
      });
    }
    this.logger.log(
      `email inbound (channel=${channel.id}) ${report.kind} suppressed ${targets.length} address(es)`,
    );
    return targets.length;
  }

  /**
   * The part the human typed.
   *
   * The provider's own stripped body wins when there is one (Mailgun does this
   * server-side and does it well); otherwise the shared stripper runs, because
   * without it the AI reads its own previous message back as the customer's.
   * A mail with nothing but attachments gets a body that SAYS the content was
   * not read — returning nothing instead would drop the mail, and inventing a
   * summary would be worse.
   */
  private messageText(mail: RawMail): string {
    const stripped = (mail.strippedText ?? '').trim();
    if (stripped) return stripped.slice(0, 8000);
    const plain = (mail.text ?? '').trim();
    const source = plain || htmlToText(truncateHtmlQuote(mail.html));
    const body = source.trim() ? stripQuotedReply(source).trim() : '';
    if (body) return body.slice(0, 8000);
    return (synthesizeAttachmentBody(mail.attachments) ?? '').slice(0, 8000);
  }

  /** `"Name" <addr>` from the parsed mailbox, with any address decoration
   *  stripped out of the name so it cannot end up as the lead's contact. */
  private canonicalFrom(from: readonly MailAddress[]): string {
    const address = primaryAddress(from);
    if (!address) return '';
    const name = primaryName(from).replace(/[<>"\\,;]/g, '').trim();
    return name ? `"${name}" <${address}>` : address;
  }

  /** The same treatment for `Reply-To`, which the adapter resolves identity
   *  from. Null when the mail named none, so the override simply never fires. */
  private canonicalReplyTo(mail: RawMail): string | null {
    return mail.replyTo?.length ? this.canonicalFrom(mail.replyTo) || null : null;
  }

  /** Say it when the envelope disagrees with the channel — never drop on it. */
  private warnOnRecipientMismatch(channel: ChannelRow, mail: RawMail): void {
    const own = String(channel.externalId ?? '').toLowerCase();
    if (!own) return;
    const addressed = preferredRecipients(mail);
    if (!addressed.length || addressed.includes(own)) return;
    this.logger.warn(
      `email inbound on channel=${channel.id} (${own}) was addressed to ${addressed.join(', ')} — delivering anyway (alias/plus-addressing)`,
    );
  }

  /**
   * Everything the classifier, the authenticator and the report parser need,
   * rebuilt from a provider's POST body.
   *
   * The header list is the part that matters and the part providers disagree
   * about most: Mailgun posts `message-headers` (a JSON array of pairs),
   * Postmark posts `Headers` (`{Name, Value}` objects) and SendGrid posts
   * `headers` as one raw folded string. Order is preserved through all three,
   * because "the FIRST `Authentication-Results` line" is a security property.
   */
  private buildRawMail(body: any): RawMail {
    const b = (body ?? {}) as Record<string, any>;
    const headerLines = this.headerLinesOf(b);
    const header = (name: string) => headerLineValue({ headerLines }, name);

    const fromRaw = b.from ?? b.sender ?? b.From ?? header('from') ?? '';
    const replyToRaw = b['Reply-To'] ?? b.ReplyTo ?? b.replyTo ?? b['reply-to'] ?? header('reply-to') ?? '';
    const toRaw = b.To ?? b.to ?? header('to') ?? '';
    const ccRaw = b.Cc ?? b.cc ?? header('cc') ?? '';
    const text = firstString(b['stripped-text'], b.text, b.TextBody, b['body-plain'], b.plain, b.body);
    const html = firstString(b['stripped-html'], b.html, b.HtmlBody, b['body-html']);
    const subject = firstString(b.subject, b.Subject, header('subject'));
    const messageId = firstString(b['message-id'], b.messageId, b.MessageID, b['Message-Id'], header('message-id'));
    const contentType = parseContentType(header('content-type') ?? firstString(b['content-type']));

    const mail = rawMail({
      source: 'webhook',
      itemKey: normalizeMessageId(messageId) ?? `sha256:${sha256(b)}`,
      from: parseAddressList(String(fromRaw)),
      replyTo: parseAddressList(String(replyToRaw)),
      to: parseAddressList(String(toRaw)).concat(fullAddresses(b.ToFull)),
      cc: parseAddressList(String(ccRaw)).concat(fullAddresses(b.CcFull)),
      envelopeTo: this.envelopeRecipients(b, header),
      subject: subject || null,
      messageId,
      inReplyTo: firstString(b['in-reply-to'], b.inReplyTo, header('in-reply-to')),
      references: splitReferences(firstString(b.references, header('references'))),
      headerLines,
      contentType,
      internalDate: receivedAt(b),
      text: text || null,
      html: html || null,
      // Mailgun is the one provider that strips server-side; the field exists
      // only when it did, and `messageText` falls back to our own stripper.
      strippedText: typeof b['stripped-text'] === 'string' ? b['stripped-text'] : null,
      attachments: attachmentsOf(b),
      providerAuth: providerAuthOf(b, header),
    });
    return mail;
  }

  /**
   * What the SERVER accepted this mail for, best first.
   *
   * SendGrid's `envelope` is posted as a JSON **string**, which is the reason
   * the old `body.envelope?.to` chain never once yielded an address.
   */
  private envelopeRecipients(b: Record<string, any>, header: (n: string) => string | null): string[] {
    const out: string[] = [];
    const add = (v: unknown) => {
      for (const a of parseAddressList(String(v ?? ''))) out.push(a.address);
    };
    add(b.recipient); // Mailgun
    add(b.OriginalRecipient); // Postmark
    const envelope = jsonMaybe(b.envelope); // SendGrid
    if (envelope && typeof envelope === 'object') {
      const to = (envelope as { to?: unknown }).to;
      for (const v of Array.isArray(to) ? to : [to]) add(v);
    }
    add(b['Delivered-To'] ?? header('delivered-to'));
    add(b['X-Original-To'] ?? header('x-original-to'));
    return unique(out);
  }

  /** The posted headers, in order, whatever shape the provider chose. */
  private headerLinesOf(b: Record<string, any>): RawMailHeaderLine[] {
    const out: RawMailHeaderLine[] = [];
    const push = (name: unknown, value: unknown) => {
      const label = String(name ?? '').trim();
      if (!label) return;
      out.push({ key: label.toLowerCase(), line: `${label}: ${String(value ?? '')}` });
    };

    const mailgun = jsonMaybe(b['message-headers']);
    if (Array.isArray(mailgun)) {
      for (const pair of mailgun) if (Array.isArray(pair)) push(pair[0], pair[1]);
      if (out.length) return out;
    }
    const postmark = jsonMaybe(b.Headers);
    if (Array.isArray(postmark)) {
      for (const h of postmark) {
        if (h && typeof h === 'object') push((h as any).Name ?? (h as any).name, (h as any).Value ?? (h as any).value);
      }
      if (out.length) return out;
    }
    const sendgrid = typeof b.headers === 'string' ? b.headers : '';
    if (sendgrid.trim()) {
      // RFC 5322 folding: a continuation line begins with whitespace and belongs
      // to the header above it. Unfold before splitting or a folded
      // Authentication-Results reads as its own (empty-named) header.
      for (const line of sendgrid.replace(/\r\n/g, '\n').replace(/\n[ \t]+/g, ' ').split('\n')) {
        const colon = line.indexOf(':');
        if (colon <= 0) continue;
        push(line.slice(0, colon), line.slice(colon + 1).trim());
      }
    }
    return out;
  }
}

/** The first of these that is a non-empty string. */
function firstString(...values: unknown[]): string {
  for (const v of values) if (typeof v === 'string' && v.trim()) return v;
  return '';
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

/** A value a provider may post either as JSON text or as the parsed thing. */
function jsonMaybe(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Postmark's `ToFull` / `CcFull`: `[{Email, Name}]`. */
function fullAddresses(value: unknown): MailAddress[] {
  const list = jsonMaybe(value);
  if (!Array.isArray(list)) return [];
  const out: MailAddress[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const address = parseAddressList(String((entry as any).Email ?? (entry as any).email ?? ''))[0];
    if (address) out.push({ address: address.address, name: String((entry as any).Name ?? address.name ?? '') });
  }
  return out;
}

/** Every id in a `References` chain, whatever separator the provider used. */
function splitReferences(value: string): string[] {
  if (!value.trim()) return [];
  return value.match(/<[^<>]+>/g) ?? value.split(/\s+/);
}

/**
 * When we received it — the RELAY's clock, never the `Date:` header, which the
 * sender writes and which the age bound downstream would otherwise honour.
 * Mailgun signs a unix `timestamp`; everyone else gets "now", which is true.
 */
function receivedAt(b: Record<string, any>): Date {
  const ts = Number(b.timestamp);
  if (Number.isFinite(ts) && ts > 0) return new Date(ts * 1000);
  return new Date();
}

/** What was attached, by name and size — never the bytes. */
function attachmentsOf(b: Record<string, any>): RawAttachment[] {
  const out: RawAttachment[] = [];
  const push = (filename: unknown, contentType: unknown, size: unknown) => {
    const name = String(filename ?? '').trim();
    if (!name) return;
    out.push({
      filename: name,
      contentType: contentType ? String(contentType) : null,
      sizeBytes: Number.isFinite(Number(size)) ? Number(size) : null,
    });
  };
  const mailgun = jsonMaybe(b.attachments);
  if (Array.isArray(mailgun)) {
    for (const a of mailgun) {
      if (a && typeof a === 'object') push((a as any).name ?? (a as any).filename, (a as any)['content-type'], (a as any).size);
    }
  }
  const postmark = jsonMaybe(b.Attachments);
  if (Array.isArray(postmark)) {
    for (const a of postmark) {
      if (a && typeof a === 'object') push((a as any).Name, (a as any).ContentType, (a as any).ContentLength);
    }
  }
  const sendgrid = jsonMaybe(b['attachment-info']);
  if (sendgrid && typeof sendgrid === 'object' && !Array.isArray(sendgrid)) {
    for (const a of Object.values(sendgrid as Record<string, any>)) {
      if (a && typeof a === 'object') push((a as any).filename, (a as any).type, null);
    }
  }
  return out;
}

/**
 * The ESP's own verdict, for the one path where no border MTA wrote an
 * `Authentication-Results` line because the ESP IS the MX.
 */
function providerAuthOf(b: Record<string, any>, header: (n: string) => string | null) {
  const spf = firstString(b.SPF, b.spf, header('x-mailgun-spf'), header('received-spf'));
  const dkim = firstString(
    typeof b.dkim === 'string' ? b.dkim : '',
    header('x-mailgun-dkim-check-result'),
  );
  const dmarc = firstString(header('x-mailgun-dmarc'));
  if (!spf && !dkim && !dmarc) return null;
  return { spf: spf || null, dkim: dkim || null, dmarc: dmarc || null };
}

/**
 * HTML to something a person (and a prompt) can read.
 *
 * Deliberately the same shape the IMAP poller uses on its own HTML-only mail —
 * block tags become line breaks, everything else goes — plus entity decoding,
 * because a provider posts the body already decoded from its transfer encoding
 * but not from its entities, and `te&#351;ekk&uuml;rler` is not Turkish.
 */
function htmlToText(html: string | null | undefined): string {
  const source = String(html ?? '');
  if (!source.trim()) return '';
  return decodeEntities(
    source
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (whole, name: string) => {
    const key = name.toLowerCase();
    if (key.startsWith('#x')) return codePoint(parseInt(key.slice(2), 16), whole);
    if (key.startsWith('#')) return codePoint(parseInt(key.slice(1), 10), whole);
    return NAMED_ENTITIES[key] ?? whole;
  });
}

function codePoint(value: number, fallback: string): string {
  return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : fallback;
}

/** A stable item key for a mail whose provider sent no Message-ID. */
function sha256(body: unknown): string {
  try {
    return createHash('sha256').update(JSON.stringify(body) ?? '').digest('hex').slice(0, 32);
  } catch {
    return createHash('sha256').update(String(body)).digest('hex').slice(0, 32);
  }
}
