import { Body, Controller, ForbiddenException, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { timingSafeEqual } from 'crypto';
import { isNetgsmIvrConfigured } from './voice-ai.config';
import { NetgsmIvrService, NetgsmIvrInput, NetgsmIvrReply } from './netgsm-ivr.service';

/** Constant-time token compare with a length guard (timingSafeEqual throws on length mismatch). */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(String(provided ?? ''));
  const b = Buffer.from(String(expected ?? ''));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Public NetGSM "Özel API (Custom)" inbound IVR webhook. During a live inbound
 * call NetGSM calls this URL (GET query OR POST form/JSON) with the call params;
 * we reply with `{status,result,data}` where `data` is read aloud by NetGSM's
 * built-in TTS robot. Inert (404) until NETGSM_IVR_TOKEN is set; the unguessable
 * `:token` path segment authenticates the call (NetGSM cannot sign requests).
 */
@Controller('public/telephony/netgsm-ivr')
@Throttle({ default: { limit: 120, ttl: 60_000 } })
export class NetgsmIvrController {
  constructor(private readonly service: NetgsmIvrService) {}

  @Post(':token')
  async webhook(
    @Param('token') token: string,
    @Query() query: Record<string, any>,
    @Body() body: Record<string, any>,
  ): Promise<NetgsmIvrReply> {
    if (!isNetgsmIvrConfigured()) throw new NotFoundException();
    if (!tokenMatches(token, process.env.NETGSM_IVR_TOKEN)) throw new ForbiddenException();
    // NetGSM may send GET query OR POST body (form/json) — merge, body wins.
    const params = { ...(query || {}), ...(body || {}) } as NetgsmIvrInput;
    return this.service.handle(params);
  }
}
