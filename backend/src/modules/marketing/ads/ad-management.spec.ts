import { BadRequestException } from '@nestjs/common';
import * as client from './meta-ads-management.client';
import * as tiktok from './tiktok-ads.client';
import * as linkedin from './linkedin-ads.client';
import { AdManagementService } from './ad-management.service';
import { AdWriteCapabilityService } from './ad-write-capability.service';

jest.mock('./meta-ads-management.client');
jest.mock('./tiktok-ads.client');
jest.mock('./linkedin-ads.client');
jest.mock('../../../common/crypto/secret-box.helper', () => ({ openSecret: () => 'TOKEN' }));
jest.mock('../../../common/util/safe-fetch', () => ({
  safeFetch: jest.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }),
}));

const mClient = client as jest.Mocked<typeof client>;
const mTiktok = tiktok as jest.Mocked<typeof tiktok>;
const mLinkedin = linkedin as jest.Mocked<typeof linkedin>;

describe('AdManagementService', () => {
  let prisma: any;
  let mediaGen: { getAsset: jest.Mock };
  let svc: AdManagementService;

  beforeAll(() => {
    process.env.META_APP_ID = 'app';
    process.env.META_APP_SECRET = 'secret';
    process.env.TIKTOK_BUSINESS_APP_ID = 'a';
    process.env.TIKTOK_BUSINESS_APP_SECRET = 'b';
    process.env.LINKEDIN_ADS_CLIENT_ID = 'c';
    process.env.LINKEDIN_ADS_CLIENT_SECRET = 'd';
  });
  afterAll(() => {
    for (const k of ['META_APP_ID', 'META_APP_SECRET', 'TIKTOK_BUSINESS_APP_ID', 'TIKTOK_BUSINESS_APP_SECRET', 'LINKEDIN_ADS_CLIENT_ID', 'LINKEDIN_ADS_CLIENT_SECRET']) delete process.env[k];
  });
  beforeEach(() => {
    prisma = {
      adAccount: { findFirst: jest.fn(), update: jest.fn().mockResolvedValue({}) },
      socialAccount: { findFirst: jest.fn().mockResolvedValue({ externalId: 'page-1' }) },
    };
    mediaGen = { getAsset: jest.fn() };
    svc = new AdManagementService(prisma, new AdWriteCapabilityService(), mediaGen as any);
    jest.clearAllMocks();
  });

  const metaAcc = () => ({ id: 'acc', workspaceId: 'ws', provider: 'META', externalAdId: 'act_1', accessToken: 'sealed', currency: 'TRY' });

  it('rejects management on a non-Meta account', async () => {
    prisma.adAccount.findFirst.mockResolvedValue({ id: 'acc', provider: 'TIKTOK', accessToken: 'x' });
    await expect(svc.campaigns('ws', 'acc')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lists campaigns with budgets converted cents→major', async () => {
    prisma.adAccount.findFirst.mockResolvedValue(metaAcc());
    mClient.listCampaigns.mockResolvedValue({
      ok: true,
      items: [{ id: 'c1', name: 'C1', status: 'ACTIVE', dailyBudget: 5000, lifetimeBudget: null }],
    });
    const out = await svc.campaigns('ws', 'acc');
    expect(out[0].dailyBudget).toBe(50);
    expect(mClient.listCampaigns).toHaveBeenCalledWith('TOKEN', 'act_1');
  });

  it('setDailyBudget converts major→cents', async () => {
    prisma.adAccount.findFirst.mockResolvedValue(metaAcc());
    mClient.updateEntity.mockResolvedValue({ ok: true, id: 'c1' });
    await svc.setDailyBudget('ws', 'acc', 'c1', 75);
    expect(mClient.updateEntity).toHaveBeenCalledWith('TOKEN', 'c1', { daily_budget: 7500 });
  });

  it('setStatus rejects an invalid status', async () => {
    prisma.adAccount.findFirst.mockResolvedValue(metaAcc());
    await expect(svc.setStatus('ws', 'acc', 'c1', 'FOO' as any)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('flips account to TOKEN_EXPIRED on an auth error', async () => {
    prisma.adAccount.findFirst.mockResolvedValue(metaAcc());
    mClient.listCampaigns.mockResolvedValue({ ok: false, items: [], error: 'bad token', isAuthError: true });
    await expect(svc.campaigns('ws', 'acc')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.adAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'TOKEN_EXPIRED' }) }),
    );
  });

  it('setDailyBudget on TikTok passes MAJOR units (no ×100)', async () => {
    prisma.adAccount.findFirst.mockResolvedValue({ id: 'tt', workspaceId: 'ws', provider: 'TIKTOK', externalAdId: 'adv-1', accessToken: 'x', currency: 'TRY' });
    mTiktok.setTiktokCampaignBudget.mockResolvedValue({ ok: true, id: 'c1' });
    await svc.setDailyBudget('ws', 'tt', 'c1', 75);
    expect(mTiktok.setTiktokCampaignBudget).toHaveBeenCalledWith('TOKEN', 'adv-1', 'c1', 75);
    expect(mClient.updateEntity).not.toHaveBeenCalled();
  });

  it('setStatus on TikTok routes to the status endpoint', async () => {
    prisma.adAccount.findFirst.mockResolvedValue({ id: 'tt', workspaceId: 'ws', provider: 'TIKTOK', externalAdId: 'adv-1', accessToken: 'x', currency: 'TRY' });
    mTiktok.setTiktokCampaignStatus.mockResolvedValue({ ok: true, id: 'c1' });
    await svc.setStatus('ws', 'tt', 'c1', 'PAUSED');
    expect(mTiktok.setTiktokCampaignStatus).toHaveBeenCalledWith('TOKEN', 'adv-1', 'c1', 'PAUSED');
  });

  it('setDailyBudget on LinkedIn passes major units + currency (and needs a currency)', async () => {
    prisma.adAccount.findFirst.mockResolvedValue({ id: 'li', workspaceId: 'ws', provider: 'LINKEDIN', externalAdId: '512', accessToken: 'x', currency: 'USD' });
    mLinkedin.updateLinkedinCampaign.mockResolvedValue({ ok: true, id: 'c1' });
    await svc.setDailyBudget('ws', 'li', 'c1', 40);
    expect(mLinkedin.updateLinkedinCampaign).toHaveBeenCalledWith('TOKEN', 'c1', { dailyBudgetMajor: 40, currencyCode: 'USD' });
  });

  it('setDailyBudget on LinkedIn without a currency is rejected', async () => {
    prisma.adAccount.findFirst.mockResolvedValue({ id: 'li', workspaceId: 'ws', provider: 'LINKEDIN', externalAdId: '512', accessToken: 'x', currency: null });
    await expect(svc.setDailyBudget('ws', 'li', 'c1', 40)).rejects.toBeInstanceOf(BadRequestException);
  });

  const launchDto = () => ({
    generatedAssetId: 'asset-1', adsetName: 'Set A', dailyBudget: 50,
    optimizationGoal: 'LINK_CLICKS', billingEvent: 'IMPRESSIONS',
    targeting: { geo_locations: { countries: ['TR'] } }, link: 'https://x.com',
    primaryText: 'Buy now', callToAction: 'SHOP_NOW',
  });

  it('launchAdFromCreative builds campaign→adset→image creative→ad from a READY asset', async () => {
    prisma.adAccount.findFirst.mockResolvedValue(metaAcc());
    mediaGen.getAsset.mockResolvedValue({ id: 'asset-1', status: 'READY', url: 'https://r2/img.png', type: 'IMAGE', mime: 'image/png' });
    mClient.createCampaign.mockResolvedValue({ ok: true, id: 'cmp-1' });
    mClient.createAdSet.mockResolvedValue({ ok: true, id: 'as-1' });
    mClient.uploadAdImage.mockResolvedValue({ ok: true, id: 'hash-1' });
    mClient.createAdCreative.mockResolvedValue({ ok: true, id: 'cr-1' });
    mClient.createAd.mockResolvedValue({ ok: true, id: 'ad-1' });

    const out = await svc.launchAdFromCreative('ws', 'acc', launchDto() as any);
    expect(out).toEqual({ campaignId: 'cmp-1', adsetId: 'as-1', creativeId: 'cr-1', adId: 'ad-1', status: 'PAUSED' });
    expect(mClient.createAdSet).toHaveBeenCalledWith('TOKEN', 'act_1', expect.objectContaining({ dailyBudgetCents: 5000, campaignId: 'cmp-1' }));
    expect(mClient.uploadAdImage).toHaveBeenCalledWith('TOKEN', 'act_1', expect.any(String));
    expect(mClient.createAdCreative).toHaveBeenCalledWith('TOKEN', 'act_1', expect.objectContaining({ pageId: 'page-1', linkData: expect.objectContaining({ image_hash: 'hash-1' }) }));
    expect(mClient.uploadAdVideo).not.toHaveBeenCalled();
  });

  it('launchAdFromCreative uses the video pull-from-URL path for a video asset', async () => {
    prisma.adAccount.findFirst.mockResolvedValue(metaAcc());
    mediaGen.getAsset.mockResolvedValue({ id: 'asset-1', status: 'READY', url: 'https://r2/v.mp4', type: 'VIDEO', mime: 'video/mp4' });
    mClient.createCampaign.mockResolvedValue({ ok: true, id: 'cmp-1' });
    mClient.createAdSet.mockResolvedValue({ ok: true, id: 'as-1' });
    mClient.uploadAdVideo.mockResolvedValue({ ok: true, id: 'vid-1' });
    mClient.waitVideoReady.mockResolvedValue({ ok: true, id: 'vid-1' });
    mClient.createAdCreative.mockResolvedValue({ ok: true, id: 'cr-1' });
    mClient.createAd.mockResolvedValue({ ok: true, id: 'ad-1' });
    await svc.launchAdFromCreative('ws', 'acc', launchDto() as any);
    expect(mClient.uploadAdVideo).toHaveBeenCalledWith('TOKEN', 'act_1', 'https://r2/v.mp4', 'Set A');
    expect(mClient.waitVideoReady).toHaveBeenCalledWith('TOKEN', 'vid-1');
    expect(mClient.createAdCreative).toHaveBeenCalledWith('TOKEN', 'act_1', expect.objectContaining({ videoData: expect.objectContaining({ video_id: 'vid-1' }) }));
    expect(mClient.uploadAdImage).not.toHaveBeenCalled();
  });

  it('launchAdFromCreative rejects when no Facebook Page is connected', async () => {
    prisma.adAccount.findFirst.mockResolvedValue(metaAcc());
    prisma.socialAccount.findFirst.mockResolvedValue(null);
    await expect(svc.launchAdFromCreative('ws', 'acc', launchDto() as any)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('launchAdFromCreative rejects an asset that is not READY', async () => {
    prisma.adAccount.findFirst.mockResolvedValue(metaAcc());
    mediaGen.getAsset.mockResolvedValue({ id: 'asset-1', status: 'PENDING', url: null });
    await expect(svc.launchAdFromCreative('ws', 'acc', launchDto() as any)).rejects.toBeInstanceOf(BadRequestException);
  });
});
