import { useTranslation } from 'react-i18next';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';
import { TimelinePanel } from './TimelinePanel';
import { AgentActivity } from './AgentActivity';

/**
 * The home screen's left column: what is COMING (the calendar) and what HAS
 * HAPPENED (the agent's flow), one at a time.
 *
 * Tabbed rather than stacked, on purpose. Two half-height panels are two panels
 * you have to squint at; tabbing buys each of them the full column. The bill for
 * that is blindness — while you are reading the calendar, a run can fail in the
 * flow and the screen says nothing — and `failureCount` is what pays it. That is
 * why the count is a required prop rather than a nicety with a default: a badge
 * wired to a constant makes the column LOOK instrumented while telling you
 * nothing, which is strictly worse than no badge at all.
 *
 * Built on the design system's Radix `Tabs` rather than hand-rolled buttons, so
 * the ARIA pattern is whole: aria-selected, aria-controls/id wiring to a real
 * tabpanel, roving tabindex and arrow-key navigation. A half-built tablist —
 * the roles without the keyboard contract — is worse than plain buttons,
 * because a screen-reader user is told to expect arrows that do nothing.
 */
export function LeftColumn({ failureCount }: { failureCount: number }) {
  const { t } = useTranslation('marketing');
  const panelCls = 'mt-3 min-h-0 flex-1 overflow-y-auto';

  return (
    <Tabs defaultValue="timeline" className="flex h-full min-h-0 flex-col">
      <TabsList className="shrink-0">
        <TabsTrigger value="timeline">{t('command.tabs.timeline', 'Takvim')}</TabsTrigger>
        <TabsTrigger value="flow" className="gap-1.5">
          {t('command.tabs.flow', 'Akış')}
          {failureCount > 0 && (
            <span
              data-testid="flow-badge"
              // The bare number is meaningless read aloud, and it lands inside
              // the tab's accessible name — so this is what makes the tab
              // announce "Akış, 2 başarısız iş" instead of "Akış 2".
              aria-label={t('command.tabs.failures', '{{count}} başarısız iş', {
                count: failureCount,
              })}
              className="inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-danger-subtle px-1 text-micro font-medium text-danger"
            >
              {failureCount}
            </span>
          )}
        </TabsTrigger>
      </TabsList>

      {/* Radix unmounts the inactive panel, which is the point: the visible one
          gets the whole column rather than half of it. */}
      <TabsContent value="timeline" className={panelCls}>
        <TimelinePanel />
      </TabsContent>
      <TabsContent value="flow" className={panelCls}>
        <AgentActivity />
      </TabsContent>
    </Tabs>
  );
}
