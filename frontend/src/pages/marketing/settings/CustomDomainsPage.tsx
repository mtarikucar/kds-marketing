import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Plus, RefreshCw, Trash2, Copy, Globe } from 'lucide-react';
import marketingApi from '../../../features/marketing/api/marketingApi';
import {
  PageHeader, Card, CardContent, Button, Input, Field, Badge, EmptyState,
} from '@/components/ui';

interface DnsInstruction { label: string; host: string; type: string; value: string }
interface CustomDomain {
  id: string;
  hostname: string;
  status: 'PENDING' | 'VERIFIED' | 'ACTIVE' | 'FAILED';
  homeSlug: string;
  lastError: string | null;
  instructions: DnsInstruction[];
}

const STATUS_TONE: Record<CustomDomain['status'], 'neutral' | 'success' | 'danger'> = {
  PENDING: 'neutral',
  VERIFIED: 'success',
  ACTIVE: 'success',
  FAILED: 'danger',
};

function apiErr(e: any, fallback: string): string {
  return e?.response?.data?.message ?? fallback;
}

/**
 * Custom domains (Epic 13) — point your own hostname at the platform to white-
 * label your public site. Inert until an operator enables it (register → 503).
 */
export default function CustomDomainsPage() {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();
  const [hostname, setHostname] = useState('');
  const [homeSlug, setHomeSlug] = useState('');

  const { data: domains = [] } = useQuery({
    queryKey: ['custom-domains'],
    queryFn: () => marketingApi.get('/custom-domains').then((r) => r.data as CustomDomain[]),
    refetchInterval: (q) =>
      (q.state.data as CustomDomain[] | undefined)?.some((d) => d.status === 'PENDING') ? 15000 : false,
  });

  const register = useMutation({
    mutationFn: () => marketingApi.post('/custom-domains', { hostname, homeSlug: homeSlug || undefined }).then((r) => r.data),
    onSuccess: () => {
      setHostname('');
      setHomeSlug('');
      qc.invalidateQueries({ queryKey: ['custom-domains'] });
      toast.success(t('customDomains.added', { defaultValue: 'Domain added — publish the DNS records below, then verify.' }));
    },
    onError: (e) => toast.error(apiErr(e, t('customDomains.addFailed', { defaultValue: 'Could not add the domain' }))),
  });

  const verify = useMutation({
    mutationFn: (id: string) => marketingApi.post(`/custom-domains/${id}/verify`).then((r) => r.data as CustomDomain),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ['custom-domains'] });
      toast[d.status === 'VERIFIED' || d.status === 'ACTIVE' ? 'success' : 'message'](
        d.status === 'VERIFIED' || d.status === 'ACTIVE'
          ? t('customDomains.verified', { defaultValue: 'Domain verified!' })
          : t('customDomains.notYet', { defaultValue: 'Records not found yet — DNS can take a while to propagate.' }),
      );
    },
    onError: (e) => toast.error(apiErr(e, t('customDomains.verifyFailed', { defaultValue: 'Verification failed' }))),
  });

  const remove = useMutation({
    mutationFn: (id: string) => marketingApi.delete(`/custom-domains/${id}`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['custom-domains'] }),
    onError: (e) => toast.error(apiErr(e, t('customDomains.deleteFailed', { defaultValue: 'Could not delete the domain' }))),
  });

  const copy = (value: string) =>
    navigator.clipboard?.writeText(value).then(() => toast.success(t('customDomains.copied', { defaultValue: 'Copied' })), () => undefined);

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('customDomains.title', { defaultValue: 'Custom Domains' })}
        description={t('customDomains.subtitle', { defaultValue: 'Serve your public site on your own domain.' })}
      />

      <Card className="max-w-2xl">
        <CardContent className="flex flex-wrap items-end gap-3 p-5">
          <div className="flex-1 min-w-[200px]">
            <Field label={t('customDomains.hostname', { defaultValue: 'Hostname' })}>
              {({ id }) => <Input id={id} placeholder="www.acme.com" value={hostname} onChange={(e) => setHostname(e.target.value)} />}
            </Field>
          </div>
          <div className="flex-1 min-w-[140px]">
            <Field label={t('customDomains.homeSlug', { defaultValue: 'Home page slug (optional)' })}>
              {({ id }) => <Input id={id} placeholder="home" value={homeSlug} onChange={(e) => setHomeSlug(e.target.value)} />}
            </Field>
          </div>
          <Button onClick={() => register.mutate()} loading={register.isPending} disabled={!hostname.trim()}>
            <Plus className="h-4 w-4" />{t('customDomains.add', { defaultValue: 'Add' })}
          </Button>
        </CardContent>
      </Card>

      {domains.length === 0 ? (
        <EmptyState
          icon={<Globe className="h-10 w-10 text-muted-foreground" />}
          title={t('customDomains.empty', { defaultValue: 'No custom domains' })}
          description={t('customDomains.emptyHint', { defaultValue: 'Add a domain to serve your site on your own URL.' })}
        />
      ) : (
        <div className="space-y-4">
          {domains.map((d) => (
            <Card key={d.id}>
              <CardContent className="p-5">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                  <p className="font-semibold text-foreground">{d.hostname}</p>
                  <div className="flex items-center gap-2">
                    <Badge tone={STATUS_TONE[d.status]} size="sm">{d.status}</Badge>
                    <Button variant="outline" size="sm" loading={verify.isPending && verify.variables === d.id} onClick={() => verify.mutate(d.id)}>
                      <RefreshCw className="h-4 w-4" />{t('customDomains.verify', { defaultValue: 'Verify' })}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => remove.mutate(d.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                {d.status !== 'VERIFIED' && d.status !== 'ACTIVE' && (
                  <>
                    {d.lastError && <p className="mb-2 text-sm text-warning">{d.lastError}</p>}
                    <p className="mb-2 text-sm text-muted-foreground">
                      {t('customDomains.addRecords', { defaultValue: 'Add these records at your DNS provider:' })}
                    </p>
                    <div className="space-y-2">
                      {d.instructions.map((rec) => (
                        <div key={rec.label} className="rounded-lg border border-border bg-surface-muted p-3 text-sm">
                          <div className="mb-1 flex items-center justify-between">
                            <span className="font-medium text-foreground">{rec.type}</span>
                            <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => copy(rec.value)} title={t('customDomains.copy', { defaultValue: 'Copy value' })}>
                              <Copy className="h-4 w-4" />
                            </button>
                          </div>
                          <p className="break-all font-mono text-xs text-muted-foreground">{rec.host}</p>
                          <p className="break-all font-mono text-xs text-foreground">{rec.value}</p>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
