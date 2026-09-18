import { useMemo, useState, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { toast } from 'sonner';
import { Image as ImageIcon, Clapperboard } from 'lucide-react';
import { AiExecutionPolicyCard } from './AiExecutionPolicyCard';
import { AiUsageOverview } from './AiUsageOverview';
import { getAiUsageDashboard } from '@/features/marketing/api/aiUsageDashboard.service';
import { useMarketingAuthStore, type MarketingUser } from '@/store/marketingAuthStore';
import { hasMarketingRole, MarketingRole } from '@/features/marketing/types';
import { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetClose } from '@/components/ui/Sheet';
import {
  getMediaModelDefaults,
  setMediaModelDefaults,
  type MediaModelDefaults,
  type MediaModelDefaultsPatch,
  type MediaModelType,
  type PricedMediaModel,
} from '../../../../features/marketing/api/mediaModels.service';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Label } from '@/components/ui/Label';
import { Callout } from '@/components/ui/Callout';
import { RadioGroup, RadioGroupItem } from '@/components/ui/RadioGroup';
import { QueryStateBoundary } from '@/components/ui/QueryStateBoundary';
/** The RadioGroup value that means "no choice — follow the platform". Radix
 *  needs a string, and the empty string is indistinguishable from unset. */
const PLATFORM = '__platform__';

function usd(n: number): string {
  // Per-second video prices go to three decimals ($0.025); flat image prices to
  // two. Trailing zeros are trimmed so $0.030 does not read as more precision
  // than the catalogue actually carries.
  return `$${Number(n.toFixed(3))}`;
}

export default function AiModelsPage() {
  const user = useMarketingAuthStore(state => state.user);
  return <WorkspaceAiModels key={`${user?.workspaceId}:${user?.id}`} user={user} />;
}

function WorkspaceAiModels({ user }: { user: MarketingUser | null }) {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();

  const queryKey = ['marketing', 'workspace', 'media-models', user?.workspaceId, user?.id];
  const canRead = hasMarketingRole(user?.role, MarketingRole.MANAGER);
  const q = useQuery<MediaModelDefaults>({ queryKey, queryFn: getMediaModelDefaults, enabled: canRead });
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => {
    const onVisibility = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);
  const usage = useQuery({
    queryKey: ['marketing', 'ai', 'usage-dashboard', user?.workspaceId, user?.id],
    queryFn: getAiUsageDashboard,
    enabled: canRead,
    refetchInterval: visible ? 60_000 : false,
    refetchIntervalInBackground: false,
    staleTime: 30_000,
    retry: false,
  });

  // Draft state per kind, `undefined` while untouched so the server's answer
  // stays authoritative until a manager actually picks something.
  const [draftImage, setDraftImage] = useState<string | undefined>();
  const [draftVideo, setDraftVideo] = useState<string | undefined>();

  const save = useMutation({
    mutationFn: (patch: MediaModelDefaultsPatch) => setMediaModelDefaults(patch),
    onMutate: () => qc.cancelQueries({ queryKey }),
    onSuccess: (fresh) => {
      qc.setQueryData(queryKey, fresh);
      setDraftImage(undefined);
      setDraftVideo(undefined);
      toast.success(t('aiModels.saved', 'Model defaults updated.'));
    },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast.error(msg ?? t('aiModels.saveFailed', 'The model defaults could not be saved.'));
    },
  });

  const storedImage = q.data ? (q.data.defaultImageModel ?? PLATFORM) : PLATFORM;
  const storedVideo = q.data ? (q.data.defaultVideoModel ?? PLATFORM) : PLATFORM;
  const selectedImage = draftImage ?? storedImage;
  const selectedVideo = draftVideo ?? storedVideo;

  const patch = useMemo<MediaModelDefaultsPatch>(() => {
    const out: MediaModelDefaultsPatch = {};
    // Only what CHANGED. `absent` and `null` are different instructions to the
    // PATCH — absent leaves the other kind alone — so transmitting both fields
    // would re-assert a value nobody touched.
    if (draftImage !== undefined && draftImage !== storedImage) {
      out.defaultImageModel = draftImage === PLATFORM ? null : draftImage;
    }
    if (draftVideo !== undefined && draftVideo !== storedVideo) {
      out.defaultVideoModel = draftVideo === PLATFORM ? null : draftVideo;
    }
    return out;
  }, [draftImage, draftVideo, storedImage, storedVideo]);

  const dirty = Object.keys(patch).length > 0;

  return (
    <div className="min-w-0 space-y-3 p-4 md:px-5 md:py-2">
      <PageHeader title={t('aiModels.title', 'AI settings')} />
      <AiUsageOverview query={usage} />
      <section aria-label={t('aiModels.mediaTitle', 'Media models')} className="rounded-xl border border-border bg-surface">
        <QueryStateBoundary isLoading={q.isLoading} isError={q.isError} onRetry={() => q.refetch()}
          errorMessage={t('aiModels.loadFailed', 'The model catalogue could not be loaded, so no choice can be shown. This is a load failure, not an empty catalogue.')}
          retryLabel={t('common.retry', 'Retry')} className="py-3">
          {q.data && <>
            <div className="flex items-center justify-between gap-2 px-4 pt-2">
              <h2 className="font-display text-sm font-semibold">{t('aiModels.mediaTitle', 'Media models')}</h2>
              <Button type="button" size="sm" variant="outline" disabled={!dirty || save.isPending} loading={save.isPending}
                onClick={() => save.mutate(patch)}>{save.isPending ? t('common.saving', 'Saving…') : t('common.save', 'Save')}</Button>
            </div>
            <div className="grid gap-2 px-4 pb-3 pt-1 sm:grid-cols-2 sm:gap-4">
              <ModelChoiceCard kind="IMAGE" icon={<ImageIcon className="h-4 w-4" aria-hidden="true" />}
                title={t('aiModels.image.title', 'Image model')} description={t('aiModels.image.desc', 'Billed flat, per image — used for post creatives and reference frames.')}
                data={q.data} value={selectedImage} onChange={setDraftImage} disabled={save.isPending} t={t} />
              <ModelChoiceCard kind="VIDEO" icon={<Clapperboard className="h-4 w-4" aria-hidden="true" />}
                title={t('aiModels.video.title', 'Video model')} description={t('aiModels.video.desc', 'Base rates are per second or per run, depending on the model. Duration, resolution and options can change the total cost.')}
                data={q.data} value={selectedVideo} onChange={setDraftVideo} disabled={save.isPending} t={t} />
            </div>
            {save.isError && <Callout tone="danger" className="mx-4 mb-3">{t('aiModels.saveFailed', 'The model defaults could not be saved.')}</Callout>}
          </>}
        </QueryStateBoundary>
      </section>
      <AiExecutionPolicyCard usage={usage.isError ? undefined : usage.data} usageUnavailable={usage.isError || !usage.data} />
    </div>
  );
}

function ModelChoiceCard({
  kind,
  icon,
  title,
  description,
  data,
  value,
  onChange,
  disabled,
  t,
}: {
  kind: MediaModelType;
  icon: React.ReactNode;
  title: string;
  description: string;
  data: MediaModelDefaults;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  t: TFunction<'marketing'>;
}) {
  const models = data.models.filter((m) => m.type === kind);
  const platformDefault = models.find((m) => m.isPlatformDefault);
  const effective = kind === 'VIDEO' ? data.effectiveVideoModel : data.effectiveImageModel;
  // A stored choice the catalogue has since dropped. The server applies the
  // fallback and REPORTS it, so `effective` is always an id in `models` and the
  // "In use" badge below always lands somewhere.
  const retired = kind === 'VIDEO' ? data.retiredVideoModel : data.retiredImageModel;
  const effectiveModel = models.find((m) => m.id === effective);

  const selected = value === PLATFORM ? platformDefault : models.find(model => model.id === value);
  const display = selected ?? effectiveModel;

  return (
    <Sheet>
      <div className="flex min-w-0 items-center gap-3">
        <span className="text-muted-foreground">{icon}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" title={display?.label}>{display?.label ?? title}</p>
          <p className="text-caption tabular-nums text-muted-foreground">{display ? priceLine(display, t) : t('aiModels.unknownPrice', 'Price unavailable')}</p>
          {retired && <p className="text-caption text-warning">{t('aiModels.retiredShort', 'Retired choice · fallback in use')}</p>}
          {value === PLATFORM && <span className="sr-only">{t('aiModels.platformDefault', 'Platform default')}</span>}
        </div>
        <SheetTrigger asChild><Button variant="ghost" size="sm" aria-label={kind === 'VIDEO' ? t('aiModels.chooseVideo', 'Choose video model') : t('aiModels.chooseImage', 'Choose image model')}>
          {t('aiModels.choose', 'Choose')}
        </Button></SheetTrigger>
      </div>
      <SheetContent hideClose className="w-full max-w-xl overflow-y-auto">
        <SheetHeader><SheetTitle>{title}</SheetTitle><SheetDescription>{description}</SheetDescription></SheetHeader>
        <SheetClose asChild><Button variant="outline" size="sm" className="self-end">{t('common.done', 'Done')}</Button></SheetClose>
        {retired && <Callout tone="warning">{t('aiModels.retired', 'This workspace is set to "{{retired}}", which is no longer in the catalogue, so it cannot be priced or run. {{label}} runs instead ({{price}}). Pick a model below to replace the stored choice.', {
          retired, label: effectiveModel?.label ?? effective, price: effectiveModel ? priceLine(effectiveModel, t) : t('aiModels.unknownPrice', 'Price unavailable'),
        })}</Callout>}
        {!models.length ? <Callout tone="danger">{t('aiModels.noModels', 'The server returned no models of this kind. That is a catalogue fault, not a plan limit — generation cannot be configured until it is fixed.')}</Callout> :
          <RadioGroup value={value} onValueChange={onChange} disabled={disabled} aria-label={title} className="gap-2">
            <ModelOption id={`${kind}-platform`} value={PLATFORM}
              title={platformDefault ? t('aiModels.platformDefaultIs', 'Platform default ({{label}})', { label: platformDefault.label }) : t('aiModels.platformDefault', 'Platform default')}
              subtitle={t('aiModels.platformDefaultHint', 'Keeps following the platform if it changes this.')}
              price={platformDefault ? priceLine(platformDefault, t) : t('aiModels.unknownPrice', 'Price unavailable')} />
            {models.map(m => <ModelOption key={m.id} id={`${kind}-${m.id}`} value={m.id} title={m.label} subtitle={m.id}
              price={priceLine(m, t)} badge={m.id === effective ? t('aiModels.inUse', 'In use') : undefined} />)}
          </RadioGroup>}
        <p className="text-caption text-muted-foreground">{t('aiModels.overrideNote', 'A campaign that sets its own model keeps it — this is the default for everything that does not.')}</p>
        <p className="text-caption text-muted-foreground">{t('aiModels.draftHint', 'Choices are kept as a draft. Close this panel and save to apply them.')}</p>
      </SheetContent>
    </Sheet>
  );
}

/** The number, in the unit its kind is actually billed in. Credits are the
 *  customer-facing meter and lead; the USD figure is the bookkeeping one and
 *  follows in parentheses. */
function priceLine(m: PricedMediaModel, t: TFunction<'marketing'>): string {
  if (m.pricePerSecUsd == null && m.priceUsd == null) {
    return t('aiModels.unknownPrice', 'Price unavailable');
  }
  if (m.pricePerSecUsd != null) {
    return t('aiModels.priceVideo', '{{credits}} credits/sec ({{usd}}/sec)', {
      credits: m.creditsPerSec ?? '—',
      usd: m.pricePerSecUsd == null ? '—' : usd(m.pricePerSecUsd),
    });
  }
  if (m.type === 'VIDEO') {
    return t('aiModels.priceRun', '{{credits}} credits / run ({{usd}})', {
      credits: m.credits ?? '—',
      usd: usd(m.priceUsd!),
    });
  }
  return t('aiModels.priceImage', '{{credits}} credits / image ({{usd}})', {
    credits: m.credits ?? '—',
    usd: m.priceUsd == null ? '—' : usd(m.priceUsd),
  });
}

function ModelOption({
  id,
  value,
  title,
  subtitle,
  price,
  badge,
}: {
  id: string;
  value: string;
  title: string;
  subtitle: string;
  price: string;
  badge?: string;
}) {
  return (
    <div className="grid grid-cols-[auto_1fr] items-start gap-x-3 gap-y-1 rounded-lg border border-border p-3">
      {/*
        The price is inside the radio's accessible name (aria-labelledby spans
        the label AND the price), so an assertion on the option cannot pass while
        the cost is missing from it — which is exactly the failure mode a
        jsdom test that only queries the label would sail past.
      */}
      <RadioGroupItem value={value} id={id} aria-labelledby={`${id}-label ${id}-price`} className="mt-1" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor={id} id={`${id}-label`} className="cursor-pointer text-sm font-medium">
            {title}
          </Label>
          {badge && <Badge tone="primary" size="sm">{badge}</Badge>}
        </div>
        <p className="truncate text-caption text-muted-foreground">{subtitle}</p>
      </div>
      <p id={`${id}-price`} className="col-start-2 text-sm font-medium tabular-nums text-foreground">
        {price}
      </p>
    </div>
  );
}
