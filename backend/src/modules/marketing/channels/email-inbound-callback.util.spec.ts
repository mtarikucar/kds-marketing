import {
  emailInboundToken,
  verifyEmailInboundToken,
  emailInboundCallbackUrl,
} from './email-inbound-callback.util';
import { netgsmMoToken } from './netgsm-callback.util';

/**
 * The per-channel inbound token is what replaces the platform-global
 * `EMAIL_INBOUND_SECRET` HMAC that no relay could ever produce. The URL names
 * the tenant, so these cases are the cross-tenant boundary itself, not a
 * formatting check.
 */
describe('email inbound callback token', () => {
  const KEY = Buffer.alloc(32, 9).toString('base64');

  beforeEach(() => {
    process.env.MARKETING_SECRET_KEY = KEY;
  });
  afterEach(() => {
    delete process.env.MARKETING_SECRET_KEY;
  });

  it('is deterministic per channel and verifies its own token', () => {
    const t = emailInboundToken('chan-1');
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(emailInboundToken('chan-1')).toBe(t);
    expect(verifyEmailInboundToken('chan-1', t)).toBe(true);
  });

  it('rejects another channel’s token — the URL is the tenant boundary', () => {
    const a = emailInboundToken('chan-a');
    const b = emailInboundToken('chan-b');
    expect(a).not.toBe(b);
    expect(verifyEmailInboundToken('chan-b', a)).toBe(false);
    expect(verifyEmailInboundToken('chan-a', b)).toBe(false);
  });

  it('is domain-separated from the SMS MO token on the same master key', () => {
    // Both MACs are built from MARKETING_SECRET_KEY. Without the label, an SMS
    // channel's MO token would open that same id's mail endpoint.
    expect(emailInboundToken('chan-1')).not.toBe(netgsmMoToken('chan-1'));
  });

  it('rejects an empty or garbage token without throwing', () => {
    expect(verifyEmailInboundToken('chan-1', '')).toBe(false);
    expect(verifyEmailInboundToken('chan-1', 'deadbeef')).toBe(false);
    expect(verifyEmailInboundToken('chan-1', undefined as unknown as string)).toBe(false);
  });

  it('rejects (does not throw) when the master key is absent', () => {
    delete process.env.MARKETING_SECRET_KEY;
    expect(verifyEmailInboundToken('chan-1', 'whatever')).toBe(false);
  });
});

describe('emailInboundCallbackUrl', () => {
  const KEY = Buffer.alloc(32, 9).toString('base64');
  beforeEach(() => {
    process.env.MARKETING_SECRET_KEY = KEY;
  });
  afterEach(() => {
    delete process.env.MARKETING_SECRET_KEY;
  });

  it('builds the public inbound URL with the per-channel token', () => {
    expect(emailInboundCallbackUrl('https://m.example.com', 'chan-1')).toBe(
      `https://m.example.com/api/public/channels/email/chan-1/${emailInboundToken('chan-1')}/inbound`,
    );
  });

  it('tolerates a trailing slash on the base URL', () => {
    expect(emailInboundCallbackUrl('https://m.example.com//', 'chan-1')).toBe(
      `https://m.example.com/api/public/channels/email/chan-1/${emailInboundToken('chan-1')}/inbound`,
    );
  });

  it('returns null rather than throwing when the base URL or the key is missing', () => {
    expect(emailInboundCallbackUrl(undefined, 'chan-1')).toBeNull();
    delete process.env.MARKETING_SECRET_KEY;
    expect(emailInboundCallbackUrl('https://m.example.com', 'chan-1')).toBeNull();
  });
});
