import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Download } from 'lucide-react';
import marketingApi from '../../features/marketing/api/marketingApi';
import { GettingStarted, NeedsAttention } from '../../features/marketing/components';
import { useMarketingAuthStore } from '../../store/marketingAuthStore';
import { PageHeader } from '@/components/ui';
import { KpiGrid } from './dashboard/KpiGrid';
import { TodaySummary } from './dashboard/TodaySummary';
import { MonthlyMetrics } from './dashboard/MonthlyMetrics';
import { LeadsByStatus } from './dashboard/LeadsByStatus';
import { TopPerformers } from './dashboard/TopPerformers';

export default function MarketingDashboardPage() {
  const { user } = useMarketingAuthStore();
  const { t } = useTranslation('marketing');
  const isManager = user?.role === 'MANAGER' || user?.role === 'OWNER';

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

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('dashboard.title')}
        description={t('dashboard.subtitle')}
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            {/* Manager rehberi — sadece MANAGER görür: lead atama,
                otomatik dağıtım, komisyon onay akışı, ekip yönetimi. */}
            {isManager && (
              <a
                href={managerGuideUrl}
                target="_blank"
                rel="noopener noreferrer"
                download="Yonetici-Rehberi.pdf"
                className="inline-flex items-center gap-2 rounded-lg border border-success/30 bg-success-subtle px-3 py-2 text-sm font-medium text-success hover:opacity-80 transition-opacity"
                data-testid="dashboard-manager-guide-download"
              >
                <Download className="w-4 h-4" />
                {t('dashboard.downloadManagerGuide', 'Yönetici Rehberini İndir (PDF)')}
              </a>
            )}
            {/* Pazarlamacı rehberi — sahaya çıkış, komisyon yapısı, sıkça
                sorulan sorular. Manager da görür: ekibinin elindeki belgenin
                aynısını okuyabilsin. */}
            <a
              href={guideUrl}
              target="_blank"
              rel="noopener noreferrer"
              download="Pazarlamaci-Rehberi.pdf"
              className="inline-flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm font-medium text-primary hover:opacity-80 transition-opacity"
              data-testid="dashboard-guide-download"
            >
              <Download className="w-4 h-4" />
              {t('dashboard.downloadGuide', 'Pazarlamacı Rehberini İndir (PDF)')}
            </a>
          </div>
        }
      />

      {/* First-run orientation: setup checklist (managers) + actionable items. */}
      {isManager && <GettingStarted />}
      <NeedsAttention
        stats={stats}
        today={today}
        isManager={isManager}
        conversationAiEnabled={conversationAiEnabled}
        unreadCount={unreadCount}
      />

      {/* KPI tiles */}
      <KpiGrid stats={stats} isManager={isManager} />

      {/* Today + Monthly side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <TodaySummary today={today} />
        <MonthlyMetrics monthly={monthly} />
      </div>

      {/* Leads by Status breakdown */}
      <LeadsByStatus leadsByStatus={leadsByStatus} />

      {/* Top Performers — manager only */}
      {isManager && topPerformers && topPerformers.length > 0 && (
        <TopPerformers topPerformers={topPerformers} />
      )}
    </div>
  );
}
