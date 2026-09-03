import { lazy, Suspense, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/components/ui';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';
import { RouteFallback } from '../../components/RouteFallback';

// Lazy so a tab's code only loads when it is opened — each of these was its own
// route before, and neither should be paid for by someone who wanted the other.
const VoicePage = lazy(() => import('./VoicePage'));
const IvrMenusPage = lazy(() => import('./voice/ivr/IvrMenusPage'));

const TABS = ['assistant', 'ivr'] as const;
type Tab = (typeof TABS)[number];

function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<RouteFallback />}>{children}</Suspense>;
}

/**
 * Voice — the greeting, and the menu the caller hears after it.
 *
 * One sitting of work, listed as two. You record what answers the phone and
 * you wire what the keypad does, and neither is finished without the other.
 *
 * `?tab=` keeps every view addressable: the old routes redirect here with their
 * tab set, so a bookmark, a support link or a deep link from elsewhere in the
 * app lands exactly where it used to. Nothing became unreachable; the LIST got
 * shorter, which is the only thing that was too long.
 */
export default function VoiceHubPage() {
  const { t } = useTranslation('marketing');
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const tab: Tab = (TABS as readonly string[]).includes(raw ?? '') ? (raw as Tab) : 'assistant';

  const setTab = (v: string) => setParams((p) => {
    p.set('tab', v);
    return p;
  }, { replace: true });

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('voiceHub.title', { defaultValue: 'Voice' })}
        description={t('voiceHub.subtitle', { defaultValue: 'What answers your line, and the options it offers.' })}
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="assistant">{t('voiceHub.tab.assistant', { defaultValue: 'Assistant' })}</TabsTrigger>
          <TabsTrigger value="ivr">{t('voiceHub.tab.ivr', { defaultValue: 'Phone tree' })}</TabsTrigger>
        </TabsList>

        <TabsContent value="assistant" className="pt-5">
          <Lazy><VoicePage embedded /></Lazy>
        </TabsContent>
        <TabsContent value="ivr" className="pt-5">
          <Lazy><IvrMenusPage embedded /></Lazy>
        </TabsContent>
      </Tabs>
    </div>
  );
}
