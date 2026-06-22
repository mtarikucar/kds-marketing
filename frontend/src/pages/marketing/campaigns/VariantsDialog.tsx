import { useState, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Plus, Trash2 } from 'lucide-react';
import marketingApi from '../../../features/marketing/api/marketingApi';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Switch } from '@/components/ui/Switch';
import { Badge } from '@/components/ui/Badge';
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription,
} from '@/components/ui/Dialog';

interface Variant {
  key: string;
  weight: number;
  subject?: string;
  body: string;
  stats?: { sent?: number; opened?: number; clicked?: number } | null;
}
const KEYS = ['A', 'B', 'C', 'D', 'E', 'F'];

/**
 * A/B variants editor for a draft EMAIL campaign (GHL parity). Recipients are
 * split across variants by weight at launch; each variant has its own subject +
 * body. Per-variant open/click stats show after the send starts.
 */
export function VariantsDialog({ campaignId, open, onOpenChange }: { campaignId: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();
  const [abEnabled, setAbEnabled] = useState(false);
  const [variants, setVariants] = useState<Variant[]>([]);

  useEffect(() => {
    if (!open) return;
    marketingApi.get(`/campaigns/${campaignId}`).then((r) => {
      setAbEnabled(!!r.data.abEnabled);
      setVariants((r.data.variants ?? []).map((v: any) => ({ key: v.key, weight: v.weight ?? 1, subject: v.subject ?? '', body: v.body ?? '', stats: v.stats })));
    }).catch(() => undefined);
  }, [open, campaignId]);

  const save = useMutation({
    mutationFn: () => marketingApi.put(`/campaigns/${campaignId}/variants`, {
      abEnabled,
      variants: variants.map((v) => ({ key: v.key, weight: v.weight, subject: v.subject || undefined, body: v.body })),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['marketing', 'campaigns'] });
      onOpenChange(false);
      toast.success(t('campaigns.variantsSaved', 'A/B variants saved'));
    },
    onError: (e: any) => toast.error(e.response?.data?.message ?? t('campaigns.variantsSaveFailed', 'Could not save variants')),
  });

  const addVariant = () => {
    const used = new Set(variants.map((v) => v.key));
    const key = KEYS.find((k) => !used.has(k)) ?? `V${variants.length + 1}`;
    setVariants((vs) => [...vs, { key, weight: 1, subject: '', body: '' }]);
  };
  const patch = (i: number, p: Partial<Variant>) => setVariants((vs) => vs.map((v, idx) => (idx === i ? { ...v, ...p } : v)));
  const del = (i: number) => setVariants((vs) => vs.filter((_, idx) => idx !== i));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('campaigns.abTitle', 'A/B test')}</DialogTitle>
          <DialogDescription>{t('campaigns.abHint', 'Split recipients across variants by weight. Each variant has its own subject + body.')}</DialogDescription>
        </DialogHeader>

        <label className="flex items-center gap-2 text-sm">
          <Switch checked={abEnabled} onCheckedChange={setAbEnabled} />
          {t('campaigns.abEnable', 'Enable A/B split (needs 2+ variants)')}
        </label>
        {abEnabled && variants.length < 2 && (
          <p className="text-[11px] text-amber-600">{t('campaigns.abNeeds2', 'An A/B split needs at least 2 variants — add another or it sends as a single campaign.')}</p>
        )}

        <div className="space-y-3 max-h-[55vh] overflow-y-auto">
          {variants.map((v, i) => (
            <div key={v.key} className="rounded-lg border border-border p-3 space-y-2">
              <div className="flex items-center gap-2">
                <Badge tone="neutral" size="sm">{v.key}</Badge>
                <span className="text-caption text-muted-foreground">{t('campaigns.weight', 'Weight')}</span>
                <Input type="number" className="w-20" value={v.weight} min={1} max={1000}
                  onChange={(e) => patch(i, { weight: Math.min(1000, Math.max(1, Math.round(Number(e.target.value) || 1))) })} />
                {v.stats && (
                  <span className="text-caption text-muted-foreground ml-auto">
                    {t('campaigns.sent', 'Sent')} {v.stats.sent ?? 0} · {t('campaigns.opened', 'Opened')} {v.stats.opened ?? 0} · {t('campaigns.clicked', 'Clicked')} {v.stats.clicked ?? 0}
                  </span>
                )}
                <IconButton variant="ghost" size="sm" aria-label="Remove" className="text-danger hover:bg-danger-subtle" onClick={() => del(i)}><Trash2 className="h-4 w-4" /></IconButton>
              </div>
              <Input placeholder={t('campaigns.subject', 'Subject')} value={v.subject ?? ''} onChange={(e) => patch(i, { subject: e.target.value })} />
              <Textarea className="min-h-24" placeholder={t('campaigns.body', 'Message')} value={v.body} onChange={(e) => patch(i, { body: e.target.value })} />
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={addVariant} disabled={variants.length >= 6}>
            <Plus className="h-3.5 w-3.5" />{t('campaigns.addVariant', 'Add variant')}
          </Button>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel', 'Cancel')}</Button>
          <Button onClick={() => save.mutate()} loading={save.isPending}
            disabled={save.isPending || variants.some((v) => !v.body.trim()) || (abEnabled && variants.length < 2)}>
            {t('common.save', 'Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
