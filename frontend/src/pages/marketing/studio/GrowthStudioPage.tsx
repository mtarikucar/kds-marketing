import { lazy, Suspense, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Wrench, ArrowLeft } from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';
import { FeatureGate } from '@/components/ui/access-gates';
import { RouteFallback } from '../../../components/RouteFallback';
import { UpgradeCallout } from './UpgradeCallout';

// Lazy so a surface's code only loads when opened.
const BudgetAutopilotPage = lazy(() => import('../budget/BudgetAutopilotPage'));
const StudioCalendarTab = lazy(() => import('./StudioCalendarTab'));
const TrendsPage = lazy(() => import('../trends/TrendsPage'));
const CampaignsPage = lazy(() => import('../CampaignsPage'));
const SocialCampaignsPage = lazy(() => import('../socialCampaigns/SocialCampaignsPage'));
const SocialPlannerPage = lazy(() => import('../social'));
const AiStudioPage = lazy(() => import('../social/AiStudioPage'));
const PersonasPage = lazy(() => import('../personas/PersonasPage'));
const EmailTemplatesPage = lazy(() => import('../emailTemplates'));
const ReviewsPage = lazy(() => import('../ReviewsPage'));
const AffiliatePortalPage = lazy(() => import('../affiliate-portal/AffiliatePortalPage'));

const TOOL_TABS = ['calendar', 'create', 'campaigns', 'trends', 'more'] as const;
type ToolTab = (typeof TOOL_TABS)[number];

const CREATE_SUBS = ['studio', 'personas'] as const;
const CAMPAIGN_SUBS = ['standard', 'social', 'planner'] as const;
const MORE_SUBS = ['email', 'reviews', 'affiliates'] as const;

function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<RouteFallback />}>{children}</Suspense>;
}

/**
 * Growth Studio — AUTONOMY-FIRST (2026-07 radical reshape, owner-directed).
 *
 * The default screen IS the Growth Autopilot console: load credit, flip one
 * switch, and the engine spends it to grow sales — it never asks. The old
 * 6-tab "suite" (content calendar, create, campaigns, trends, more) is NOT the
 * front door anymore; it lives behind a single "Manual tools" button as an
 * advanced surface (`?view=tools`), one click away, deep-links preserved.
 * The Autopilot is no longer a tab — it is the page.
 */
export default function GrowthStudioPage() {
  const { t } = useTranslation('marketing');
  const [params, setParams] = useSearchParams();
  const showTools = params.get('view') === 'tools';

  const openTools = () => setParams((p) => { p.set('view', 'tools'); return p; }, { replace: true });
  const closeTools = () => setParams((p) => { p.delete('view'); p.delete('tab'); p.delete('sub'); return p; }, { replace: true });

  if (showTools) {
    return (
      <div className="space-y-5">
        <PageHeader
          title={t('studio.tools.title', 'Manual tools')}
          description={t('studio.tools.subtitle', 'Hand-run content, campaigns and trends. The Autopilot uses these same tools automatically — you only need them for one-off overrides.')}
          actions={
            <Button variant="secondary" onClick={closeTools}>
              <ArrowLeft className="mr-1.5 h-4 w-4" aria-hidden="true" />
              {t('studio.tools.back', 'Back to Autopilot')}
            </Button>
          }
        />
        <ToolsSurface />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('autopilot.title', 'Growth Autopilot')}
        description={t('autopilot.subtitle', 'Load credit, set your caps once, flip it on — the engine spends it where it makes you the most sales, and logs everything it does.')}
        actions={
          <Button variant="secondary" onClick={openTools}>
            <Wrench className="mr-1.5 h-4 w-4" aria-hidden="true" />
            {t('studio.manualTools', 'Manual tools')}
          </Button>
        }
      />
      <Lazy><BudgetAutopilotPage embedded /></Lazy>
    </div>
  );
}

/** URL-synced nested tab state (`?sub=`) — deep-linkable, back-button-safe. */
function useSubTab<T extends readonly string[]>(subs: T, fallback: T[number]): [T[number], (v: string) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get('sub');
  const sub = (subs as readonly string[]).includes(raw ?? '') ? (raw as T[number]) : fallback;
  const setSub = (v: string) => setParams((p) => {
    p.set('sub', v);
    return p;
  }, { replace: true });
  return [sub, setSub];
}

/** The advanced/manual surface — the former Studio hub, now one click away. */
function ToolsSurface() {
  const { t } = useTranslation('marketing');
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const tab: ToolTab = (TOOL_TABS as readonly string[]).includes(raw ?? '') ? (raw as ToolTab) : 'calendar';
  const setTab = (v: string) => setParams((p) => {
    p.set('view', 'tools');
    p.set('tab', v);
    p.delete('sub');
    return p;
  }, { replace: true });

  return (
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList>
        <TabsTrigger value="calendar">{t('studio.tab.calendar', 'Content Calendar')}</TabsTrigger>
        <TabsTrigger value="create">{t('studio.tab.create', 'Create')}</TabsTrigger>
        <TabsTrigger value="campaigns">{t('studio.tab.campaigns', 'Campaigns')}</TabsTrigger>
        <TabsTrigger value="trends">{t('studio.tab.trends', 'Trends')}</TabsTrigger>
        <TabsTrigger value="more">{t('studio.tab.more', 'More')}</TabsTrigger>
      </TabsList>

      <TabsContent value="calendar" className="pt-5">
        <FeatureGate feature="socialCampaigns" fallback={<UpgradeCallout />}>
          <Lazy><StudioCalendarTab /></Lazy>
        </FeatureGate>
      </TabsContent>
      <TabsContent value="create" className="pt-5"><CreateTab /></TabsContent>
      <TabsContent value="campaigns" className="pt-5"><CampaignsTab /></TabsContent>
      <TabsContent value="trends" className="pt-5"><Lazy><TrendsPage embedded /></Lazy></TabsContent>
      <TabsContent value="more" className="pt-5"><MoreTab /></TabsContent>
    </Tabs>
  );
}

/** Create tab — the AI content tools: media generation + reusable UGC personas. */
function CreateTab() {
  const { t } = useTranslation('marketing');
  const [sub, setSub] = useSubTab(CREATE_SUBS, 'studio');
  return (
    <Tabs value={sub} onValueChange={setSub}>
      <TabsList>
        <TabsTrigger value="studio">{t('studio.create.studio', 'AI Studio')}</TabsTrigger>
        <TabsTrigger value="personas">{t('studio.create.personas', 'UGC Personas')}</TabsTrigger>
      </TabsList>
      <TabsContent value="studio" className="pt-4">
        <FeatureGate feature="mediaGen" fallback={<UpgradeCallout />}>
          <Lazy><AiStudioPage embedded /></Lazy>
        </FeatureGate>
      </TabsContent>
      <TabsContent value="personas" className="pt-4"><Lazy><PersonasPage embedded /></Lazy></TabsContent>
    </Tabs>
  );
}

/** Campaigns tab — normal campaigns + AI social campaigns + the social planner. */
function CampaignsTab() {
  const { t } = useTranslation('marketing');
  const [sub, setSub] = useSubTab(CAMPAIGN_SUBS, 'standard');
  return (
    <Tabs value={sub} onValueChange={setSub}>
      <TabsList>
        <TabsTrigger value="standard">{t('studio.camp.standard', 'Campaigns')}</TabsTrigger>
        <TabsTrigger value="social">{t('studio.camp.social', 'Social Campaigns')}</TabsTrigger>
        <TabsTrigger value="planner">{t('studio.camp.planner', 'Social Planner')}</TabsTrigger>
      </TabsList>
      <TabsContent value="standard" className="pt-4">
        <FeatureGate feature="campaigns" fallback={<UpgradeCallout />}>
          <Lazy><CampaignsPage /></Lazy>
        </FeatureGate>
      </TabsContent>
      <TabsContent value="social" className="pt-4">
        <FeatureGate feature="socialCampaigns" fallback={<UpgradeCallout />}>
          <Lazy><SocialCampaignsPage /></Lazy>
        </FeatureGate>
      </TabsContent>
      <TabsContent value="planner" className="pt-4"><Lazy><SocialPlannerPage /></Lazy></TabsContent>
    </Tabs>
  );
}

/** Everything else the old Marketing hub carried, kept reachable. */
function MoreTab() {
  const { t } = useTranslation('marketing');
  const [sub, setSub] = useSubTab(MORE_SUBS, 'email');
  return (
    <Tabs value={sub} onValueChange={setSub}>
      <TabsList>
        <TabsTrigger value="email">{t('studio.more.email', 'Email Templates')}</TabsTrigger>
        <TabsTrigger value="reviews">{t('studio.more.reviews', 'Reviews')}</TabsTrigger>
        <TabsTrigger value="affiliates">{t('studio.more.affiliates', 'Affiliates')}</TabsTrigger>
      </TabsList>
      <TabsContent value="email" className="pt-4">
        <FeatureGate feature="campaigns" fallback={<UpgradeCallout />}>
          <Lazy><EmailTemplatesPage /></Lazy>
        </FeatureGate>
      </TabsContent>
      <TabsContent value="reviews" className="pt-4"><Lazy><ReviewsPage /></Lazy></TabsContent>
      <TabsContent value="affiliates" className="pt-4"><Lazy><AffiliatePortalPage /></Lazy></TabsContent>
    </Tabs>
  );
}
