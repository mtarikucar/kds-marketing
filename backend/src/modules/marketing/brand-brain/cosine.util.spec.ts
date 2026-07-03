import { cosineSimilarity } from './cosine.util';

describe('cosineSimilarity', () => {
  it('is 1 for identical direction, 0 for orthogonal, -1 for opposite', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it('is scale-invariant', () => {
    expect(cosineSimilarity([2, 0], [5, 0])).toBeCloseTo(1);
  });

  it('returns 0 for empty / mismatched / zero vectors instead of throwing', () => {
    expect(cosineSimilarity([], [1, 2])).toBe(0);
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});
