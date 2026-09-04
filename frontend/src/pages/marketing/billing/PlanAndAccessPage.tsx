import { lazy, Suspense, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/components/ui';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';
import { RouteFallback } from '../../../components/RouteFallback';

// Lazy so a tab's code only loads when it is opened. Each of these was its own
// route, and none should be paid for by someone who wanted another.
const BillingPage = lazy(() => import('./index'));
const ModulesPage = lazy(() => import('../settings/modules'));

const TABS = ['plan', 'modules'] as const;
type Tab = (typeof TABS)[number];

function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<RouteFallback />}>{children}</Suspense>;
}

/**
 * The plan, and what it switches on.
 *
 * Modules were a page of their own near the top of settings, which put a
 * switch that REMOVES features next to the logo and the timezone. It belongs
 * with the plan that pays for them, at the bottom, where you go once.
 *
 * Every absorbed route still resolves — App.tsx redirects each to its tab, and
 * the command palette offers each half by its own name. The LIST got shorter;
 * nothing became unreachable.
 */
export default function PlanAndAccessPage() {
  const { t } = useTranslation('marketing');
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const tab: Tab = (TABS as readonly string[]).includes(raw ?? '') ? (raw as Tab) : 'plan';

  const setTab = (v: string) => setParams((p) => {
    p.set('tab', v);
    return p;
  }, { replace: true });

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('planAccess.title', { defaultValue: 'Plan & access' })}
        description={t('planAccess.subtitle', { defaultValue: 'The plan this workspace is on, and which parts of the product it turns on.' })}
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="plan">{t('planAccess.tab.plan', { defaultValue: 'Plan' })}</TabsTrigger>
          <TabsTrigger value="modules">{t('planAccess.tab.modules', { defaultValue: 'Modules' })}</TabsTrigger>
        </TabsList>

        <TabsContent value="plan" className="pt-5">
          <Lazy><BillingPage embedded /></Lazy>
        </TabsContent>
        <TabsContent value="modules" className="pt-5">
          <Lazy><ModulesPage embedded /></Lazy>
        </TabsContent>
      </Tabs>
    </div>
  );
}
