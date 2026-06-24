import { isLinkedinAdsConfigured } from './ads.types';

describe('isLinkedinAdsConfigured', () => {
  const orig = process.env;
  beforeEach(() => {
    process.env = { ...orig };
  });
  afterAll(() => {
    process.env = orig;
  });

  it('returns false when both ads vars are missing', () => {
    delete process.env.LINKEDIN_ADS_CLIENT_ID;
    delete process.env.LINKEDIN_ADS_CLIENT_SECRET;
    expect(isLinkedinAdsConfigured()).toBe(false);
  });

  it('returns false when only the client id is set', () => {
    process.env.LINKEDIN_ADS_CLIENT_ID = 'cid';
    delete process.env.LINKEDIN_ADS_CLIENT_SECRET;
    expect(isLinkedinAdsConfigured()).toBe(false);
  });

  it('returns true when both ads vars are set', () => {
    process.env.LINKEDIN_ADS_CLIENT_ID = 'cid';
    process.env.LINKEDIN_ADS_CLIENT_SECRET = 'sec';
    expect(isLinkedinAdsConfigured()).toBe(true);
  });
});
