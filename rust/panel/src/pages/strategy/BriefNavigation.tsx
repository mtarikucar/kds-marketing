import { createContext, useContext, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { SECTION_KEYS, type Gap } from '@/api/types';

export const BRIEF_SECTIONS = [...SECTION_KEYS, 'hypotheses', 'consultation'] as const;
export type BriefSection = (typeof BRIEF_SECTIONS)[number];
export type BriefGroup = 'brand' | 'plan' | 'hypotheses' | 'consultation';
export function groupForSection(section: BriefSection): BriefGroup {
  if (section === 'hypotheses' || section === 'consultation') return section;
  return ['identity', 'audience', 'prohibitions'].includes(section) ? 'brand' : 'plan';
}
export const BriefGroupContext = createContext<{ group: BriefGroup; setGroup: (group: BriefGroup) => void }>({ group: 'brand', setGroup: () => {} });
export function navigateToSection(section: BriefSection, setGroup: (group: BriefGroup) => void, edit = false) {
  setGroup(groupForSection(section));
  requestAnimationFrame(() => {
    const input = edit ? document.getElementById(sectionId(section))?.querySelector<HTMLElement>('form input, form textarea, form button') : null;
    if (input) { input.focus(); input.scrollIntoView?.({ block: 'center' }); }
    else focusSection(section);
  });
}

export const sectionId = (section: BriefSection) => `strategy-section-${section}`;

export function sectionForGap(gap: Gap): BriefSection | null {
  const key = gap.field.split('.')[0].split('[')[0];
  return BRIEF_SECTIONS.find((section) => section === key) ?? null;
}

export function focusSection(section: BriefSection) {
  const target = document.getElementById(sectionId(section));
  target?.focus({ preventScroll: true });
  target?.scrollIntoView?.({ block: 'start' });
}

export const EditRequestContext = createContext<{ section: BriefSection; id: number } | null>(null);

/** Consume each deliberate request once; a save/refetch must never reopen the editor. */
export function useRequestedEdit(section: BriefSection, open: () => void) {
  const request = useContext(EditRequestContext);
  const consumed = useRef(0);
  useEffect(() => {
    if (request?.section !== section || consumed.current === request.id) return;
    consumed.current = request.id;
    open();
  }, [request, section, open]);
}

export function BriefNavigation({ gaps = [] }: { gaps?: readonly Gap[] }) {
  const { t } = useTranslation();
  const { group, setGroup } = useContext(BriefGroupContext);
  const categories: { key: BriefGroup; label: string }[] = [
    { key: 'brand', label: t('strategy.workbench.brand', { defaultValue: 'Marka ve kitle' }) },
    { key: 'plan', label: t('strategy.workbench.plan', { defaultValue: 'Hedefler ve plan' }) },
    { key: 'hypotheses', label: t('strategy.sections.hypotheses') },
    { key: 'consultation', label: t('strategy.consultation.title') },
  ];
  return (
    <nav aria-label={t('strategy.workbench.sections', { defaultValue: 'Brief bölümleri' })} className="space-y-3 border-y border-border bg-surface py-3">
      <div className="flex flex-wrap gap-2">
        {categories.map((category) => (
          <button key={category.key} type="button" aria-pressed={group === category.key} onClick={() => setGroup(category.key)} className="min-h-10 rounded-md border border-border px-3 py-2 text-sm text-muted-foreground hover:bg-surface-muted aria-pressed:border-primary aria-pressed:bg-primary aria-pressed:text-primary-foreground focus-visible:ring-2 focus-visible:ring-ring">
            {category.label}
          </button>
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-1 gap-y-1">
        {BRIEF_SECTIONS.filter((section) => groupForSection(section) === group).map((section) => {
          const count = gaps.filter((gap) => sectionForGap(gap) === section).length;
          return (
            <li key={section}>
              <a
                href={`#${sectionId(section)}`}
                className="inline-flex min-h-10 items-center gap-2 rounded px-3 text-sm text-muted-foreground hover:bg-surface-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={(event) => { event.preventDefault(); navigateToSection(section, setGroup); }}
              >
                {section === 'consultation' ? t('strategy.consultation.title') : t(`strategy.sections.${section}`)}
                {count > 0 && <span className="text-xs tabular-nums text-warning" aria-label={t('strategy.workbench.gapCount', { count, defaultValue: '{{count}} eksik' })}>{count}</span>}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
