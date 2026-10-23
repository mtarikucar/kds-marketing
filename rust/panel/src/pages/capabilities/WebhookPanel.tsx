import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { connectorHooks } from '@/api/connectors';
import { CopyField } from '@/components/CopyField';
import { QueryState } from '@/components/QueryState';
import { Callout, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';
import { HOOKS_KEY } from './queries';

/**
 * Where the providers deliver this workspace's events, to paste into each provider's dashboard:
 * the workspace's NetGSM callback URL per purpose (each carries the workspace's hook token, so the
 * page shows it only to who may manage capabilities) and the platform's Meta webhook, whose verify
 * token is never shown.
 */
export function WebhookPanel() {
  const { t } = useTranslation();
  const hooks = useQuery({ queryKey: HOOKS_KEY, queryFn: connectorHooks });
  return (
    <section aria-labelledby="webhook-addresses-title">
      <Card>
        <CardHeader>
          <CardTitle id="webhook-addresses-title">{t('capabilities.hooks.title')}</CardTitle>
          <CardDescription>{t('capabilities.hooks.description')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <QueryState query={hooks}>
            {hooks.data && (
              <>
                <div className="flex flex-col gap-2">
                  <h4 className="text-sm font-medium text-foreground">{t('capabilities.hooks.netgsmTitle')}</h4>
                  <p className="text-caption text-muted-foreground">{t('capabilities.hooks.netgsmHelp')}</p>
                  {hooks.data.netgsm.map((hook) => {
                    const label = t(`capabilities.hooks.purposes.${hook.purpose}`);
                    return (
                      <div key={hook.purpose} className="flex flex-col gap-1">
                        <span className="text-caption text-muted-foreground">{label}</span>
                        <CopyField label={label} value={hook.url} />
                      </div>
                    );
                  })}
                </div>
                <div className="flex flex-col gap-2">
                  <h4 className="text-sm font-medium text-foreground">{t('capabilities.hooks.metaTitle')}</h4>
                  {hooks.data.meta ? (
                    <>
                      <CopyField label={t('capabilities.hooks.metaUrl')} value={hooks.data.meta.url} />
                      <p className="text-caption text-muted-foreground">{t('capabilities.hooks.verifyTokenHint')}</p>
                    </>
                  ) : (
                    <Callout tone="info">{t('capabilities.hooks.metaMissing')}</Callout>
                  )}
                </div>
              </>
            )}
          </QueryState>
        </CardContent>
      </Card>
    </section>
  );
}
