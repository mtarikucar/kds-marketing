import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import {
  InboundWebhooksService,
  hashWebhookSecret,
} from '../inbound-webhooks/inbound-webhooks.service';

/**
 * Authenticates a public inbound-webhook POST. The `:slug` (globally unique)
 * names the endpoint; the `x-webhook-secret` header authenticates by a
 * timing-safe sha256 match (mirrors IngestTokenGuard's posture: only the hash
 * is stored, the raw secret is shown once at mint time).
 *
 * The secret is taken ONLY from a header, never a query param — a `?secret=`
 * would leak the long-lived secret into access logs / proxy logs / Referer.
 *
 * Resolution returns null for both "unknown slug" and "disabled" so the 401 is
 * uniform — no enabled/exists oracle. On success the webhook context is pinned
 * to the request for the controller.
 */
@Injectable()
export class InboundWebhookGuard implements CanActivate {
  constructor(private readonly webhooks: InboundWebhooksService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const slug = req.params?.slug;
    const header = req.headers['x-webhook-secret'];
    const presented = typeof header === 'string' ? header : '';
    if (!slug || !presented) throw new UnauthorizedException('Missing webhook secret');

    const webhook = await this.webhooks.resolveActive(slug);
    if (!webhook) throw new UnauthorizedException('Invalid webhook');

    const a = Buffer.from(hashWebhookSecret(presented), 'hex');
    const b = Buffer.from(webhook.secretHash, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Invalid webhook');
    }

    req.inboundWebhook = { id: webhook.id, workspaceId: webhook.workspaceId, slug: webhook.slug };
    return true;
  }
}
