import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Plus, RefreshCw, Trash2, Copy, ShieldCheck } from 'lucide-react';
import marketingApi from '../../../features/marketing/api/marketingApi';
import {
  PageHeader, Card, CardContent, Button, Input, Field, Badge, EmptyState, ConfirmDialog,
} from '@/components/ui';

interface DnsRecord { label: string; host: string; type: string; value: string }
interface SendingDomain {
  id: string;
  domain: string;
  status: 'PENDING' | 'VERIFIED' | 'FAILED';
  fromEmail: string | null;
  lastError: string | null;
  records: DnsRecord[];
}

const STATUS_TONE: Record<SendingDomain['status'], 'neutral' | 'success' | 'danger'> = {
  PENDING: 'neutral',
  VERIFIED: 'success',
  FAILED: 'danger',
};

function apiErr(e: any, fallback: string): string {
  return e?.response?.data?.message ?? fallback;
}

/**
 * Custom sending domains (Epic 13) — register a domain, publish the DKIM/SPF/
 * DMARC records, and verify it. Inert until an operator enables an ESP
 * transport (register returns 503).
 */
export default function SendingDomainsPage() {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();
  const [domain, setDomain] = useState('');
  const [fromName, setFromName] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<SendingDomain | null>(null);

  const { data: domains = [] } = useQuery({
    queryKey: ['sending-domains'],
    queryFn: () => marketingApi.get('/sending-domains').then((r) => r.data as SendingDomain[]),
    refetchInterval: (q) =>
      (q.state.data as SendingDomain[] | undefined)?.some((d) => d.status === 'PENDING') ? 15000 : false,
  });

  const register = useMutation({
    mutationFn: () => marketingApi.post('/sending-domains', { domain, fromName: fromName || undefined }).then((r) => r.data),
    onSuccess: () => {
      setDomain('');
      setFromName('');
      qc.invalidateQueries({ queryKey: ['sending-domains'] });
      toast.success(t('sendingDomains.added', { defaultValue: 'Domain added — publish the DNS records below, then verify.' }));
    },
    onError: (e) => toast.error(apiErr(e, t('sendingDomains.addFailed', { defaultValue: 'Could not add the domain' }))),
  });

  const verify = useMutation({
    mutationFn: (id: string) => marketingApi.post(`/sending-domains/${id}/verify`).then((r) => r.data as SendingDomain),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ['sending-domains'] });
      toast[d.status === 'VERIFIED' ? 'success' : 'message'](
        d.status === 'VERIFIED'
          ? t('sendingDomains.verified', { defaultValue: 'Domain verified!' })
          : t('sendingDomains.notYet', { defaultValue: 'Records not found yet — DNS can take a while to propagate.' }),
      );
    },
    onError: (e) => toast.error(apiErr(e, t('sendingDomains.verifyFailed', { defaultValue: 'Verification failed' }))),
  });

  const remove = useMutation({
    mutationFn: (id: string) => marketingApi.delete(`/sending-domains/${id}`).then((r) => r.data),
    onSuccess: () => { setDeleteTarget(null); qc.invalidateQueries({ queryKey: ['sending-domains'] }); },
    onError: (e) => toast.error(apiErr(e, t('sendingDomains.deleteFailed', { defaultValue: 'Could not delete the domain' }))),
  });

  const copy = (value: string) => {
    navigator.clipboard?.writeText(value).then(
      () => toast.success(t('sendingDomains.copied', { defaultValue: 'Copied' })),
      () => undefined,
    );
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('sendingDomains.title', { defaultValue: 'Sending Domains' })}
        description={t('sendingDomains.subtitle', { defaultValue: 'Send marketing email from your own domain with DKIM/SPF/DMARC.' })}
      />

      <Card className="max-w-2xl">
        <CardContent className="flex flex-wrap items-end gap-3 p-5">
          <div className="flex-1 min-w-[200px]">
            <Field label={t('sendingDomains.domain', { defaultValue: 'Domain' })}>
              {({ id }) => <Input id={id} placeholder="mail.acme.com" value={domain} onChange={(e) => setDomain(e.target.value)} />}
            </Field>
          </div>
          <div className="flex-1 min-w-[160px]">
            <Field label={t('sendingDomains.fromName', { defaultValue: 'From name (optional)' })}>
              {({ id }) => <Input id={id} value={fromName} onChange={(e) => setFromName(e.target.value)} />}
            </Field>
          </div>
          <Button onClick={() => register.mutate()} loading={register.isPending} disabled={!domain.trim()}>
            <Plus className="h-4 w-4" />{t('sendingDomains.add', { defaultValue: 'Add' })}
          </Button>
        </CardContent>
      </Card>

      {domains.length === 0 ? (
        <EmptyState
          icon={<ShieldCheck className="h-10 w-10 text-muted-foreground" />}
          title={t('sendingDomains.empty', { defaultValue: 'No sending domains' })}
          description={t('sendingDomains.emptyHint', { defaultValue: 'Add a domain to send branded, authenticated email.' })}
        />
      ) : (
        <div className="space-y-4">
          {domains.map((d) => (
            <Card key={d.id}>
              <CardContent className="p-5">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="font-semibold text-foreground">{d.domain}</p>
                    {d.fromEmail && <p className="text-sm text-muted-foreground">{d.fromEmail}</p>}
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={STATUS_TONE[d.status]} size="sm">{d.status}</Badge>
                    <Button variant="outline" size="sm" loading={verify.isPending && verify.variables === d.id} onClick={() => verify.mutate(d.id)}>
                      <RefreshCw className="h-4 w-4" />{t('sendingDomains.verify', { defaultValue: 'Verify' })}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(d)} title={t('common.delete', { defaultValue: 'Delete' })}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                {d.status !== 'VERIFIED' && (
                  <>
                    {d.lastError && <p className="mb-2 text-sm text-warning">{d.lastError}</p>}
                    <p className="mb-2 text-sm text-muted-foreground">
                      {t('sendingDomains.addRecords', { defaultValue: 'Add these TXT records at your DNS provider:' })}
                    </p>
                    <div className="space-y-2">
                      {d.records.map((rec) => (
                        <div key={rec.label} className="rounded-lg border border-border bg-surface-muted p-3 text-sm">
                          <div className="mb-1 flex items-center justify-between">
                            <span className="font-medium text-foreground">{rec.label} · {rec.type}</span>
                            <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => copy(rec.value)} title={t('sendingDomains.copy', { defaultValue: 'Copy value' })}>
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

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}
        title={t('sendingDomains.deleteTitle', { defaultValue: 'Delete sending domain?' })}
        description={t('sendingDomains.deleteDesc', {
          defaultValue:
            'Email can no longer be sent from this domain. Re-adding it means publishing and verifying the DKIM/SPF/DMARC records again.',
        })}
        confirmLabel={t('common.delete', { defaultValue: 'Delete' })}
        cancelLabel={t('common.cancel', { defaultValue: 'Cancel' })}
        tone="danger"
        loading={remove.isPending}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget.id)}
      />
    </div>
  );
}
