import { Controller, Get, Post, Query, Req, Res, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { PublicChannelResolverService } from '../channels/public-channel-resolver.service';
import { ChannelAdapterRegistry } from '../channels/channel-adapter.registry';
import { ConversationIngressService } from '../channels/conversation-ingress.service';
import { MessageReceiptService } from '../channels/message-receipt.service';
import { MetaLeadgenIngestService } from '../channels/meta-leadgen-ingest.service';

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
    private readonly leadgen: MetaLeadgenIngestService,
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
      if (type === 'WHATSAPP') {
        // One WABA entry (entry.id = WABA id) batches changes[] that can span
        // DIFFERENT phone numbers — each change carries its own
        // value.metadata.phone_number_id, and each number is an independent
        // Channel row, possibly in a DIFFERENT workspace. Resolving the
        // channel once per entry routed EVERY message/receipt in the entry to
        // whichever number appeared first: inbound messages ingested into the
        // wrong tenant (KVKK) and receipts silently no-oping under the wrong
        // workspaceId (messages stuck at SENT). Resolve per change.
        for (const change of entry?.changes ?? []) {
          const phoneId = change?.value?.metadata?.phone_number_id;
          if (!phoneId) continue;
          const channel = await this.resolver.byExternalId(type, String(phoneId));
          if (!channel) {
            this.logger.warn(`meta inbound for unregistered ${type} id=${phoneId} — skipping`);
            continue;
          }
          await this.handleEntry(adapter, channel, body.object, { ...entry, changes: [change] });
        }
        continue;
      }
      // Messenger / Instagram: the page id is the entry id (one page per entry).
      const externalId = entry?.id ? String(entry.id) : null;
      if (!externalId) continue;
      const channel = await this.resolver.byExternalId(type, externalId);
      if (!channel) {
        this.logger.warn(`meta inbound for unregistered ${type} id=${externalId} — skipping`);
        continue;
      }
      await this.handleEntry(adapter, channel, body.object, entry);
    }
  }

  /** Parse + route ONE entry (already scoped to a single resolved channel). */
  private async handleEntry(
    adapter: ReturnType<ChannelAdapterRegistry['get']>,
    channel: { id: string; workspaceId: string; type: string; externalId: string | null },
    object: string,
    entry: any,
  ): Promise<void> {
    const config = this.registry.resolveConfig(channel as any);
    const inbounds = adapter.parseInbound
      ? adapter.parseInbound(config, { object, entry: [entry] })
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
      const updates = adapter.parseStatusUpdates(config, { object, entry: [entry] });
      if (updates.length) await this.receipts.apply(channel.workspaceId, updates);
    }
    // Meta Lead Ads (Instant Form) submissions arrive on the SAME page webhook
    // as Messenger, but under entry[].changes[] with field==='leadgen' (not
    // entry[].messaging[]). Fetch + create the lead with the page token we
    // already resolved. Best-effort per change: one bad form never rejects the
    // shared (already-200-ACKed) process() promise.
    for (const ch of entry?.changes ?? []) {
      if (ch?.field === 'leadgen' && ch?.value?.leadgen_id) {
        await this.leadgen
          .ingest(
            { id: channel.id, workspaceId: channel.workspaceId, externalId: channel.externalId },
            config,
            ch.value,
          )
          .catch((e) => this.logger.error(`leadgen ingest failed: ${e?.message ?? e}`));
      }
    }
  }
}
