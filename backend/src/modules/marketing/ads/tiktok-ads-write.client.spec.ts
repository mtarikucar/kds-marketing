// ── safeFetch mock (the seam the write helpers transport over) ──────────────
const mockSafeFetch = jest.fn();
jest.mock('../../../common/util/safe-fetch', () => ({
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

import { setTiktokCampaignBudget, setTiktokCampaignStatus } from './tiktok-ads.client';

function res(ok: boolean, status: number, body: unknown) {
  return { ok, status, json: async () => body };
}

beforeEach(() => mockSafeFetch.mockReset());

describe('setTiktokCampaignBudget', () => {
  it('POSTs /campaign/update/ with the Access-Token header and advertiser id', async () => {
    mockSafeFetch.mockResolvedValue(res(true, 200, { code: 0, data: {} }));
    const r = await setTiktokCampaignBudget('tok', 'adv_1', 'c9', 50);
    expect(r.ok).toBe(true);
    const [url, opts] = mockSafeFetch.mock.calls[0] as [string, any];
    expect(url).toBe('https://business-api.tiktok.com/open_api/v1.3/campaign/update/');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Access-Token']).toBe('tok');
    const body = JSON.parse(opts.body);
    expect(body.advertiser_id).toBe('adv_1');
    expect(body.campaign_id).toBe('c9');
  });

  it('sends the budget in MAJOR units (no Meta ×100 conversion) with BUDGET_MODE_DAY', async () => {
    mockSafeFetch.mockResolvedValue(res(true, 200, { code: 0, data: {} }));
    await setTiktokCampaignBudget('tok', 'adv_1', 'c9', 50);
    const body = JSON.parse((mockSafeFetch.mock.calls[0][1] as any).body);
    expect(body.budget).toBe(50); // NOT 5000
    expect(body.budget_mode).toBe('BUDGET_MODE_DAY');
  });

  it('returns ok:false on a non-zero TikTok response code', async () => {
    mockSafeFetch.mockResolvedValue(res(true, 200, { code: 40002, message: 'invalid budget' }));
    const r = await setTiktokCampaignBudget('tok', 'adv_1', 'c9', 50);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/TikTok write \[40002\]/);
  });

  it('flags an auth code (40105) as isAuthError (drives TOKEN_EXPIRED)', async () => {
    mockSafeFetch.mockResolvedValue(res(true, 200, { code: 40105, message: 'access token invalid' }));
    const r = await setTiktokCampaignBudget('tok', 'adv_1', 'c9', 50);
    expect(r).toMatchObject({ ok: false, isAuthError: true });
  });

  it('does NOT flag a server code (50000) as isAuthError (stays retry-friendly)', async () => {
    mockSafeFetch.mockResolvedValue(res(true, 200, { code: 50000, message: 'internal error' }));
    const r = await setTiktokCampaignBudget('tok', 'adv_1', 'c9', 50);
    expect(r).toMatchObject({ ok: false, isAuthError: false });
  });

  it('returns ok:false (retry-friendly) when the transport throws', async () => {
    mockSafeFetch.mockRejectedValue(new Error('network down'));
    const r = await setTiktokCampaignBudget('tok', 'adv_1', 'c9', 50);
    expect(r).toMatchObject({ ok: false, isAuthError: false });
    expect(r.error).toMatch(/network down/);
  });
});

describe('setTiktokCampaignStatus', () => {
  it('maps ACTIVE→ENABLE and hits /campaign/status/update/ with a campaign_ids array', async () => {
    mockSafeFetch.mockResolvedValue(res(true, 200, { code: 0, data: {} }));
    const r = await setTiktokCampaignStatus('tok', 'adv_1', 'c9', 'ACTIVE');
    expect(r.ok).toBe(true);
    const [url, opts] = mockSafeFetch.mock.calls[0] as [string, any];
    expect(url).toBe('https://business-api.tiktok.com/open_api/v1.3/campaign/status/update/');
    const body = JSON.parse(opts.body);
    expect(body.advertiser_id).toBe('adv_1');
    expect(body.campaign_ids).toEqual(['c9']);
    expect(body.operation_status).toBe('ENABLE');
  });

  it('maps PAUSED→DISABLE', async () => {
    mockSafeFetch.mockResolvedValue(res(true, 200, { code: 0, data: {} }));
    await setTiktokCampaignStatus('tok', 'adv_1', 'c9', 'PAUSED');
    const body = JSON.parse((mockSafeFetch.mock.calls[0][1] as any).body);
    expect(body.operation_status).toBe('DISABLE');
  });

  it('returns ok:false with isAuthError on a token error code (40110)', async () => {
    mockSafeFetch.mockResolvedValue(res(true, 200, { code: 40110, message: 'not authorized' }));
    const r = await setTiktokCampaignStatus('tok', 'adv_1', 'c9', 'PAUSED');
    expect(r).toMatchObject({ ok: false, isAuthError: true });
  });
});
