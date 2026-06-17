import { mapNetgsmDlr } from './netgsm-dlr.util';

/**
 * NetGSM's polled delivery report (`/sms/report`) returns a `durumcode` per
 * message (+ a `hatakod` reason). mapNetgsmDlr turns that into our Message.status
 * and tells the poller whether the state is terminal (stop polling) or still
 * pending. Codes per NetGSM's documented report contract:
 *   0 pending · 1 delivered · 2/3/4/11/12 failed · 13 duplicate · 15 blacklist · 16/17 İYS.
 */
describe('mapNetgsmDlr', () => {
  it('treats durum 0 as still pending (keep SENT, non-terminal)', () => {
    const r = mapNetgsmDlr('0');
    expect(r.status).toBe('SENT');
    expect(r.terminal).toBe(false);
  });

  it('maps durum 1 to DELIVERED (terminal, no reason)', () => {
    const r = mapNetgsmDlr('1');
    expect(r.status).toBe('DELIVERED');
    expect(r.terminal).toBe(true);
    expect(r.reason).toBeNull();
  });

  it('maps fail codes 2,3,4,11,12 to FAILED (terminal)', () => {
    for (const c of ['2', '3', '4', '11', '12']) {
      const r = mapNetgsmDlr(c);
      expect(r.status).toBe('FAILED');
      expect(r.terminal).toBe(true);
      expect(r.reason).toBeTruthy();
    }
  });

  it('maps duplicate 13, blacklist 15 and İYS 16/17 to FAILED with a reason', () => {
    expect(mapNetgsmDlr('13').reason).toMatch(/duplicate/i);
    expect(mapNetgsmDlr('15').reason).toMatch(/blacklist/i);
    expect(mapNetgsmDlr('16').reason).toMatch(/İYS|IYS/i);
    expect(mapNetgsmDlr('17').reason).toMatch(/İYS|IYS/i);
  });

  it('includes the hatakod in the failure reason when present', () => {
    expect(mapNetgsmDlr('2', '101').reason).toMatch(/101/);
  });

  it('keeps an unknown durum as SENT (non-terminal) rather than guessing', () => {
    const r = mapNetgsmDlr('99');
    expect(r.status).toBe('SENT');
    expect(r.terminal).toBe(false);
  });

  it('tolerates numeric input and surrounding whitespace', () => {
    expect(mapNetgsmDlr(1 as any).status).toBe('DELIVERED');
    expect(mapNetgsmDlr(' 1 ' as any).status).toBe('DELIVERED');
  });
});
