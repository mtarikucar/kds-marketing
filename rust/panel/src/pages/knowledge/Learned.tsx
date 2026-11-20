import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import * as studio from '@/api/studio';
import { useSession } from '@/auth/useSession';
import { canAny } from '@/lib/roles';
import { useOverviewWindow, useStudioKey } from '../StudioShared';

/** The owner's own requests are measured on their own arms (§3.5): not a topic of the page. */
const OWNER_REQUEST_SEGMENT = 'owner_request';

/** "İlgi" from a topic's derived confidence (§4.11: ≥ 0.66 high, ≥ 0.40 medium, else low). */
export function interestLevel(confidence: number): 'high' | 'medium' | 'low' {
  return confidence >= 0.66 ? 'high' : confidence >= 0.4 ? 'medium' : 'low';
}

/**
 * The posts a topic's evidence measured: each post (or ad set binding) once, whatever the number
 * of its windows (24 h, 72 h, 7 days) or days, and only by a complete reading (not a missing or
 * failed one).
 */
export function measuredPosts(evidence: studio.Learned['arms'][number]['evidence']): number {
  return new Set(evidence.filter((e) => e.status === 'complete').map((e) => e.publication_id ?? e.binding_id ?? e.id)).size;
}

/** One line per topic that has measured posts: its title, how much interest, how many were measured. */
export function learnedLines(data: studio.Overview | undefined): { id: string; title: string; level: 'high' | 'medium' | 'low' | null; measured: number }[] {
  if (!data) return [];
  return data.hypotheses
    .filter((h) => h.segment_key !== OWNER_REQUEST_SEGMENT)
    .flatMap((h) => {
      const measured = measuredPosts(data.learned.arms.filter((a) => a.arm.key.hypothesis_id === h.id).flatMap((a) => a.evidence));
      if (measured === 0) return [];
      const derived = data.learned.hypotheses.find((x) => x.hypothesis_id === h.id)?.derived_confidence ?? h.derived_confidence;
      return [{ id: h.id, title: h.title, level: typeof derived === 'number' ? interestLevel(derived) : null, measured }];
    });
}

/**
 * "Neler işe yarıyor" (§4.11.6): read only, and only when the learned results hold evidence and
 * the viewer works on content, posts or ads. No version, no hypothesis word: a topic's title, an
 * interest bucket and how many posts were measured. Nothing at all otherwise (also on a failed read).
 */
export function Learned() {
  const { t } = useTranslation();
  const session = useSession();
  const key = useStudioKey();
  const allowed = canAny(session.data, ['content.work', 'social.work', 'ads.work']);
  const window = useOverviewWindow();
  const overview = useQuery({
    queryKey: [...key, 'overview', window, 'knowledge'],
    queryFn: () => studio.overview(window),
    enabled: allowed,
    retry: false,
  });
  if (!allowed) return null;
  const lines = learnedLines(overview.data);
  if (!lines.length) return null;
  return (
    <section aria-labelledby="knowledge-learned" className="flex flex-col gap-2 rounded-xl border border-border bg-surface px-4 py-4 sm:px-5">
      <h2 id="knowledge-learned" className="text-sm font-semibold">{t('knowledge.learned.title')}</h2>
      <ul className="flex flex-col gap-1.5 text-sm">
        {lines.map((line) => (
          <li key={line.id} className="[overflow-wrap:anywhere]">
            <span className="font-medium">{line.title}</span>
            {line.level && <span className="text-muted-foreground"> · {t('knowledge.learned.interest', { level: t(`knowledge.learned.${line.level}`) })}</span>}
            <span className="text-muted-foreground"> · {t('knowledge.learned.measured', { n: line.measured })}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
