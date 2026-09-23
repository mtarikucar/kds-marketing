import {
  signTriggerLinkContact,
  verifyTriggerLinkContact,
} from './trigger-link-contact.token';
import { signLeadUnsubscribeToken } from '../channels/lead-unsubscribe.token';

/**
 * `?c=` decides which lead a click is attributed to, and that attribution is
 * what fires `link.clicked` workflows — qualify the lead, send the code, ring
 * the bell. A raw lead id in a query string is a claim anyone can type.
 */
describe('trigger-link contact token', () => {
  const KEY = Buffer.alloc(32, 7).toString('base64');
  const WS = 'ws-1';
  const LEAD = 'lead-1';

  beforeEach(() => {
    process.env.MARKETING_SECRET_KEY = KEY;
  });
  afterEach(() => {
    delete process.env.MARKETING_SECRET_KEY;
  });

  it('round-trips the workspace and the lead', () => {
    const token = signTriggerLinkContact(WS, LEAD);
    expect(token).toBeTruthy();
    expect(verifyTriggerLinkContact(token!)).toEqual({ workspaceId: WS, leadId: LEAD });
  });

  it('is deterministic, so one lead has one link across resends', () => {
    expect(signTriggerLinkContact(WS, LEAD)).toBe(signTriggerLinkContact(WS, LEAD));
  });

  it('is URL-safe (it travels in a query string)', () => {
    const token = signTriggerLinkContact(WS, LEAD)!;
    expect(token).toBe(encodeURIComponent(token));
  });

  it('refuses a raw lead id — the whole point of the change', () => {
    expect(verifyTriggerLinkContact(LEAD)).toBeNull();
  });

  it('refuses a tampered payload and a tampered signature', () => {
    const token = signTriggerLinkContact(WS, LEAD)!;
    const [body, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ w: WS, l: 'lead-999' })).toString('base64url');
    expect(verifyTriggerLinkContact(`${forged}.${sig}`)).toBeNull();
    expect(verifyTriggerLinkContact(`${body}.${'A'.repeat(sig.length)}`)).toBeNull();
  });

  it('refuses a token signed with another key (rotation invalidates, never leaks)', () => {
    const token = signTriggerLinkContact(WS, LEAD)!;
    process.env.MARKETING_SECRET_KEY = Buffer.alloc(32, 9).toString('base64');
    expect(verifyTriggerLinkContact(token)).toBeNull();
  });

  it('does not accept a lead-unsubscribe token (labels are separated)', () => {
    // Both derive from MARKETING_SECRET_KEY; a shared key with no label would
    // let an unsubscribe link double as a click-attribution claim.
    const other = signLeadUnsubscribeToken(WS, LEAD, 'EMAIL');
    expect(other).toBeTruthy();
    expect(verifyTriggerLinkContact(other)).toBeNull();
  });

  it('never throws on junk', () => {
    for (const junk of ['', '.', 'a.b.c', 'a.', '.b', 'x'.repeat(5000), '%%%.%%%']) {
      expect(verifyTriggerLinkContact(junk)).toBeNull();
    }
    expect(verifyTriggerLinkContact(undefined as any)).toBeNull();
    expect(verifyTriggerLinkContact(null as any)).toBeNull();
    expect(verifyTriggerLinkContact(123 as any)).toBeNull();
  });

  describe('without MARKETING_SECRET_KEY', () => {
    beforeEach(() => {
      delete process.env.MARKETING_SECRET_KEY;
    });

    it('cannot mint', () => {
      expect(signTriggerLinkContact(WS, LEAD)).toBeNull();
    });

    it('cannot verify', () => {
      expect(verifyTriggerLinkContact('anything')).toBeNull();
    });
  });

  it('refuses to mint for a blank workspace or lead', () => {
    expect(signTriggerLinkContact('', LEAD)).toBeNull();
    expect(signTriggerLinkContact(WS, '')).toBeNull();
  });
});
