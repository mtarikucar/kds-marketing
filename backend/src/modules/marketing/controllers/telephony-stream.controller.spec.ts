import { Subject } from 'rxjs';
import { TelephonyStreamController } from './telephony-stream.controller';
import { TelephonyStreamEvent } from '../telephony/telephony-stream.service';

/**
 * Light route test: the controller must delegate to
 * TelephonyStreamService.forRep(workspaceId, dahili) for the CURRENT rep
 * (from @CurrentMarketingUser, populated by SseTokenGuard) and map each
 * TelephonyStreamEvent onto a plain `{ data }` MessageEvent — same shape
 * MarketingConversationsController.streamInbox uses.
 */
describe('TelephonyStreamController', () => {
  it('streams forRep(workspaceId, dahili) events mapped as { data: event } for the current rep', () => {
    const subject = new Subject<TelephonyStreamEvent>();
    const stream: any = { forRep: jest.fn().mockReturnValue(subject.asObservable()) };
    const ctrl = new TelephonyStreamController(stream);

    const received: unknown[] = [];
    const sub = ctrl
      .streamForRep({ workspaceId: 'ws-1', dahili: '104' } as any)
      .subscribe((msg) => received.push(msg));

    expect(stream.forRep).toHaveBeenCalledWith('ws-1', '104');

    const event: TelephonyStreamEvent = { kind: 'screen_pop', targetDahili: '104', payload: { x: 1 } };
    subject.next(event);

    expect(received).toEqual([{ data: event }]);
    sub.unsubscribe();
  });

  it('resolves the rep with no configured dahili to forRep(workspaceId, null) — never undefined', () => {
    const stream: any = { forRep: jest.fn().mockReturnValue(new Subject().asObservable()) };
    const ctrl = new TelephonyStreamController(stream);

    const sub = ctrl.streamForRep({ workspaceId: 'ws-1', dahili: undefined } as any).subscribe();

    expect(stream.forRep).toHaveBeenCalledWith('ws-1', null);
    sub.unsubscribe();
  });
});
