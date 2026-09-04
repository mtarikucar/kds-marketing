import { lazy, Suspense, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/components/ui';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';
import { RouteFallback } from '../../../components/RouteFallback';

// Lazy so a tab's code only loads when it is opened — each of these was its own
// route before, and neither should be paid for by someone who wanted the other.
const SegmentsPage = lazy(() => import('./segments/SegmentsPage'));
const TagsPage = lazy(() => import('./tags/TagsPage'));

const TABS = ['segments', 'tags'] as const;
type Tab = (typeof TABS)[number];

function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<RouteFallback />}>{children}</Suspense>;
}

/**
 * Segments and tags — the two ways contacts get grouped.
 *
 * A segment is a rule the system keeps applying; a tag is a label somebody
 * sticks on. You choose between them for the SAME job, which is exactly why
 * they belong on one page: the choice is only visible when both are.
 *
 * `?tab=` keeps every view addressable: the old routes redirect here with their
 * tab set, so a bookmark, a support link or a deep link from elsewhere in the
 * app lands exactly where it used to. Nothing became unreachable; the LIST got
 * shorter, which is the only thing that was too long.
 */
export default function AudiencePage(
  {
    embedded,
    /**
     * Which query parameter names THIS page's tab.
     *
     * Inside the Inbox `?tab=` already means "which config surface is open", so
     * a nested shell reading the same parameter sees `audience`, recognises
     * none of its own tabs and silently shows the first one — Tags becomes
     * unreachable, with nothing anywhere reporting a fault.
     */
    param = 'tab',
  }: { embedded?: boolean; param?: string } = {},
) {
  const { t } = useTranslation('marketing');
  const [params, setParams] = useSearchParams();
  const raw = params.get(param);
  const tab: Tab = (TABS as readonly string[]).includes(raw ?? '') ? (raw as Tab) : 'segments';

  const setTab = (v: string) => setParams((p) => {
    p.set(param, v);
    return p;
  }, { replace: true });

  return (
    <div className="space-y-5">
      <PageHeader
        embedded={embedded}
        title={t('audience.title', { defaultValue: 'Segments & tags' })}
        description={t('audience.subtitle', { defaultValue: 'Rules that group people automatically, and labels you apply by hand.' })}
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="segments">{t('audience.tab.segments', { defaultValue: 'Segments' })}</TabsTrigger>
          <TabsTrigger value="tags">{t('audience.tab.tags', { defaultValue: 'Tags' })}</TabsTrigger>
        </TabsList>

        <TabsContent value="segments" className="pt-5">
          <Lazy><SegmentsPage embedded /></Lazy>
        </TabsContent>
        <TabsContent value="tags" className="pt-5">
          <Lazy><TagsPage embedded /></Lazy>
        </TabsContent>
      </Tabs>
    </div>
  );
}
