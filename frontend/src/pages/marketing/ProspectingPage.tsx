import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Search, ExternalLink, UserPlus, Gauge } from 'lucide-react';
import marketingApi from '../../features/marketing/api/marketingApi';
import { API_URL } from '../../lib/env';
import {
  PageHeader, Card, CardContent, Button, Input, Field, Badge, EmptyState,
} from '@/components/ui';

interface Audit {
  id: string;
  targetUrl: string;
  businessName: string | null;
  status: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED';
  score: number | null;
  publicToken: string;
  convertedLeadId: string | null;
  createdAt: string;
  completedAt: string | null;
}

const STATUS_TONE: Record<Audit['status'], 'neutral' | 'info' | 'success' | 'danger'> = {
  PENDING: 'neutral',
  RUNNING: 'info',
  DONE: 'success',
  FAILED: 'danger',
};

function apiErr(e: any, fallback: string): string {
  return e?.response?.data?.message ?? fallback;
}

/** Public report URL is shareable with the prospect (served by the backend). */
const reportUrl = (token: string) => `${API_URL}/public/audits/${token}`;

/**
 * Prospecting audit (Epic 13) — point the tool at a prospect's website to get a
 * branded SEO/performance report you can share or convert to a lead. Inert until
 * an operator sets PAGESPEED_API_KEY (the API returns 503).
 */
export default function ProspectingPage() {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');

  const { data: audits = [] } = useQuery({
    queryKey: ['prospect-audits'],
    queryFn: () => marketingApi.get('/prospecting/audits').then((r) => r.data as Audit[]),
    // Poll while any audit is still being graded so the score lands without a manual refresh.
    refetchInterval: (q) =>
      (q.state.data as Audit[] | undefined)?.some((a) => a.status === 'PENDING' || a.status === 'RUNNING') ? 5000 : false,
  });

  const request = useMutation({
    mutationFn: () => marketingApi.post('/prospecting/audits', { targetUrl: url, businessName: name || undefined }).then((r) => r.data),
    onSuccess: () => {
      setUrl('');
      setName('');
      qc.invalidateQueries({ queryKey: ['prospect-audits'] });
      toast.success(t('prospecting.queued', { defaultValue: 'Audit started — the report will be ready shortly.' }));
    },
    onError: (e) => toast.error(apiErr(e, t('prospecting.failed', { defaultValue: 'Could not start the audit' }))),
  });

  const convert = useMutation({
    mutationFn: (id: string) => marketingApi.post(`/prospecting/audits/${id}/convert`).then((r) => r.data as { leadId: string; alreadyConverted: boolean }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['prospect-audits'] });
      toast.success(res.alreadyConverted
        ? t('prospecting.alreadyLead', { defaultValue: 'This audit is already linked to a lead.' })
        : t('prospecting.convertedToLead', { defaultValue: 'Lead created from the audit.' }));
    },
    onError: (e) => toast.error(apiErr(e, t('prospecting.convertFailed', { defaultValue: 'Could not convert to a lead' }))),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('prospecting.title', { defaultValue: 'Prospecting Audit' })}
        description={t('prospecting.subtitle', { defaultValue: "Grade a prospect's website and turn the report into a lead." })}
      />

      <Card className="max-w-2xl">
        <CardContent className="space-y-4 p-5">
          <Field label={t('prospecting.url', { defaultValue: 'Website URL' })}>
            {({ id }) => <Input id={id} placeholder="acme-coffee.com" value={url} onChange={(e) => setUrl(e.target.value)} />}
          </Field>
          <Field label={t('prospecting.businessName', { defaultValue: 'Business name (optional)' })}>
            {({ id }) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <Button onClick={() => request.mutate()} loading={request.isPending} disabled={!url.trim()}>
            <Search className="h-4 w-4" />{t('prospecting.run', { defaultValue: 'Run audit' })}
          </Button>
        </CardContent>
      </Card>

      {audits.length === 0 ? (
        <EmptyState
          icon={<Gauge className="h-10 w-10 text-muted-foreground" />}
          title={t('prospecting.empty', { defaultValue: 'No audits yet' })}
          description={t('prospecting.emptyHint', { defaultValue: 'Run your first website audit above.' })}
        />
      ) : (
        <div className="space-y-3">
          {audits.map((a) => (
            <Card key={a.id}>
              <CardContent className="flex flex-wrap items-center gap-4 p-4">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-foreground">{a.businessName || a.targetUrl}</p>
                  <p className="truncate text-sm text-muted-foreground">{a.targetUrl}</p>
                </div>
                {a.status === 'DONE' && a.score != null && (
                  <div className="text-center">
                    <p className="text-2xl font-bold tabular-nums text-foreground">{a.score}</p>
                    <p className="text-micro text-muted-foreground">/ 100</p>
                  </div>
                )}
                <Badge tone={STATUS_TONE[a.status]} size="sm">{a.status}</Badge>
                <div className="flex gap-2">
                  <a href={reportUrl(a.publicToken)} target="_blank" rel="noopener noreferrer">
                    <Button variant="outline" size="sm"><ExternalLink className="h-4 w-4" />{t('prospecting.viewReport', { defaultValue: 'Report' })}</Button>
                  </a>
                  <Button
                    variant={a.convertedLeadId ? 'ghost' : 'primary'}
                    size="sm"
                    // Scope the in-flight guard to THIS audit (convert.variables ===
                    // a.id) — a bare convert.isPending disables every other audit's
                    // convert button while one conversion is running.
                    disabled={!!a.convertedLeadId || (convert.isPending && convert.variables === a.id)}
                    onClick={() => convert.mutate(a.id)}
                  >
                    <UserPlus className="h-4 w-4" />
                    {a.convertedLeadId
                      ? t('prospecting.isLead', { defaultValue: 'Lead created' })
                      : t('prospecting.convert', { defaultValue: 'To lead' })}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
