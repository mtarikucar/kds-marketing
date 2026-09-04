import { lazy, Suspense, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/components/ui';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';
import { useGatedTabs } from '../../features/marketing/hooks/useGatedTabs';
import { RouteFallback } from '../../components/RouteFallback';

// Lazy so a tab's code only loads when it is opened — each of these was its own
// route before, and neither should be paid for by someone who wanted the other.
const VoicePage = lazy(() => import('./VoicePage'));
const IvrMenusPage = lazy(() => import('./voice/ivr/IvrMenusPage'));
// The log of what the phone actually did. It was a separate entry from the
// thing that answers the phone, which is one subject in two places.
const CallsPage = lazy(() => import('./CallsPage'));

const TAB_GATES = [
  { value: 'assistant' },
  { value: 'ivr' },
  { value: 'calls', feature: 'telephony' as const },
] as const;
type Tab = (typeof TAB_GATES)[number]['value'];

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
  // Gated, not merely validated: a half this workspace has not bought must
  // not be openable by typing its name into the URL either.
  const { allowed, active } = useGatedTabs(TAB_GATES, raw);
  const tab = active as Tab;

  const setTab = (v: string) => setParams((p) => {
    p.set('tab', v);
    return p;
  }, { replace: true });

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('voiceHub.title', { defaultValue: 'Voice' })}
        description={t('voiceHub.subtitle', { defaultValue: 'What answers your line, the options it offers, and what it has done.' })}
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          {allowed.includes('assistant') && <TabsTrigger value="assistant">{t('voiceHub.tab.assistant', { defaultValue: 'Assistant' })}</TabsTrigger>}
          {allowed.includes('ivr') && <TabsTrigger value="ivr">{t('voiceHub.tab.ivr', { defaultValue: 'Phone tree' })}</TabsTrigger>}
          {allowed.includes('calls') && <TabsTrigger value="calls">{t('voiceHub.tab.calls', { defaultValue: 'Calls' })}</TabsTrigger>}
        </TabsList>

        {allowed.includes('assistant') && <TabsContent value="assistant" className="pt-5">
          <Lazy><VoicePage embedded /></Lazy>
        </TabsContent>}
        {allowed.includes('ivr') && <TabsContent value="ivr" className="pt-5">
          <Lazy><IvrMenusPage embedded /></Lazy>
        </TabsContent>}
        {allowed.includes('calls') && <TabsContent value="calls" className="pt-5">
          <Lazy><CallsPage embedded param="sub" /></Lazy>
        </TabsContent>}
      </Tabs>
    </div>
  );
}
