// ── safeFetch mock (the seam the write helper transports over) ──────────────
const mockSafeFetch = jest.fn();
jest.mock('../../../common/util/safe-fetch', () => ({
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

import { updateLinkedinCampaign } from './linkedin-ads.client';
import { LINKEDIN_DEFAULT_API_VERSION } from '../../../common/util/linkedin-api.util';

function res(ok: boolean, status: number, body: unknown) {
  return {
    ok,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

beforeEach(() => {
  mockSafeFetch.mockReset();
  // Unpinned on purpose: this write goes through the shared transport (with an
  // X-RestLi-Method override) and must stay in step with the shared default
  // rather than freeze its own copy of the version.
  delete process.env.LINKEDIN_API_VERSION;
});

describe('updateLinkedinCampaign', () => {
  it('POSTs a PARTIAL_UPDATE to /rest/adCampaigns/{id} with the status in patch.$set', async () => {
    mockSafeFetch.mockResolvedValue(res(true, 204, null));
    const r = await updateLinkedinCampaign('tok', 'c123', { status: 'PAUSED' });
    expect(r).toMatchObject({ ok: true, id: 'c123' });
    const [url, opts] = mockSafeFetch.mock.calls[0] as [string, any];
    expect(url).toBe('https://api.linkedin.com/rest/adCampaigns/c123');
    expect(opts.method).toBe('POST');
    expect(opts.headers['X-RestLi-Method']).toBe('PARTIAL_UPDATE');
    expect(opts.headers['Authorization']).toBe('Bearer tok');
    expect(opts.headers['LinkedIn-Version']).toBe(LINKEDIN_DEFAULT_API_VERSION);
    expect(opts.headers['X-Restli-Protocol-Version']).toBe('2.0.0');
    const body = JSON.parse(opts.body);
    expect(body.patch.$set.status).toBe('PAUSED');
    // status-only patch carries no budget
    expect(body.patch.$set.dailyBudget).toBeUndefined();
  });

  it('builds a dailyBudget MoneyAmount { amount, currencyCode } from major units', async () => {
    mockSafeFetch.mockResolvedValue(res(true, 204, null));
    const r = await updateLinkedinCampaign('tok', 'c123', { dailyBudgetMajor: 50, currencyCode: 'USD' });
    expect(r.ok).toBe(true);
    const body = JSON.parse((mockSafeFetch.mock.calls[0][1] as any).body);
    expect(body.patch.$set.dailyBudget).toEqual({ amount: '50', currencyCode: 'USD' });
  });

  it('sets both status and dailyBudget when both are supplied', async () => {
    mockSafeFetch.mockResolvedValue(res(true, 204, null));
    await updateLinkedinCampaign('tok', 'c123', { status: 'ACTIVE', dailyBudgetMajor: 12.5, currencyCode: 'TRY' });
    const body = JSON.parse((mockSafeFetch.mock.calls[0][1] as any).body);
    expect(body.patch.$set).toEqual({ status: 'ACTIVE', dailyBudget: { amount: '12.5', currencyCode: 'TRY' } });
  });

  it('returns ok:false with isAuthError on a 401 (drives TOKEN_EXPIRED)', async () => {
    mockSafeFetch.mockResolvedValue(res(false, 401, { message: 'Invalid access token' }));
    const r = await updateLinkedinCampaign('tok', 'c123', { status: 'PAUSED' });
    expect(r).toMatchObject({ ok: false, isAuthError: true });
    expect(r.error).toMatch(/401/);
  });

  it('returns ok:false WITHOUT isAuthError on a 403 (permission/scope, stays retry-friendly)', async () => {
    mockSafeFetch.mockResolvedValue(res(false, 403, { message: 'Not enough permissions' }));
    const r = await updateLinkedinCampaign('tok', 'c123', { status: 'PAUSED' });
    expect(r).toMatchObject({ ok: false, isAuthError: false });
  });

  it('surfaces a retired-version rejection with the SAME operator message the publish path gets', async () => {
    // This is the regression the hand-rolled builder had: it sent the version
    // header but classified nothing, so a retired version arrived here as a bare
    // "426: Requested version …" with no hint that the DEPLOY, not this campaign
    // and not this token, was at fault. Routing through linkedinRest means the
    // ads-write path names the version sent and the knob, exactly like publish.
    process.env.LINKEDIN_API_VERSION = '202406';
    mockSafeFetch.mockResolvedValue(
      res(false, 426, { message: 'Requested version 20240601 is not active', status: 426 }),
    );
    const r = await updateLinkedinCampaign('tok', 'c123', { status: 'PAUSED' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('202406');
    expect(r.error).toContain('LINKEDIN_API_VERSION');
    expect(r.error).toContain('is not active');
    // ...and it must NOT flip the account to TOKEN_EXPIRED (ad-management's
    // onResult keys on this flag): the token is fine, the version is not.
    expect(r.isAuthError).toBe(false);
  });

  it('sends the PARTIAL_UPDATE override through the shared transport, not a hand-built request', async () => {
    // Same three standard headers linkedinRest builds + the rest.li override +
    // JSON Content-Type, all from one place.
    mockSafeFetch.mockResolvedValue(res(true, 204, null));
    await updateLinkedinCampaign('tok', 'c123', { status: 'ACTIVE' });
    const [url, opts] = mockSafeFetch.mock.calls[0] as [string, any];
    expect(url).toBe('https://api.linkedin.com/rest/adCampaigns/c123');
    expect(opts.headers['X-RestLi-Method']).toBe('PARTIAL_UPDATE');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(opts.timeoutMs).toBe(20_000);
  });

  it('returns ok:false (retry-friendly) when the transport throws', async () => {
    mockSafeFetch.mockRejectedValue(new Error('network down'));
    const r = await updateLinkedinCampaign('tok', 'c123', { status: 'PAUSED' });
    expect(r).toMatchObject({ ok: false, isAuthError: false });
    expect(r.error).toMatch(/network down/);
  });
});
