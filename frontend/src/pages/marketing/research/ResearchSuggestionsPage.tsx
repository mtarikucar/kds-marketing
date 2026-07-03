import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Link } from 'react-router-dom';
import { Sparkles, Check, X, Phone, Instagram, Globe, Mail, ArrowLeft } from 'lucide-react';
import marketingApi from '../../../features/marketing/api/marketingApi';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryStateBoundary } from '@/components/ui/QueryStateBoundary';

interface Candidate {
  id: string;
  businessName: string;
  city?: string | null;
  region?: string | null;
  businessType: string;
  phone?: string | null;
  instagram?: string | null;
  website?: string | null;
  email?: string | null;
  stage?: string | null;
  priority: string;
  painPoint: string;
  evidence: string;
  pitch: string;
  score?: number | null;
}

const PRIORITY_TONE: Record<string, 'neutral' | 'info' | 'warning' | 'danger'> = {
  LOW: 'neutral', MEDIUM: 'info', HIGH: 'warning', URGENT: 'danger',
};

export default function ResearchSuggestionsPage() {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const q = useQuery<Candidate[]>({
    queryKey: ['marketing', 'research', 'candidates'],
    queryFn: () => marketingApi.get('/research/candidates').then((r) => r.data),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['marketing', 'research', 'candidates'] });
    qc.invalidateQueries({ queryKey: ['marketing', 'leads'] });
    setSelected(new Set());
  };

  const accept = useMutation({
    mutationFn: (ids: string[]) => marketingApi.post('/research/candidates/accept', { ids }).then((r) => r.data),
    onSuccess: (res: { accepted: number; ingest?: { created: number; clipped: number } }) => {
      const created = res.ingest?.created ?? res.accepted;
      toast.success(t('research.accepted', `${created} lead(s) added to your pipeline`, { count: created }));
      if (res.ingest?.clipped) toast.warning(t('research.acceptedClipped', 'Some were held back — daily quota reached'));
      invalidate();
    },
    onError: (e: any) => toast.error(e.response?.data?.message ?? t('research.acceptFailed', 'Could not accept')),
  });

  const reject = useMutation({
    mutationFn: (ids: string[]) => marketingApi.post('/research/candidates/reject', { ids }).then((r) => r.data),
    onSuccess: () => { toast.success(t('research.rejected', 'Dismissed')); invalidate(); },
    onError: (e: any) => toast.error(e.response?.data?.message ?? t('research.rejectFailed', 'Could not dismiss')),
  });

  const candidates = q.data ?? [];
  const toggle = (id: string) =>
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allSelected = candidates.length > 0 && selected.size === candidates.length;
  const busy = accept.isPending || reject.isPending;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('research.suggestions', 'AI suggestions')}
        description={t('research.suggestionsSubtitle', 'Review what the research agent found. Accept to add to your pipeline, dismiss the rest — nothing reaches your sales floor unvetted.')}
        actions={
          <Button asChild variant="outline" size="md">
            <Link to="/research"><ArrowLeft className="h-4 w-4" />{t('research.backToProfiles', 'Research profiles')}</Link>
          </Button>
        }
      />

      <QueryStateBoundary
        isLoading={q.isLoading}
        isError={q.isError}
        onRetry={() => q.refetch()}
        errorMessage={t('research.loadError', 'Could not load suggestions.')}
      >
        {candidates.length === 0 ? (
          <EmptyState
            icon={<Sparkles className="h-10 w-10" />}
            title={t('research.noSuggestions', 'No suggestions waiting')}
            description={t('research.noSuggestionsDesc', 'Run a research profile (or wait for tonight’s run) and qualified prospects will queue here for your review.')}
            action={<Button asChild><Link to="/research">{t('research.backToProfiles', 'Research profiles')}</Link></Button>}
          />
        ) : (
          <>
            {/* Bulk bar */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface-muted px-4 py-2.5">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={(c) => setSelected(c ? new Set(candidates.map((x) => x.id)) : new Set())}
                  aria-label={t('research.selectAll', 'Select all')}
                />
                {selected.size > 0
                  ? t('research.nSelected', `${selected.size} selected`, { count: selected.size })
                  : t('research.selectAll', 'Select all')}
              </label>
              <div className="flex items-center gap-2">
                <Button variant="secondary" size="sm" disabled={selected.size === 0 || busy} onClick={() => reject.mutate([...selected])}>
                  <X className="h-4 w-4" />{t('research.dismiss', 'Dismiss')}
                </Button>
                <Button size="sm" disabled={selected.size === 0 || busy} loading={accept.isPending} onClick={() => accept.mutate([...selected])}>
                  <Check className="h-4 w-4" />{t('research.accept', 'Add to pipeline')}
                </Button>
              </div>
            </div>

            <div className="space-y-3">
              {candidates.map((c) => (
                <Card key={c.id}>
                  <CardContent className="p-4">
                    <div className="flex items-start gap-3">
                      <Checkbox
                        checked={selected.has(c.id)}
                        onCheckedChange={() => toggle(c.id)}
                        aria-label={t('research.selectOne', 'Select {{name}}', { name: c.businessName })}
                        className="mt-1"
                      />
                      <div className="min-w-0 flex-1 space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-foreground">{c.businessName}</span>
                          <Badge tone="neutral" size="sm" className="uppercase">{c.businessType}</Badge>
                          <Badge tone={PRIORITY_TONE[c.priority] ?? 'neutral'} size="sm">{c.priority}</Badge>
                          {c.stage && <Badge tone="info" size="sm">{c.stage}</Badge>}
                          {(c.city || c.region) && (
                            <span className="text-caption text-muted-foreground">{[c.city, c.region].filter(Boolean).join(', ')}</span>
                          )}
                        </div>

                        <p className="text-sm text-foreground"><span className="text-muted-foreground">{t('research.painPoint', 'Pain')}:</span> {c.painPoint}</p>
                        <p className="text-caption text-muted-foreground">
                          <span className="font-medium">{t('research.evidence', 'Evidence')}:</span> {c.evidence}
                        </p>
                        <p className="rounded-md bg-surface-muted px-3 py-2 text-sm text-foreground">
                          <span className="text-muted-foreground">{t('research.pitch', 'Suggested opener')}:</span> {c.pitch}
                        </p>

                        <div className="flex flex-wrap items-center gap-3 text-caption text-muted-foreground">
                          {c.phone && <span className="inline-flex items-center gap-1"><Phone className="h-3.5 w-3.5" aria-hidden="true" />{c.phone}</span>}
                          {c.instagram && <span className="inline-flex items-center gap-1"><Instagram className="h-3.5 w-3.5" aria-hidden="true" />{c.instagram}</span>}
                          {c.website && (
                            <a href={c.website} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 hover:text-foreground">
                              <Globe className="h-3.5 w-3.5" aria-hidden="true" />{t('research.site', 'Website')}
                            </a>
                          )}
                          {c.email && <span className="inline-flex items-center gap-1"><Mail className="h-3.5 w-3.5" aria-hidden="true" />{c.email}</span>}
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-1">
                        <Button variant="secondary" size="sm" disabled={busy} onClick={() => reject.mutate([c.id])} aria-label={t('research.dismiss', 'Dismiss')}>
                          <X className="h-4 w-4" />
                        </Button>
                        <Button size="sm" disabled={busy} onClick={() => accept.mutate([c.id])}>
                          <Check className="h-4 w-4" />{t('research.add', 'Add')}
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </>
        )}
      </QueryStateBoundary>
    </div>
  );
}
