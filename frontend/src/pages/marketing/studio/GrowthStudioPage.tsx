import { lazy, Suspense, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Sparkles } from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';
import { RouteFallback } from '../../../components/RouteFallback';
import { EnableAutopilotWizard } from '../budget/EnableAutopilotWizard';

// Lazy so a tab's code only loads when opened (each was its own route before).
const StudioCalendarTab = lazy(() => import('./StudioCalendarTab'));
const BudgetAutopilotPage = lazy(() => import('../budget/BudgetAutopilotPage'));
const TrendsPage = lazy(() => import('../trends/TrendsPage'));
const CampaignsPage = lazy(() => import('../CampaignsPage'));
const SocialCampaignsPage = lazy(() => import('../socialCampaigns/SocialCampaignsPage'));
const SocialPlannerPage = lazy(() => import('../social'));
const AiStudioPage = lazy(() => import('../social/AiStudioPage'));
const PersonasPage = lazy(() => import('../personas/PersonasPage'));
const EmailTemplatesPage = lazy(() => import('../emailTemplates'));
const ReviewsPage = lazy(() => import('../ReviewsPage'));
const AffiliatePortalPage = lazy(() => import('../affiliate-portal/AffiliatePortalPage'));

const TABS = ['calendar', 'create', 'campaigns', 'trends', 'budget', 'more'] as const;
type StudioTab = (typeof TABS)[number];

const CREATE_SUBS = ['studio', 'personas'] as const;
const CAMPAIGN_SUBS = ['standard', 'social', 'planner'] as const;
const MORE_SUBS = ['email', 'reviews', 'affiliates'] as const;

function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<RouteFallback />}>{children}</Suspense>;
}

/**
 * Growth Studio — the single unified marketing surface. Content calendar,
 * campaigns (normal + social + planner), trends and the Autopilot all live
 * here as deep-linkable tabs: `?tab=` for the page level and `?sub=` for the
 * nested groups, so EVERY view survives refresh/back and can be shared.
 * The header carries the product's one-click promise: Enable Autopilot.
 */
export default function GrowthStudioPage() {
  const { t } = useTranslation('marketing');
  const [params, setParams] = useSearchParams();
  const [wizardOpen, setWizardOpen] = useState(false);
  const raw = params.get('tab');
  const tab: StudioTab = (TABS as readonly string[]).includes(raw ?? '') ? (raw as StudioTab) : 'calendar';

  const setTab = (v: string) => setParams((p) => {
    p.set('tab', v);
    p.delete('sub'); // a page-level switch resets the nested selection
    return p;
  }, { replace: true });

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('studio.title', 'Growth Studio')}
        description={t('studio.subtitle', 'Plan, create, schedule and budget your marketing — all in one place.')}
        actions={
          <Button onClick={() => setWizardOpen(true)}>
            <Sparkles className="mr-1.5 h-4 w-4" aria-hidden="true" />
            {t('autopilot.enableCta', 'Enable Autopilot')}
          </Button>
        }
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="calendar">{t('studio.tab.calendar', 'Content Calendar')}</TabsTrigger>
          <TabsTrigger value="create">{t('studio.tab.create', 'Create')}</TabsTrigger>
          <TabsTrigger value="campaigns">{t('studio.tab.campaigns', 'Campaigns')}</TabsTrigger>
          <TabsTrigger value="trends">{t('studio.tab.trends', 'Trends')}</TabsTrigger>
          <TabsTrigger value="budget">{t('studio.tab.autopilot', 'Autopilot')}</TabsTrigger>
          <TabsTrigger value="more">{t('studio.tab.more', 'More')}</TabsTrigger>
        </TabsList>

        <TabsContent value="calendar" className="pt-5">
          <Lazy><StudioCalendarTab /></Lazy>
        </TabsContent>
        <TabsContent value="create" className="pt-5">
          <CreateTab />
        </TabsContent>
        <TabsContent value="campaigns" className="pt-5">
          <CampaignsTab />
        </TabsContent>
        <TabsContent value="trends" className="pt-5">
          <Lazy><TrendsPage embedded /></Lazy>
        </TabsContent>
        <TabsContent value="budget" className="pt-5">
          <Lazy><BudgetAutopilotPage embedded /></Lazy>
        </TabsContent>
        <TabsContent value="more" className="pt-5">
          <MoreTab />
        </TabsContent>
      </Tabs>

      <EnableAutopilotWizard open={wizardOpen} onOpenChange={setWizardOpen} onProvisioned={() => setTab('budget')} />
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
      <TabsContent value="studio" className="pt-4"><Lazy><AiStudioPage embedded /></Lazy></TabsContent>
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
      <TabsContent value="standard" className="pt-4"><Lazy><CampaignsPage /></Lazy></TabsContent>
      <TabsContent value="social" className="pt-4"><Lazy><SocialCampaignsPage /></Lazy></TabsContent>
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
      <TabsContent value="email" className="pt-4"><Lazy><EmailTemplatesPage /></Lazy></TabsContent>
      <TabsContent value="reviews" className="pt-4"><Lazy><ReviewsPage /></Lazy></TabsContent>
      <TabsContent value="affiliates" className="pt-4"><Lazy><AffiliatePortalPage /></Lazy></TabsContent>
    </Tabs>
  );
}
