import { Body, Controller, Post, Query, UnauthorizedException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { timingSafeEqual } from 'crypto';
import { MediaGenService } from '../ai/media/media-gen.service';
import { MediaGenResult } from '../ai/providers/media-provider.interface';
import { mapFalOutputs } from '../ai/providers/fal.provider';

interface FalWebhookBody { request_id?: string; status?: string; payload?: any; error?: string; }

/** Constant-time secret comparison (avoids leaking the token via timing). */
function tokenMatches(provided: string | undefined, secret: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Public fal completion callback. Token-guarded via FAL_WEBHOOK_SECRET; the
 *  body is mapped to a MediaGenResult and finalized idempotently by request_id. */
@Controller('marketing/ai/media')
@Throttle({ default: { limit: 120, ttl: 60_000 } })
export class MarketingMediaWebhookController {
  constructor(private readonly gen: MediaGenService) {}

  @Post('webhook')
  async receive(@Query('token') token: string, @Body() body: FalWebhookBody): Promise<{ ok: true }> {
    const secret = process.env.FAL_WEBHOOK_SECRET;
    if (!secret || !tokenMatches(token, secret)) throw new UnauthorizedException();
    if (body.request_id) {
      const mapped = this.mapBody(body);
      // A "success" webhook we couldn't parse into any output is IGNORED rather
      // than terminalized: finalizeAsset would mark it FAILED+refund and the poll
      // (which reads the canonical /requests/{id} result) could never recover a
      // genuinely-successful generation. Error/blocked results still finalize.
      if (mapped.status === 'COMPLETED' && !(mapped.outputs && mapped.outputs.length)) {
        return { ok: true };
      }
      await this.gen.finalizeByRequestId(body.request_id, mapped);
    }
    return { ok: true };
  }

  private mapBody(body: FalWebhookBody): MediaGenResult {
    if (body.status && body.status !== 'OK' && body.status !== 'COMPLETED') {
      const msg = body.error ?? 'fal webhook error';
      return { status: /nsfw|moderat|content polic|safety/i.test(msg) ? 'BLOCKED' : 'FAILED', error: msg };
    }
    // Shared with the poll path: fal has no single result envelope (images[] vs a
    // singular image vs video vs audio), and the two paths finalizing the SAME
    // asset must not disagree about what the payload contained.
    return { status: 'COMPLETED', outputs: mapFalOutputs(body.payload) };
  }
}
