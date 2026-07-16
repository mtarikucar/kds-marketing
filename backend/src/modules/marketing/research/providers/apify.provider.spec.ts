import { ApifyProvider } from './apify.provider';

/** Mirrors the fetch-mock idiom in research-sources.spec.ts. */
describe('ApifyProvider.scrapeGoogleBusiness', () => {
  beforeEach(() => {
    delete process.env.APIFY_TOKEN;
    jest.restoreAllMocks();
  });

  it('unconfigured: resolves null and never calls fetch', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch' as never);
    const result = await new ApifyProvider().scrapeGoogleBusiness('Acme Cafe Izmir');
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('blank query short-circuits to null without calling fetch (even when configured)', async () => {
    process.env.APIFY_TOKEN = 'ap-test';
    const fetchSpy = jest.spyOn(globalThis, 'fetch' as never);
    const result = await new ApifyProvider().scrapeGoogleBusiness('   ');
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('configured: maps the actor row to a PlaceHit with mapped latestReviews', async () => {
    process.env.APIFY_TOKEN = 'ap-test';
    jest.spyOn(globalThis, 'fetch' as never).mockResolvedValue({
      ok: true,
      json: async () => [{ title: 'Acme Cafe', address: '123 Main', reviews: [{ text: 'great', stars: 5 }] }],
    } as never);

    const hit = await new ApifyProvider().scrapeGoogleBusiness('Acme Cafe');
    expect(hit).toEqual({
      placeId: undefined,
      name: 'Acme Cafe',
      address: '123 Main',
      city: undefined,
      region: undefined,
      phone: undefined,
      website: undefined,
      category: undefined,
      rating: undefined,
      reviewsCount: undefined,
      permanentlyClosed: undefined,
      latestReviews: [{ text: 'great', rating: 5, date: undefined }],
    });
  });

  it('configured, empty dataset: resolves null', async () => {
    process.env.APIFY_TOKEN = 'ap-test';
    jest.spyOn(globalThis, 'fetch' as never).mockResolvedValue({ ok: true, json: async () => [] } as never);
    const hit = await new ApifyProvider().scrapeGoogleBusiness('Nowhere Cafe');
    expect(hit).toBeNull();
  });
});

describe('ApifyProvider.scrapeSocial', () => {
  beforeEach(() => {
    delete process.env.APIFY_TOKEN;
    delete process.env.APIFY_FACEBOOK_ACTOR;
    delete process.env.APIFY_LINKEDIN_ACTOR;
    jest.restoreAllMocks();
  });

  it('unconfigured: resolves null and never calls fetch', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch' as never);
    const result = await new ApifyProvider().scrapeSocial('INSTAGRAM', '@acme');
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('configured INSTAGRAM: reuses the IG lookup path', async () => {
    process.env.APIFY_TOKEN = 'ap-test';
    jest.spyOn(globalThis, 'fetch' as never).mockResolvedValue({
      ok: true,
      json: async () => [{ username: 'acme', fullName: 'Acme', biography: 'we sell x', followersCount: 100 }],
    } as never);

    const hit = await new ApifyProvider().scrapeSocial('INSTAGRAM', 'acme');
    expect(hit).toEqual({
      handle: '@acme',
      fullName: 'Acme',
      bio: 'we sell x',
      followers: 100,
      website: undefined,
      isBusiness: undefined,
    });
  });

  it('configured FACEBOOK with no APIFY_FACEBOOK_ACTOR set: resolves null without calling fetch', async () => {
    process.env.APIFY_TOKEN = 'ap-test';
    const fetchSpy = jest.spyOn(globalThis, 'fetch' as never);
    const hit = await new ApifyProvider().scrapeSocial('FACEBOOK', 'acme');
    expect(hit).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('configured LINKEDIN with APIFY_LINKEDIN_ACTOR set: runs the actor and maps the row', async () => {
    process.env.APIFY_TOKEN = 'ap-test';
    process.env.APIFY_LINKEDIN_ACTOR = 'some~linkedin-actor';
    jest.spyOn(globalThis, 'fetch' as never).mockResolvedValue({
      ok: true,
      json: async () => [{ name: 'Acme LI', description: 'desc', followers: 50, url: 'https://linkedin.com/acme' }],
    } as never);

    const hit = await new ApifyProvider().scrapeSocial('LINKEDIN', 'acme');
    expect(hit).toEqual({
      handle: '@acme',
      fullName: 'Acme LI',
      bio: 'desc',
      followers: 50,
      website: 'https://linkedin.com/acme',
      isBusiness: undefined,
    });
  });

  it('blank handle short-circuits to null without calling fetch', async () => {
    process.env.APIFY_TOKEN = 'ap-test';
    const fetchSpy = jest.spyOn(globalThis, 'fetch' as never);
    const hit = await new ApifyProvider().scrapeSocial('INSTAGRAM', '   ');
    expect(hit).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('ApifyProvider.searchPlaces (mapPlace refactor regression)', () => {
  beforeEach(() => {
    delete process.env.APIFY_TOKEN;
    jest.restoreAllMocks();
  });

  it('output shape is unchanged after extracting the private mapPlace helper', async () => {
    process.env.APIFY_TOKEN = 'ap-test';
    jest.spyOn(globalThis, 'fetch' as never).mockResolvedValue({
      ok: true,
      json: async () => [
        {
          placeId: 'p1',
          title: 'Acme Cafe',
          address: '123 Main',
          city: 'Izmir',
          state: 'Izmir',
          phone: '+90 111',
          phoneUnformatted: '+90111',
          website: 'https://acme.example',
          categoryName: 'Cafe',
          totalScore: 4.5,
          reviewsCount: 10,
          permanentlyClosed: false,
          reviews: [{ text: 'great', stars: 5, publishedAtDate: '2024-01-01' }],
        },
      ],
    } as never);

    const rows = await new ApifyProvider().searchPlaces({ query: 'kuaför', geo: { country: 'TR' }, limit: 5 });
    expect(rows).toEqual([
      {
        placeId: 'p1',
        name: 'Acme Cafe',
        address: '123 Main',
        city: 'Izmir',
        region: 'Izmir',
        phone: '+90111',
        website: 'https://acme.example',
        category: 'Cafe',
        rating: 4.5,
        reviewsCount: 10,
        permanentlyClosed: false,
        latestReviews: [{ text: 'great', rating: 5, date: '2024-01-01' }],
      },
    ]);
  });
});
