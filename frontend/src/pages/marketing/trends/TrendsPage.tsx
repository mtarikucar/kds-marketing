import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { TrendingUp, Sparkles, ShieldAlert, Link as LinkIcon } from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Callout } from '@/components/ui/Callout';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/Select';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryStateBoundary } from '@/components/ui/QueryStateBoundary';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/Dialog';
import { listTrends, saveTrend, remixTrend, type RemixBrief, type TrendPlatform } from '../../../features/marketing/api/trends.service';

const PLATFORM_LABEL: Record<string, string> = { TIKTOK: 'TikTok', INSTAGRAM: 'Instagram', YOUTUBE: 'YouTube' };

/**
 * Trend → Remix console (Faz 4). Save a trend's ABSTRACT format (never a copy),
 * then adapt it onto your brand as a ready-to-shoot brief — always with a
 * compliance note.
 */
export default function TrendsPage({ embedded }: { embedded?: boolean } = {}) {
  const { t } = useTranslation('marketing');
  const [dialogOpen, setDialogOpen] = useState(false);
  const q = useQuery({ queryKey: ['trend-templates'], queryFn: listTrends });

  return (
    <div className="space-y-6">
      {!embedded && (
      <PageHeader
        title={t('trend.title', 'Trend Remix')}
        description={t('trend.subtitle', 'Capture a trend’s format — hook, pacing, structure — and remix it onto your brand. Never a copy.')}
        actions={<Button onClick={() => setDialogOpen(true)}>{t('trend.save', 'Save a trend')}</Button>}
      />
      )}

      <QueryStateBoundary isLoading={q.isLoading} isError={q.isError} onRetry={() => q.refetch()}>
        {!q.data?.length ? (
          <EmptyState
            icon={<TrendingUp className="h-6 w-6" />}
            title={t('trend.empty.title', 'No trends captured yet')}
            description={t('trend.empty.desc', 'Paste a trending video link and describe its format (hook, pacing). Jeeta stores the abstract structure — never the video — so you can remix it onto your brand.')}
            action={<Button onClick={() => setDialogOpen(true)}>{t('trend.save', 'Save a trend')}</Button>}
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {q.data.map((tpl) => (
              <Card key={tpl.id}>
                <CardContent className="space-y-2 py-4">
                  <div className="flex items-center justify-between">
                    <Badge tone="info">{PLATFORM_LABEL[tpl.sourcePlatform] ?? tpl.sourcePlatform}</Badge>
                    <Badge
                      tone={tpl.riskScore >= 60 ? 'danger' : tpl.riskScore >= 30 ? 'warning' : 'success'}
                      title={t('trend.riskTip', 'Copyright / Terms-of-Service risk of reusing this format (0–100). Higher = riskier.')}
                    >
                      {t('trend.risk', 'risk {{n}}', { n: tpl.riskScore })}
                    </Badge>
                  </div>
                  <p className="font-medium">{tpl.title || t('trend.untitled', 'Untitled format')}</p>
                  {tpl.hookPattern && <p className="line-clamp-2 text-sm text-muted-foreground">{tpl.hookPattern}</p>}
                  {tpl.sourceUrl && (
                    <a href={tpl.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                      <LinkIcon className="h-3 w-3" />{t('trend.source', 'source')}
                    </a>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </QueryStateBoundary>

      {!!q.data?.length && <RemixPanel templates={q.data} />}

      <SaveTrendDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}

function RemixPanel({ templates }: { templates: { id: string; title: string | null }[] }) {
  const { t } = useTranslation('marketing');
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? '');
  const [brandName, setBrandName] = useState('');
  const [product, setProduct] = useState('');
  const [brief, setBrief] = useState<RemixBrief | null>(null);

  const gen = useMutation({
    mutationFn: () => remixTrend(templateId, { name: brandName, product: product || undefined }),
    onSuccess: setBrief,
    onError: () => toast.error(t('trend.remixError', 'Could not build the remix brief')),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('trend.remix.title', 'Remix to your brand')}</CardTitle>
        <CardDescription>{t('trend.remix.desc', 'Adapt the abstract format onto your brand — free, no generation credits.')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:flex sm:flex-wrap sm:items-end">
          <div className="w-full space-y-1.5 sm:w-48">
            <Label htmlFor="remix-trend">{t('trend.remix.template', 'Trend')}</Label>
            <Select value={templateId} onValueChange={setTemplateId}>
              <SelectTrigger id="remix-trend"><SelectValue /></SelectTrigger>
              <SelectContent>{templates.map((tpl) => <SelectItem key={tpl.id} value={tpl.id}>{tpl.title || tpl.id.slice(0, 6)}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="w-full space-y-1.5 sm:w-40">
            <Label htmlFor="brand-name">{t('trend.remix.brand', 'Brand')}</Label>
            <Input id="brand-name" value={brandName} onChange={(e) => setBrandName(e.target.value)} placeholder="Clinic" />
          </div>
          <div className="w-full space-y-1.5 sm:min-w-[160px] sm:flex-1">
            <Label htmlFor="brand-product">{t('trend.remix.product', 'Product')}</Label>
            <Input id="brand-product" value={product} onChange={(e) => setProduct(e.target.value)} placeholder={t('trend.remix.productPh', 'e.g. dental implants')} />
          </div>
          <Button className="w-full sm:w-auto" onClick={() => gen.mutate()} disabled={!templateId || !brandName.trim() || gen.isPending}>
            <Sparkles className="mr-1.5 h-4 w-4" aria-hidden="true" />{gen.isPending ? t('trend.remixing', 'Remixing…') : t('trend.remix.go', 'Remix')}
          </Button>
        </div>

        {gen.isError && !gen.isPending && (
          <Callout
            tone="danger"
            title={t('trend.remixError', 'Could not build the remix brief')}
            icon={<ShieldAlert className="h-4 w-4" />}
          >
            <div className="flex flex-col gap-2">
              <p>{t('trend.remixErrorDesc', 'Something went wrong while adapting this format. Please try again.')}</p>
              <Button variant="secondary" size="sm" className="w-fit" onClick={() => gen.mutate()}>
                {t('common.retry', 'Retry')}
              </Button>
            </div>
          </Callout>
        )}

        {brief && (
          <div className="space-y-3">
            <div>
              <p className="text-micro uppercase text-muted-foreground">{t('trend.remix.hook', 'Hook')}</p>
              <p className="text-sm font-medium">{brief.hook}</p>
            </div>
            <div className="space-y-1.5">
              {brief.scenes.map((s, i) => (
                <div key={i} className="rounded-md bg-surface-muted px-3 py-2 text-sm">
                  <span className="font-medium">{s.scene}</span> · <span className="text-muted-foreground">{s.direction}</span>
                </div>
              ))}
            </div>
            <div>
              <p className="text-micro uppercase text-muted-foreground">{t('trend.remix.caption', 'Caption')}</p>
              <p className="text-sm">{brief.captionDraft}</p>
            </div>
            <Callout tone={brief.complianceNote.startsWith('HIGH') ? 'danger' : 'info'} title={t('trend.remix.compliance', 'Compliance')} icon={<ShieldAlert className="h-4 w-4" />}>
              {brief.complianceNote}
            </Callout>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SaveTrendDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();
  const [platform, setPlatform] = useState<TrendPlatform>('TIKTOK');
  const [sourceUrl, setSourceUrl] = useState('');
  const [title, setTitle] = useState('');
  const [hookPattern, setHookPattern] = useState('');
  const [riskScore, setRiskScore] = useState('20');

  const save = useMutation({
    mutationFn: () => saveTrend({ sourcePlatform: platform, sourceUrl: sourceUrl || undefined, title: title || undefined, hookPattern: hookPattern || undefined, riskScore: Number(riskScore) || 0 }),
    onSuccess: () => {
      toast.success(t('trend.saved', 'Trend saved'));
      qc.invalidateQueries({ queryKey: ['trend-templates'] });
      onOpenChange(false);
      setSourceUrl(''); setTitle(''); setHookPattern('');
    },
    onError: () => toast.error(t('trend.saveError', 'Could not save the trend')),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('trend.save', 'Save a trend')}</DialogTitle>
          <DialogDescription>{t('trend.dialog.desc', 'We store the abstract format, never the source video.')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="tr-platform">{t('trend.field.platform', 'Platform')}</Label>
            <Select value={platform} onValueChange={(v) => setPlatform(v as TrendPlatform)}>
              <SelectTrigger id="tr-platform"><SelectValue /></SelectTrigger>
              <SelectContent>
                {(['TIKTOK', 'INSTAGRAM', 'YOUTUBE'] as TrendPlatform[]).map((p) => <SelectItem key={p} value={p}>{PLATFORM_LABEL[p] ?? p}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tr-url">{t('trend.field.url', 'Source link')}</Label>
            <Input id="tr-url" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="https://…" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tr-title">{t('trend.field.title', 'Title')}</Label>
            <Input id="tr-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('trend.field.titlePh', 'e.g. Price-objection hook')} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tr-hook">{t('trend.field.hook', 'Hook pattern')}</Label>
            <Input id="tr-hook" value={hookPattern} onChange={(e) => setHookPattern(e.target.value)} placeholder={t('trend.field.hookPh', 'Think [product] is too expensive?')} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tr-risk">{t('trend.field.risk', 'Copy/ToS risk (0–100)')}</Label>
            <Input id="tr-risk" type="number" min={0} max={100} value={riskScore} onChange={(e) => setRiskScore(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>{t('common.cancel', 'Cancel')}</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? t('common.saving', 'Saving…') : t('common.save', 'Save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
