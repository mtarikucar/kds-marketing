import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Download, BookOpen } from 'lucide-react';
import marketingApi from '../../features/marketing/api/marketingApi';
import { GettingStarted, NeedsAttention } from '../../features/marketing/components';
import { useMarketingAuthStore } from '../../store/marketingAuthStore';
import {
  PageHeader,
  Button,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui';
import { DashboardHero } from './dashboard/DashboardHero';
import { WelcomeDialog } from './dashboard/WelcomeDialog';
import { KpiGrid } from './dashboard/KpiGrid';
import { TodaySummary } from './dashboard/TodaySummary';
import { MonthlyMetrics } from './dashboard/MonthlyMetrics';
import { LeadsByStatus } from './dashboard/LeadsByStatus';
import { TopPerformers } from './dashboard/TopPerformers';

export default function MarketingDashboardPage() {
  const { user } = useMarketingAuthStore();
  const { t } = useTranslation('marketing');
  const isManager = user?.role === 'MANAGER' || user?.role === 'OWNER';

  // One-time post-register welcome (register redirects to /dashboard?welcome=1).
  const [searchParams, setSearchParams] = useSearchParams();
  const [welcome, setWelcome] = useState(false);
  useEffect(() => {
    if (searchParams.get('welcome') === '1') {
      setWelcome(true);
      const next = new URLSearchParams(searchParams);
      next.delete('welcome');
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { data: stats } = useQuery({
    queryKey: ['marketing', 'dashboard', 'stats'],
    queryFn: () => marketingApi.get('/dashboard/stats').then((r) => r.data),
  });

  const { data: leadsByStatus } = useQuery({
    queryKey: ['marketing', 'dashboard', 'leads-by-status'],
    queryFn: () => marketingApi.get('/dashboard/leads-by-status').then((r) => r.data),
  });

  const { data: today } = useQuery({
    queryKey: ['marketing', 'dashboard', 'today'],
    queryFn: () => marketingApi.get('/dashboard/today').then((r) => r.data),
  });

  const { data: monthly } = useQuery({
    queryKey: ['marketing', 'dashboard', 'monthly'],
    queryFn: () => marketingApi.get('/dashboard/monthly').then((r) => r.data),
  });

  const { data: topPerformers } = useQuery({
    queryKey: ['marketing', 'dashboard', 'top-performers'],
    queryFn: () => marketingApi.get('/dashboard/top-performers').then((r) => r.data),
    enabled: isManager,
  });

  // Entitlements (shared key with BillingPage). The Inbox/conversations API is
  // gated by the conversationAi feature and 403s without it — so only surface
  // the unread card (and call /conversations) when the feature is enabled.
  const { data: summary } = useQuery({
    queryKey: ['marketing', 'billing', 'summary'],
    queryFn: () => marketingApi.get('/billing/summary').then((r) => r.data),
  });
  const conversationAiEnabled = !!summary?.entitlements?.features?.conversationAi;

  const { data: convos } = useQuery({
    // Same key InboxPage uses → shared cache + live EventSource invalidation.
    queryKey: ['marketing', 'conversations', 'OPEN'],
    queryFn: () => marketingApi.get('/conversations', { params: { status: 'OPEN' } }).then((r) => r.data),
    enabled: conversationAiEnabled,
    refetchInterval: 60_000,
  });
  const unreadCount = (convos ?? []).reduce((n: number, c: any) => n + (c.unreadCount ?? 0), 0);

  // The guide PDFs are shipped from frontend/public, so their URLs are just
  // the Vite base path + filename. Resolving at runtime keeps the
  // link correct under any deploy prefix (BASE_URL env / Vite `base`).
  const basePath = import.meta.env.BASE_URL.replace(/\/?$/, '/');
  const guideUrl = `${basePath}pazarlamaci-rehberi.pdf`;
  const managerGuideUrl = `${basePath}yonetici-rehberi.pdf`;

  // Trigger a PDF guide download from a menu item (preserves the download name).
  const downloadFile = (url: string, name: string) => {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <div className="space-y-6">
      <WelcomeDialog open={welcome} onClose={() => setWelcome(false)} />
      <PageHeader
        title={t('dashboard.title')}
        description={t('dashboard.subtitleTask', 'What needs you today')}
        actions={
          // The guide PDFs were the loudest thing on the page; demote them into
          // a quiet "Guides" menu so the primary CTA (the hero) leads instead.
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-2" data-testid="dashboard-guides">
                <BookOpen className="h-4 w-4" />
                {t('dashboard.guides', 'Guides')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              {isManager && (
                <DropdownMenuItem
                  onSelect={() => downloadFile(managerGuideUrl, 'Yonetici-Rehberi.pdf')}
                >
                  <Download className="me-2 h-4 w-4" />
                  {t('dashboard.downloadManagerGuide', 'Yönetici Rehberini İndir (PDF)')}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => downloadFile(guideUrl, 'Pazarlamaci-Rehberi.pdf')}>
                <Download className="me-2 h-4 w-4" />
                {t('dashboard.downloadGuide', 'Pazarlamacı Rehberini İndir (PDF)')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />

      {/* Role-aware "what do I do now?" anchor — the first thing every user sees. */}
      <DashboardHero
        stats={stats}
        today={today}
        isManager={isManager}
        firstName={user?.firstName}
      />

      {/* First-run setup checklist (managers). */}
      {isManager && <GettingStarted />}

      {/* Actionable "what's waiting on you" — deep links, hidden when clean. */}
      <NeedsAttention
        stats={stats}
        today={today}
        isManager={isManager}
        conversationAiEnabled={conversationAiEnabled}
        unreadCount={unreadCount}
      />

      {/* The day's work sits above the at-a-glance metrics. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <TodaySummary today={today} />
        <MonthlyMetrics monthly={monthly} />
      </div>

      {/* KPI tiles — the "performance at a glance" report, below the day's work.
          Trimmed to the two numbers no other section shows (2026-07): queues
          live in NeedsAttention, NEW/WON/LOST live in LeadsByStatus. */}
      <KpiGrid stats={stats} />

      {/* Leads by Status breakdown */}
      <LeadsByStatus leadsByStatus={leadsByStatus} />

      {/* Top Performers — manager only */}
      {isManager && topPerformers && topPerformers.length > 0 && (
        <TopPerformers topPerformers={topPerformers} />
      )}
    </div>
  );
}
