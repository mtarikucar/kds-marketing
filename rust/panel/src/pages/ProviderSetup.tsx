import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { connectorHooks } from '@/api/connectors';
import { useSession } from '@/auth/useSession';
import { CopyField } from '@/components/CopyField';
import { QueryState } from '@/components/QueryState';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui';

/** The hooks API carries the configured public base URL, including its path prefix. */
export function ProviderSetup() {
  const {t}=useTranslation();
  const client=useQueryClient();
  const workspace=useSession().data?.current_workspace;
  const hooks=useQuery({queryKey:['connectors','setup',workspace],queryFn:({signal})=>connectorHooks(signal),gcTime:0,staleTime:0});
  useEffect(()=>()=>{client.removeQueries({queryKey:['connectors','setup',workspace],exact:true});},[client,workspace]);
  const url=hooks.data?.meta?.url ?? hooks.data?.netgsm[0]?.url;
  const base=url?.replace(/\/hooks\/(?:meta|netgsm)(?:\/.*)?$/, '');
  return <Card><CardHeader><CardTitle>{t('providerSetup.title')}</CardTitle></CardHeader><CardContent className="space-y-4">
    <p>{t('providerSetup.help')}</p>
    <QueryState query={hooks}>{hooks.data && <>
      {base && base!==url && ['meta','instagram','x'].map(provider=><CopyField key={provider} label={t('providerSetup.callback',{provider})} value={`${base}/oauth/callback/${provider}`}/>)}
      {hooks.data.meta && <CopyField label={t('capabilities.hooks.metaUrl')} value={hooks.data.meta.url}/>}
      {hooks.data.netgsm.map(hook=><CopyField key={hook.purpose} label={t(`capabilities.hooks.purposes.${hook.purpose}`)} value={hook.url}/>)}
    </>}</QueryState>
  </CardContent></Card>;
}
