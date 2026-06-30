import { Body, Controller, Post, Query, UnauthorizedException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { MediaGenService } from '../ai/media/media-gen.service';
import { MediaGenResult } from '../ai/providers/media-provider.interface';

interface FalWebhookBody { request_id?: string; status?: string; payload?: any; error?: string; }

/** Public fal completion callback. Token-guarded via FAL_WEBHOOK_SECRET; the
 *  body is mapped to a MediaGenResult and finalized idempotently by request_id. */
@Controller('marketing/ai/media')
@Throttle({ default: { limit: 120, ttl: 60_000 } })
export class MarketingMediaWebhookController {
  constructor(private readonly gen: MediaGenService) {}

  @Post('webhook')
  async receive(@Query('token') token: string, @Body() body: FalWebhookBody): Promise<{ ok: true }> {
    const secret = process.env.FAL_WEBHOOK_SECRET;
    if (!secret || token !== secret) throw new UnauthorizedException();
    if (body.request_id) {
      await this.gen.finalizeByRequestId(body.request_id, this.mapBody(body));
    }
    return { ok: true };
  }

  private mapBody(body: FalWebhookBody): MediaGenResult {
    if (body.status && body.status !== 'OK' && body.status !== 'COMPLETED') {
      const msg = body.error ?? 'fal webhook error';
      return { status: /nsfw|moderat|content polic|safety/i.test(msg) ? 'BLOCKED' : 'FAILED', error: msg };
    }
    const out: NonNullable<MediaGenResult['outputs']> = [];
    for (const img of body.payload?.images ?? []) out.push({ url: img.url, mime: img.content_type ?? 'image/png', width: img.width, height: img.height });
    const vids = body.payload?.video ? [body.payload.video] : (body.payload?.videos ?? []);
    for (const v of vids) out.push({ url: v.url, mime: v.content_type ?? 'video/mp4', durationSec: v.duration });
    return { status: 'COMPLETED', outputs: out };
  }
}
