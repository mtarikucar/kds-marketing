import { Controller, Get, Post, Query, Req, Res, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { PublicChannelResolverService } from '../channels/public-channel-resolver.service';
import { ChannelAdapterRegistry } from '../channels/channel-adapter.registry';
import { ConversationIngressService } from '../channels/conversation-ingress.service';
import { MessageReceiptService } from '../channels/message-receipt.service';

/** body.object → our ChannelType. */
const TYPE_BY_OBJECT: Record<string, string> = {
  whatsapp_business_account: 'WHATSAPP',
  instagram: 'INSTAGRAM',
  page: 'MESSENGER',
};

/**
 * Meta webhook for WhatsApp Cloud + Instagram + Messenger (one app, one
 * callback URL). GET answers the subscription challenge; POST verifies the
 * X-Hub-Signature-256 HMAC over the RAW body (a raw parser is mounted on this
 * exact path in main.ts — re-serialized JSON never verifies), ACKs fast, then
 * resolves the channel by its provider page/phone id and funnels each message
 * through ConversationIngress. Unknown / unsigned payloads are rejected.
 */
@Controller('public/channels/meta')
export class MetaWebhookController {
  private readonly logger = new Logger(MetaWebhookController.name);

  constructor(
    private readonly resolver: PublicChannelResolverService,
    private readonly registry: ChannelAdapterRegistry,
    private readonly ingress: ConversationIngressService,
    private readonly receipts: MessageReceiptService,
  ) {}

  @Get('webhook')
  verify(@Query() q: Record<string, string>, @Res() res: Response): void {
    const expected = process.env.META_WEBHOOK_VERIFY_TOKEN;
    if (q['hub.mode'] === 'subscribe' && expected && q['hub.verify_token'] === expected) {
      res.status(200).send(q['hub.challenge']);
    } else {
      res.status(403).send('forbidden');
    }
  }

  @Post('webhook')
  receive(@Req() req: Request, @Res() res: Response): void {
    const raw: Buffer = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(JSON.stringify(req.body ?? {}));
    if (!this.validSignature(raw, req.headers['x-hub-signature-256'])) {
      res.status(401).send('bad signature');
      return;
    }
    // Fast 200 — Meta retries aggressively on slow handlers, so ACK then work.
    res.status(200).send('EVENT_RECEIVED');
    let body: any;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    this.process(body).catch((e) =>
      this.logger.error(`meta webhook processing failed: ${e?.message ?? e}`),
    );
  }

  private validSignature(raw: Buffer, sig: unknown): boolean {
    const appSecret = process.env.META_APP_SECRET;
    if (!appSecret || typeof sig !== 'string') return false;
    const expected = 'sha256=' + createHmac('sha256', appSecret).update(raw).digest('hex');
    try {
      const a = Buffer.from(sig);
      const b = Buffer.from(expected);
      return a.length === b.length && timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  private async process(body: any): Promise<void> {
    const type = TYPE_BY_OBJECT[body?.object];
    if (!type || !this.registry.has(type)) return;
    const adapter = this.registry.get(type);
    for (const entry of body?.entry ?? []) {
      const externalId = this.externalIdFor(type, entry);
      if (!externalId) continue;
      const channel = await this.resolver.byExternalId(type, externalId);
      if (!channel) {
        this.logger.warn(`meta inbound for unregistered ${type} id=${externalId} — skipping`);
        continue;
      }
      const config = this.registry.resolveConfig(channel);
      const inbounds = adapter.parseInbound
        ? adapter.parseInbound(config, { object: body.object, entry: [entry] })
        : [];
      for (const msg of inbounds) {
        await this.ingress.ingest(
          { id: channel.id, workspaceId: channel.workspaceId, type: channel.type },
          msg,
        );
      }
      // Delivery/read receipts ride the same signed webhook — advance the
      // matching OUTBOUND Message's status (no conversation side-effects).
      if (adapter.parseStatusUpdates) {
        const updates = adapter.parseStatusUpdates(config, { object: body.object, entry: [entry] });
        if (updates.length) await this.receipts.apply(channel.workspaceId, updates);
      }
    }
  }

  private externalIdFor(type: string, entry: any): string | null {
    if (type === 'WHATSAPP') {
      for (const ch of entry?.changes ?? []) {
        const id = ch?.value?.metadata?.phone_number_id;
        if (id) return String(id);
      }
      return null;
    }
    // Messenger / Instagram: the page id is the entry id.
    return entry?.id ? String(entry.id) : null;
  }
}
