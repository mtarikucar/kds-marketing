import { lazy, Suspense, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/components/ui/PageHeader';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';
import { RouteFallback } from '../../../components/RouteFallback';

// Lazy so a tab's code only loads when opened (each was its own route before).
const ContentCalendarPage = lazy(() => import('../contentCalendar/ContentCalendarPage'));
const BudgetAutopilotPage = lazy(() => import('../budget/BudgetAutopilotPage'));
const TrendsPage = lazy(() => import('../trends/TrendsPage'));
const CampaignsPage = lazy(() => import('../CampaignsPage'));
const SocialCampaignsPage = lazy(() => import('../socialCampaigns/SocialCampaignsPage'));
const SocialPlannerPage = lazy(() => import('../social'));
const EmailTemplatesPage = lazy(() => import('../emailTemplates'));
const TriggerLinksPage = lazy(() => import('../triggerLinks'));
const ReviewsPage = lazy(() => import('../ReviewsPage'));
const AffiliatePortalPage = lazy(() => import('../affiliate-portal/AffiliatePortalPage'));

const TABS = ['calendar', 'campaigns', 'trends', 'budget', 'more'] as const;
type StudioTab = (typeof TABS)[number];

function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<RouteFallback />}>{children}</Suspense>;
}

/**
 * Growth Studio — the single unified marketing surface. Replaces the old
 * Marketing hub sub-nav: content calendar, campaigns (normal + social + planner),
 * trends, and the ad budget all live here as deep-linkable tabs (`?tab=`), so the
 * whole social/content/budget workflow is one page.
 */
export default function GrowthStudioPage() {
  const { t } = useTranslation('marketing');
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const tab: StudioTab = (TABS as readonly string[]).includes(raw ?? '') ? (raw as StudioTab) : 'calendar';

  const setTab = (v: string) => setParams((p) => {
    p.set('tab', v);
    return p;
  }, { replace: true });

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('studio.title', 'Growth Studio')}
        description={t('studio.subtitle', 'Plan, create, schedule and budget your marketing — all in one place.')}
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="calendar">{t('studio.tab.calendar', 'Content Calendar')}</TabsTrigger>
          <TabsTrigger value="campaigns">{t('studio.tab.campaigns', 'Campaigns')}</TabsTrigger>
          <TabsTrigger value="trends">{t('studio.tab.trends', 'Trends')}</TabsTrigger>
          <TabsTrigger value="budget">{t('studio.tab.budget', 'Ad Budget')}</TabsTrigger>
          <TabsTrigger value="more">{t('studio.tab.more', 'More')}</TabsTrigger>
        </TabsList>

        <TabsContent value="calendar" className="pt-5">
          <Lazy><ContentCalendarPage embedded /></Lazy>
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
    </div>
  );
}

/** Campaigns tab — normal campaigns + AI social campaigns + the social planner. */
function CampaignsTab() {
  const { t } = useTranslation('marketing');
  return (
    <Tabs defaultValue="standard">
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
  return (
    <Tabs defaultValue="email">
      <TabsList>
        <TabsTrigger value="email">{t('studio.more.email', 'Email Templates')}</TabsTrigger>
        <TabsTrigger value="triggerLinks">{t('studio.more.triggerLinks', 'Trigger Links')}</TabsTrigger>
        <TabsTrigger value="reviews">{t('studio.more.reviews', 'Reviews')}</TabsTrigger>
        <TabsTrigger value="affiliates">{t('studio.more.affiliates', 'Affiliates')}</TabsTrigger>
      </TabsList>
      <TabsContent value="email" className="pt-4"><Lazy><EmailTemplatesPage /></Lazy></TabsContent>
      <TabsContent value="triggerLinks" className="pt-4"><Lazy><TriggerLinksPage /></Lazy></TabsContent>
      <TabsContent value="reviews" className="pt-4"><Lazy><ReviewsPage /></Lazy></TabsContent>
      <TabsContent value="affiliates" className="pt-4"><Lazy><AffiliatePortalPage /></Lazy></TabsContent>
    </Tabs>
  );
}
