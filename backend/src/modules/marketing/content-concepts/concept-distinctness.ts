/**
 * The distinctness contract for a batch of video concepts.
 *
 * ## What this can and cannot do — read this before trusting it
 *
 * The creative decision is an LLM's. Nothing here judges whether five concepts
 * are five genuinely different *angles*; no deterministic function can, and a
 * test that claimed to would be lying about its own strength.
 *
 * What IS enforceable is the shape of the failure we actually expect. The
 * observed failure mode of "give me five concepts" is not five bad ideas — it
 * is one idea, reworded five times, each rewrite carrying the same hook and the
 * same beats. That is mechanical, and mechanical duplication is measurable. So
 * this module holds three independent axes and refuses a batch that collides on
 * any of them:
 *
 *  1. `angle` — the one-word claim about WHICH lens this concept uses. Two
 *     concepts may not claim the same lens.
 *  2. `hook` — the opening line. Not just uniqueness: pairwise word overlap
 *     must stay under {@link HOOK_SIMILARITY_CEILING}, so "Bunun motoru yok"
 *     and "Bunun motoru yok!" are one hook, not two.
 *  3. the BODY — every shot's on-screen text, narration and visual description
 *     concatenated. Two concepts with different hooks bolted onto the same
 *     shot list are the single most likely way a paraphrase batch slips a
 *     hook-only check, so the same overlap measure runs over the whole body at
 *     the looser {@link BODY_SIMILARITY_CEILING}.
 *
 * ## Measured, not assumed
 *
 * Every number below is measured and pinned by a test in
 * `concept-distinctness.spec.ts`, so none of them can quietly stop being true.
 *
 * HOOKS. Against the reference batch the five genuinely-different hooks score
 * 0.00 to 0.10 pairwise, and a re-punctuated copy scores 1.00. A real
 * paraphrase — "Bu Strandbeest'in motoru yok" against "Bunun motoru yok" —
 * scores **0.33**: below the ceiling, so it passes. (The apostrophe is not a
 * letter, so "Strandbeest'in" tokenises as two words and the score is lower
 * than counting by eye suggests.)
 *
 * The ceiling is not tightened to catch it, because word overlap cuts both
 * ways: two legitimately different hooks cast in one template ("Diş implantı ne
 * kadar sürer?" / "Diş implantı ne kadar dayanır?") score 0.67 and would be
 * rejected by any ceiling this side of 0.7. A tighter number would buy one
 * paraphrase and cost real concepts, so the hook axis is deliberately tuned to
 * catch mechanical copies and nothing subtler.
 *
 * BODIES. The same instrument, the same limit, and worth stating separately
 * because the body axis is the one that sounds strongest. A body reused
 * VERBATIM under a new hook scores 1.00 and is caught. The same three beats,
 * same order, same claims, REWORDED the way a model rewords score **0.12** —
 * nowhere near the 0.70 ceiling, and accepted. So "catches a re-skin of the
 * same shot list" means a re-skin that reuses the WORDS; it does not mean
 * paraphrase.
 *
 * Honest limits, stated so nobody reads a green suite as more than it is:
 *  - a semantic paraphrase that shares few words passes, on either axis
 *    (0.33 hook / 0.12 body, both measured). Catching that needs a judge model,
 *    not a set operation.
 *  - the ceilings are calibrated against one reference batch, not a corpus.
 *  - passing says "these are not copies of each other". It does not say
 *    "these are good".
 *
 * A false positive here is loud, not silent: the caller refuses the batch and
 * says why, which is the correct direction for this repo's central rule (a
 * failure must never render as "no good ideas here").
 */

/** A concept must be planned shot by shot, or it is a caption, not a concept. */
export const MIN_SHOTS_PER_CONCEPT = 2;

/**
 * Hooks are short, so a shared subject noun already moves the score a lot;
 * half the words in common is as close as two openings may be.
 */
export const HOOK_SIMILARITY_CEILING = 0.5;

/**
 * Bodies are long and legitimately share the subject's whole vocabulary — five
 * angles on one Strandbeest all say "bacak", "pervane", "yürüyor". So the body
 * ceiling is deliberately looser than the hook's: it is there to catch a
 * re-skin of the same shot list, not to punish concepts for being about the
 * same thing.
 */
export const BODY_SIMILARITY_CEILING = 0.7;

export interface ConceptShotLike {
  onScreenText?: string;
  voiceover?: string;
  description: string;
}

export interface ConceptLike {
  angle: string;
  hook: string;
  shots: ConceptShotLike[];
}

/** Lower-cased, punctuation-stripped, whitespace-collapsed. */
export function normalizeForCompare(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Jaccard overlap over word tokens, 0..1.
 *
 * Two empty strings return 1, not 0. Returning 0 would make the emptiest
 * possible batch score as the most distinct one — the exact inversion that
 * lets a degenerate response through a similarity gate.
 */
export function tokenOverlap(a: string, b: string): number {
  const sa = new Set(normalizeForCompare(a).split(' ').filter(Boolean));
  const sb = new Set(normalizeForCompare(b).split(' ').filter(Boolean));
  if (sa.size === 0 && sb.size === 0) return 1;
  if (sa.size === 0 || sb.size === 0) return 0;
  let shared = 0;
  for (const t of sa) if (sb.has(t)) shared += 1;
  return shared / (sa.size + sb.size - shared);
}

/** Everything a concept SAYS and SHOWS, as one string. */
function bodyOf(c: ConceptLike): string {
  return (c.shots ?? [])
    .map((s) => `${s.onScreenText ?? ''} ${s.voiceover ?? ''} ${s.description ?? ''}`)
    .join(' ');
}

/**
 * Every way this batch fails the contract, in human-readable sentences.
 * An empty array means the contract holds.
 *
 * Concepts are named by 1-based position (`#1`, `#3`) so an error message
 * points at the two rows to compare rather than announcing that something,
 * somewhere, collided.
 */
export function conceptContractViolations(concepts: ConceptLike[]): string[] {
  const out: string[] = [];

  concepts.forEach((c, i) => {
    const at = `#${i + 1}`;
    if (!normalizeForCompare(c?.angle ?? '')) out.push(`concept ${at} has no angle`);
    if (!normalizeForCompare(c?.hook ?? '')) out.push(`concept ${at} has no hook`);
    const shots = c?.shots ?? [];
    if (shots.length < MIN_SHOTS_PER_CONCEPT) {
      out.push(
        `concept ${at} has ${shots.length} shot(s); a concept must be planned shot by shot (min ${MIN_SHOTS_PER_CONCEPT})`,
      );
    }
    shots.forEach((s, j) => {
      // A SILENT shot is legitimate — a whole concept can be wordless. A shot
      // with no visual description is not: nothing tells the generator what is
      // in frame, and the beat would render as an empty prompt.
      if (!normalizeForCompare(s?.description ?? '')) {
        out.push(`concept ${at} shot ${j + 1} has no visual description`);
      }
    });
  });

  for (let i = 0; i < concepts.length; i++) {
    for (let j = i + 1; j < concepts.length; j++) {
      const a = concepts[i];
      const b = concepts[j];
      const pair = `#${i + 1} and #${j + 1}`;

      if (normalizeForCompare(a?.angle ?? '') === normalizeForCompare(b?.angle ?? '')) {
        out.push(`concepts ${pair} claim the same angle ("${a?.angle}") — that is one concept, not two`);
      }

      const hookScore = tokenOverlap(a?.hook ?? '', b?.hook ?? '');
      if (hookScore >= HOOK_SIMILARITY_CEILING) {
        out.push(
          `concepts ${pair} share a hook (${hookScore.toFixed(2)} word overlap, ceiling ${HOOK_SIMILARITY_CEILING}): "${a?.hook}" vs "${b?.hook}"`,
        );
      }

      const bodyScore = tokenOverlap(bodyOf(a), bodyOf(b));
      if (bodyScore >= BODY_SIMILARITY_CEILING) {
        out.push(
          `concepts ${pair} are the same shot content reworded (${bodyScore.toFixed(2)} body overlap, ceiling ${BODY_SIMILARITY_CEILING})`,
        );
      }
    }
  }

  return out;
}
