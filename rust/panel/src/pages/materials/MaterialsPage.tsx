import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useSession } from '@/auth/useSession';
import { WorkspaceHeader } from '@/components/WorkspaceHeader';
import { can } from '@/lib/roles';
import { StudioMaterials } from './StudioMaterials';

export function MaterialsPage() {
  const { t } = useTranslation();
  const session = useSession();
  const navigate = useNavigate();
  return <div className="space-y-6">
    <WorkspaceHeader title={t('modulePages.materials')} />
    {can(session.data, 'materials.work')
      ? <StudioMaterials onOpenSlot={id => navigate(`/social?slot=${encodeURIComponent(id)}`)} />
      : <p role="alert">{t('studio.forbidden')}</p>}
  </div>;
}
