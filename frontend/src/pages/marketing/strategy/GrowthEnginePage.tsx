import { lazy, Suspense, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/components/ui';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';
import { useGatedTabs } from '../../../features/marketing/hooks/useGatedTabs';
import { RouteFallback } from '../../../components/RouteFallback';

// Lazy so a tab's code only loads when it is opened. Each of these was its own
// route, and none should be paid for by someone who wanted another.
const StrategyConsolePage = lazy(() => import('./StrategyConsolePage'));
const AutomationsListPage = lazy(() => import('../automations/AutomationsListPage'));
const ResearchSettingsPage = lazy(() => import('../research/ResearchSettingsPage'));

const TAB_GATES = [
  { value: 'strategy' },
  { value: 'automations', feature: 'workflows' as const },
  { value: 'research', feature: 'research' as const },
] as const;
type Tab = (typeof TAB_GATES)[number]['value'];

function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<RouteFallback />}>{children}</Suspense>;
}

/**
 * Strategy, automations and research — the plan and the machines that run it.
 *
 * A workspace without a strategy is not a workspace with a blank page; it is
 * one whose automations have nothing to be FOR. And 'AI research' was a third
 * entry whose difference from an automation nobody could state: both are
 * standing instructions that run without you and put data into the funnel.
 * Strategy first, because everything below it is downstream of it.
 *
 * Every absorbed route still resolves — App.tsx redirects each to its tab, and
 * the command palette offers each half by its own name. The LIST got shorter;
 * nothing became unreachable.
 */
export default function GrowthEnginePage() {
  const { t } = useTranslation('marketing');
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  // Gated, not merely validated: a half this workspace has not bought must
  // not be openable by typing its name into the URL either.
  const { allowed, active } = useGatedTabs(TAB_GATES, raw);
  const tab = active as Tab;

  const setTab = (v: string) => setParams((p) => {
    p.set('tab', v);
    return p;
  }, { replace: true });

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('growthEngine.title', { defaultValue: 'Strategy' })}
        description={t('growthEngine.subtitle', { defaultValue: 'The plan, the machinery that runs it, and the research that feeds them.' })}
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          {allowed.includes('strategy') && <TabsTrigger value="strategy">{t('growthEngine.tab.strategy', { defaultValue: 'Strategy' })}</TabsTrigger>}
          {allowed.includes('automations') && <TabsTrigger value="automations">{t('growthEngine.tab.automations', { defaultValue: 'Automations' })}</TabsTrigger>}
          {allowed.includes('research') && <TabsTrigger value="research">{t('growthEngine.tab.research', { defaultValue: 'Research' })}</TabsTrigger>}
        </TabsList>

        {allowed.includes('strategy') && <TabsContent value="strategy" className="pt-5">
          <Lazy><StrategyConsolePage embedded /></Lazy>
        </TabsContent>}
        {allowed.includes('automations') && <TabsContent value="automations" className="pt-5">
          <Lazy><AutomationsListPage embedded /></Lazy>
        </TabsContent>}
        {allowed.includes('research') && <TabsContent value="research" className="pt-5">
          <Lazy><ResearchSettingsPage embedded /></Lazy>
        </TabsContent>}
      </Tabs>
    </div>
  );
}
