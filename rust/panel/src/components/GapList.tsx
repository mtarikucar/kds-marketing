import type { Gap } from '@/api/types';

/**
 * A refusal's gaps (a capability's: a dotted path and what is wrong with it), as the server words
 * them, so nothing is ever hidden. The strategy's own gap sentences went with its page.
 */
export function gapText(gap: Gap): string {
  return gap.message;
}

/** Gaps as a person reads them; the dotted path stays available as a tooltip for whoever debugs. */
export function GapList({ gaps }: { gaps: readonly Gap[] }) {
  if (gaps.length === 0) return null;
  return (
    <ul className="flex list-disc flex-col gap-2 ps-5">
      {gaps.map((gap, i) => (
        <li key={`${gap.field}-${i}`} className="text-sm leading-relaxed text-foreground" title={gap.field}>
          {gapText(gap)}
        </li>
      ))}
    </ul>
  );
}
