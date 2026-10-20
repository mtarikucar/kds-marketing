import {
  COMMERCE_SIGNATURE_MAX_AGE_MS,
  signCommercePayload,
  verifyCommerceSignature,
} from './commerce-signature';
import { VECTOR_BODY, VECTOR_SECRET, VECTOR_SIGNATURE, VECTOR_TIMESTAMP } from './commerce-ingest.fixture';

const NOW = Number(VECTOR_TIMESTAMP) * 1000;
const RAW = Buffer.from(VECTOR_BODY, 'utf8');
const OTHER_SECRET = 'whsec_00000000000000000000000000000000';

function verify(over: Partial<Parameters<typeof verifyCommerceSignature>[0]> = {}) {
  return verifyCommerceSignature({
    rawBody: RAW,
    timestamp: VECTOR_TIMESTAMP,
    signatureHeader: `v1=${VECTOR_SIGNATURE}`,
    secrets: [VECTOR_SECRET],
    now: NOW,
    ...over,
  });
}

describe('commerce signature (contract §1.2)', () => {
  it('reproduces the contract vector 7d5da73a… over the exact 818 bytes', () => {
    expect(RAW.length).toBe(818);
    expect(signCommercePayload(VECTOR_SECRET, VECTOR_TIMESTAMP, RAW)).toBe(VECTOR_SIGNATURE);
    expect(verify()).toEqual({ ok: true });
  });

  it('rejects a wrong signature, a different secret, and a single changed byte', () => {
    expect(verify({ signatureHeader: `v1=${'0'.repeat(64)}` })).toEqual({ ok: false, code: 'BAD_SIGNATURE' });
    expect(verify({ secrets: [OTHER_SECRET] })).toEqual({ ok: false, code: 'BAD_SIGNATURE' });
    const tampered = Buffer.from(VECTOR_BODY.replace('349900,"refundedMinor"', '349901,"refundedMinor"'), 'utf8');
    expect(verify({ rawBody: tampered })).toEqual({ ok: false, code: 'BAD_SIGNATURE' });
  });

  it('rejects missing headers and a scheme other than v1', () => {
    expect(verify({ signatureHeader: undefined })).toEqual({ ok: false, code: 'BAD_SIGNATURE' });
    expect(verify({ signatureHeader: '' })).toEqual({ ok: false, code: 'BAD_SIGNATURE' });
    expect(verify({ signatureHeader: VECTOR_SIGNATURE })).toEqual({ ok: false, code: 'BAD_SIGNATURE' });
    expect(verify({ signatureHeader: `v0=${VECTOR_SIGNATURE}` })).toEqual({ ok: false, code: 'BAD_SIGNATURE' });
    expect(verify({ timestamp: undefined })).toEqual({ ok: false, code: 'BAD_SIGNATURE' });
    expect(verify({ timestamp: 'yesterday' })).toEqual({ ok: false, code: 'BAD_SIGNATURE' });
  });

  it('signs the timestamp too: the same body under another timestamp does not verify', () => {
    expect(verify({ timestamp: String(Number(VECTOR_TIMESTAMP) + 1), now: NOW })).toEqual({
      ok: false,
      code: 'BAD_SIGNATURE',
    });
  });

  it('accepts ±300 s and rejects anything outside it as STALE_TIMESTAMP', () => {
    expect(COMMERCE_SIGNATURE_MAX_AGE_MS).toBe(300_000);
    expect(verify({ now: NOW + 300_000 })).toEqual({ ok: true });
    expect(verify({ now: NOW - 300_000 })).toEqual({ ok: true });
    expect(verify({ now: NOW + 300_001 })).toEqual({ ok: false, code: 'STALE_TIMESTAMP' });
    expect(verify({ now: NOW - 300_001 })).toEqual({ ok: false, code: 'STALE_TIMESTAMP' });
  });

  it('reports a forged old request as BAD_SIGNATURE, not STALE (no clock oracle without the key)', () => {
    expect(verify({ signatureHeader: `v1=${'a'.repeat(64)}`, now: NOW + 10 * 60_000 })).toEqual({
      ok: false,
      code: 'BAD_SIGNATURE',
    });
  });

  it('passes when any one of several comma-separated v1= values matches (rotation)', () => {
    const header = `v1=${'1'.repeat(64)}, v1=${VECTOR_SIGNATURE}`;
    expect(verify({ signatureHeader: header })).toEqual({ ok: true });
  });

  it('passes on the previous secret while it is still offered (rotation window)', () => {
    expect(verify({ secrets: [OTHER_SECRET, VECTOR_SECRET] })).toEqual({ ok: true });
    expect(verify({ secrets: [] })).toEqual({ ok: false, code: 'BAD_SIGNATURE' });
  });
});
