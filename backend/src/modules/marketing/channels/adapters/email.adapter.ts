import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import addressparser from 'nodemailer/lib/addressparser';
import { ImapFlow } from 'imapflow';
import { ChannelAdapterRegistry } from '../channel-adapter.registry';
import { EmailOAuthProvider, isEmailOAuthProvider } from '../email-oauth.config';
import { EmailOAuthSecrets, needsRefresh, sendViaOAuth } from '../email-oauth.sender';
import { EmailOAuthRefreshService } from '../email-oauth-refresh.service';
import { imapForSmtpHost } from '../smtp-autodiscover';
import { classifySmtpError } from '../outbound/smtp-error';
import { isSingleAddress, normalizeAddress } from '../../../../common/util/email-address';
import { listUnsubscribeHeaders } from '../../../../common/util/list-unsubscribe';
import {
  ChannelAdapter,
  ChannelCapability,
  InboundMessage,
  OutboundSend,
  ResolvedChannelConfig,
  SendResult,
} from '../channel-adapter.interface';

const CAPS: readonly ChannelCapability[] = ['send', 'receive'];
const SEND_TIMEOUT_MS = 15_000;

/**
 * The last resort, and nothing more. Every caller supplies a subject; a reply
 * reads the thread's off the channel config. What used to sit here was
 * `'Re: your message'`, so a Turkish prospect's FIRST contact arrived as an
 * English fake reply that every later message in the thread then kept
 * (`fake-re-subject`). A neutral placeholder is still needed because
 * `sendMail` with an empty subject is refused by some servers outright.
 */
const NO_SUBJECT = '(no subject)';

/** Said to an operator, not to a customer — this lands on the channel card. */
const NO_IMAP_HOST =
  'no incoming (IMAP) server is set for this mailbox — fill in the IMAP host, or point your provider\'s inbound webhook at Jeeta';
const IMAP_REFUSED = 'the mail server refused the IMAP login';

/** SMTP settings live in the sealed `secrets` (host/port/user/from are not
 *  sensitive but are kept together with the password for a single connection). */
interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

/**
 * What this mailbox can actually do, send and receive answered SEPARATELY.
 *
 * `healthCheck` collapses this into one `ok`, and that `ok` is SEND-truth on
 * purpose (see the note there). The probe is the un-collapsed answer, so a
 * health card can say "you can send but no reply will ever come back".
 */
export interface MailboxProbe {
  transport: 'smtp' | 'oauth' | 'none';
  provider?: string;
  host?: string;
  imapHost?: string;
  from?: string;
  send: boolean;
  receive: boolean;
  /** Why `send` is false. */
  reason?: string;
  /** Why `receive` is false, in words that name the fix. */
  receiveReason?: string;
}

/**
 * Two-way Email channel (GoHighLevel parity). OUTBOUND: each workspace sends via
 * its OWN SMTP (sealed creds), so replies come from the workspace's address.
 * INBOUND: the workspace points its email provider's inbound-parse webhook at
 * /api/public/channels/email/webhook; parseInbound normalizes the posted mail.
 * Secrets: { smtpHost, smtpPort, smtpSecure?, smtpUser, smtpPass, fromEmail }.
 * The channel's `externalId` is the inbound address the webhook resolves by.
 * Fully INERT without SMTP creds (send → FAILED).
 */
@Injectable()
export class EmailChannelAdapter implements ChannelAdapter, OnModuleInit {
  readonly type = 'EMAIL' as const;
  readonly capabilities = CAPS;
  private readonly logger = new Logger(EmailChannelAdapter.name);

  constructor(
    private readonly registry: ChannelAdapterRegistry,
    private readonly oauthRefresh: EmailOAuthRefreshService,
  ) {}
  onModuleInit(): void {
    this.registry.register(this);
  }

  /** A consent-connected mailbox, or null when this channel is SMTP. */
  private oauth(
    config: ResolvedChannelConfig,
  ): { provider: EmailOAuthProvider; accessToken: string; from: string } | null {
    const s = (config.secrets ?? {}) as EmailOAuthSecrets;
    if (!isEmailOAuthProvider(s.oauthProvider)) return null;
    const from = (s.fromEmail ?? '').trim();
    // No from address means we do not know which mailbox consented, and Gmail
    // would silently send as the authenticated account instead.
    if (!from || !s.oauthAccessToken) return null;
    return { provider: s.oauthProvider, accessToken: s.oauthAccessToken, from };
  }

  /**
   * A token this send can actually use — refreshed here if the stored one is
   * dead.
   *
   * The refresh cron is the floor, not the ceiling: a mailbox connected a
   * minute after the last tick still has to send, and answering "try again
   * shortly" was a real failure on a real customer's mail. `refreshNow` dedupes
   * per channel, so concurrent sends on one mailbox still cost one exchange,
   * and the retry MUST use what came back rather than the stale sealed value.
   */
  private async usableToken(
    config: ResolvedChannelConfig,
    stored: string,
  ): Promise<{ accessToken: string | null; error?: string }> {
    if (!needsRefresh(config.secrets as EmailOAuthSecrets)) return { accessToken: stored };
    const t = await this.oauthRefresh.refreshNow(config.workspaceId, config.channelId);
    if (t.accessToken) return { accessToken: t.accessToken };
    return {
      accessToken: null,
      // The provider's own words, which is what the operator pastes into a
      // support thread — never a paraphrase about trying again later.
      error: String(t.error ?? 'the connected mailbox token could not be refreshed').slice(0, 300),
    };
  }

  /** The display name for this send: the caller's, else the channel's. */
  private displayName(config: ResolvedChannelConfig, fromName?: string): string {
    return (
      fromName ||
      (typeof config.public?.fromName === 'string' && config.public.fromName) ||
      ''
    ).trim();
  }

  private smtp(config: ResolvedChannelConfig): SmtpConfig | null {
    const s = config.secrets ?? {};
    const host = s.smtpHost?.trim();
    const user = s.smtpUser?.trim();
    const pass = s.smtpPass;
    const from = (s.fromEmail || s.smtpUser || '').trim();
    if (!host || !user || !pass || !from) return null;
    const port = Number(s.smtpPort) || 587;
    return { host, port, secure: s.smtpSecure === 'true' || port === 465, user, pass, from };
  }

  /**
   * One transport shape for both the send and the verify.
   *
   * `forceAuth` is the whole point: nodemailer skips AUTH entirely against a
   * server that does not advertise it, so Verify passed — and stamped
   * `lastVerifiedAt` — against hosts this workspace never authenticated to
   * (`mailbox-any-host-verify`). `smtp()` already refuses to build a config
   * without user+pass, so this only enforces what the stored config claims.
   * Both call sites need it: nothing consults `lastVerifiedAt` before sending.
   */
  private transportFor(smtp: SmtpConfig) {
    return nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: { user: smtp.user, pass: smtp.pass },
      forceAuth: true,
      // Bound every phase so a stalled SMTP server can't wedge the auto-reply batch.
      connectionTimeout: SEND_TIMEOUT_MS,
      greetingTimeout: SEND_TIMEOUT_MS,
      socketTimeout: SEND_TIMEOUT_MS,
      dnsTimeout: SEND_TIMEOUT_MS,
      // `forceAuth` is nodemailer 8; @types/nodemailer 7 has not caught up.
    } as nodemailer.TransportOptions);
  }

  async send({
    config,
    to,
    text,
    subject: subjectArg,
    html,
    fromName,
    replyTo,
    inReplyTo,
    references,
    autoSubmitted,
    messageId,
    listUnsubscribeUrl,
  }: OutboundSend): Promise<SendResult> {
    const recipient = (to || '').trim();
    if (!recipient) {
      return { externalMessageId: null, status: 'FAILED', error: 'recipient email missing', retriable: false };
    }
    // ONE address, and no address that can write a header. A comma list mailed
    // two people under one unsubscribe token; a CR/LF turned the recipient
    // field into a header writer (`single-recipient-check`). Deliberately
    // repeated at each transport rather than trusted from the caller.
    if (!isSingleAddress(recipient)) {
      return {
        externalMessageId: null,
        status: 'FAILED',
        error: 'recipient must be exactly one email address',
        retriable: false,
      };
    }
    // Per-send subject wins over the thread's. A reply carries no subject
    // argument and keeps reading it off the channel config, exactly as before.
    const subject =
      subjectArg?.trim() ||
      (typeof config.public?.subject === 'string' && config.public.subject) ||
      NO_SUBJECT;

    const name = this.displayName(config, fromName);

    /**
     * A mailbox connected by CONSENT rather than by password takes the HTTP
     * path — see email-oauth.config.ts for why Google cannot go over SMTP
     * without moving this product onto a paid annual security assessment.
     *
     * It carries the SAME fields as the SMTP branch below: `email-oauth.sender`
     * builds a real multipart/alternative with an encoded display name and the
     * threading headers, so a consent-connected mailbox is no longer the
     * text-only, bare-From sibling it used to be. `listUnsubscribeUrl` is the
     * one exception and it is unreachable here: Graph accepts `x-`-prefixed
     * custom headers only, which is why `SenderIdentityService` keeps BULK off
     * this transport (RFC 8058 headers are fail-closed on bulk).
     */
    const oauth = this.oauth(config);
    if (oauth) {
      const token = await this.usableToken(config, oauth.accessToken);
      if (!token.accessToken) {
        // Retriable: the credential may come back on its own (a provider blip),
        // and a revoked consent is reported by its own words above.
        return { externalMessageId: null, status: 'FAILED', error: token.error, retriable: true };
      }
      const r = await sendViaOAuth({
        provider: oauth.provider,
        accessToken: token.accessToken,
        from: oauth.from,
        to: recipient,
        subject,
        text,
        ...(name ? { fromName: name } : {}),
        ...(replyTo ? { replyTo } : {}),
        ...(html ? { html } : {}),
        ...(messageId ? { messageId } : {}),
        ...(inReplyTo ? { inReplyTo } : {}),
        ...(references?.length ? { references } : {}),
        ...(autoSubmitted ? { autoSubmitted } : {}),
      });
      if (r.ok) return { externalMessageId: r.externalId, status: 'SENT', retriable: false };
      const error = String(r.error ?? '').slice(0, 300);
      return { externalMessageId: null, status: 'FAILED', error, ...this.classified(error) };
    }

    const smtp = this.smtp(config);
    if (!smtp) {
      return { externalMessageId: null, status: 'FAILED', error: 'SMTP credentials missing', retriable: false };
    }
    try {
      const transport = this.transportFor(smtp);
      // The display name is a SEPARATE field, never folded into the address:
      // `fromEmail` is passed verbatim to Graph (which wants a bare address)
      // and is parsed by the echo-loop guard below. nodemailer's object form
      // also does the RFC 2047 encoding, which a hand-built `"name" <addr>`
      // gets wrong the moment a workspace name contains a quote (`no-display-name`).
      //
      // `text` is always sent alongside `html`: a multipart message is what
      // every client and every spam filter expects, and an HTML-only mail from
      // a brand-new sending identity is a reputation problem on its own.
      // Bulk mail says so, one-to-one mail stays silent — `listUnsubscribeUrl`
      // is only ever set on bulk, and the OAuth branch above is the one
      // transport that cannot carry it (see the note there).
      //
      // Threading and Auto-Submitted are built as ONE object with the
      // unsubscribe pair: two separate `headers` spreads would silently drop
      // whichever came first. `inReplyTo`/`references`/`messageId` stay
      // top-level, where nodemailer owns the bracket spelling.
      const headers = {
        ...listUnsubscribeHeaders(listUnsubscribeUrl),
        ...(autoSubmitted ? { 'Auto-Submitted': autoSubmitted } : {}),
      };
      const info = await transport.sendMail({
        from: name ? { name, address: smtp.from } : smtp.from,
        to: recipient,
        subject,
        text,
        ...(html ? { html } : {}),
        ...(replyTo ? { replyTo } : {}),
        ...(messageId ? { messageId } : {}),
        ...(inReplyTo ? { inReplyTo } : {}),
        ...(references?.length ? { references } : {}),
        ...(Object.keys(headers).length ? { headers } : {}),
      });
      transport.close();
      return { externalMessageId: info?.messageId ?? null, status: 'SENT', retriable: false };
    } catch (e: any) {
      return {
        externalMessageId: null,
        status: 'FAILED',
        error: String(e?.message ?? e).slice(0, 300),
        ...this.classified(e),
      };
    }
  }

  /** Whether the caller should try again, and the codes it can act on. */
  private classified(e: unknown): Pick<SendResult, 'retriable' | 'smtpCode' | 'smtpEnhanced'> {
    const c = classifySmtpError(e);
    return {
      retriable: c.retriable,
      ...(c.code ? { smtpCode: c.code } : {}),
      ...(c.enhanced ? { smtpEnhanced: c.enhanced } : {}),
    };
  }

  parseInbound(config: ResolvedChannelConfig, body: unknown): InboundMessage[] {
    const b = (body ?? {}) as Record<string, any>;
    // Tolerant across providers: Mailgun (sender/stripped-text/body-plain),
    // SendGrid (from/text), Postmark (From/TextBody/MessageID), or a plain
    // {from,text,subject,messageId} shape. Pull the first present value.
    const fromRaw = b.from ?? b.sender ?? b.From ?? b.envelope?.from ?? '';
    const from = this.parseAddress(String(fromRaw));
    const text =
      b['stripped-text'] ?? b.text ?? b.TextBody ?? b['body-plain'] ?? b.plain ?? b.body ?? '';
    const subject = b.subject ?? b.Subject ?? null;
    const messageId = b['message-id'] ?? b.messageId ?? b.MessageID ?? b['Message-Id'] ?? null;
    if (!from.address || typeof text !== 'string' || !text.trim()) return [];

    // Drop our OWN address (auto-reply echo loop guard). The From we send with is
    // `fromEmail || smtpUser` (see send()); the inbound address is `externalId`.
    // Check ALL of them so a workspace that set only smtpUser (no fromEmail) still
    // filters its own echoes instead of letting the AI answer itself.
    const own = new Set(
      [config.secrets?.fromEmail, config.secrets?.smtpUser, config.externalId]
        .map((v) => this.parseAddress(String(v ?? '')).address)
        .filter(Boolean),
    );
    if (own.has(from.address)) return [];

    return [
      {
        externalUserId: from.address,
        kind: 'EMAIL',
        externalMessageId: messageId ? String(messageId) : null,
        text: subject ? `${subject}\n\n${text}`.slice(0, 8000) : String(text).slice(0, 8000),
        displayName: from.name || null,
        raw: b,
      },
    ];
  }

  /**
   * What this mailbox can actually do, answered the way `send()` would answer.
   *
   * It asks about CONSENT first. `EmailOAuthService.handleCallback` clears the
   * SMTP keys on purpose — a password left sealed beside a live token is a
   * credential nobody is watching — so judging a consent-connected mailbox by
   * `smtp()` reported "SMTP credentials missing" about a mailbox that sends
   * perfectly well over HTTP. That was the single thing an operator saw when
   * they pressed Verify on a mailbox they had just connected successfully.
   *
   * `details` reports send and receive SEPARATELY because for this channel they
   * are not the same answer: a consent-connected mailbox is send-only (both
   * IMAP services skip it — they authenticate with smtpUser/smtpPass and there
   * is no XOAUTH2 path anywhere), and an SMTP mailbox receives only if its IMAP
   * login actually works, which `probe()` goes and finds out.
   *
   * `ok` is SEND-truth and must stay that way. `channels.service.verify` stamps
   * `lastVerifiedAt` on it alone, and that column gates four other paths —
   * `WorkspaceMailboxService.resolve`, both IMAP services and
   * `WorkspaceReadinessService`. Folding a failed IMAP login into `ok` would
   * silently reroute every tenant's mail back to the platform address and
   * freeze readiness at ATTENTION: far worse than the bug it would report
   * (`healthcheck-receive-true`).
   */
  async healthCheck(config: ResolvedChannelConfig) {
    const p = await this.probe(config);
    return { ok: p.send, details: { ...p } as Record<string, unknown> };
  }

  /**
   * SMTP login and IMAP login as two separate answers.
   *
   * Public because the health card and the readiness check want the
   * un-collapsed truth, not `healthCheck`'s single `ok`.
   */
  async probe(config: ResolvedChannelConfig): Promise<MailboxProbe> {
    const oauth = this.oauth(config);
    if (oauth) {
      // Same on-demand refresh as send(), for the same reason: pressing Verify
      // on a mailbox that merely needs a new hour-long token must not report it
      // broken and send the operator off to reconnect a working connection.
      const token = await this.usableToken(config, oauth.accessToken);
      if (!token.accessToken) {
        return {
          transport: 'oauth',
          provider: oauth.provider,
          send: false,
          receive: false,
          reason: token.error,
        };
      }
      return {
        transport: 'oauth',
        provider: oauth.provider,
        from: oauth.from,
        send: true,
        receive: false,
        receiveReason:
          'a consent-connected mailbox is send-only here — replies arrive through the inbound webhook, not IMAP',
      };
    }

    const smtp = this.smtp(config);
    if (!smtp) {
      return { transport: 'none', send: false, receive: false, reason: 'SMTP credentials missing' };
    }
    try {
      const transport = this.transportFor(smtp);
      await transport.verify();
      transport.close();
    } catch (e: any) {
      return {
        transport: 'smtp',
        send: false,
        receive: false,
        reason: String(e?.message ?? e).slice(0, 200),
      };
    }
    // Only once sending is proven: an IMAP login attempt against a host whose
    // password was just refused is a second failed login on a server that counts them.
    const inbound = await this.probeImap(config.secrets ?? {});
    return { transport: 'smtp', host: smtp.host, from: smtp.from, send: true, ...inbound };
  }

  /**
   * Can a reply ever come back? Connect, open INBOX read-only, log out.
   *
   * The IMAP host is NEVER guessed from the SMTP host. `imapForSmtpHost` is
   * consumed unconditionally by both pollers, so a blanket "same host" default
   * would start five-minutely logins against hosts nobody proved — including
   * pure relays that have no IMAP at all. The dialog suggests it; this does not.
   */
  private async probeImap(
    s: Record<string, string>,
  ): Promise<{ receive: boolean; receiveReason?: string; imapHost?: string }> {
    const user = s.smtpUser?.trim();
    const pass = s.smtpPass;
    const explicitHost = s.imapHost?.trim();
    const discovered = imapForSmtpHost(s.smtpHost ?? '');
    const host = explicitHost || discovered?.host;
    if (!host || !user || !pass) return { receive: false, receiveReason: NO_IMAP_HOST };
    const port = Number(s.imapPort) || discovered?.port || 993;

    const client = new ImapFlow({
      host,
      port,
      // 993/994 are implicit TLS; everything else negotiates it with STARTTLS.
      // Forcing `secure` on port 143 fails the handshake against servers that
      // are perfectly willing to encrypt.
      secure: port === 993 || port === 994,
      ...(port === 993 || port === 994 ? {} : { doSTARTTLS: true }),
      auth: { user, pass },
      logger: false,
      greetingTimeout: SEND_TIMEOUT_MS,
      socketTimeout: SEND_TIMEOUT_MS,
      connectionTimeout: SEND_TIMEOUT_MS,
    } as any);
    try {
      await client.connect();
      // READ-ONLY: a verify must never change what the human who reads this
      // inbox sees.
      await client.mailboxOpen('INBOX', { readOnly: true });
      return { receive: true, imapHost: host };
    } catch (e: any) {
      return {
        receive: false,
        imapHost: host,
        receiveReason: `${IMAP_REFUSED}: ${String(e?.message ?? e).slice(0, 160)}`,
      };
    } finally {
      // Verify is a synchronous HTTP request; a probe that leaves the socket
      // open holds a connection slot on the customer's mail server.
      await client.logout().catch(() => undefined);
    }
  }

  /**
   * The real sender, and its label, as two values.
   *
   * The old first-`<>` regex read the address out of the DISPLAY NAME, so
   * `"<ceo@victim>" <attacker@evil>` filed the mail under the CEO. The name is
   * carried separately because dropping it makes every IMAP lead "Channel
   * contact", and a multi-mailbox `From` is RFC-legal — the first deliverable
   * address wins rather than the whole header being refused.
   */
  private parseAddress(s: string): { address: string; name: string } {
    for (const entry of addressparser(String(s ?? ''), { flatten: true })) {
      const address = normalizeAddress(entry.address);
      if (address && isSingleAddress(address)) return { address, name: String(entry.name ?? '').trim() };
    }
    return { address: '', name: '' };
  }
}
