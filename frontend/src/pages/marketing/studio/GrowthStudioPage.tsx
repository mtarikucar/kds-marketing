import { lazy, Suspense, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';
import { FeatureGate } from '@/components/ui/access-gates';
import { RouteFallback } from '../../../components/RouteFallback';
import { UpgradeCallout } from './UpgradeCallout';

// Lazy so a surface's code only loads when opened.
const StudioOneScreen = lazy(() => import('./StudioOneScreen'));
const StudioCalendarTab = lazy(() => import('./StudioCalendarTab'));
const TrendsPage = lazy(() => import('../trends/TrendsPage'));
const CampaignsPage = lazy(() => import('../CampaignsPage'));
const SocialCampaignsPage = lazy(() => import('../socialCampaigns/SocialCampaignsPage'));
const SocialPlannerPage = lazy(() => import('../social'));
const AiStudioPage = lazy(() => import('../social/AiStudioPage'));
const PersonasPage = lazy(() => import('../personas/PersonasPage'));
const EmailTemplatesPage = lazy(() => import('../emailTemplates'));
const ReviewsPage = lazy(() => import('../ReviewsPage'));
/**
 * The workspace's affiliate MANAGEMENT page, not `affiliate-portal`.
 *
 * This tab mounted `AffiliatePortalPage` for as long as it has existed, and
 * that page is the PUBLIC, token-authenticated self-serve portal an affiliate
 * opens at /affiliate-portal — it asks the visitor to paste a bearer token and
 * has no idea a marketing session exists. So a logged-in manager clicking
 * "Ortaklar" met a token form for an account they already were.
 *
 * The mismatch predates the one-screen work; what changed is that it became
 * load-bearing. This tab is now justified by the claim that it duplicates the
 * Settings entry for people with the old bookmark — and a duplicate that opens
 * a different page is not a duplicate, it is a second wrong answer.
 */
const AffiliatesPage = lazy(() => import('../experiments/affiliates'));

const TOOL_TABS = ['calendar', 'create', 'campaigns', 'trends', 'more'] as const;
type ToolTab = (typeof TOOL_TABS)[number];

const CREATE_SUBS = ['studio', 'personas'] as const;
const CAMPAIGN_SUBS = ['standard', 'social', 'planner'] as const;
const MORE_SUBS = ['email', 'reviews', 'affiliates'] as const;

function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<RouteFallback />}>{children}</Suspense>;
}

/**
 * Growth Studio.
 *
 * 2026-08, owner-directed: the front door is now ONE working screen — today's
 * publishing queue, the connected accounts' numbers, and the strategy's
 * proposals — see `StudioOneScreen`. Before this it was the ad-budget console
 * plus a button that opened five tabs, three of which opened sub-tabs; the
 * product could do all of it and none of it was where anyone would look.
 *
 * `?view=tools` still renders that old tabbed surface, and that is deliberate
 * rather than leftover. Six routes redirect into it with an exact `tab`/`sub`
 * pair (`/campaigns`, `/social`, `/social-campaigns`, `/trends`,
 * `/content-calendar`, and the AI Studio's "add to post" hand-off, which also
 * carries router state a redirect would drop). Several of the pages it hosts —
 * blast campaigns, the social planner's table, the trends browser — are
 * full-page surfaces that genuinely do not fit in a panel or a drawer. Keeping
 * the surface is what lets the front door change without a single destination
 * becoming unreachable; the one-screen's tools menu links into it by name.
 */
export default function GrowthStudioPage() {
  const { t } = useTranslation('marketing');
  const [params, setParams] = useSearchParams();
  const showTools = params.get('view') === 'tools';

  const closeTools = () =>
    setParams(
      (p) => {
        p.delete('view');
        p.delete('tab');
        p.delete('sub');
        return p;
      },
      { replace: true },
    );

  if (showTools) {
    return (
      <div className="space-y-5">
        <PageHeader
          title={t('studio.tools.title', 'Tüm araçlar')}
          description={t(
            'studio.tools.subtitle',
            'Growth Studio ekranına sığmayan tam sayfa araçlar. Günlük işin ekranda; buradakiler tek seferlik kurulum ve derin çalışma için.',
          )}
          actions={
            <Button variant="secondary" onClick={closeTools}>
              <ArrowLeft className="mr-1.5 h-4 w-4" aria-hidden="true" />
              {t('studio.tools.back', 'Growth Studio’ya dön')}
            </Button>
          }
        />
        <ToolsSurface />
      </div>
    );
  }

  return (
    <Lazy>
      <StudioOneScreen />
    </Lazy>
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

/** The full-page tools, kept exactly where their deep links already point. */
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
        <TabsTrigger value="calendar">{t('studio.tab.calendar', 'İçerik Takvimi')}</TabsTrigger>
        <TabsTrigger value="create">{t('studio.tab.create', 'Üret')}</TabsTrigger>
        <TabsTrigger value="campaigns">{t('studio.tab.campaigns', 'Kampanyalar')}</TabsTrigger>
        <TabsTrigger value="trends">{t('studio.tab.trends', 'Trendler')}</TabsTrigger>
        <TabsTrigger value="more">{t('studio.tab.more', 'Diğer')}</TabsTrigger>
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
        <TabsTrigger value="studio">{t('studio.create.studio', 'AI Stüdyo')}</TabsTrigger>
        <TabsTrigger value="personas">{t('studio.create.personas', 'UGC Personaları')}</TabsTrigger>
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
        <TabsTrigger value="standard">{t('studio.camp.standard', 'Kampanyalar')}</TabsTrigger>
        <TabsTrigger value="social">{t('studio.camp.social', 'Sosyal Kampanyalar')}</TabsTrigger>
        <TabsTrigger value="planner">{t('studio.camp.planner', 'Sosyal Planlayıcı')}</TabsTrigger>
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

/**
 * The three pages that now also have a permanent home in Settings.
 *
 * They stay here as well, and the duplication is on purpose: these exact
 * `?tab=more&sub=…` URLs are in people's bookmarks and in this file's own test,
 * so removing the tab would break a link to buy nothing.
 */
function MoreTab() {
  const { t } = useTranslation('marketing');
  const [sub, setSub] = useSubTab(MORE_SUBS, 'email');
  return (
    <Tabs value={sub} onValueChange={setSub}>
      <TabsList>
        <TabsTrigger value="email">{t('studio.more.email', 'E-posta Şablonları')}</TabsTrigger>
        <TabsTrigger value="reviews">{t('studio.more.reviews', 'Yorumlar')}</TabsTrigger>
        <TabsTrigger value="affiliates">{t('studio.more.affiliates', 'Ortaklar')}</TabsTrigger>
      </TabsList>
      <TabsContent value="email" className="pt-4">
        <FeatureGate feature="campaigns" fallback={<UpgradeCallout />}>
          <Lazy><EmailTemplatesPage /></Lazy>
        </FeatureGate>
      </TabsContent>
      <TabsContent value="reviews" className="pt-4"><Lazy><ReviewsPage /></Lazy></TabsContent>
      <TabsContent value="affiliates" className="pt-4"><Lazy><AffiliatesPage /></Lazy></TabsContent>
    </Tabs>
  );
}
