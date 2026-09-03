import { lazy, Suspense, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/components/ui';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';
import { RouteFallback } from '../../../components/RouteFallback';

// Lazy so a tab's code only loads when it is opened — each of these was its own
// route before, and neither should be paid for by someone who wanted the other.
const WebhooksPage = lazy(() => import('./webhooks/WebhooksPage'));
const InboundWebhooksPage = lazy(() => import('./inboundWebhooks'));

const TABS = ['outgoing', 'inbound'] as const;
type Tab = (typeof TABS)[number];

function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<RouteFallback />}>{children}</Suspense>;
}

/**
 * Webhooks — what this workspace sends out, and what it accepts in.
 *
 * Two entries for one idea. A webhook is a URL and a payload; which direction
 * it points is a detail of the same setup, not a different job, and splitting
 * it made someone learn two names for one concept.
 *
 * `?tab=` keeps every view addressable: the old routes redirect here with their
 * tab set, so a bookmark, a support link or a deep link from elsewhere in the
 * app lands exactly where it used to. Nothing became unreachable; the LIST got
 * shorter, which is the only thing that was too long.
 */
export default function WebhooksHubPage() {
  const { t } = useTranslation('marketing');
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const tab: Tab = (TABS as readonly string[]).includes(raw ?? '') ? (raw as Tab) : 'outgoing';

  const setTab = (v: string) => setParams((p) => {
    p.set('tab', v);
    return p;
  }, { replace: true });

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('webhooksHub.title', { defaultValue: 'Webhooks' })}
        description={t('webhooksHub.subtitle', { defaultValue: 'Send events to your systems, and accept events from theirs.' })}
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="outgoing">{t('webhooksHub.tab.outgoing', { defaultValue: 'Outgoing' })}</TabsTrigger>
          <TabsTrigger value="inbound">{t('webhooksHub.tab.inbound', { defaultValue: 'Inbound' })}</TabsTrigger>
        </TabsList>

        <TabsContent value="outgoing" className="pt-5">
          <Lazy><WebhooksPage embedded /></Lazy>
        </TabsContent>
        <TabsContent value="inbound" className="pt-5">
          <Lazy><InboundWebhooksPage embedded /></Lazy>
        </TabsContent>
      </Tabs>
    </div>
  );
}
