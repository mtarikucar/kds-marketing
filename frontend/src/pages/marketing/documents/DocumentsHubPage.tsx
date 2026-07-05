import { lazy, Suspense, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/components/ui/PageHeader';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';
import { RouteFallback } from '../../../components/RouteFallback';

// Lazy so a tab's code only loads when opened (each was its own route before).
const OffersPage = lazy(() => import('../offers/OffersPage'));
const EstimatesPage = lazy(() => import('../estimates/EstimatesPage'));
const DocumentsPage = lazy(() => import('./DocumentsPage'));

const TABS = ['offers', 'estimates', 'files'] as const;
type DocumentsTab = (typeof TABS)[number];

function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<RouteFallback />}>{children}</Suspense>;
}

/**
 * Documents hub — the ONE surface for all sales paperwork: price offers,
 * estimates/quotes and e-signature documents live here as deep-linkable
 * `?tab=` tabs, so every view survives refresh/back and can be shared.
 * Each embedded page skips its own header and keeps its create CTA in-body.
 */
export default function DocumentsHubPage() {
  const { t } = useTranslation('marketing');
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const tab: DocumentsTab = (TABS as readonly string[]).includes(raw ?? '') ? (raw as DocumentsTab) : 'offers';

  const setTab = (v: string) => setParams((p) => {
    p.set('tab', v);
    return p;
  }, { replace: true });

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('documentsHub.title', 'Documents')}
        description={t('documentsHub.subtitle', 'Offers, estimates and e-signature agreements — all your sales paperwork in one place.')}
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="offers">{t('documentsHub.tab.offers', 'Offers')}</TabsTrigger>
          <TabsTrigger value="estimates">{t('documentsHub.tab.estimates', 'Estimates')}</TabsTrigger>
          <TabsTrigger value="files">{t('documentsHub.tab.files', 'Documents')}</TabsTrigger>
        </TabsList>

        <TabsContent value="offers" className="pt-5">
          <Lazy><OffersPage embedded /></Lazy>
        </TabsContent>
        <TabsContent value="estimates" className="pt-5">
          <Lazy><EstimatesPage embedded /></Lazy>
        </TabsContent>
        <TabsContent value="files" className="pt-5">
          <Lazy><DocumentsPage embedded /></Lazy>
        </TabsContent>
      </Tabs>
    </div>
  );
}
