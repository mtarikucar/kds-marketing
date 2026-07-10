import { AdWriteCapabilityService } from './ad-write-capability.service';

jest.mock('./ads.types', () => ({
  isMetaAdsConfigured: jest.fn(),
  isTiktokAdsConfigured: jest.fn(),
  isLinkedinAdsConfigured: jest.fn(),
  isGoogleAdsConfigured: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const gates = require('./ads.types') as {
  isMetaAdsConfigured: jest.Mock;
  isTiktokAdsConfigured: jest.Mock;
  isLinkedinAdsConfigured: jest.Mock;
  isGoogleAdsConfigured: jest.Mock;
};
const { isMetaAdsConfigured } = gates;

describe('AdWriteCapabilityService', () => {
  beforeEach(() => {
    // Default every gate OFF; individual tests flip what they need.
    for (const g of Object.values(gates)) g.mockReset().mockReturnValue(false);
  });

  it('reports Meta as fully write-capable (gated on configuration)', () => {
    isMetaAdsConfigured.mockReturnValue(true);
    const svc = new AdWriteCapabilityService();
    const meta = svc.get('META');
    expect(meta).toMatchObject({ setBudget: true, pauseResume: true, createCampaign: true, configured: true });
    expect(svc.canWriteBudget('META')).toBe(true);
  });

  it('cannot write to Meta when creds are absent', () => {
    isMetaAdsConfigured.mockReturnValue(false);
    const svc = new AdWriteCapabilityService();
    expect(svc.get('META').configured).toBe(false);
    expect(svc.canWriteBudget('META')).toBe(false);
  });

  it('TikTok/LinkedIn support budget + pause/resume + audience sync when configured', () => {
    gates.isTiktokAdsConfigured.mockReturnValue(true);
    gates.isLinkedinAdsConfigured.mockReturnValue(true);
    const svc = new AdWriteCapabilityService();
    for (const p of ['TIKTOK', 'LINKEDIN']) {
      expect(svc.canWriteBudget(p)).toBe(true);
      expect(svc.canPauseResume(p)).toBe(true);
      expect(svc.canSyncAudience(p)).toBe(true);
    }
  });

  it('TikTok/LinkedIn write is inert when creds are absent', () => {
    const svc = new AdWriteCapabilityService(); // all gates false
    expect(svc.canWriteBudget('TIKTOK')).toBe(false);
    expect(svc.canSyncAudience('LINKEDIN')).toBe(false);
  });

  it('Google supports budget + pause/resume (not audience) when configured', () => {
    gates.isGoogleAdsConfigured.mockReturnValue(true);
    const svc = new AdWriteCapabilityService();
    expect(svc.canWriteBudget('GOOGLE')).toBe(true);
    expect(svc.canPauseResume('GOOGLE')).toBe(true);
    expect(svc.canSyncAudience('GOOGLE')).toBe(false); // Customer-Match not shipped
    expect(svc.get('GOOGLE').note).toMatch(/Google Ads API/);
  });

  it('handles an unknown provider safely', () => {
    const svc = new AdWriteCapabilityService();
    expect(svc.canWriteBudget('SNAPCHAT')).toBe(false);
    expect(svc.get('SNAPCHAT').note).toMatch(/Unknown/);
  });

  it('all() returns the full matrix', () => {
    const svc = new AdWriteCapabilityService();
    expect(svc.all().map((c) => c.provider).sort()).toEqual(['GOOGLE', 'LINKEDIN', 'META', 'TIKTOK']);
  });
});
