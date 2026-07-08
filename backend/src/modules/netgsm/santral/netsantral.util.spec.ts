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

  // Real Netsantral linkup/originate success: response carries a SIP unique_id
  // plus response/caller_num/called_num/crm_id/status/message. The `status` value
  // is account/locale-dependent and is NOT one of '', success, ok, 00/01/02 — so
  // the presence of unique_id, not the status string, is the acceptance signal.
  it('treats any JSON carrying a unique_id as success regardless of the status string', () => {
    const body =
      '{"response":"linkup","status":"1","unique_id":"sip3-1675712345.6789","caller_num":"5551112233","called_num":"5324445566","crm_id":"call-1","message":"Call queued"}';
    expect(interpretNetsantralOriginate(body)).toEqual({ ok: true, callId: 'sip3-1675712345.6789' });
  });

  it('accepts a camelCase uniqueId key as well', () => {
    const r = interpretNetsantralOriginate('{"status":"ringing","uniqueId":"sip3-9.9"}');
    expect(r).toEqual({ ok: true, callId: 'sip3-9.9' });
  });

  // Genuine rejection (no call id): surface NetGSM's own `message`, not a generic
  // "did not return a call id" — the real failure fields are message/status, not `code`.
  it('surfaces the NetGSM message on a failure that has no call id', () => {
    const r = interpretNetsantralOriginate('{"response":"linkup","status":"error","message":"yetkisiz kullanim"}');
    expect(r.ok).toBe(false);
    expect(r.callId).toBeUndefined();
    expect(r.message).toMatch(/yetkisiz kullanim/i);
  });

  it('still maps a legacy numeric JSON code when present and no id/message', () => {
    const r = interpretNetsantralOriginate('{"code":"30"}');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('30');
    expect(r.message).toMatch(/auth/i);
  });

  // THE REAL bug: with wait_response=0, Netsantral's ACCEPTED response carries NO
  // unique_id — only status "Originate successfully queued" + message "Success".
  // The SIP id arrives later on the CDR (correlated by crm_id). Treating the
  // missing id as failure is why every placed call was wrongly marked CANCELLED.
  it('treats the real "Originate successfully queued" response (no unique_id) as success', () => {
    const body =
      '{"caller_num":"5060687100","called_num":"5324445566","crm_id":"call-1","response":"linkup","status":"Originate successfully queued","message":"Success"}';
    const r = interpretNetsantralOriginate(body);
    expect(r.ok).toBe(true);
    expect(r.callId).toBeUndefined();
  });

  it('treats a "Success" message as accepted even without an id (originate shape)', () => {
    const r = interpretNetsantralOriginate('{"response":"originate","status":"Originate successfully queued","message":"Success"}');
    expect(r.ok).toBe(true);
  });

  // Real failure shapes captured live from crmsntrl.netgsm.com.tr:9111.
  it('surfaces the real "Eksik yada yanlis parametre" (code 30) failure verbatim', () => {
    const r = interpretNetsantralOriginate('{"code":"30","status":"Error","message":"Eksik yada yanlis parametre"}');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/eksik|parametre/i);
  });

  it('surfaces the real "Kullanici dogrulanamadi" auth failure verbatim', () => {
    const r = interpretNetsantralOriginate('{"status":"Error","message":"Kullanici dogrulanamadi"}');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/dogrulanamadi/i);
  });
});
