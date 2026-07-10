import { TelephonyStreamService, TelephonyStreamEvent } from './telephony-stream.service';

/**
 * TelephonyStreamService mirrors ConversationStreamService: a per-workspace
 * hot RxJS Subject. What matters for screen-pop correctness:
 *  - a pushed event reaches a rep subscribed to their OWN dahili;
 *  - it does NOT reach a rep subscribed to a DIFFERENT dahili;
 *  - `targetDahili: null` is a broadcast — every rep in the workspace gets it;
 *  - workspaces are fully isolated — a push to workspace A never reaches any
 *    subscriber in workspace B, regardless of dahili.
 */
describe('TelephonyStreamService', () => {
  let svc: TelephonyStreamService;

  beforeEach(() => {
    svc = new TelephonyStreamService();
  });

  function collect(workspaceId: string, dahili: string | null): TelephonyStreamEvent[] {
    const received: TelephonyStreamEvent[] = [];
    svc.forRep(workspaceId, dahili).subscribe((e) => received.push(e));
    return received;
  }

  it('delivers a pushed event to a rep subscribed to the exact targetDahili', () => {
    const received = collect('ws-1', '104');

    const event: TelephonyStreamEvent = {
      kind: 'screen_pop',
      targetDahili: '104',
      payload: { customerNum: '05551112233' },
    };
    svc.push('ws-1', event);

    expect(received).toEqual([event]);
  });

  it('does NOT deliver an event targeting a different dahili', () => {
    const received = collect('ws-1', '105');

    svc.push('ws-1', { kind: 'screen_pop', targetDahili: '104', payload: {} });

    expect(received).toEqual([]);
  });

  it('delivers a broadcast event (targetDahili: null) to every rep in the workspace', () => {
    const repA = collect('ws-1', '104');
    const repB = collect('ws-1', '105');

    const broadcast: TelephonyStreamEvent = { kind: 'call_status', targetDahili: null, payload: { status: 'ENDED' } };
    svc.push('ws-1', broadcast);

    expect(repA).toEqual([broadcast]);
    expect(repB).toEqual([broadcast]);
  });

  it('a rep with no configured dahili (null) still receives broadcast events but never a targeted one', () => {
    const received = collect('ws-1', null);

    svc.push('ws-1', { kind: 'screen_pop', targetDahili: '104', payload: {} });
    expect(received).toEqual([]);

    const broadcast: TelephonyStreamEvent = { kind: 'call_status', targetDahili: null, payload: {} };
    svc.push('ws-1', broadcast);
    expect(received).toEqual([broadcast]);
  });

  it('isolates workspaces — a push to workspace A never reaches a subscriber in workspace B', () => {
    const wsA = collect('ws-A', '104');
    const wsB = collect('ws-B', '104');

    // Even a broadcast is scoped to its own workspace's Subject.
    svc.push('ws-A', { kind: 'screen_pop', targetDahili: null, payload: { from: 'A' } });

    expect(wsA).toHaveLength(1);
    expect(wsB).toHaveLength(0);
  });

  it('multiple pushes accumulate in subscription order', () => {
    const received = collect('ws-1', '104');

    svc.push('ws-1', { kind: 'screen_pop', targetDahili: '104', payload: { n: 1 } });
    svc.push('ws-1', { kind: 'call_status', targetDahili: null, payload: { n: 2 } });
    svc.push('ws-1', { kind: 'screen_pop', targetDahili: '999', payload: { n: 3 } }); // filtered out

    expect(received.map((e) => (e.payload as { n: number }).n)).toEqual([1, 2]);
  });
});
