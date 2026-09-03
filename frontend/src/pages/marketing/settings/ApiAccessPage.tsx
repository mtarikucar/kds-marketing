import { lazy, Suspense, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/components/ui';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';
import { RouteFallback } from '../../../components/RouteFallback';

// Lazy so a tab's code only loads when it is opened — each of these was its own
// route before, and neither should be paid for by someone who wanted the other.
const ApiKeysPage = lazy(() => import('./apiKeys/ApiKeysPage'));
const McpConsolePage = lazy(() => import('./mcpConsole/McpConsolePage'));

const TABS = ['keys', 'connector'] as const;
type Tab = (typeof TABS)[number];

function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<RouteFallback />}>{children}</Suspense>;
}

/**
 * API access — every way a program can act as this workspace.
 *
 * An API key and the Claude connector are the same decision wearing two
 * names: you are granting something outside this app the right to read and
 * write inside it. Keeping them apart hid that they answer one question, and
 * hid the connector from anyone who came looking for 'API'.
 *
 * `?tab=` keeps every view addressable: the old routes redirect here with their
 * tab set, so a bookmark, a support link or a deep link from elsewhere in the
 * app lands exactly where it used to. Nothing became unreachable; the LIST got
 * shorter, which is the only thing that was too long.
 */
export default function ApiAccessPage() {
  const { t } = useTranslation('marketing');
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const tab: Tab = (TABS as readonly string[]).includes(raw ?? '') ? (raw as Tab) : 'keys';

  const setTab = (v: string) => setParams((p) => {
    p.set('tab', v);
    return p;
  }, { replace: true });

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('apiAccess.title', { defaultValue: 'API access' })}
        description={t('apiAccess.subtitle', { defaultValue: 'Keys for your own code, and the Claude connector.' })}
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="keys">{t('apiAccess.tab.keys', { defaultValue: 'API keys' })}</TabsTrigger>
          <TabsTrigger value="connector">{t('apiAccess.tab.connector', { defaultValue: 'Claude connector' })}</TabsTrigger>
        </TabsList>

        <TabsContent value="keys" className="pt-5">
          <Lazy><ApiKeysPage embedded /></Lazy>
        </TabsContent>
        <TabsContent value="connector" className="pt-5">
          <Lazy><McpConsolePage embedded /></Lazy>
        </TabsContent>
      </Tabs>
    </div>
  );
}
