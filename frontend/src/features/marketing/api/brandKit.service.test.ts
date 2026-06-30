import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./marketingApi', () => ({
  default: { get: vi.fn(), put: vi.fn(), post: vi.fn() },
}));

import marketingApi from './marketingApi';
import { getBrandKit, updateBrandKit, uploadReferenceImage } from './brandKit.service';

const api = marketingApi as unknown as {
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
};

const KIT = {
  id: 'bk-1',
  logoUrl: null,
  logoR2Key: null,
  palette: ['#111111'],
  tone: 'friendly',
  referenceImages: [],
  defaultHashtags: ['#jeeta'],
  defaultCta: 'Book now',
  createdAt: '2026-06-30T00:00:00Z',
  updatedAt: '2026-06-30T00:00:00Z',
};

describe('brandKit.service', () => {
  beforeEach(() => vi.clearAllMocks());

  it('getBrandKit GETs /brand-kit', async () => {
    api.get.mockResolvedValue({ data: KIT });
    expect(await getBrandKit()).toEqual(KIT);
    expect(api.get).toHaveBeenCalledWith('/brand-kit');
  });

  it('updateBrandKit PUTs the payload', async () => {
    api.put.mockResolvedValue({ data: KIT });
    await updateBrandKit({ tone: 'bold', defaultHashtags: ['#a'] });
    expect(api.put).toHaveBeenCalledWith('/brand-kit', { tone: 'bold', defaultHashtags: ['#a'] });
  });

  it('uploadReferenceImage posts multipart form-data to /brand-kit/reference-image', async () => {
    api.post.mockResolvedValue({ data: KIT });
    const file = new File(['x'], 'ref.png', { type: 'image/png' });
    await uploadReferenceImage(file);
    expect(api.post).toHaveBeenCalledTimes(1);
    const [url, body, config] = api.post.mock.calls[0];
    expect(url).toBe('/brand-kit/reference-image');
    expect(body).toBeInstanceOf(FormData);
    expect((body as FormData).get('file')).toBe(file);
    expect(config).toEqual({ headers: { 'Content-Type': 'multipart/form-data' } });
  });
});
