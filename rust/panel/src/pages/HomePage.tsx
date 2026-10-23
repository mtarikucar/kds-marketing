import { useQuery } from '@tanstack/react-query';
import { Compass } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getWorkspace } from '@/api/workspace';
import { useSession } from '@/auth/useSession';
import { PermissionList } from '@/components/PermissionList';
import { QueryState } from '@/components/QueryState';
import { WorkspaceStatusBadge } from '@/components/StatusBadges';
import { Callout, Card, CardContent, CardDescription, CardHeader, CardTitle, PageHeader } from '@/components/ui';
import { roleLabel } from '@/lib/roles';

export function HomePage() {
  const { t } = useTranslation();
  const session = useSession();
  const workspace = useQuery({
    queryKey: ['workspace', session.data?.current_workspace],
    queryFn: getWorkspace,
    enabled: !!session.data?.current_workspace,
  });

  return (
    <>
      <PageHeader title={t('home.title')} description={t('home.description')} />
      <QueryState query={workspace}>
        {workspace.data && (
          <Card>
            <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
              <div className="flex flex-col gap-1">
                <CardTitle>{workspace.data.name}</CardTitle>
                <CardDescription>{t(`home.inactive.${workspace.data.status}`)}</CardDescription>
              </div>
              <WorkspaceStatusBadge status={workspace.data.status} />
            </CardHeader>
            <CardContent>
              <dl className="grid gap-4 text-sm sm:grid-cols-3">
                <div className="flex flex-col gap-1">
                  <dt className="text-caption text-muted-foreground">{t('home.slug')}</dt>
                  <dd className="font-mono text-foreground">{workspace.data.slug}</dd>
                </div>
                <div className="flex flex-col gap-1">
                  <dt className="text-caption text-muted-foreground">{t('home.myRole')}</dt>
                  <dd className="text-foreground">{roleLabel(t, workspace.data.my_role)}</dd>
                </div>
                <div className="flex flex-col gap-1">
                  <dt className="text-caption text-muted-foreground">{t('home.myPermissions')}</dt>
                  <dd>
                    <PermissionList permissions={workspace.data.my_permissions} />
                  </dd>
                </div>
              </dl>
            </CardContent>
          </Card>
        )}
      </QueryState>
      {/* Filled in by the strategy milestone; until then every workspace is waiting. */}
      <Callout tone="info" icon={<Compass className="h-4 w-4" />} title={t('home.strategy.title')}>
        {t('home.strategy.body')}
      </Callout>
    </>
  );
}
