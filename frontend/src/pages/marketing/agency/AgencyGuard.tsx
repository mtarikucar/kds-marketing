import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Building2 } from 'lucide-react';
import { EmptyState, Skeleton } from '@/components/ui';
import { useWorkspaceProfile } from '../../../features/marketing/hooks/useWorkspaceProfile';

/**
 * Page-level gate for the Agency console. The backend already 403s every
 * `/agency/*` route for a non-AGENCY workspace, and the nav hides the section —
 * but routes are deep-linkable, so each agency page also guards itself: a
 * non-agency workspace gets a clean empty state instead of a wall of failed
 * requests. While the workspace profile loads we show a skeleton (fail-closed:
 * nothing agency-specific renders until kind is confirmed AGENCY).
 */
export function AgencyGuard({ children }: { children: ReactNode }) {
  const { t } = useTranslation('marketing');
  const { isAgency, isLoading } = useWorkspaceProfile();

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (!isAgency) {
    return (
      <EmptyState
        icon={<Building2 className="h-10 w-10" />}
        title={t('agency.notAgency.title', { defaultValue: 'Agency console unavailable' })}
        description={t('agency.notAgency.desc', {
          defaultValue: 'This workspace is not an agency. Sub-accounts, snapshots and rebilling are only available to agency workspaces.',
        })}
      />
    );
  }

  return <>{children}</>;
}
