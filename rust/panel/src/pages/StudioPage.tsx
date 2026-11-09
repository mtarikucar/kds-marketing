import { WorkspaceHeader } from '@/components/WorkspaceHeader';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import * as api from '@/api/studio';
import { getPending } from '@/api/work';
import type { Hypothesis, LaneKind } from '@/api/types';
import { useSession } from '@/auth/useSession';
import { can } from '@/lib/roles';
import { StudioStrategyBar } from './StudioStrategyBar';
import { StudioPlan } from './StudioPlan';
import { StudioToday } from './StudioToday';
import { StudioLearned } from './StudioLearned';
import { StudioLedger } from './StudioLedger';
import { Field, StudioReadStatus, inputClass, useStudioKey } from './StudioShared';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { StudioMaterials } from './materials/StudioMaterials';
import { StudioPosts } from './posts/StudioPosts';
import { StudioProjects } from './projects/StudioProjects';
export function StudioPage() {
  const { t } = useTranslation();
  const session = useSession();
  const key = useStudioKey();
  const allowed = can(session.data, 'studio.work');
  const manage = can(session.data, 'studio.manage');
  const [hypothesis, setHypothesis] = useState('');
  const [lane, setLane] = useState<LaneKind>();
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  // Which tab is open lives in the address (`?tab=materials`, `?tab=posts`), so links reach it.
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const tab = raw === 'materials' || raw === 'posts' || raw === 'projects' ? raw : 'studio';
  const rawSection = params.get('section');
  const section = rawSection === 'plan' || rawSection === 'learned' || rawSection === 'ledger' ? rawSection : 'today';
  const openSection = (next: string) => {
    const updated = new URLSearchParams(params);
    if (next === 'today') updated.delete('section');
    else updated.set('section', next);
    setParams(updated);
  };
  const openSlot = (id: string) => {
    setParams({});
    setSelectedSlot(id);
  };
  const [defaultDates] = useState(() => ({
    from: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10),
    until: new Date(Date.now() + 8 * 86400000).toISOString().slice(0, 10),
  }));
  const [from, setFrom] = useState(defaultDates.from);
  const [until, setUntil] = useState(defaultDates.until);
  const filtersActive = Boolean(hypothesis || lane || from !== defaultDates.from || until !== defaultDates.until);
  const resetFilters = () => {
    setHypothesis('');
    setLane(undefined);
    setFrom(defaultDates.from);
    setUntil(defaultDates.until);
    setSelectedSlot(null);
  };
  const validRange = Boolean(from && until && from <= until);
  const query: api.Query = {
    hypothesis_id: hypothesis || undefined,
    lane,
    from: `${from}T00:00:00+03:00`,
    until: `${until}T00:00:00+03:00`,
  };
  const overview = useQuery({
    queryKey: [...key, 'overview', query],
    queryFn: () => api.overview(query),
    enabled: allowed && validRange && (tab === 'studio' || tab === 'posts'),
    refetchInterval: 60_000,
  });
  const work = useQuery({
    queryKey: ['work', 'pending', session.data?.current_workspace],
    queryFn: getPending,
    enabled: allowed && tab === 'studio',
    refetchInterval: 60_000,
  });
  // Keep the selector's complete choices when the server projects only the selected hypothesis.
  const [choices, setChoices] = useState<Hypothesis[]>([]);
  useEffect(() => {
    if (overview.data && !hypothesis) setChoices(overview.data.hypotheses);
  }, [overview.data, hypothesis]);
  const data = overview.data;
  return (
    <div data-testid="studio" className="space-y-6">
      <WorkspaceHeader scene={tab === 'materials' || tab === 'projects' ? undefined : 'studio'} title={t('studio.title')} description={t('studio.description')} />
      <Tabs
        value={tab}
        onValueChange={(next) => setParams(next === 'studio' ? {} : { tab: next })}
      >
        <TabsList aria-label={t('studio.title')} className="grid grid-cols-2 sm:flex">
          <TabsTrigger value="studio" className="min-h-11">
            {t('materials.studioTab')}
          </TabsTrigger>
          <TabsTrigger value="projects" className="min-h-11">
            {t('projects.tab')}
          </TabsTrigger>
          <TabsTrigger value="materials" className="min-h-11">
            {t('materials.tab')}
          </TabsTrigger>
          <TabsTrigger value="posts" className="min-h-11">
            {t('posts.tab')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="projects">
          {allowed ? <StudioProjects onOpenSlot={openSlot} /> : <p role="alert">{t('studio.forbidden')}</p>}
        </TabsContent>
        <TabsContent value="posts">
          {allowed ? (
            <StudioPosts hypotheses={choices} onOpenSlot={openSlot} />
          ) : (
            <p role="alert">{t('studio.forbidden')}</p>
          )}
        </TabsContent>
        <TabsContent value="materials">
          {allowed ? (
            <StudioMaterials onOpenSlot={openSlot} />
          ) : (
            <p role="alert">{t('studio.forbidden')}</p>
          )}
        </TabsContent>
        <TabsContent value="studio" className="space-y-5">
          <details className="border-b border-border pb-4">
            <summary className="cursor-pointer py-2 text-sm font-medium text-foreground">
              {t('studio.workbench.filters', { defaultValue: 'Filtreler' })}
              {filtersActive && <span className="ms-2 text-caption font-normal text-muted-foreground">{t('studio.workbench.filtersActive', { defaultValue: 'Etkin' })}</span>}
            </summary>
          <div className="mt-3 grid grid-cols-2 items-end gap-3 sm:grid-cols-[minmax(12rem,1fr)_minmax(9rem,12rem)_minmax(9rem,12rem)_auto]">
            <div className="col-span-2 sm:col-span-1"><Field label="filters.hypothesis">
              <select
                className={inputClass}
                value={hypothesis}
                onChange={(e) => {
                  setHypothesis(e.target.value);
                  setSelectedSlot(null);
                }}
              >
                <option value="">{t('studio.all')}</option>
                {choices.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.title}
                  </option>
                ))}
              </select>
            </Field></div>
            <Field label="filters.from">
              <input
                className={inputClass}
                type="date"
                value={from}
                onChange={(e) => {
                  if (e.target.value) {
                    setFrom(e.target.value);
                    setSelectedSlot(null);
                  }
                }}
              />
            </Field>
            <Field label="filters.until">
              <input
                className={inputClass}
                type="date"
                value={until}
                onChange={(e) => {
                  if (e.target.value) {
                    setUntil(e.target.value);
                    setSelectedSlot(null);
                  }
                }}
              />
            </Field>
            {filtersActive && (
              <button type="button" className="min-h-10 text-start text-sm text-primary underline underline-offset-4" onClick={resetFilters}>
                {t('studio.workbench.clearFilters', { defaultValue: 'Filtreleri temizle' })}
              </button>
            )}
          </div>
          {!validRange && <p role="alert" className="mt-3 text-sm text-danger">{t('studio.workbench.invalidRange', { defaultValue: 'Başlangıç tarihi bitiş tarihinden sonra olamaz.' })}</p>}
          </details>
          {!allowed && <p role="alert">{t('studio.forbidden')}</p>}
          {allowed && <StudioReadStatus query={overview} />}
          <div className="grid grid-cols-1 items-start gap-8 xl:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
            <Tabs value={section} onValueChange={openSection} className="min-w-0">
              <TabsList aria-label={t('studio.workbench.sections', { defaultValue: 'Stüdyo görünümü' })} className="overflow-x-auto">
                <TabsTrigger value="today" data-studio-section className="min-h-11">{t('studio.today')}</TabsTrigger>
                <TabsTrigger value="plan" data-studio-section className="min-h-11">{t('studio.plan')}</TabsTrigger>
                <TabsTrigger value="learned" data-studio-section className="min-h-11">{t('studio.learned')}</TabsTrigger>
                <TabsTrigger value="ledger" data-studio-section className="min-h-11">{t('studio.ledger')}</TabsTrigger>
              </TabsList>
              <TabsContent value="today">
                <StudioToday
                  data={data}
                  selectedSlot={selectedSlot}
                  onSelect={setSelectedSlot}
                  onViewPlan={() => openSection('plan')}
                  manage={manage}
                  overdue={work.data?.agent.overdue ?? false}
                />
              </TabsContent>
              <TabsContent value="plan">
                <StudioPlan
                  available={Boolean(data)}
                  slots={data?.slots ?? []}
                  hypotheses={data?.hypotheses ?? []}
                  arms={data?.learned.arms.map((a) => a.arm) ?? []}
                  onSelect={(id) => {
                    setSelectedSlot(id);
                    openSection('today');
                  }}
                />
              </TabsContent>
              <TabsContent value="learned">
                <StudioLearned
                  data={data}
                  query={query}
                  lane={lane}
                  onLane={(l) => {
                    setLane(l);
                    setSelectedSlot(null);
                  }}
                  manage={manage}
                />
              </TabsContent>
              <TabsContent value="ledger">
                <StudioLedger query={query} allowed={allowed && validRange} />
              </TabsContent>
            </Tabs>
            <StudioStrategyBar
              data={data}
              manage={manage}
              propose={can(session.data, 'team.manage')}
              onHypothesis={(id) => {
                setHypothesis(id);
                setSelectedSlot(null);
                openSection('today');
              }}
            />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
