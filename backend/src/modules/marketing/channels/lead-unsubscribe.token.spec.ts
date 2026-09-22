import { deriveMailKey, signLeadUnsubscribeToken, verifyLeadUnsubscribeToken } from './lead-unsubscribe.token';

/**
 * The footer link of every BULK mail. It has to survive a campaign being
 * deleted, a lead being merged and a mail sitting in an inbox for two years,
 * so it is signed rather than stored — and a signature that can be forged, or
 * that resolves to the wrong tenant, is worse than no link at all.
 */
describe('lead unsubscribe token', () => {
  const KEY = Buffer.alloc(32, 11).toString('base64');
  const WS = 'ws-1';
  const LEAD = 'lead-1';

  beforeEach(() => {
    process.env.MARKETING_SECRET_KEY = KEY;
  });
  afterEach(() => {
    delete process.env.MARKETING_SECRET_KEY;
  });

  it('round-trips the workspace, lead and channel', () => {
    const token = signLeadUnsubscribeToken(WS, LEAD, 'EMAIL');
    expect(token).toBeTruthy();
    expect(verifyLeadUnsubscribeToken(token!)).toEqual({
      workspaceId: WS,
      leadId: LEAD,
      channel: 'EMAIL',
    });
  });

  it('is deterministic, so the same lead always gets the same link', () => {
    // A resent campaign, a re-rendered footer and a stored copy of the mail
    // must all point at one URL; a nonce would mint a second live token per
    // send and make the old one unrevocable.
    expect(signLeadUnsubscribeToken(WS, LEAD, 'EMAIL')).toBe(signLeadUnsubscribeToken(WS, LEAD, 'EMAIL'));
  });

  it('does not expire — a mail sits in an inbox longer than any TTL', () => {
    const token = signLeadUnsubscribeToken(WS, LEAD, 'EMAIL')!;
    const before = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(before + 5 * 365 * 24 * 60 * 60 * 1000);
    expect(verifyLeadUnsubscribeToken(token)).toMatchObject({ leadId: LEAD });
    (Date.now as jest.Mock).mockRestore();
  });

  it('rejects a forged signature', () => {
    const token = signLeadUnsubscribeToken(WS, LEAD, 'EMAIL')!;
    const [body] = token.split('.');
    expect(verifyLeadUnsubscribeToken(`${body}.AAAA`)).toBeNull();
    expect(verifyLeadUnsubscribeToken(`${body}.${'a'.repeat(43)}`)).toBeNull();
  });

  it('rejects a truncated or shapeless token without throwing', () => {
    const token = signLeadUnsubscribeToken(WS, LEAD, 'EMAIL')!;
    expect(verifyLeadUnsubscribeToken(token.slice(0, token.length - 4))).toBeNull();
    expect(verifyLeadUnsubscribeToken(token.split('.')[0])).toBeNull();
    expect(verifyLeadUnsubscribeToken('')).toBeNull();
    expect(verifyLeadUnsubscribeToken('....')).toBeNull();
    expect(verifyLeadUnsubscribeToken(undefined as unknown as string)).toBeNull();
  });

  it('rejects a payload re-pointed at another workspace', () => {
    // The attack the workspace field exists to stop: keep the signature, swap
    // the tenant, and unsubscribe someone else's lead.
    const token = signLeadUnsubscribeToken(WS, LEAD, 'EMAIL')!;
    const [body, sig] = token.split('.');
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    payload.w = 'ws-2';
    const forged = Buffer.from(JSON.stringify(payload)).toString('base64url');
    expect(verifyLeadUnsubscribeToken(`${forged}.${sig}`)).toBeNull();
  });

  it('rejects another workspace’s token for the same lead id', () => {
    const mine = signLeadUnsubscribeToken(WS, LEAD, 'EMAIL')!;
    const theirs = signLeadUnsubscribeToken('ws-2', LEAD, 'EMAIL')!;
    expect(theirs).not.toBe(mine);
    expect(verifyLeadUnsubscribeToken(theirs)).toEqual({
      workspaceId: 'ws-2',
      leadId: LEAD,
      channel: 'EMAIL',
    });
  });

  it('rejects a payload with a missing or unknown channel', () => {
    const token = signLeadUnsubscribeToken(WS, LEAD, 'EMAIL')!;
    const [, sig] = token.split('.');
    const body = Buffer.from(JSON.stringify({ w: WS, l: LEAD })).toString('base64url');
    expect(verifyLeadUnsubscribeToken(`${body}.${sig}`)).toBeNull();
  });

  it('returns null instead of throwing when the master key is absent', () => {
    // BULK fails closed without an unsubscribe: no key means no token means the
    // gateway refuses the mail. A throw here would take the whole send down.
    const token = signLeadUnsubscribeToken(WS, LEAD, 'EMAIL')!;
    delete process.env.MARKETING_SECRET_KEY;
    expect(signLeadUnsubscribeToken(WS, LEAD, 'EMAIL')).toBeNull();
    expect(verifyLeadUnsubscribeToken(token)).toBeNull();
  });

  it('returns null for a missing workspace or lead id', () => {
    expect(signLeadUnsubscribeToken('', LEAD, 'EMAIL')).toBeNull();
    expect(signLeadUnsubscribeToken(WS, '', 'EMAIL')).toBeNull();
  });

  it('a token minted under one master key does not verify under another', () => {
    const token = signLeadUnsubscribeToken(WS, LEAD, 'EMAIL')!;
    process.env.MARKETING_SECRET_KEY = Buffer.alloc(32, 12).toString('base64');
    expect(verifyLeadUnsubscribeToken(token)).toBeNull();
  });

  it('is URL-safe', () => {
    const token = signLeadUnsubscribeToken(WS, LEAD, 'EMAIL')!;
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(token)).toBe(token);
  });
});

/**
 * One derivation root, two labels. Judge flaw #2: if the footer link and the
 * suppression pepper ever rotate independently, the link 404s against rows it
 * itself wrote.
 */
describe('deriveMailKey', () => {
  const KEY = Buffer.alloc(32, 11).toString('base64');

  beforeEach(() => {
    process.env.MARKETING_SECRET_KEY = KEY;
  });
  afterEach(() => {
    delete process.env.MARKETING_SECRET_KEY;
  });

  it('derives a stable 32-byte key per label', () => {
    const a = deriveMailKey('lead-unsubscribe');
    expect(a).toHaveLength(32);
    expect(deriveMailKey('lead-unsubscribe').equals(a)).toBe(true);
  });

  it('separates labels, so one secret cannot be used as the other', () => {
    expect(deriveMailKey('lead-unsubscribe').equals(deriveMailKey('contact-suppression'))).toBe(false);
  });

  it('follows the master key, so both labels rotate together', () => {
    const before = deriveMailKey('contact-suppression');
    process.env.MARKETING_SECRET_KEY = Buffer.alloc(32, 12).toString('base64');
    expect(deriveMailKey('contact-suppression').equals(before)).toBe(false);
  });

  it('returns null when the master key is absent, never throws', () => {
    delete process.env.MARKETING_SECRET_KEY;
    expect(deriveMailKey('contact-suppression')).toBeNull();
  });
});
