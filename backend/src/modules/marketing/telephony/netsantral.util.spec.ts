import { interpretNetsantralOriginate } from './netsantral.util';

describe('interpretNetsantralOriginate', () => {
  it('parses a JSON success with unique_id', () => {
    const r = interpretNetsantralOriginate('{"status":"success","unique_id":"abc-123"}');
    expect(r).toEqual({ ok: true, callId: 'abc-123' });
  });
  it('parses a plain-text numeric error code', () => {
    const r = interpretNetsantralOriginate('30');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('30');
    expect(r.message).toMatch(/auth/i);
  });
  it('treats an unreadable body as a non-ok no-op (never throws)', () => {
    const r = interpretNetsantralOriginate('<html>nope</html>');
    expect(r.ok).toBe(false);
    expect(r.callId).toBeUndefined();
  });
  it('handles empty body', () => {
    expect(interpretNetsantralOriginate('').ok).toBe(false);
  });
});
