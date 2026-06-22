import { Controller, Post, Param, Body, Headers, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { InboundWebhookGuard } from '../guards/inbound-webhook.guard';
import { InboundWebhooksService } from '../inbound-webhooks/inbound-webhooks.service';

/**
 * Public inbound-webhook receiver (GoHighLevel parity). No marketing session —
 * the InboundWebhookGuard authenticates the `:slug` + secret and pins the
 * webhook context onto the request. An accepted POST emits the
 * `marketing.webhook.received.v1` workflow trigger; the JSON body is carried to
 * filters under `trigger.body.*`.
 *
 * Per-IP throttled to 60/min (keyed `default`, the global throttler's name) —
 * well under the 300/min global default but with headroom for a legitimate
 * Zapier/Make burst. The global ThrottlerGuard runs before this guard, so the
 * cap also bounds unauthenticated probes (a wrong secret still 401s here).
 */
@Controller('public/hooks')
@Throttle({ default: { limit: 60, ttl: 60_000 } })
@UseGuards(InboundWebhookGuard)
export class PublicInboundWebhookController {
  constructor(private readonly webhooks: InboundWebhooksService) {}

  @Post(':slug')
  receive(
    @Param('slug') _slug: string,
    @Body() body: Record<string, unknown>,
    @Headers('x-idempotency-key') idemHeader: string | undefined,
    @Headers('x-delivery-id') deliveryId: string | undefined,
    @Req() req: Request,
  ) {
    const webhook = (req as any).inboundWebhook as { id: string; workspaceId: string; slug: string };
    return this.webhooks.receive(webhook, body, { idempotencyKey: idemHeader || deliveryId });
  }
}
