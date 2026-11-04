import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { Gap } from '@/api/types';

/**
 * The server's gap paths (jt_strategy rules), each with the panel's own sentence. The server's
 * message is English and written for the agent too; a person reads these instead, and an unknown
 * path falls back to the server's words so nothing is ever hidden.
 */
const KNOWN: ReadonlyArray<[RegExp, (t: TFunction, m: RegExpMatchArray) => string]> = [
  [/^identity\.product$/, (t) => t('strategy.gaps.product')],
  [/^audience$/, (t) => t('strategy.gaps.segment')],
  [/^audience\[(\d+)\]\.key$/, (t, m) => t('strategy.gaps.segmentKey', { n: Number(m[1]) + 1 })],
  [/^channels$/, (t) => t('strategy.gaps.channel')],
  [/^channels\[(\d+)\]\.channel$/, (t, m) => t('strategy.gaps.channelUnavailable', { n: Number(m[1]) + 1 })],
  [/^budget_frame/, (t) => t('strategy.gaps.budget')],
  [/^cadence/, (t) => t('strategy.gaps.cadence')],
  [/^hypotheses$/, (t) => t('strategy.gaps.hypothesis')],
  [/^hypotheses\[(\d+)\]\.(title|angle|metric)$/, (t, m) =>
    t('strategy.gaps.hypothesisField', { n: Number(m[1]) + 1, field: t(`strategy.gaps.hypothesisFields.${m[2] as 'title' | 'angle' | 'metric'}`) })],
  [/^hypotheses\[(\d+)\]\.segment_key$/, (t, m) => t('strategy.gaps.hypothesisSegment', { n: Number(m[1]) + 1 })],
  [/^hypotheses\[(\d+)\]\.channel$/, (t, m) => t('strategy.gaps.hypothesisChannel', { n: Number(m[1]) + 1 })],
  [/^hypotheses\[(\d+)\]\.id$/, (t, m) => t('strategy.gaps.hypothesisDuplicate', { n: Number(m[1]) + 1 })],
];

/** The panel's sentence for one gap, or the server's message for a path it does not know. */
export function gapText(t: TFunction, gap: Gap): string {
  for (const [pattern, text] of KNOWN) {
    const m = gap.field.match(pattern);
    if (m) return text(t, m);
  }
  return gap.message;
}

/** Gaps as a person reads them; the dotted path stays available as a tooltip for whoever debugs. */
export function GapList({ gaps }: { gaps: readonly Gap[] }) {
  const { t } = useTranslation();
  if (gaps.length === 0) return null;
  return (
    <ul className="flex list-disc flex-col gap-1 ps-5">
      {gaps.map((gap, i) => (
        <li key={`${gap.field}-${i}`} className="text-sm text-foreground" title={gap.field}>
          {gapText(t, gap)}
        </li>
      ))}
    </ul>
  );
}
