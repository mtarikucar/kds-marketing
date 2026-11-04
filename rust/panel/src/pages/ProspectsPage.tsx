import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/components/ui';

/** `/prospects`: the prospect pool (spec §9). */
export function ProspectsPage() {
  const { t } = useTranslation();
  return <PageHeader title={t('leads.prospects.title')} description={t('leads.prospects.description')} />;
}
