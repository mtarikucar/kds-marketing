/**
 * brandKit.service.ts — typed Brand Kit API (spec §5.2 / §8).
 * One kit per workspace; paths relative to /marketing.
 */
import marketingApi from './marketingApi';

export interface BrandKitMedia {
  url: string;
  r2Key: string;
  mime: string;
}

export interface BrandKit {
  id: string;
  logoUrl?: string | null;
  logoR2Key?: string | null;
  palette: string[];
  tone?: string | null;
  referenceImages: BrandKitMedia[];
  defaultHashtags: string[];
  defaultCta?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BrandKitPayload {
  logoUrl?: string | null;
  logoR2Key?: string | null;
  palette?: string[];
  tone?: string | null;
  defaultHashtags?: string[];
  defaultCta?: string | null;
}

export const getBrandKit = (): Promise<BrandKit> =>
  marketingApi.get('/brand-kit').then((r) => r.data);

export const updateBrandKit = (p: BrandKitPayload): Promise<BrandKit> =>
  marketingApi.put('/brand-kit', p).then((r) => r.data);

export const uploadReferenceImage = (file: File): Promise<BrandKit> => {
  const fd = new FormData();
  fd.append('file', file);
  return marketingApi
    .post('/brand-kit/reference-image', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    .then((r) => r.data);
};
