import { useTranslation } from 'react-i18next';
import { WorkspaceHeader } from '@/components/WorkspaceHeader';
import { TeamPage } from './TeamPage';
import { RolesPage } from './RolesPage';

export function UsersPage() {
  const { t } = useTranslation();
  return <div className="space-y-6">
    <WorkspaceHeader title={t('nav.users')} />
    <section aria-labelledby="users-team" className="space-y-4">
      <h2 id="users-team" className="text-lg font-medium">{t('team.title')}</h2>
      <TeamPage embedded />
    </section>
    <section aria-labelledby="users-roles" className="space-y-4">
      <h2 id="users-roles" className="text-lg font-medium">{t('roles.title')}</h2>
      <RolesPage embedded />
    </section>
  </div>;
}
