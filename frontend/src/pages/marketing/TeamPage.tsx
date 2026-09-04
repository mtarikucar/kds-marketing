import { lazy, Suspense, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/components/ui';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';
import { useGatedTabs } from '../../features/marketing/hooks/useGatedTabs';
import { RouteFallback } from '../../components/RouteFallback';

// Lazy so a tab's code only loads when it is opened — each of these was its own
// route before, and neither should be paid for by someone who wanted the other.
const MarketingUsersPage = lazy(() => import('./users'));
const RolesPage = lazy(() => import('./settings/roles/RolesPage'));
// Targets are what the team is measured against and Booking is when they are
// available. Both were entries of their own about PEOPLE, reachable only if
// you already knew they were not on the page about people.
const TargetsPage = lazy(() => import('./targets'));
const BookingSettingsPage = lazy(() => import('./BookingSettingsPage'));

const TAB_GATES = [
  { value: 'members' },
  { value: 'roles' },
  { value: 'targets' },
  { value: 'booking', feature: 'funnels' as const },
] as const;
type Tab = (typeof TAB_GATES)[number]['value'];

function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<RouteFallback />}>{children}</Suspense>;
}

/**
 * Team — who is in this workspace, and what they are allowed to do.
 *
 * Nobody thinks about a role without thinking about the person who has it.
 * These were adjacent entries in the same list, and the answer to 'why can’t
 * this person do that' lived on the other one.
 *
 * `?tab=` keeps every view addressable: the old routes redirect here with their
 * tab set, so a bookmark, a support link or a deep link from elsewhere in the
 * app lands exactly where it used to. Nothing became unreachable; the LIST got
 * shorter, which is the only thing that was too long.
 */
export default function TeamPage() {
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
        title={t('team.title', { defaultValue: 'Team' })}
        description={t('team.subtitle', { defaultValue: 'Who is here, what they may do, what they are aiming at, and when they can be booked.' })}
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          {allowed.includes('members') && <TabsTrigger value="members">{t('team.tab.members', { defaultValue: 'Members' })}</TabsTrigger>}
          {allowed.includes('roles') && <TabsTrigger value="roles">{t('team.tab.roles', { defaultValue: 'Roles & permissions' })}</TabsTrigger>}
          {allowed.includes('targets') && <TabsTrigger value="targets">{t('team.tab.targets', { defaultValue: 'Targets' })}</TabsTrigger>}
          {allowed.includes('booking') && <TabsTrigger value="booking">{t('team.tab.booking', { defaultValue: 'Booking' })}</TabsTrigger>}
        </TabsList>

        {allowed.includes('members') && <TabsContent value="members" className="pt-5">
          <Lazy><MarketingUsersPage embedded /></Lazy>
        </TabsContent>}
        {allowed.includes('roles') && <TabsContent value="roles" className="pt-5">
          <Lazy><RolesPage embedded /></Lazy>
        </TabsContent>}
        {allowed.includes('targets') && <TabsContent value="targets" className="pt-5">
          <Lazy><TargetsPage embedded /></Lazy>
        </TabsContent>}
        {allowed.includes('booking') && <TabsContent value="booking" className="pt-5">
          <Lazy><BookingSettingsPage embedded /></Lazy>
        </TabsContent>}
      </Tabs>
    </div>
  );
}
