import { describe, expect, it } from 'vitest';
import type { Rubric, ScoreRow } from '@/api/types';
import { prospectOut } from '@/test/leads';
import { countOf, filterChoices, keyWords, shortfalls, verdictOf } from './purpose';

const rubric: Rubric = {
  criteria: [
    { key: 'sube_sayisi', description: 'Birden fazla şubesi var mı', weight: 40 },
    { key: 'aktif_sosyal', description: 'Sosyal medyada düzenli paylaşım', weight: 60 },
  ],
  qualify_at: 60,
};

const scored = (points: [number, number]): ScoreRow => ({
  ...prospectOut(1).scores[0],
  score: points[0] + points[1],
  reasons: [
    { criterion: 'sube_sayisi', points: points[0], evidence: 'e', source: null },
    { criterion: 'aktif_sosyal', points: points[1], evidence: 'e', source: null },
  ],
});

describe('purpose words', () => {
  it('reads_a_workspace_key_as_words', () => {
    expect(keyWords('toplu_etkinlik', 'tr')).toBe('Toplu etkinlik');
    expect(keyWords('izmir__merkez', 'tr')).toBe('İzmir merkez');
    expect(keyWords('okul', 'en')).toBe('Okul');
    expect(keyWords('_', 'tr')).toBe('_');
  });

  it('offers_the_workspaces_values_then_what_the_pool_holds_with_counts', () => {
    const counted = [
      { key: 'bayi_adayi', count: 4 },
      { key: null, count: 7 },
      { key: 'okul_isbirligi', count: 2 },
    ];
    const label = (v: string) => v.toUpperCase();
    // Known first (one the pool does not hold counts 0), then the counted others, then the
    // current value; "without one" is never a choice.
    expect(filterChoices(['okul_isbirligi', 'fuar'], counted, 'eski_kapi', label)).toEqual([
      { value: 'okul_isbirligi', label: 'OKUL_ISBIRLIGI', count: 2 },
      { value: 'fuar', label: 'FUAR', count: 0 },
      { value: 'bayi_adayi', label: 'BAYI_ADAYI', count: 4 },
      { value: 'eski_kapi', label: 'ESKI_KAPI', count: 0 },
    ]);
    // Not counted (the counts could not be read): no numbers at all.
    expect(filterChoices(['fuar'], undefined, '', label)).toEqual([{ value: 'fuar', label: 'FUAR', count: null }]);
    expect(countOf(counted, null)).toBe(7);
    expect(countOf(counted, 'yok')).toBe(0);
    expect(countOf(undefined, 'okul_isbirligi')).toBeNull();
  });
});

describe('verdict', () => {
  it('passes_at_the_threshold_of_the_rubric_it_was_scored_under', () => {
    expect(verdictOf(scored([30, 30]), rubric)).toEqual({ kind: 'passed', score: 60, threshold: 60 });
    expect(verdictOf(undefined, rubric)).toEqual({ kind: 'unscored' });
    // Without the rubric, only the score is known.
    expect(verdictOf(scored([10, 10]), null)).toEqual({ kind: 'scored', score: 20 });
  });

  it('names_where_a_low_score_fell_short_largest_loss_first', () => {
    expect(verdictOf(scored([10, 20]), rubric)).toEqual({
      kind: 'below',
      score: 30,
      threshold: 60,
      short: [
        { criterion: 'aktif_sosyal', points: 20, weight: 60 },
        { criterion: 'sube_sayisi', points: 10, weight: 40 },
      ],
    });
    // A criterion that gave all its points is no shortfall.
    expect(shortfalls(scored([40, 5]), rubric)).toEqual([{ criterion: 'aktif_sosyal', points: 5, weight: 60 }]);
    expect(shortfalls(scored([0, 0]), rubric, 1)).toEqual([{ criterion: 'aktif_sosyal', points: 0, weight: 60 }]);
  });
});
