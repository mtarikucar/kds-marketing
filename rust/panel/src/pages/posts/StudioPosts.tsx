import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { Hypothesis } from '@/api/types';
import { PostsPlan } from './PostsPlan';
import { PostsSettings } from './PostsSettings';
import { PostsWeek } from './PostsWeek';

export const POST_VIEWS = ['plan', 'week', 'settings'] as const;
export type PostView = (typeof POST_VIEWS)[number];

/**
 * The Paylaşımlar tab of Growth Studio (spec 2026-11-03 §14): what the agent is asked to plan and
 * what is planned (Plan), what a week brought (Haftalık özet) and the posting policy (Paylaşım
 * ayarları, an owner's or manager's). Where it is lives in the address (`?tab=posts&view=…`), so
 * a phone's back button walks back through it.
 */
export function StudioPosts({
  hypotheses,
  onOpenSlot,
}: {
  hypotheses: Hypothesis[];
  onOpenSlot: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const raw = params.get('view');
  const view: PostView = (POST_VIEWS as readonly string[]).includes(raw ?? '')
    ? (raw as PostView)
    : 'plan';
  const week = params.get('week') ?? undefined;
  const go = (next: PostView, extra: Record<string, string> = {}) =>
    setParams({ tab: 'posts', view: next, ...extra });
  return (
    <div className="space-y-4" data-testid="studio-posts">
      <nav aria-label={t('posts.tab')}>
        <ul className="grid grid-cols-1 gap-2 min-[400px]:grid-cols-3 sm:flex sm:flex-wrap">
          {POST_VIEWS.map((v) => (
            <li key={v}>
              <button
                type="button"
                aria-current={view === v ? 'page' : undefined}
                onClick={() => go(v)}
                className={`inline-flex min-h-11 w-full items-center justify-center rounded-md border px-4 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  view === v ? 'border-primary bg-primary/10 text-foreground' : 'border-border bg-surface'
                }`}
              >
                {t(`posts.views.${v}`)}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      {view === 'plan' && <PostsPlan onOpenSlot={onOpenSlot} />}
      {view === 'week' && (
        <PostsWeek
          week={week}
          hypotheses={hypotheses}
          onWeek={(w) => go('week', w ? { week: w } : {})}
        />
      )}
      {view === 'settings' && <PostsSettings />}
    </div>
  );
}
