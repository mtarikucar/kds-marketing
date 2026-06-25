import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import type { StepEditorProps } from './types';

/** Visual editor for `ai_classify`: a prompt, a comma-separated category list,
 *  and a per-category "route to step #" map. Replaces the JSON-only fallback. */
export function AiClassifyEditor({ step, onPatch, count }: StepEditorProps) {
  const { t } = useTranslation('marketing');
  const categories = (Array.isArray(step.categories) ? step.categories : []) as string[];
  const routes = (step.routes && typeof step.routes === 'object' ? step.routes : {}) as Record<string, number>;

  return (
    <div className="space-y-3">
      <div>
        <div className="text-caption text-muted-foreground mb-1">{t('automations.prompt', 'Prompt')}</div>
        <Textarea
          className="min-h-20"
          value={(step.prompt as string) ?? ''}
          onChange={(e) => onPatch({ prompt: e.target.value })}
        />
      </div>
      <div>
        <div className="text-caption text-muted-foreground mb-1">
          {t('automations.categories', 'Categories (comma-separated)')}
        </div>
        <Input
          value={categories.join(', ')}
          placeholder="hot, warm, cold"
          onChange={(e) => onPatch({ categories: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
        />
      </div>
      {categories.length > 0 && (
        <div className="space-y-1">
          <div className="text-caption text-muted-foreground">
            {t('automations.routes', 'Route each category to a step # (optional)')}
          </div>
          {categories.map((cat) => (
            <div key={cat} className="flex items-center gap-2">
              <span className="text-xs font-medium w-20 truncate">{cat}</span>
              <span className="text-muted-foreground text-xs">→</span>
              <Input
                type="number"
                min={1}
                max={count ?? undefined}
                className="w-24"
                aria-label={t('automations.routeFor', 'Route for {{cat}}', { cat })}
                value={typeof routes[cat] === 'number' ? routes[cat] + 1 : ''}
                onChange={(e) => {
                  const next = { ...routes };
                  if (e.target.value === '') delete next[cat];
                  else next[cat] = Math.max(0, Math.round(Number(e.target.value)) - 1);
                  onPatch({ routes: next });
                }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
