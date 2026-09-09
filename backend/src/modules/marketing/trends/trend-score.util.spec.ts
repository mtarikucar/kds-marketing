import { brandRelevance, decayedScore, suggestionScore } from './trend-score.util';

const T0 = new Date('2026-09-08T00:00:00Z');
const hours = (h: number) => new Date(T0.getTime() + h * 3_600_000);

describe('decayedScore', () => {
  it('halves at exactly one half-life and quarters at two', () => {
    expect(decayedScore(80, T0, 36, hours(36))).toBeCloseTo(40, 6);
    expect(decayedScore(80, T0, 36, hours(72))).toBeCloseTo(20, 6);
  });

  it('is the raw score at the moment of observation and never grows for a clock skew into the past', () => {
    expect(decayedScore(55, T0, 48, T0)).toBe(55);
    expect(decayedScore(55, T0, 48, hours(-5))).toBe(55);
  });

  it('treats a non-positive half-life as "no decay" rather than dividing by zero', () => {
    expect(decayedScore(30, T0, 0, hours(100))).toBe(30);
  });
});

describe('brandRelevance', () => {
  it('is the fraction of the title\'s words (≥ 3 characters) that are brand vocabulary', () => {
    // title tokens {yeni, kahve, makinesi} ∩ brand {kahve, makinesi, filtre} = 2 of the title's 3
    expect(brandRelevance('Yeni kahve makinesi', ['kahve', 'makinesi', 'filtre'])).toBeCloseTo(2 / 3, 6);
  });

  it('is not diluted by the size of the brand keyword bag: an on-brand title scores 1.0 against 200 keywords', () => {
    // The planner's bag is every token of name + tagline + description + brief.
    // Jaccard put the whole bag in the denominator (3 / 200 ≈ 0.015 here) and
    // the 0.3 floor in the suggestion decided the ranking on raw score alone.
    const bag = Array.from({ length: 197 }, (_, i) => `kelime${i}`).concat(['figür', 'koleksiyon', 'hediye']);
    expect(brandRelevance('Figür koleksiyon hediye', bag)).toBe(1);
    expect(brandRelevance('Galatasaray derbi', bag)).toBe(0);
    // A half-on-brand title stays half: the denominator is the title, not the bag.
    expect(brandRelevance('Figür derbi', bag)).toBeCloseTo(0.5, 6);
    // Ranking consequence: a lukewarm on-brand trend outranks a hot off-brand one.
    expect(suggestionScore(50, brandRelevance('Figür koleksiyon hediye', bag))).toBeGreaterThan(suggestionScore(90, brandRelevance('Galatasaray derbi', bag)));
  });

  it('folds Turkish diacritics so "Ürün" matches "urun" and "İSTANBUL" matches "istanbul"', () => {
    expect(brandRelevance('Ürün lansmanı', ['urun'])).toBeCloseTo(0.5, 6);
    expect(brandRelevance('İSTANBUL', ['istanbul'])).toBe(1);
    expect(brandRelevance('Şık çanta', ['sik', 'canta'])).toBe(1);
  });

  it('splits multi-word brand keywords into tokens and ignores short/empty ones', () => {
    expect(brandRelevance('organik zeytinyağı', ['organik zeytinyağı', 've', ''])).toBe(1);
  });

  it('is 0 when either side has no usable tokens', () => {
    expect(brandRelevance('', ['kahve'])).toBe(0);
    expect(brandRelevance('kahve', [])).toBe(0);
    expect(brandRelevance('ab', ['ab'])).toBe(0);
  });
});

describe('suggestionScore', () => {
  it('is decayed * (0.3 + 0.7 * relevance): an irrelevant hit keeps 30%, a perfect one 100%', () => {
    expect(suggestionScore(50, 0)).toBeCloseTo(15, 6);
    expect(suggestionScore(50, 1)).toBeCloseTo(50, 6);
    expect(suggestionScore(50, 0.5)).toBeCloseTo(32.5, 6);
  });
});
