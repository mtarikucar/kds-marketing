import type { TFunction } from 'i18next';
import type { ProductionProject } from '@/api/projects';
import type { AreaState } from '@/api/content';
import { Badge } from '@/components/ui';
import { useTranslation } from 'react-i18next';

export const AREA_STEPS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14] as const;
export const stepName = (t: TFunction, step: number) => t(`contentAreas.steps.${AREA_STEPS.find(s => s === step) ?? 1}`);
export const currentPackage = (area: ProductionProject) => area.packages?.[area.packages.length - 1];
export const startsAt = (area: ProductionProject) => area.state?.starts_at || area.start_at || area.created_at;
/** Older documents have neither the projected state nor the new fields. */
export function areaState(area: ProductionProject, now = Date.now()): AreaState {
  if (area.state) return area.state.state;
  if (area.archived) return 'archived';
  if ((area.refused ?? 0) >= 3) return 'held';
  if (area.requests.some(r => r.status === 'open')) return 'waiting_material';
  if (area.claim && Date.parse(area.claim.lease_until) > now) return 'working';
  if (currentPackage(area) && !area.redo) return 'done';
  return 'queued';
}
export function areaSentence(t: TFunction, area: ProductionProject): string {
  if (area.redo && !area.archived) return t('contentAreas.redoStatus', { note: area.redo.note });
  const state = areaState(area);
  const step = area.state?.step ?? area.progress?.step ?? 1;
  switch (state) {
    case 'queued': return t(Date.parse(startsAt(area)) > Date.now() ? 'contentAreas.future' : 'contentAreas.queued');
    case 'working': return `${stepName(t, step)} · ${step} / 14`;
    case 'waiting_material': return t('contentAreas.waiting', { n: area.requests.filter(r => r.status === 'open').length });
    case 'done': return t('contentAreas.done', { n: currentPackage(area)?.versions.length ?? 0 });
    case 'held': return t('contentAreas.held');
    case 'archived': return t('contentAreas.states.archived');
  }
}
export function AreaBadge({ area }: { area: ProductionProject }) {
  const { t } = useTranslation();
  const state = areaState(area);
  return <Badge tone={state === 'held' ? 'danger' : state === 'waiting_material' ? 'warning' : state === 'done' ? 'success' : 'neutral'}>{t(`contentAreas.states.${state}`)}</Badge>;
}
export function openedBy(t: TFunction, area: ProductionProject) {
  return area.opened_by?.kind === 'system' ? t(`contentAreas.opened.${area.opened_by.trigger}`) : t('contentAreas.opened.human');
}
export function areaTime(at: string, lang: string) {
  return at && Number.isFinite(Date.parse(at)) ? new Date(at).toLocaleString(lang, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
}
