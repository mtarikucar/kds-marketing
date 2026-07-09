import { normalizeSantralEvent } from './santral-event-normalizer';

/**
 * Netsantral "URL'e Yönlendirme" pushes a raw scenario record per call leg.
 * Field names AND casing vary by scenario/vendor firmware, so the normalizer
 * parses tolerantly across the documented alternates (see the NetGSM Phase 3
 * plan's "Key santral-event facts"). An unrecognized scenario returns null —
 * the caller still archives the raw payload for audit, it just never
 * publishes a typed domain event for it.
 */
describe('normalizeSantralEvent', () => {
  it('normalizes an Inbound_call event with every documented field present', () => {
    const raw = {
      scenario: 'Inbound_call',
      unique_id: 'abc-123',
      crm_id: 'sc-9',
      customer_num: '905551112233',
      internal_num: '101',
      yon: 'INBOUND',
      sondurum: 'RINGING',
      seskaydi: 'https://rec.example/1.wav',
      bilsec: '0',
    };

    expect(normalizeSantralEvent(raw)).toEqual({
      kind: 'inbound_call',
      uniqueId: 'abc-123',
      crmId: 'sc-9',
      customerNum: '905551112233',
      internalNum: '101',
      direction: 'INBOUND',
      status: 'RINGING',
      recording: 'https://rec.example/1.wav',
      durationSec: 0,
      raw,
    });
  });

  it('normalizes an Answer event using the alternate (durum/arayan/aranan) field names', () => {
    const raw = {
      durum: 'Answer',
      uniqueid: 'call-1',
      arayan: '905551112233',
      aranan: '102',
      direction: 'outbound',
      status: 'ANSWERED',
    };

    const result = normalizeSantralEvent(raw);
    expect(result?.kind).toBe('answer');
    expect(result?.uniqueId).toBe('call-1');
    expect(result?.customerNum).toBe('905551112233');
    expect(result?.internalNum).toBe('102');
    expect(result?.direction).toBe('OUTBOUND');
    expect(result?.status).toBe('ANSWERED');
  });

  it('normalizes a Hangup event using the event/callid/dahili field names', () => {
    const raw = { event: 'Hangup', callid: 'sip8-999888', dahili: '103' };

    const result = normalizeSantralEvent(raw);
    expect(result?.kind).toBe('hangup');
    expect(result?.internalNum).toBe('103');
  });

  it('normalizes a cdr scenario, and its "end" alias, to kind "cdr"', () => {
    expect(normalizeSantralEvent({ scenario: 'cdr', unique_id: 'c-1' })?.kind).toBe('cdr');
    expect(normalizeSantralEvent({ scenario: 'end', unique_id: 'c-2' })?.kind).toBe('cdr');
  });

  it('strips a leading sip<digits>- prefix from unique_id for correlation, but keeps raw untouched', () => {
    const raw = { scenario: 'Hangup', unique_id: 'sip12-0102030405' };

    const result = normalizeSantralEvent(raw);
    expect(result?.uniqueId).toBe('0102030405');
    expect(result?.raw).toEqual(raw);
    expect((result?.raw as Record<string, unknown>).unique_id).toBe('sip12-0102030405');
  });

  it('parses bilsec/billsec/duration fields tolerantly, coercing numeric strings and numbers', () => {
    expect(normalizeSantralEvent({ scenario: 'Hangup', bilsec: '42' })?.durationSec).toBe(42);
    expect(normalizeSantralEvent({ scenario: 'Hangup', billsec: '7' })?.durationSec).toBe(7);
    expect(normalizeSantralEvent({ scenario: 'Hangup', duration: 3 })?.durationSec).toBe(3);
    expect(normalizeSantralEvent({ scenario: 'Hangup', duration: 'not-a-number' })?.durationSec).toBeNull();
  });

  it('is null-safe on every optional field when only the scenario is present', () => {
    const result = normalizeSantralEvent({ scenario: 'Inbound_call' });

    expect(result).toEqual({
      kind: 'inbound_call',
      uniqueId: null,
      crmId: null,
      customerNum: null,
      internalNum: null,
      direction: null,
      status: null,
      recording: null,
      durationSec: null,
      raw: { scenario: 'Inbound_call' },
    });
  });

  it('returns null for an unrecognized scenario value', () => {
    expect(normalizeSantralEvent({ scenario: 'SomethingElse' })).toBeNull();
  });

  it('returns null when no scenario/durum/event field is present at all', () => {
    expect(normalizeSantralEvent({ unique_id: 'abc' })).toBeNull();
  });

  it('returns null for non-object input', () => {
    expect(normalizeSantralEvent(null)).toBeNull();
    expect(normalizeSantralEvent(undefined)).toBeNull();
  });
});
