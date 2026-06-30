import { Prisma } from '@prisma/client';

describe('AI media Prisma models', () => {
  it('exposes BrandKit and GeneratedAsset on the generated client', () => {
    expect(Prisma.ModelName.BrandKit).toBe('BrandKit');
    expect(Prisma.ModelName.GeneratedAsset).toBe('GeneratedAsset');
  });

  it('GeneratedAsset carries the credit-reconcile + idempotency fields', () => {
    const fields = Prisma.dmmf.datamodel.models
      .find((m) => m.name === 'GeneratedAsset')!
      .fields.map((f) => f.name);
    for (const f of [
      'providerRequestId', 'costCreditsReserved', 'costCredits',
      'r2Key', 'socialCampaignId', 'status', 'type',
    ]) {
      expect(fields).toContain(f);
    }
  });
});
