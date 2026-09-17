import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button, PageHeader, Textarea } from '@/components/ui';
import marketingApi from '../../../features/marketing/api/marketingApi';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import { businessTypesKey, readBusinessTypes, useBusinessTypes, validateBusinessTypes, type BusinessTypesResponse } from './businessTypes';

export default function BusinessTypesPage({ embedded = false }: { embedded?: boolean } = {}) {
  const workspaceId = useMarketingAuthStore((state) => state.user?.workspaceId);
  return <BusinessTypesEditor key={workspaceId} workspaceId={workspaceId} embedded={embedded} />;
}

function BusinessTypesEditor({ workspaceId, embedded }: { workspaceId?: string; embedded: boolean }) {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  const query = useBusinessTypes();
  const canManage = query.data?.canManage === true;
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? query.businessTypes.join('\n');
  const keys = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const validation = validateBusinessTypes(keys);
  const mutation = useMutation({
    mutationFn: (businessTypes: string[]) => marketingApi.patch('/workspaces/business-types', { businessTypes }).then((r) => readBusinessTypes(r.data)),
    onSuccess: async (response) => {
      // PATCH may contain only configured keys. Retain GET-only metadata until
      // the mandatory refresh supplies current historical values and permission.
      queryClient.setQueryData<BusinessTypesResponse>(businessTypesKey(workspaceId), (previous) => ({ ...previous, ...response }));
      setDraft(null);
      await queryClient.invalidateQueries({ queryKey: businessTypesKey(workspaceId) });
    },
  });
  const unavailable = !workspaceId || query.isPending || query.isError;
  const title = t('businessTypes.title');

  return (
    <div className="space-y-6">
      {embedded ? <h2 className="text-lg font-semibold">{title}</h2> : <PageHeader title={title} />}
      <form className="max-w-2xl space-y-4 rounded-xl border border-border bg-surface p-6" onSubmit={(event) => {
        event.preventDefault();
        if (canManage && !validation && !unavailable && !mutation.isPending) mutation.mutate(keys);
      }}>
        <p id="business-types-help" className="text-sm text-muted-foreground">{t('businessTypes.description')}</p>
        {!query.isPending && !canManage && <p className="text-sm text-muted-foreground">{t('businessTypes.readOnly')}</p>}
        {query.isPending && <p role="status">{t('businessTypes.loading')}</p>}
        {query.isError && <div role="alert" className="text-sm text-danger">
          <p>{t('businessTypes.loadError')}</p>
          <Button type="button" variant="outline" loading={query.isFetching} onClick={() => void query.refetch()}>{t('businessTypes.retry')}</Button>
        </div>}
        <div className="space-y-2">
          <label htmlFor="business-types" className="text-sm font-medium">{t('businessTypes.label')}</label>
          <Textarea id="business-types" rows={12} className="font-mono" value={value}
            readOnly={!canManage}
            disabled={unavailable || mutation.isPending}
            aria-describedby={`business-types-help${validation ? ' business-types-error' : ''}`}
            aria-invalid={!!validation}
            onChange={(event) => { setDraft(event.target.value); mutation.reset(); }} />
          {validation && <p id="business-types-error" role="alert" className="text-sm text-danger">{t(`businessTypes.validation.${validation}`)}</p>}
        </div>
        {mutation.isError && <p role="alert" className="text-sm text-danger">{t('businessTypes.saveError')}</p>}
        {mutation.isSuccess && <p role="status" className="text-sm">{t('businessTypes.saved')}</p>}
        <Button type="submit" loading={mutation.isPending} disabled={!canManage || unavailable || !!validation || draft === null}>
          {t(mutation.isPending ? 'businessTypes.saving' : 'businessTypes.save')}
        </Button>
      </form>
    </div>
  );
}
