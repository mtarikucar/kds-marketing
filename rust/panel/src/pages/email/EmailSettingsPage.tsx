import { useTranslation } from 'react-i18next';
import { useSession } from '@/auth/useSession';
import { QueryState } from '@/components/QueryState';
import { Callout, Card, CardContent, CardDescription, CardHeader, CardTitle, PageHeader } from '@/components/ui';
import { can } from '@/lib/roles';
import { B2bForm, SenderForm, useEmailSettings, useMayOpenBasis } from './EmailFacts';

/**
 * `/settings/email`: the facts every email to a person needs, whatever modules are installed:
 * the sender details under each email and, for the owner, the first-message permission for
 * businesses. The campaigns' own settings stay on their page.
 */
export function EmailSettingsPage() {
  const { t } = useTranslation();
  const session = useSession();
  const settings = useEmailSettings();
  const owner = useMayOpenBasis();
  const s = settings.data;
  return (
    <>
      <PageHeader title={t('email.title')} description={t('email.description')} />
      {s && !s.platform_enabled && <Callout tone="warning">{t('email.platformOff')}</Callout>}
      <QueryState query={settings}>
        {s && (
          <div className="flex flex-col gap-4">
            <Card>
              <CardHeader>
                <CardTitle>{t('leads.settings.identity')}</CardTitle>
                {!can(session.data, 'inbox.work') && <CardDescription>{t('leads.settings.readOnly')}</CardDescription>}
              </CardHeader>
              <CardContent>
                <SenderForm key={JSON.stringify([s.sender_company, s.sender_address, s.privacy_notice_url])} settings={s} />
              </CardContent>
            </Card>
            {owner && <B2bForm key={JSON.stringify([s.b2b_basis, s.require_iys_lookup, s.legal_ack])} settings={s} />}
          </div>
        )}
      </QueryState>
    </>
  );
}
