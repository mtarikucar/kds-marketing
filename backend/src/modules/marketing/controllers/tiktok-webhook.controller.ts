import { Controller, Get, Post, Query, Req, Res, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { PublicChannelResolverService } from '../channels/public-channel-resolver.service';
import { ChannelAdapterRegistry } from '../channels/channel-adapter.registry';
import { ConversationIngressService } from '../channels/conversation-ingress.service';

/**
 * TikTok DM (Business Messaging) inbound webhook. Mirrors the Meta webhook: GET
 * answers an optional subscription challenge; POST verifies an HMAC-SHA256 over
 * the RAW body (a raw parser is mounted on this exact path in app.config.ts —
 * re-serialized JSON never verifies), ACKs fast, then resolves the channel by
 * the connected business/creator id and funnels each message through the same
 * ConversationIngress → AI pipeline. Inert without TIKTOK_WEBHOOK_SECRET (401).
 */
@Controller('public/channels/tiktok')
export class TiktokWebhookController {
  private readonly logger = new Logger(TiktokWebhookController.name);

  constructor(
    private readonly resolver: PublicChannelResolverService,
    private readonly registry: ChannelAdapterRegistry,
    private readonly ingress: ConversationIngressService,
  ) {}

  @Get('webhook')
  verify(@Query() q: Record<string, string>, @Res() res: Response): void {
    // TikTok (where used) echoes a challenge param on subscription.
    const expected = process.env.TIKTOK_WEBHOOK_VERIFY_TOKEN;
    if (expected && q['verify_token'] === expected && q['challenge']) {
      res.status(200).send(q['challenge']);
    } else {
      res.status(403).send('forbidden');
    }
  }

  @Post('webhook')
  receive(@Req() req: Request, @Res() res: Response): void {
    const raw: Buffer = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(JSON.stringify(req.body ?? {}));
    if (!this.validSignature(raw, req.headers['tiktok-signature'] ?? req.headers['x-tiktok-signature'])) {
      res.status(401).send('bad signature');
      return;
    }
    res.status(200).send('EVENT_RECEIVED'); // ACK fast, then work
    let body: any;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    this.process(body).catch((e) =>
      this.logger.error(`tiktok webhook processing failed: ${e?.message ?? e}`),
    );
  }

  private validSignature(raw: Buffer, sig: unknown): boolean {
    const secret = process.env.TIKTOK_WEBHOOK_SECRET;
    if (!secret || typeof sig !== 'string') return false;
    // TikTok signs as a hex HMAC-SHA256 of the raw body (optionally "t=…,s=…");
    // accept the bare hex digest, compared timing-safe.
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
    if (!this.registry.has('TIKTOK')) return;
    const adapter = this.registry.get('TIKTOK');
    // The connected business/creator id the event targets — the channel's externalId.
    const externalId =
      body?.business_id ?? body?.data?.business_id ?? body?.to_user_id ?? body?.data?.to_user_id;
    if (!externalId) return;
    const channel = await this.resolver.byExternalId('TIKTOK', String(externalId));
    if (!channel) {
      this.logger.warn(`tiktok inbound for unregistered business id=${externalId} — skipping`);
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
}
