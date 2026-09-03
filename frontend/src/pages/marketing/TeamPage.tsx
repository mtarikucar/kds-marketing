import { lazy, Suspense, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/components/ui';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';
import { RouteFallback } from '../../components/RouteFallback';

// Lazy so a tab's code only loads when it is opened — each of these was its own
// route before, and neither should be paid for by someone who wanted the other.
const MarketingUsersPage = lazy(() => import('./users'));
const RolesPage = lazy(() => import('./settings/roles/RolesPage'));

const TABS = ['members', 'roles'] as const;
type Tab = (typeof TABS)[number];

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
  const tab: Tab = (TABS as readonly string[]).includes(raw ?? '') ? (raw as Tab) : 'members';

  const setTab = (v: string) => setParams((p) => {
    p.set('tab', v);
    return p;
  }, { replace: true });

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('team.title', { defaultValue: 'Team' })}
        description={t('team.subtitle', { defaultValue: 'Members, invitations, and the permissions each role carries.' })}
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="members">{t('team.tab.members', { defaultValue: 'Members' })}</TabsTrigger>
          <TabsTrigger value="roles">{t('team.tab.roles', { defaultValue: 'Roles & permissions' })}</TabsTrigger>
        </TabsList>

        <TabsContent value="members" className="pt-5">
          <Lazy><MarketingUsersPage embedded /></Lazy>
        </TabsContent>
        <TabsContent value="roles" className="pt-5">
          <Lazy><RolesPage embedded /></Lazy>
        </TabsContent>
      </Tabs>
    </div>
  );
}
