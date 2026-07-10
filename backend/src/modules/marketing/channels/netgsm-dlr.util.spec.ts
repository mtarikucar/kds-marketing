import { mapNetgsmDlr, mapNetgsmV2Status } from './netgsm-dlr.util';

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

/**
 * `mapNetgsmV2Status` is the REST v2 `/sms/rest/v2/report` counterpart:
 * same NetgsmDlrMapping shape, numeric `status` (not a string durumcode),
 * plus 22 (expired) which the legacy mapping never had.
 */
describe('mapNetgsmV2Status', () => {
  it('treats status 0 as still pending (keep SENT, non-terminal)', () => {
    const r = mapNetgsmV2Status(0);
    expect(r.status).toBe('SENT');
    expect(r.terminal).toBe(false);
    expect(r.reason).toBeNull();
  });

  it('maps status 1 to DELIVERED (terminal, no reason)', () => {
    const r = mapNetgsmV2Status(1);
    expect(r.status).toBe('DELIVERED');
    expect(r.terminal).toBe(true);
    expect(r.reason).toBeNull();
  });

  it('maps fail statuses 2,3,4,11,12 to FAILED (terminal)', () => {
    for (const s of [2, 3, 4, 11, 12]) {
      const r = mapNetgsmV2Status(s);
      expect(r.status).toBe('FAILED');
      expect(r.terminal).toBe(true);
      expect(r.reason).toBeTruthy();
    }
  });

  it('maps duplicate 13, blacklist 15 and İYS 16/17 to FAILED with a reason', () => {
    expect(mapNetgsmV2Status(13).reason).toMatch(/duplicate/i);
    expect(mapNetgsmV2Status(15).reason).toMatch(/blacklist/i);
    expect(mapNetgsmV2Status(16).reason).toMatch(/İYS|IYS/i);
    expect(mapNetgsmV2Status(17).reason).toMatch(/İYS|IYS/i);
  });

  it('maps status 22 to FAILED as expired', () => {
    const r = mapNetgsmV2Status(22);
    expect(r.status).toBe('FAILED');
    expect(r.terminal).toBe(true);
    expect(r.reason).toMatch(/expired/i);
  });

  it('includes the handset errorCode in the failure reason when present', () => {
    expect(mapNetgsmV2Status(2, '101').reason).toMatch(/101/);
    expect(mapNetgsmV2Status(4, '119').reason).toMatch(/119/);
  });

  it('omits the error clause when no errorCode is given', () => {
    expect(mapNetgsmV2Status(2, null).reason).not.toMatch(/error/i);
    expect(mapNetgsmV2Status(2).reason).not.toMatch(/error/i);
  });

  it('keeps an unknown status as SENT (non-terminal) rather than guessing', () => {
    const r = mapNetgsmV2Status(99);
    expect(r.status).toBe('SENT');
    expect(r.terminal).toBe(false);
    expect(r.reason).toBeNull();
  });
});
