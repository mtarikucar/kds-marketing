import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { ChannelAdapterRegistry } from '../channel-adapter.registry';
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

  constructor(private readonly registry: ChannelAdapterRegistry) {}
  onModuleInit(): void {
    this.registry.register(this);
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

  async send({ config, to, text }: OutboundSend): Promise<SendResult> {
    const smtp = this.smtp(config);
    if (!smtp) {
      return { externalMessageId: null, status: 'FAILED', error: 'SMTP credentials missing' };
    }
    const recipient = (to || '').trim();
    if (!recipient) {
      return { externalMessageId: null, status: 'FAILED', error: 'recipient email missing' };
    }
    const subject =
      (typeof config.public?.subject === 'string' && config.public.subject) || 'Re: your message';
    try {
      const transport = nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        auth: { user: smtp.user, pass: smtp.pass },
        // Bound every phase so a stalled SMTP server can't wedge the auto-reply batch.
        connectionTimeout: SEND_TIMEOUT_MS,
        greetingTimeout: SEND_TIMEOUT_MS,
        socketTimeout: SEND_TIMEOUT_MS,
        dnsTimeout: SEND_TIMEOUT_MS,
      });
      const info = await transport.sendMail({ from: smtp.from, to: recipient, subject, text });
      transport.close();
      return { externalMessageId: info?.messageId ?? null, status: 'SENT' };
    } catch (e: any) {
      return { externalMessageId: null, status: 'FAILED', error: String(e?.message ?? e).slice(0, 300) };
    }
  }

  parseInbound(config: ResolvedChannelConfig, body: unknown): InboundMessage[] {
    const b = (body ?? {}) as Record<string, any>;
    // Tolerant across providers: Mailgun (sender/stripped-text/body-plain),
    // SendGrid (from/text), Postmark (From/TextBody/MessageID), or a plain
    // {from,text,subject,messageId} shape. Pull the first present value.
    const fromRaw = b.from ?? b.sender ?? b.From ?? b.envelope?.from ?? '';
    const sender = this.extractEmail(String(fromRaw));
    const text =
      b['stripped-text'] ?? b.text ?? b.TextBody ?? b['body-plain'] ?? b.plain ?? b.body ?? '';
    const subject = b.subject ?? b.Subject ?? null;
    const messageId = b['message-id'] ?? b.messageId ?? b.MessageID ?? b['Message-Id'] ?? null;
    if (!sender || typeof text !== 'string' || !text.trim()) return [];

    // Drop our OWN address (auto-reply echo loop guard). The From we send with is
    // `fromEmail || smtpUser` (see send()); the inbound address is `externalId`.
    // Check ALL of them so a workspace that set only smtpUser (no fromEmail) still
    // filters its own echoes instead of letting the AI answer itself.
    const own = new Set(
      [config.secrets?.fromEmail, config.secrets?.smtpUser, config.externalId]
        .map((v) => this.extractEmail(String(v ?? '')))
        .filter(Boolean),
    );
    if (own.has(sender)) return [];

    return [
      {
        externalUserId: sender,
        kind: 'EMAIL',
        externalMessageId: messageId ? String(messageId) : null,
        text: subject ? `${subject}\n\n${text}`.slice(0, 8000) : String(text).slice(0, 8000),
        displayName: this.extractName(String(fromRaw)) || null,
        raw: b,
      },
    ];
  }

  async healthCheck(config: ResolvedChannelConfig) {
    const smtp = this.smtp(config);
    if (!smtp) return { ok: false, details: { reason: 'SMTP credentials missing' } };
    try {
      const transport = nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        auth: { user: smtp.user, pass: smtp.pass },
        connectionTimeout: SEND_TIMEOUT_MS,
        greetingTimeout: SEND_TIMEOUT_MS,
        socketTimeout: SEND_TIMEOUT_MS,
        dnsTimeout: SEND_TIMEOUT_MS,
      });
      await transport.verify();
      transport.close();
      return { ok: true, details: { host: smtp.host, from: smtp.from } };
    } catch (e: any) {
      return { ok: false, details: { reason: String(e?.message ?? e).slice(0, 200) } };
    }
  }

  /** Pull the bare address out of "Name <a@b.com>" / "a@b.com", lower-cased. */
  private extractEmail(s: string): string {
    const m = /<([^>]+)>/.exec(s);
    const addr = (m ? m[1] : s).trim().toLowerCase();
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr) ? addr : '';
  }
  private extractName(s: string): string {
    const m = /^\s*"?([^"<]+?)"?\s*</.exec(s);
    return m ? m[1].trim() : '';
  }
}
