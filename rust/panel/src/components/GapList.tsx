import type { Gap } from '@/api/types';

/**
 * Gaps as the server lists them: the field's dotted path and what is wrong with it. The message is
 * the server's own (English, written for the agent too); the path tells a person where to look.
 */
export function GapList({ gaps }: { gaps: readonly Gap[] }) {
  if (gaps.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1">
      {gaps.map((gap, i) => (
        <li key={`${gap.field}-${i}`} className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <code className="font-mono text-micro text-muted-foreground">{gap.field}</code>
          <span className="text-foreground">{gap.message}</span>
        </li>
      ))}
    </ul>
  );
}
