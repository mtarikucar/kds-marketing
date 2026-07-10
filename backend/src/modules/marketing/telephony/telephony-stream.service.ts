import { Injectable } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import { filter } from 'rxjs/operators';

/**
 * A live telephony event pushed to a rep's webphone UI over SSE.
 *  - `screen_pop`: an inbound call arriving for a specific extension —
 *    carries the resolved lead + call context so the rep sees a caller card
 *    before/as they answer (see TelephonyEventConsumer.handleInboundCall).
 *  - `call_status`: live CONNECTED/terminal transitions for a call, driving
 *    the rep's status pill (NetGSM Phase 3 Task 6 — pushed by
 *    TelephonyEventConsumer on `answer`/`hangup`/`cdr`; INITIATED/RINGING are
 *    known client-side already, from the dial REST response and the SIP/
 *    screen-pop ringing signal respectively, so only the PBX-confirmed
 *    CONNECTED/NO_ANSWER/BUSY/FAILED transitions travel over this stream).
 */
export interface TelephonyStreamEvent {
  kind: 'screen_pop' | 'call_status';
  /** The rep's MarketingUser.dahili this event targets, or null to broadcast
   *  to every rep currently subscribed in the workspace. */
  targetDahili: string | null;
  payload: unknown;
}

/**
 * Per-workspace in-process SSE fan-out for telephony (screen-pop, live call
 * status). Mirrors ConversationStreamService EXACTLY: one hot, unbuffered
 * RxJS Subject per workspace. Single-replica assumption (documented
 * non-goal: multi-replica needs a pg NOTIFY / Redis bridge to fan pushes out
 * across instances) — matches the in-process DomainEventBus. A rep whose
 * EventSource isn't connected at push time simply misses the live event; the
 * SalesCall row itself is the durable record, this stream is best-effort UX
 * only.
 */
@Injectable()
export class TelephonyStreamService {
  private readonly streams = new Map<string, Subject<TelephonyStreamEvent>>();

  private subjectFor(workspaceId: string): Subject<TelephonyStreamEvent> {
    let s = this.streams.get(workspaceId);
    if (!s) {
      s = new Subject<TelephonyStreamEvent>();
      this.streams.set(workspaceId, s);
    }
    return s;
  }

  push(workspaceId: string, event: TelephonyStreamEvent): void {
    this.subjectFor(workspaceId).next(event);
  }

  /** Single-rep stream — events targeting this dahili specifically, plus any
   *  broadcast (`targetDahili === null`) event in the workspace. A rep with
   *  no configured dahili yet (null) still receives broadcasts, never a
   *  targeted event (nothing can equal null by coincidence here). */
  forRep(workspaceId: string, dahili: string | null): Observable<TelephonyStreamEvent> {
    return this.subjectFor(workspaceId)
      .asObservable()
      .pipe(filter((e) => e.targetDahili === dahili || e.targetDahili === null));
  }
}
