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
  it('accepts JSON status "01" as success and returns the callId', () => {
    const r = interpretNetsantralOriginate('{"status":"01","unique_id":"call-abc"}');
    expect(r).toEqual({ ok: true, callId: 'call-abc' });
  });
  it('accepts the REAL queued success that carries NO call id', () => {
    const r = interpretNetsantralOriginate(
      '{"response":"linkup","status":"Originate successfully queued","message":"Success"}',
    );
    expect(r.ok).toBe(true);
    expect(r.callId).toBeUndefined();
  });
  it('rejects a JSON error with a numeric code', () => {
    const r = interpretNetsantralOriginate('{"code":"30","status":"Error","message":"Kullanici dogrulanamadi"}');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('30');
    expect(r.message).toMatch(/auth/i);
  });
});
