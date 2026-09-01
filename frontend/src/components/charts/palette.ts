/**
 * The categorical order charts assign series colours in.
 *
 * Two rules make this a constant rather than a loop over `--chart-1..8`.
 *
 * FIXED ORDER, NEVER CYCLED. A series takes the next unused slot and keeps it.
 * Colour follows the entity, not its rank — if a filter drops Instagram, the
 * remaining series must not shuffle up into new hues, because a reader who
 * learned "LinkedIn is purple" would then be reading a different chart than the
 * one they think they are.
 *
 * ONLY FIVE OF THE EIGHT TOKENS. `--chart-3` and `--chart-8` sit below the
 * chroma floor in both themes — they read as gray rather than as an identity —
 * and in dark mode the two are indistinguishable from each other under
 * deuteranopia. `--chart-7` is a teal that lands too close to `--chart-4`'s
 * green for a colour-blind reader once they are adjacent. The five below were
 * checked as an ordered set in both themes against their real surfaces for the
 * lightness band, the chroma floor, adjacent-pair CVD separation under protan /
 * deutan / tritan, the normal-vision floor and 3:1 contrast. Adding a sixth
 * means re-running that check on the new adjacency, not appending a nice hue.
 *
 * A sixth CATEGORY does not get a sixth colour: fold the tail into "other" with
 * {@link OTHER_SERIES_VAR}, which is muted on purpose — "everything else" is not
 * an identity and must not compete with the five that are.
 */
export const CHART_SERIES_VARS = [
  'var(--chart-1)', // blue
  'var(--chart-2)', // orange
  'var(--chart-4)', // green
  'var(--chart-6)', // violet
  'var(--chart-5)', // red
] as const;

/** The most series that may carry their own identity colour. */
export const MAX_SERIES = CHART_SERIES_VARS.length;

/** The catch-all bucket. Deliberately a text token, not a chart slot. */
export const OTHER_SERIES_VAR = 'var(--muted-foreground)';

/** Slot `i`, wrapping into the muted "other" rather than cycling the hues. */
export const seriesVar = (i: number): string =>
  i < MAX_SERIES ? CHART_SERIES_VARS[i] : OTHER_SERIES_VAR;
