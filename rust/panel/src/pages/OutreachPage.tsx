import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/components/ui';

/** `/outreach`: the email campaigns (spec §9). */
export function OutreachPage() {
  const { t } = useTranslation();
  return <PageHeader title={t('leads.outreach.title')} description={t('leads.outreach.description')} />;
}
