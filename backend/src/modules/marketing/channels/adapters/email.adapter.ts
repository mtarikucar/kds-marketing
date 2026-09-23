import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { ChannelAdapterRegistry } from '../channel-adapter.registry';
import { EmailOAuthProvider, isEmailOAuthProvider } from '../email-oauth.config';
import { EmailOAuthSecrets, needsRefresh, sendViaOAuth } from '../email-oauth.sender';
import { EmailOAuthRefreshService } from '../email-oauth-refresh.service';
import { imapConnectOptions, imapTarget } from '../imap-target';
import { classifySmtpError } from '../outbound/smtp-error';
import { isSingleAddress } from '../../../../common/util/email-address';
import { resolveSenderIdentity } from '../inbound/inbound-policy';
import { stripQuotedReply } from '../email-reply-text';
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

/**
 * Why a mailbox cannot receive, as a MACHINE CODE.
 *
 * `channels.verifySendOnly` interpolates this into an otherwise Turkish
 * sentence, so an English sentence here reached the tenant verbatim (PLAN G8 —
 * a server reason code is never printed raw). The codes match the convention
 * `email-oauth.config.ts` already uses for its own `receiveReason`, and the
 * frontend maps each to `channels.health.reason.<CODE>`.
 *
 * The prose still travels, as `receiveDetail`: it is what an operator reading a
 * log or a health blob needs, and it names the fix the code cannot spell out.
 */
const NO_IMAP_HOST = 'NO_IMAP_HOST';
const NO_IMAP_HOST_DETAIL =
  'no incoming (IMAP) server is set for this mailbox — fill in the IMAP host, or point your provider\'s inbound webhook at Jeeta';
const OAUTH_NO_IMAP_PASSWORD = 'OAUTH_NO_IMAP_PASSWORD';
const OAUTH_NO_IMAP_PASSWORD_DETAIL =
  'this mailbox is connected by consent and holds no incoming (IMAP) password — replies arrive through the inbound URL, not IMAP';
const IMAP_REFUSED = 'IMAP_REFUSED';
const IMAP_REFUSED_DETAIL = 'the mail server refused the IMAP login';

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
  /** Why `receive` is false, as a code the UI translates. */
  receiveReason?: string;
  /** The same thing in words, for an operator reading a log. Never rendered to
   *  a tenant on its own — that is what `receiveReason` is for. */
  receiveDetail?: string;
}

/**
 * Two-way Email channel (GoHighLevel parity). OUTBOUND: each workspace sends via
 * its OWN SMTP (sealed creds), so replies come from the workspace's address.
 *
 * INBOUND arrives three ways, all of which end here in `parseInbound`:
 * `EmailImapPollService` reading the mailbox directly (the path that needs no
 * ESP and no DNS change, and the one most tenants use); a relay POSTing the
 * per-channel tokenized URL `/api/public/channels/email/:channelId/:token/
 * inbound`, where the URL names the tenant; and the legacy platform-HMAC
 * `/api/public/channels/email/webhook`, kept for what already points at it and
 * routed by an envelope-preferred recipient list rather than a To header.
 *
 * Secrets: { smtpHost, smtpPort, smtpSecure?, smtpUser, smtpPass, fromEmail },
 * plus optional { imapHost, imapPort, imapUser, imapPass } for a mailbox whose
 * incoming server differs from its outgoing one. Fully INERT without send
 * credentials (send → FAILED).
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
    ics,
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
        ...(ics ? { ics } : {}),
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
        // nodemailer's `icalEvent.method` is what sets the MIME `method=`
        // parameter. It is threaded from the caller and never defaulted to
        // REQUEST: a CANCEL body announced as a REQUEST puts the cancelled
        // appointment back on the customer's calendar.
        ...(ics
          ? {
              icalEvent: {
                method: ics.method,
                filename: ics.filename ?? 'invite.ics',
                content: ics.content,
              },
            }
          : {}),
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

  /**
   * A posted mail as this product's one inbound message shape.
   *
   * Three things happen here and nowhere else, which is why both doors — the
   * IMAP poller and the inbound webhook — come through this method:
   *
   * 1. **Identity.** A contact-form relay mails as `wordpress@site.com` and
   *    puts the enquirer in `Reply-To`. `resolveSenderIdentity` sees through
   *    that on a CROSS-DOMAIN Reply-To only (a vendor's
   *    `noreply@vendor → sales@vendor` stays what it is), and it runs BEFORE
   *    the own-address check so a form that mails from the mailbox itself is
   *    rescued — then the check re-runs on the RESOLVED address, so a form
   *    pointing Reply-To back at us cannot open a self-reply loop.
   * 2. **Authentication.** The transport's verdict becomes `senderVerified`.
   *    Only an explicit `fail` sets `false`; no header means no opinion.
   * 3. **Quoting.** A caller that already stripped says so. A raw provider
   *    body (the legacy route's shape) is stripped here, because otherwise the
   *    quoted thread is what the AI reads and answers.
   */
  parseInbound(config: ResolvedChannelConfig, body: unknown): InboundMessage[] {
    const b = (body ?? {}) as Record<string, any>;
    // Tolerant across providers: Mailgun (sender/stripped-text/body-plain),
    // SendGrid (from/text), Postmark (From/TextBody/MessageID), or a plain
    // {from,text,subject,messageId} shape. Pull the first present value.
    const fromRaw = b.from ?? b.sender ?? b.From ?? b.envelope?.from ?? '';
    const replyToRaw = b['reply-to'] ?? b.replyTo ?? b.ReplyTo ?? b['Reply-To'] ?? null;
    const subject = b.subject ?? b.Subject ?? null;
    const messageId = b['message-id'] ?? b.messageId ?? b.MessageID ?? b['Message-Id'] ?? null;

    const picked = this.inboundText(b);
    if (typeof picked.text !== 'string' || !picked.text.trim()) return [];

    // `fromEmail || smtpUser` is what send() puts in the From; `externalId` is
    // the address the webhook is registered under. All three, so a workspace
    // that set only smtpUser still filters its own echoes instead of letting
    // the AI answer itself.
    const identity = resolveSenderIdentity({
      from: String(fromRaw),
      replyTo: replyToRaw == null ? null : String(replyToRaw),
      ownAddresses: [config.secrets?.fromEmail, config.secrets?.smtpUser, config.externalId],
    });
    if (!identity.address || identity.own) return [];

    const text = picked.stripped ? picked.text : stripQuotedReply(picked.text);
    if (!text.trim()) return [];

    // Three states. `undefined` is "the transport had no opinion", which is
    // every channel but this one and most mail on this one — it must stay
    // undefined rather than collapsing to a boolean, or unverifiable mail
    // would start reading as forged.
    const verdict = this.authVerdictOf(b);

    return [
      {
        externalUserId: identity.address,
        kind: 'EMAIL',
        externalMessageId: messageId ? String(messageId) : null,
        text: subject ? `${subject}\n\n${text}`.slice(0, 8000) : text.slice(0, 8000),
        // The name of the RESOLVED identity. The relay's would name every form
        // lead after the website, permanently — the AI's capture path fills
        // only EMPTY fields, so the wrong name never gets corrected.
        displayName: identity.name || null,
        ...(verdict === undefined ? {} : { senderVerified: verdict }),
        raw: b,
      },
    ];
  }

  /**
   * The body a human typed, and whether somebody already removed the quote.
   *
   * Mailgun's `stripped-text` and our own two callers hand over text that has
   * been through `stripQuotedReply` already; running it a second time is not
   * free, because a short reply whose remaining text happens to look like an
   * attribution line would be stripped down to nothing. So provenance is
   * tracked rather than guessed.
   */
  private inboundText(b: Record<string, any>): { text: unknown; stripped: boolean } {
    if (typeof b['stripped-text'] === 'string' && b['stripped-text'].trim()) {
      return { text: b['stripped-text'], stripped: true };
    }
    // Set by the IMAP poller and the inbound webhook, both of which strip (and
    // pre-truncate HTML) before they get here.
    if (b.textIsStripped === true) {
      return { text: b.text ?? b.TextBody ?? b['body-plain'] ?? b.plain ?? b.body ?? '', stripped: true };
    }
    return {
      text: b.text ?? b.TextBody ?? b['body-plain'] ?? b.plain ?? b.body ?? '',
      stripped: false,
    };
  }

  /** `true`/`false` when the transport had an opinion, `undefined` when not. */
  private authVerdictOf(b: Record<string, any>): boolean | undefined {
    const raw = b.authVerdict ?? b.auth?.verdict;
    if (raw === 'fail') return false;
    if (raw === 'pass') return true;
    return undefined;
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
      // A consent mailbox is not automatically send-only any more: if a receive
      // credential is sealed beside the token, the pollers WILL use it
      // (`imapTarget`), so saying "send-only" here would be a card that
      // contradicts the mail arriving in the inbox. Probe and report what is
      // actually true. `ok` stays SEND-truth either way — see healthCheck.
      const inbound = await this.probeImap(config.secrets ?? {});
      return {
        transport: 'oauth',
        provider: oauth.provider,
        from: oauth.from,
        send: true,
        ...inbound,
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
  ): Promise<{
    receive: boolean;
    receiveReason?: string;
    receiveDetail?: string;
    imapHost?: string;
  }> {
    // The SAME resolver both pollers use. This was a third copy of the host,
    // port and TLS derivation; behaviour was identical, which is exactly how a
    // third copy survives long enough to drift.
    const resolved = imapTarget(s);
    if (resolved.kind !== 'ok') {
      const oauth = resolved.reason === 'oauth';
      return {
        receive: false,
        receiveReason: oauth ? OAUTH_NO_IMAP_PASSWORD : NO_IMAP_HOST,
        receiveDetail: oauth ? OAUTH_NO_IMAP_PASSWORD_DETAIL : NO_IMAP_HOST_DETAIL,
      };
    }
    const { host } = resolved.target;
    const client = new ImapFlow(
      imapConnectOptions(resolved.target, {
        timeoutMs: SEND_TIMEOUT_MS,
        socketTimeoutMs: SEND_TIMEOUT_MS,
      }) as any,
    );
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
        receiveReason: IMAP_REFUSED,
        receiveDetail: `${IMAP_REFUSED_DETAIL}: ${String(e?.message ?? e).slice(0, 160)}`,
      };
    } finally {
      // Verify is a synchronous HTTP request; a probe that leaves the socket
      // open holds a connection slot on the customer's mail server.
      await client.logout().catch(() => undefined);
    }
  }

}
