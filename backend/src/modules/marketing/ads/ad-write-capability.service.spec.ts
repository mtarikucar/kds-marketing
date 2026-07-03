import { AdWriteCapabilityService } from './ad-write-capability.service';

jest.mock('./ads.types', () => ({ isMetaAdsConfigured: jest.fn() }));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isMetaAdsConfigured } = require('./ads.types') as { isMetaAdsConfigured: jest.Mock };

describe('AdWriteCapabilityService', () => {
  beforeEach(() => isMetaAdsConfigured.mockReset());

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

  it('reports TikTok/LinkedIn as read-only and Google as absent', () => {
    isMetaAdsConfigured.mockReturnValue(true);
    const svc = new AdWriteCapabilityService();
    expect(svc.canWriteBudget('TIKTOK')).toBe(false);
    expect(svc.canWriteBudget('LINKEDIN')).toBe(false);
    expect(svc.canWriteBudget('GOOGLE')).toBe(false);
    expect(svc.get('GOOGLE').note).toMatch(/Google Ads API/);
  });

  it('handles an unknown provider safely', () => {
    isMetaAdsConfigured.mockReturnValue(true);
    const svc = new AdWriteCapabilityService();
    expect(svc.canWriteBudget('SNAPCHAT')).toBe(false);
    expect(svc.get('SNAPCHAT').note).toMatch(/Unknown/);
  });

  it('all() returns the full matrix', () => {
    isMetaAdsConfigured.mockReturnValue(false);
    const svc = new AdWriteCapabilityService();
    expect(svc.all().map((c) => c.provider).sort()).toEqual(['GOOGLE', 'LINKEDIN', 'META', 'TIKTOK']);
  });
});
