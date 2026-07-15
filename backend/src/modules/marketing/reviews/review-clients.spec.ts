import { safeFetch } from '../../../common/util/safe-fetch';
import { metaGraphFetch } from '../../../common/util/meta-graph.util';
import * as secretBox from '../../../common/crypto/secret-box.helper';
import { fetchSourceReviews, ReviewSourceRow } from './review-clients';

jest.mock('../../../common/util/safe-fetch', () => ({ safeFetch: jest.fn() }));
jest.mock('../../../common/util/meta-graph.util', () => ({ metaGraphFetch: jest.fn() }));

/**
 * A provider fetch must DISTINGUISH a hard failure (401/5xx/network) from a
 * genuine empty result: the sync sweep swallowed both as [] and then stamped
 * the source lastError:null + a fresh lastSyncedAt, so a revoked/expired token
 * read as healthy forever. Inert-config paths still return [] (not an error).
 */
describe('review-clients — hard provider failures throw (so the sweep stamps lastError)', () => {
  const OLD = { ...process.env };
  beforeEach(() => {
    jest.spyOn(secretBox, 'openSecret').mockReturnValue('plain-token');
  });
  afterEach(() => {
    process.env = { ...OLD };
    jest.restoreAllMocks();
    (safeFetch as jest.Mock).mockReset();
    (metaGraphFetch as jest.Mock).mockReset();
  });

  const googleSource: ReviewSourceRow = {
    id: 's1', type: 'GOOGLE', placeId: null, externalRef: 'accounts/1/locations/2', accessToken: 'sealed',
  };
  const fbSource: ReviewSourceRow = {
    id: 's2', type: 'FACEBOOK', placeId: '123', externalRef: null, accessToken: 'sealed',
  };

  it('GOOGLE: a non-OK response THROWS (was silently [] → healthy forever)', async () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'id';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'secret';
    (safeFetch as jest.Mock).mockResolvedValue({ ok: false, status: 401 });
    await expect(fetchSourceReviews(googleSource)).rejects.toThrow(/401/);
  });

  it('GOOGLE: an OK response with reviews maps + returns them (no throw on genuine success)', async () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'id';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'secret';
    (safeFetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ reviews: [{ reviewId: 'g1', starRating: 'ONE', comment: 'bad', reviewer: { displayName: 'A' }, createTime: '2026-01-01T00:00:00Z' }] }),
    });
    const out = await fetchSourceReviews(googleSource);
    expect(out).toEqual([expect.objectContaining({ externalReviewId: 'g1', rating: 1, text: 'bad' })]);
  });

  it('GOOGLE: an OK response with ZERO reviews returns [] (genuine empty, NOT an error)', async () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'id';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'secret';
    (safeFetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ reviews: [] }) });
    await expect(fetchSourceReviews(googleSource)).resolves.toEqual([]);
  });

  it('GOOGLE: not-configured / no location is INERT [] (never hits the API, never an error)', async () => {
    delete process.env.GOOGLE_OAUTH_CLIENT_ID; // provider app off
    await expect(fetchSourceReviews(googleSource)).resolves.toEqual([]);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it('FACEBOOK: a non-OK Graph result THROWS (was silently [])', async () => {
    process.env.META_APP_ID = 'a';
    process.env.META_APP_SECRET = 'b';
    (metaGraphFetch as jest.Mock).mockResolvedValue({ ok: false, status: 401, data: null });
    await expect(fetchSourceReviews(fbSource)).rejects.toThrow(/Facebook ratings API/);
  });
});
