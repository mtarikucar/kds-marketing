import { lazy, Suspense, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/components/ui';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';
import { RouteFallback } from '../../../components/RouteFallback';

// Lazy so a tab's code only loads when it is opened — each of these was its own
// route before, and neither should be paid for by someone who wanted the other.
const SendingDomainsPage = lazy(() => import('./SendingDomainsPage'));
const CustomDomainsPage = lazy(() => import('./CustomDomainsPage'));

const TABS = ['sending', 'custom'] as const;
type DomainTab = (typeof TABS)[number];

function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<RouteFallback />}>{children}</Suspense>;
}

/**
 * Domains — one page for every domain this workspace owns.
 *
 * These were two entries in the settings list and they are one job: you own a
 * domain, you paste DNS records your registrar asks for, you wait for it to
 * verify. Which of the two it is depends only on what the domain is FOR —
 * sending mail from, or serving pages on — and nobody arrives at settings
 * having already made that distinction. Two names for one workflow is how a
 * list of forty gets built.
 *
 * `?tab=` keeps every view addressable: the old routes redirect here with their
 * tab set, so a bookmark, a support link or a deep link from elsewhere in the
 * app lands exactly where it used to.
 */
export default function DomainsPage() {
  const { t } = useTranslation('marketing');
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const tab: DomainTab = (TABS as readonly string[]).includes(raw ?? '') ? (raw as DomainTab) : 'sending';

  const setTab = (v: string) => setParams((p) => {
    p.set('tab', v);
    return p;
  }, { replace: true });

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('domains.title', { defaultValue: 'Domains' })}
        description={t('domains.subtitle', {
          defaultValue: 'The domains you send mail from and serve your pages on, and the DNS records that prove they are yours.',
        })}
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="sending">{t('domains.tab.sending', { defaultValue: 'Sending' })}</TabsTrigger>
          <TabsTrigger value="custom">{t('domains.tab.custom', { defaultValue: 'Website' })}</TabsTrigger>
        </TabsList>

        <TabsContent value="sending" className="pt-5">
          <Lazy><SendingDomainsPage embedded /></Lazy>
        </TabsContent>
        <TabsContent value="custom" className="pt-5">
          <Lazy><CustomDomainsPage embedded /></Lazy>
        </TabsContent>
      </Tabs>
    </div>
  );
}
