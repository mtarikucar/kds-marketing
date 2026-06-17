import { interpretNetgsmSend } from './netgsm-send.util';

/**
 * NetGSM's send API returns a bare status code (sometimes followed by a job id)
 * as plain text. interpretNetgsmSend turns that line into a structured outcome:
 * accepted (00/01/02) → ok + jobId; anything else → a human-actionable error
 * keyed off the documented codes (30 auth/IP, 40 header, 50/51 İYS, 20 message,
 * 80/85 rate). It also flags whether retrying could plausibly help.
 */
describe('interpretNetgsmSend', () => {
  it('accepts 00 with a job id', () => {
    const r = interpretNetgsmSend('00 9988776655');
    expect(r.ok).toBe(true);
    expect(r.code).toBe('00');
    expect(r.jobId).toBe('9988776655');
    expect(r.message).toBeNull();
  });

  it('accepts 01 and 02 (alternate OK codes) even without a job id', () => {
    for (const body of ['01', '02']) {
      const r = interpretNetgsmSend(body);
      expect(r.ok).toBe(true);
      expect(r.jobId).toBeNull();
    }
  });

  it('maps 30 to an auth/API-access/IP message and marks it permanent', () => {
    const r = interpretNetgsmSend('30');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('30');
    expect(r.message).toMatch(/auth|usercode|API|IP/i);
    expect(r.retriable).toBe(false);
  });

  it('maps 40 to an unapproved sender-header message', () => {
    const r = interpretNetgsmSend('40');
    expect(r.message).toMatch(/header|msgheader|sender/i);
    expect(r.retriable).toBe(false);
  });

  it('maps 50 and 51 to İYS messages', () => {
    expect(interpretNetgsmSend('50').message).toMatch(/İYS|IYS|permission|opt-?out/i);
    expect(interpretNetgsmSend('51').message).toMatch(/İYS|IYS|brand|register/i);
  });

  it('maps 20 to a message-content error', () => {
    expect(interpretNetgsmSend('20').message).toMatch(/message|text|content|length|character/i);
  });

  it('flags rate-limit 80 as retriable but duplicate-limit 85 as not', () => {
    expect(interpretNetgsmSend('80').retriable).toBe(true);
    expect(interpretNetgsmSend('85').retriable).toBe(false);
  });

  it('still produces a generic error for an unknown code (and is not retriable)', () => {
    const r = interpretNetgsmSend('99');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('99');
    expect(r.message).toMatch(/99/);
    expect(r.retriable).toBe(false);
  });

  it('treats an empty/whitespace body as a (non-retriable) error rather than success', () => {
    const r = interpretNetgsmSend('   ');
    expect(r.ok).toBe(false);
    expect(r.message).toBeTruthy();
  });
});
