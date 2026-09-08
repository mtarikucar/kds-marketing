/**
 * Pure scoring for trend signals. Three numbers decide whether a trend earns a
 * hook in a programme slot:
 *
 *   decayed    = score · 0.5^(hoursSinceObserved / halfLifeHours)
 *   relevance  = token Jaccard(title, brand keywords)            — no embeddings, no key
 *   suggestion = decayed · (0.3 + 0.7 · relevance)
 *
 * WHY a floor of 0.3 in the suggestion: a hot but off-brand trend still
 * deserves a look (the planner can bend it), it just must not outrank a
 * lukewarm on-brand one. WHY Jaccard on folded tokens: brand keywords come
 * from a Turkish BrandProfile ("Ürün", "İstanbul") while provider titles
 * arrive in whatever casing the source used, so comparison strips diacritics
 * and the dotless/dotted i before matching.
 */

const MIN_TOKEN_LEN = 3;

export function decayedScore(score: number, observedAt: Date, halfLifeHours: number, now: Date): number {
  if (!(halfLifeHours > 0)) return score;
  const hours = Math.max(0, (now.getTime() - observedAt.getTime()) / 3_600_000);
  return score * Math.pow(0.5, hours / halfLifeHours);
}

/** Lower-case + diacritic-fold: "Ürün" → "urun", "İSTANBUL" → "istanbul", "ı" → "i". */
export function foldTurkish(s: string): string {
  return s
    .replace(/İ/g, 'i')
    .replace(/I/g, 'i') // Turkish upper-case I lower-cases to dotless ı; we want plain i
    .replace(/ı/g, 'i')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Words of ≥ 3 letters/digits after folding. Exported for the planner's dedupe. */
export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of foldTurkish(text ?? '').split(/[^\p{L}\p{N}]+/u)) {
    if (w.length >= MIN_TOKEN_LEN) out.add(w);
  }
  return out;
}

export function brandRelevance(title: string, brandKeywords: string[]): number {
  const a = tokenize(title);
  const b = tokenize((brandKeywords ?? []).join(' '));
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function suggestionScore(decayed: number, relevance: number): number {
  return decayed * (0.3 + 0.7 * relevance);
}
