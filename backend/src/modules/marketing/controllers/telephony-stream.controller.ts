import { Controller, Sse, Header, UseGuards, MessageEvent } from '@nestjs/common';
import { Observable, interval, merge } from 'rxjs';
import { map } from 'rxjs/operators';
import { SseTokenGuard } from '../guards/sse-token.guard';
import { FeatureGuard, RequiresFeature } from '../guards/feature.guard';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { TelephonyStreamService } from '../telephony/telephony-stream.service';

/**
 * Screen-pop / live-call-status stream for the rep's OWN webphone (NetGSM
 * Phase 3 Task 3). EventSource can't set an Authorization header, so this
 * uses SseTokenGuard exactly like MarketingConversationsController's `stream`
 * route (token rides as `?access_token=`). Filtered server-side to the
 * CURRENT rep's own dahili (+ any broadcast event) via
 * TelephonyStreamService.forRep — a rep never sees another rep's screen-pop.
 * Gated behind the `telephony` feature like the rest of the telephony
 * surface (TelephonyConfigController/WebphoneConfigController).
 */
@MarketingRoute()
@Controller('marketing/telephony')
@UseGuards(SseTokenGuard, FeatureGuard)
@RequiresFeature('telephony')
export class TelephonyStreamController {
  constructor(private readonly stream: TelephonyStreamService) {}

  @Sse('stream')
  @Header('X-Accel-Buffering', 'no')
  streamForRep(@CurrentMarketingUser() actor: MarketingUserPayload): Observable<MessageEvent> {
    return merge(
      this.stream.forRep(actor.workspaceId, actor.dahili ?? null).pipe(map((e) => ({ data: e }) as MessageEvent)),
      // 25s heartbeat keeps proxies from idling the connection shut.
      interval(25_000).pipe(map(() => ({ data: { kind: 'heartbeat' } }) as MessageEvent)),
    );
  }
}
