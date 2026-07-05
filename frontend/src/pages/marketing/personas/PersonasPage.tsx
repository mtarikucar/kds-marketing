import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { UserSquare2, Sparkles, Hash, Image as ImageIcon } from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Textarea } from '@/components/ui/Textarea';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/Select';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryStateBoundary } from '@/components/ui/QueryStateBoundary';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/Dialog';
import { listPersonas, createPersona, planShots, type ShotPlan, type VideoModel } from '../../../features/marketing/api/personas.service';

/** Human labels for the raw video-model identifiers. */
const MODEL_LABEL: Record<VideoModel, string> = {
  seedance: 'Seedance',
  veo: 'Veo 3',
  kling: 'Kling',
  higgsfield: 'Higgsfield',
};

/** Sentinel for "no persona" so the Radix Select can offer a clearable option. */
const NONE = '__none__';

/**
 * UGC persona library + shot-plan preview (Faz 2). A persona keeps the same
 * face/outfit consistent across every shot; the preview shows exactly how the
 * autopilot would storyboard a video before any (credit-costing) generation.
 */
export default function PersonasPage({ embedded }: { embedded?: boolean } = {}) {
  const { t } = useTranslation('marketing');
  const [dialogOpen, setDialogOpen] = useState(false);
  const q = useQuery({ queryKey: ['video-personas'], queryFn: listPersonas });

  return (
    <div className="space-y-6">
      {!embedded ? (
      <PageHeader
        title={t('persona.title', 'UGC Personas')}
        description={t('persona.subtitle', 'Reusable AI spokespeople — the same face and outfit across every shot of every campaign.')}
        actions={<Button onClick={() => setDialogOpen(true)}>{t('persona.create', 'New persona')}</Button>}
      />
      ) : (
        // Embedded (Growth Studio tab): the host owns the page header, but the
        // primary action must stay reachable — keep it as a small toolbar row.
        <div className="flex justify-end">
          <Button onClick={() => setDialogOpen(true)}>{t('persona.create', 'New persona')}</Button>
        </div>
      )}

      <QueryStateBoundary isLoading={q.isLoading} isError={q.isError} onRetry={() => q.refetch()}>
        {!q.data?.length ? (
          <EmptyState
            icon={<UserSquare2 className="h-6 w-6" />}
            title={t('persona.empty.title', 'No personas yet')}
            description={t('persona.empty.desc', 'Create a persona from a few reference images and a locked seed. The video pipeline reuses it so your spokesperson never drifts shot to shot.')}
            action={<Button onClick={() => setDialogOpen(true)}>{t('persona.create', 'New persona')}</Button>}
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {q.data.map((p) => (
              <Card key={p.id}>
                <CardContent className="space-y-2 p-4">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{p.name}</span>
                    {p.lockedSeed != null && <Badge tone="neutral"><Hash className="mr-1 h-3 w-3" aria-hidden="true" />{p.lockedSeed}</Badge>}
                  </div>
                  {p.description && <p className="line-clamp-2 text-sm text-muted-foreground">{p.description}</p>}
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <ImageIcon className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('persona.refCount', '{{n}} reference image(s)', { n: p.referenceImageUrls.length })}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </QueryStateBoundary>

      <ShotPlanPreview personas={q.data ?? []} />

      <CreatePersonaDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}

function ShotPlanPreview({ personas }: { personas: { id: string; name: string }[] }) {
  const { t } = useTranslation('marketing');
  const [product, setProduct] = useState('');
  const [personaId, setPersonaId] = useState<string>(NONE);
  const [model, setModel] = useState<VideoModel>('seedance');
  const [plan, setPlan] = useState<ShotPlan | null>(null);

  const gen = useMutation({
    mutationFn: () => planShots({ brief: { product }, model, ...(personaId !== NONE ? { personaId } : {}) }),
    onSuccess: setPlan,
    onError: () => toast.error(t('persona.planError', 'Could not build the shot plan')),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('persona.plan.title', 'Shot-plan preview')}</CardTitle>
        <CardDescription>{t('persona.plan.desc', 'Storyboard a video from a product + persona — free, no generation credits used.')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:flex sm:flex-wrap sm:items-end">
          <div className="w-full space-y-1.5 sm:min-w-[200px] sm:flex-1">
            <Label htmlFor="plan-product">{t('persona.plan.product', 'Product / offer')}</Label>
            <Input id="plan-product" value={product} onChange={(e) => setProduct(e.target.value)} placeholder={t('persona.plan.productPh', 'e.g. dental implants')} />
          </div>
          <div className="w-full space-y-1.5 sm:w-40">
            <Label htmlFor="plan-persona">{t('persona.plan.persona', 'Persona')}</Label>
            <Select value={personaId} onValueChange={setPersonaId}>
              <SelectTrigger id="plan-persona"><SelectValue placeholder={t('persona.plan.none', 'None')} /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{t('persona.plan.none', 'None')}</SelectItem>
                {personas.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="w-full space-y-1.5 sm:w-36">
            <Label htmlFor="plan-model">{t('persona.plan.model', 'Model')}</Label>
            <Select value={model} onValueChange={(v) => setModel(v as VideoModel)}>
              <SelectTrigger id="plan-model"><SelectValue /></SelectTrigger>
              <SelectContent>
                {(['seedance', 'veo', 'kling', 'higgsfield'] as VideoModel[]).map((m) => <SelectItem key={m} value={m}>{MODEL_LABEL[m]}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <Button className="w-full sm:w-auto" onClick={() => gen.mutate()} disabled={!product.trim() || gen.isPending}>
            <Sparkles className="mr-1.5 h-4 w-4" aria-hidden="true" />{gen.isPending ? t('persona.planning', 'Planning…') : t('persona.plan.go', 'Storyboard')}
          </Button>
        </div>

        {gen.isError && (
          <div className="flex items-center justify-between gap-3 rounded-md border border-border p-3">
            <p className="text-sm text-muted-foreground">{t('persona.planError', 'Could not build the shot plan')}</p>
            <Button variant="secondary" size="sm" onClick={() => gen.mutate()} disabled={gen.isPending}>
              {t('common.tryAgain', 'Try again')}
            </Button>
          </div>
        )}

        {plan && (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">{t('persona.plan.result', '{{n}} shots · {{d}}s · model {{m}}', { n: plan.shots.length, d: plan.durationSec, m: MODEL_LABEL[plan.model] })}</p>
            {plan.shots.map((s) => (
              <div key={s.ord} className="rounded-md border border-border p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{s.scene}</span>
                  <span className="text-xs text-muted-foreground">{s.cameraNote}</span>
                </div>
                <p className="mt-1 text-sm italic text-muted-foreground">“{s.voiceover}”</p>
                <p className="mt-1 text-xs text-muted-foreground">{s.prompt}</p>
                {s.reference && <Badge tone="success" className="mt-2"><Hash className="mr-1 h-3 w-3" aria-hidden="true" />{t('persona.plan.locked', 'identity-locked')}</Badge>}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CreatePersonaDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [refs, setRefs] = useState('');
  const [seed, setSeed] = useState('');

  const save = useMutation({
    mutationFn: () =>
      createPersona({
        name: name.trim(),
        description: description.trim() || undefined,
        referenceImageUrls: refs.split(/\s+/).map((s) => s.trim()).filter(Boolean),
        ...(seed ? { lockedSeed: Number(seed) } : {}),
      }),
    onSuccess: () => {
      toast.success(t('persona.saved', 'Persona created'));
      qc.invalidateQueries({ queryKey: ['video-personas'] });
      onOpenChange(false);
      setName(''); setDescription(''); setRefs(''); setSeed('');
    },
    onError: () => toast.error(t('persona.saveError', 'Could not create the persona')),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('persona.create', 'New persona')}</DialogTitle>
          <DialogDescription>{t('persona.dialog.desc', 'Use only synthetic or consented likenesses.')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="p-name">{t('persona.field.name', 'Name')}</Label>
            <Input id="p-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Dr. Aylin" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="p-desc">{t('persona.field.desc', 'Description')}</Label>
            <Textarea id="p-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder={t('persona.field.descPh', 'Warm, professional dentist spokesperson')} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="p-refs">{t('persona.field.refs', 'Reference image URLs')}</Label>
            <Textarea id="p-refs" value={refs} onChange={(e) => setRefs(e.target.value)} rows={2} placeholder={t('persona.field.refsPh', 'One URL per line (up to 9)')} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="p-seed">{t('persona.field.seed', 'Locked seed (optional)')}</Label>
            <Input id="p-seed" type="number" value={seed} onChange={(e) => setSeed(e.target.value)} placeholder="42" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>{t('common.cancel', 'Cancel')}</Button>
          <Button onClick={() => save.mutate()} disabled={!name.trim() || save.isPending}>
            {save.isPending ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
