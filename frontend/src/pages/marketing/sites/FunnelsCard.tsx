import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Plus, Trash2, ArrowUp, ArrowDown, Copy, Pencil, Layers } from 'lucide-react';
import {
  listFunnels, createFunnel, updateFunnel, deleteFunnel,
  type Funnel, type FunnelStep,
} from '../../../features/marketing/api/funnels.service';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import { Field } from '@/components/ui/Field';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription,
} from '@/components/ui/Dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/Select';

interface PageOpt { id: string; slug: string; title: string }
interface Draft { id?: string; name: string; slug: string; steps: FunnelStep[]; published: boolean }
const EMPTY: Draft = { name: '', slug: '', steps: [], published: false };

export function FunnelsCard({ pages, wsId }: { pages: PageOpt[]; wsId?: string }) {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Funnel | null>(null);

  const { data: funnels } = useQuery<Funnel[]>({
    queryKey: ['marketing', 'funnels'],
    queryFn: listFunnels,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['marketing', 'funnels'] });

  const save = useMutation({
    mutationFn: (d: Draft) => {
      const payload = { name: d.name, slug: d.slug || undefined, steps: d.steps, published: d.published };
      return d.id ? updateFunnel(d.id, payload) : createFunnel(payload);
    },
    onSuccess: () => { invalidate(); setDraft(null); toast.success(t('funnels.saved', 'Funnel saved')); },
    onError: (e: any) => toast.error(e.response?.data?.message ?? t('funnels.saveFailed', 'Could not save funnel')),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteFunnel(id),
    onSuccess: () => { invalidate(); setDeleteTarget(null); },
    onError: (e: any) => toast.error(e.response?.data?.message ?? t('sites.funnelDeleteFailed', 'Could not delete the funnel')),
  });

  const publicUrl = (slug: string) => `${window.location.origin}/api/public/funnel/${wsId ?? ':workspace'}/${slug}/0`;

  const setStep = (i: number, s: FunnelStep) => setDraft((d) => d && ({ ...d, steps: d.steps.map((x, idx) => (idx === i ? s : x)) }));
  const moveStep = (i: number, dir: -1 | 1) => setDraft((d) => {
    if (!d) return d;
    const j = i + dir;
    if (j < 0 || j >= d.steps.length) return d;
    const steps = [...d.steps];
    [steps[i], steps[j]] = [steps[j], steps[i]];
    return { ...d, steps };
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2"><Layers className="h-4 w-4" />{t('funnels.title', 'Funnels')}</CardTitle>
        <Button size="sm" variant="secondary" onClick={() => setDraft({ ...EMPTY })}>
          <Plus className="h-3.5 w-3.5" />{t('funnels.new', 'New funnel')}
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {(funnels ?? []).map((f) => (
          <div key={f.id} className="flex items-center justify-between gap-2 rounded border border-border px-3 py-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium text-foreground truncate">{f.name}</span>
                <Badge tone={f.published ? 'success' : 'neutral'} size="sm">{f.published ? t('common.published', 'Published') : t('common.draft', 'Draft')}</Badge>
                <span className="text-caption text-muted-foreground">{(f.steps ?? []).length} {t('funnels.steps', 'steps')}</span>
              </div>
              {f.published && <code className="text-[10px] text-muted-foreground break-all">{publicUrl(f.slug)}</code>}
            </div>
            <div className="flex items-center gap-0.5 shrink-0">
              {f.published && (
                <IconButton variant="ghost" size="sm" aria-label="Copy URL" onClick={() => { navigator.clipboard?.writeText(publicUrl(f.slug)); toast.success(t('common.copied', 'Copied')); }}><Copy className="h-4 w-4" /></IconButton>
              )}
              <IconButton variant="ghost" size="sm" aria-label="Edit" onClick={() => setDraft({ id: f.id, name: f.name, slug: f.slug, steps: f.steps ?? [], published: f.published })}><Pencil className="h-4 w-4" /></IconButton>
              <IconButton variant="ghost" size="sm" aria-label="Delete" className="text-danger hover:bg-danger-subtle" onClick={() => setDeleteTarget(f)}><Trash2 className="h-4 w-4" /></IconButton>
            </div>
          </div>
        ))}
        {(funnels ?? []).length === 0 && (
          <p className="text-caption text-muted-foreground py-2">{t('funnels.empty', 'No funnels yet — chain pages into a multi-step flow.')}</p>
        )}
      </CardContent>

      {/* Builder dialog */}
      <Dialog open={!!draft} onOpenChange={(o) => { if (!o) setDraft(null); }}>
        <DialogContent className="max-w-lg">
          {draft && (
            <>
              <DialogHeader>
                <DialogTitle>{draft.id ? t('funnels.edit', 'Edit funnel') : t('funnels.new', 'New funnel')}</DialogTitle>
                <DialogDescription>{t('funnels.hint', 'Order the pages a visitor walks through. Publish to get a public URL.')}</DialogDescription>
              </DialogHeader>
              <div className="grid grid-cols-2 gap-3">
                <Field label={t('funnels.name', 'Name')}>
                  {({ id }) => <Input id={id} value={draft.name} maxLength={120} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />}
                </Field>
                <Field label={t('funnels.slug', 'Slug')}>
                  {({ id }) => <Input id={id} value={draft.slug} placeholder="my-funnel" maxLength={60} onChange={(e) => setDraft({ ...draft, slug: e.target.value })} />}
                </Field>
              </div>

              <div className="space-y-1.5">
                <div className="text-caption text-muted-foreground">{t('funnels.stepsLabel', 'Steps')}</div>
                {draft.steps.map((s, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <span className="text-caption text-muted-foreground w-5 text-right">{i + 1}.</span>
                    <Select value={s.sitePageId} onValueChange={(v) => setStep(i, { ...s, sitePageId: v })}>
                      <SelectTrigger className="flex-1"><SelectValue placeholder={t('funnels.selectPage', 'Select a page')} /></SelectTrigger>
                      <SelectContent>
                        {pages.map((p) => <SelectItem key={p.id} value={p.id}>{p.title}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <IconButton variant="ghost" size="sm" aria-label="Up" disabled={i === 0} onClick={() => moveStep(i, -1)}><ArrowUp className="h-4 w-4" /></IconButton>
                    <IconButton variant="ghost" size="sm" aria-label="Down" disabled={i === draft.steps.length - 1} onClick={() => moveStep(i, 1)}><ArrowDown className="h-4 w-4" /></IconButton>
                    <IconButton variant="ghost" size="sm" aria-label="Remove" className="text-danger hover:bg-danger-subtle" onClick={() => setDraft({ ...draft, steps: draft.steps.filter((_, idx) => idx !== i) })}><Trash2 className="h-4 w-4" /></IconButton>
                  </div>
                ))}
                <Button type="button" variant="outline" size="sm" disabled={pages.length === 0} onClick={() => setDraft({ ...draft, steps: [...draft.steps, { sitePageId: pages[0]?.id ?? '' }] })}>
                  <Plus className="h-3.5 w-3.5" />{t('funnels.addStep', 'Add step')}
                </Button>
                {pages.length === 0 && <p className="text-[11px] text-amber-600">{t('funnels.needPages', 'Create a page first.')}</p>}
              </div>

              <label className="flex items-center gap-2 text-sm">
                <Switch checked={draft.published} onCheckedChange={(v) => setDraft({ ...draft, published: v })} />
                {t('funnels.published', 'Published')}
              </label>

              <DialogFooter>
                <Button variant="outline" onClick={() => setDraft(null)}>{t('common.cancel', 'Cancel')}</Button>
                <Button
                  onClick={() => save.mutate(draft)}
                  loading={save.isPending}
                  disabled={!draft.name.trim() || draft.steps.some((s) => !s.sitePageId) || save.isPending}
                >
                  {t('common.save', 'Save')}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}
        title={t('funnels.deleteTitle', 'Delete funnel?')}
        description={t('funnels.deleteDesc', 'The public URL stops working. The pages themselves are kept.')}
        confirmLabel={t('common.delete', 'Delete')}
        tone="danger"
        loading={remove.isPending}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget.id)}
      />
    </Card>
  );
}
