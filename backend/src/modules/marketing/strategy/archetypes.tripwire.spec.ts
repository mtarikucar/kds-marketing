import { ARCHETYPES, archetypeMeta } from './archetypes';
import { BusinessArchetype } from './strategy.types';

/**
 * Archetype-registry tripwire. The archetype set + the shape of each entry are a
 * design decision the rest of the engine (intake question deltas, synthesis
 * channel priors, orchestrator lead approach) depends on. Pinning the key set
 * turns "added/removed an archetype without wiring its priors" into a red build,
 * mirroring ai-credit-costs.tripwire.
 */
describe('archetypes — registry tripwire', () => {
  it('pins the archetype key set', () => {
    expect(Object.keys(ARCHETYPES).sort()).toEqual([
      'B2B_LOCAL_SERVICE',
      'B2B_SAAS',
      'B2C_COMMUNITY_NICHE',
      'B2C_ECOMMERCE',
      'CREATOR_MEDIA',
      'LOCAL_RETAIL_FOOD',
      'OTHER',
    ]);
  });

  it('every archetype has all three fields with valid shapes', () => {
    for (const [key, meta] of Object.entries(ARCHETYPES)) {
      // channelPriors: non-empty Record<string, number> with every score in 0..1
      expect(Object.keys(meta.channelPriors).length).toBeGreaterThan(0);
      for (const [channel, score] of Object.entries(meta.channelPriors)) {
        expect(channel.length).toBeGreaterThan(0);
        expect(typeof score).toBe('number');
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
      // interviewDeltas: string[]
      expect(Array.isArray(meta.interviewDeltas)).toBe(true);
      for (const d of meta.interviewDeltas) {
        expect(typeof d).toBe('string');
        expect(d.length).toBeGreaterThan(0);
      }
      // leadApproach: the two-value union
      expect(['B2B_PROSPECT', 'B2C_AUDIENCE']).toContain(meta.leadApproach);
      // archetypeMeta(key) returns the same entry
      expect(archetypeMeta(key as BusinessArchetype)).toBe(meta);
    }
  });

  it('classifies the lead approach per archetype', () => {
    expect(ARCHETYPES.B2C_COMMUNITY_NICHE.leadApproach).toBe('B2C_AUDIENCE');
    expect(ARCHETYPES.B2C_ECOMMERCE.leadApproach).toBe('B2C_AUDIENCE');
    expect(ARCHETYPES.CREATOR_MEDIA.leadApproach).toBe('B2C_AUDIENCE');
    expect(ARCHETYPES.B2B_LOCAL_SERVICE.leadApproach).toBe('B2B_PROSPECT');
    expect(ARCHETYPES.B2B_SAAS.leadApproach).toBe('B2B_PROSPECT');
    expect(ARCHETYPES.LOCAL_RETAIL_FOOD.leadApproach).toBe('B2B_PROSPECT');
    expect(ARCHETYPES.OTHER.leadApproach).toBe('B2B_PROSPECT');
  });

  it('favors community/reddit for the B2C niche and maps/linkedin for B2B', () => {
    const niche = ARCHETYPES.B2C_COMMUNITY_NICHE.channelPriors;
    expect(niche.reddit).toBeGreaterThanOrEqual(0.8);
    expect(niche.discord).toBeGreaterThanOrEqual(0.7);

    expect(ARCHETYPES.B2B_LOCAL_SERVICE.channelPriors['google-maps']).toBeGreaterThanOrEqual(0.8);
    expect(ARCHETYPES.B2B_SAAS.channelPriors.linkedin).toBeGreaterThanOrEqual(0.8);
  });
});
