import { Controller, Get, Post, Req, Res, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { PublicChannelResolverService } from '../channels/public-channel-resolver.service';
import { ChannelAdapterRegistry } from '../channels/channel-adapter.registry';
import { ConversationIngressService } from '../channels/conversation-ingress.service';

/**
 * Inbound Email webhook. A workspace points its email provider's inbound-parse
 * webhook (Mailgun / SendGrid / Postmark / …) at this path. POST verifies an
 * HMAC-SHA256 over the RAW body against the platform-global EMAIL_INBOUND_SECRET
 * (a raw parser is mounted on this exact path in app.config.ts), ACKs fast, then
 * resolves the channel by the recipient address and funnels each message through
 * the same ConversationIngress → AI pipeline as every other channel. Inert
 * without EMAIL_INBOUND_SECRET (401) — nothing runs until an operator sets it.
 */
@Controller('public/channels/email')
export class EmailWebhookController {
  private readonly logger = new Logger(EmailWebhookController.name);

  constructor(
    private readonly resolver: PublicChannelResolverService,
    private readonly registry: ChannelAdapterRegistry,
    private readonly ingress: ConversationIngressService,
  ) {}

  @Get('webhook')
  health(@Res() res: Response): void {
    res.status(200).send('ok');
  }

  @Post('webhook')
  receive(@Req() req: Request, @Res() res: Response): void {
    const raw: Buffer = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(JSON.stringify(req.body ?? {}));
    if (!this.validSignature(raw, req.headers['x-email-signature'])) {
      res.status(401).send('bad signature');
      return;
    }
    res.status(200).send('EVENT_RECEIVED'); // ACK fast, then work
    const body = this.parseBody(raw, req.headers['content-type']);
    if (!body) return;
    this.process(body).catch((e) =>
      this.logger.error(`email webhook processing failed: ${e?.message ?? e}`),
    );
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

  private async process(body: any): Promise<void> {
    if (!this.registry.has('EMAIL')) return;
    const adapter = this.registry.get('EMAIL');
    // The recipient address the mail was sent TO — the channel's externalId.
    const toRaw = body?.recipient ?? body?.to ?? body?.To ?? body?.envelope?.to ?? '';
    const externalId = this.extractEmail(String(Array.isArray(toRaw) ? toRaw[0] : toRaw));
    if (!externalId) return;
    const channel = await this.resolver.byExternalId('EMAIL', externalId);
    if (!channel) {
      this.logger.warn(`email inbound for unregistered address=${externalId} — skipping`);
      return;
    }
    const config = this.registry.resolveConfig(channel);
    const inbounds = adapter.parseInbound ? adapter.parseInbound(config, body) : [];
    for (const msg of inbounds) {
      await this.ingress.ingest(
        { id: channel.id, workspaceId: channel.workspaceId, type: channel.type },
        msg,
      );
    }
  }

  private extractEmail(s: string): string {
    const m = /<([^>]+)>/.exec(s);
    const addr = (m ? m[1] : s).trim().toLowerCase();
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr) ? addr : '';
  }
}
