import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { toast } from 'sonner';
import { Image as ImageIcon, Clapperboard } from 'lucide-react';
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
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/Card';

/**
 * İçerik üretim hattı, aşama 3 — "hangi modeli kullanacağını seçebilelim
 * ayarlar kısmından".
 *
 * The workspace-level default image and video model, which is the middle term
 * of `campaign override ?? workspace default ?? code constant`. Until this
 * screen there was no middle term at all: a campaign could carry an override
 * that nothing in the panel could set, and everything else — every
 * `jeeta.generate_video`, every manual generation — ran on a constant in
 * TypeScript that no customer could see.
 *
 * WHY THE PRICE IS ON EVERY OPTION, not in a tooltip or a docs link. Video is
 * the most expensive action in this product and the catalogue spans a 10x range
 * (3 to 25 credits per second). A five-beat concept at five seconds a beat is
 * 75 credits on the cheap tier and 625 on the expensive one — the SAME video,
 * from the same approval. Choosing a model here IS the spending decision, so a
 * picker that shows ids without their cost would be asking a manager to make it
 * blind.
 *
 * WHY THE CATALOGUE IS FETCHED. `AiStudioPage.tsx` already keeps a
 * hand-maintained copy of the model list; it has drifted from the backend's
 * labels ("Standard video" vs "Short video") and it shows no price at all. A
 * second hardcoded copy is how the number goes stale, and a stale price on THIS
 * screen would be worse than none.
 *
 * WHY "Platform default" IS AN OPTION AND NOT AN EMPTY SELECT. `null` in the
 * column does not mean "unset, treat as broken" — it means "this workspace has
 * not chosen", which is what keeps it following the platform's constant when
 * that constant moves. Storing today's constant instead would silently pin the
 * workspace to a model it never picked. So the state has to be nameable, and
 * reachable BACK to.
 *
 * The route is MANAGER-gated in App.tsx, which is the floor the PATCH enforces
 * (MANAGER + `settings.manage`) — same reasoning as `WorkspaceTimezoneCard`:
 * the affordance and the endpoint agree without a second gate to keep in step.
 */

const QK = ['marketing', 'workspace', 'media-models'] as const;

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
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();

  const q = useQuery<MediaModelDefaults>({ queryKey: QK, queryFn: getMediaModelDefaults });

  // Draft state per kind, `undefined` while untouched so the server's answer
  // stays authoritative until a manager actually picks something.
  const [draftImage, setDraftImage] = useState<string | undefined>();
  const [draftVideo, setDraftVideo] = useState<string | undefined>();

  const save = useMutation({
    mutationFn: (patch: MediaModelDefaultsPatch) => setMediaModelDefaults(patch),
    onSuccess: (fresh) => {
      qc.setQueryData(QK, fresh);
      setDraftImage(undefined);
      setDraftVideo(undefined);
      qc.invalidateQueries({ queryKey: QK });
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
    <div className="space-y-5 p-4 md:p-6">
      <PageHeader
        title={t('aiModels.title', 'AI generation models')}
        description={t(
          'aiModels.subtitle',
          'Which model this workspace generates images and videos with, and what each one costs. A campaign can still override it; anything with no campaign uses what you choose here.',
        )}
      />

      <QueryStateBoundary
        isLoading={q.isLoading}
        isError={q.isError}
        onRetry={() => q.refetch()}
        errorMessage={t(
          'aiModels.loadFailed',
          'The model catalogue could not be loaded, so no choice can be shown. This is a load failure, not an empty catalogue.',
        )}
        retryLabel={t('common.retry', 'Retry')}
      >
        {q.data && (
          <>
            <ModelChoiceCard
              kind="VIDEO"
              icon={<Clapperboard className="h-4 w-4" aria-hidden="true" />}
              title={t('aiModels.video.title', 'Video model')}
              description={t(
                'aiModels.video.desc',
                'Video is the most expensive action in this product and is billed per second, so a five-beat concept costs whatever you pick here multiplied by its whole runtime.',
              )}
              data={q.data}
              value={selectedVideo}
              onChange={setDraftVideo}
              t={t}
            />
            <ModelChoiceCard
              kind="IMAGE"
              icon={<ImageIcon className="h-4 w-4" aria-hidden="true" />}
              title={t('aiModels.image.title', 'Image model')}
              description={t(
                'aiModels.image.desc',
                'Billed flat, per image — used for post creatives and reference frames.',
              )}
              data={q.data}
              value={selectedImage}
              onChange={setDraftImage}
              t={t}
            />

            <Card>
              <CardFooter className="justify-between gap-3 pt-4">
                <p className="text-caption text-muted-foreground">
                  {t(
                    'aiModels.overrideNote',
                    'A campaign that sets its own model keeps it — this is the default for everything that does not.',
                  )}
                </p>
                <Button
                  type="button"
                  disabled={!dirty || save.isPending}
                  loading={save.isPending}
                  onClick={() => save.mutate(patch)}
                >
                  {save.isPending ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
                </Button>
              </CardFooter>
            </Card>
          </>
        )}
      </QueryStateBoundary>
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
  t,
}: {
  kind: MediaModelType;
  icon: React.ReactNode;
  title: string;
  description: string;
  data: MediaModelDefaults;
  value: string;
  onChange: (v: string) => void;
  t: TFunction<'marketing'>;
}) {
  const models = data.models.filter((m) => m.type === kind);
  const platformDefault = models.find((m) => m.isPlatformDefault);
  const effective = kind === 'VIDEO' ? data.effectiveVideoModel : data.effectiveImageModel;

  // A catalogue with no entry for this kind is a BROKEN catalogue, not an empty
  // choice — every deploy ships at least the platform default. Saying so beats
  // rendering a card with no options and letting it read as "not available on
  // your plan".
  if (!models.length) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {icon}
            {title}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Callout tone="danger">
            {t(
              'aiModels.noModels',
              'The server returned no models of this kind. That is a catalogue fault, not a plan limit — generation cannot be configured until it is fixed.',
            )}
          </Callout>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {icon}
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <RadioGroup
          value={value}
          onValueChange={onChange}
          aria-label={title}
          className="gap-2"
        >
          {/*
            The platform default NAMES what it currently is. "Platform default"
            alone would be a blind option on the one screen whose entire purpose
            is to stop the choice being blind — a manager cannot compare it to
            the priced rows below without knowing which one it is.
          */}
          <ModelOption
            id={`${kind}-platform`}
            value={PLATFORM}
            title={
              platformDefault
                ? t('aiModels.platformDefaultIs', 'Platform default ({{label}})', {
                    label: platformDefault.label,
                  })
                : t('aiModels.platformDefault', 'Platform default')
            }
            subtitle={t(
              'aiModels.platformDefaultHint',
              'Keeps following the platform if it changes this.',
            )}
            price={platformDefault ? priceLine(platformDefault, t) : ''}
          />
          {models.map((m) => (
            <ModelOption
              key={m.id}
              id={`${kind}-${m.id}`}
              value={m.id}
              title={m.label}
              subtitle={m.id}
              price={priceLine(m, t)}
              badge={
                m.id === effective
                  ? t('aiModels.inUse', 'In use')
                  : undefined
              }
            />
          ))}
        </RadioGroup>
      </CardContent>
    </Card>
  );
}

/** The number, in the unit its kind is actually billed in. Credits are the
 *  customer-facing meter and lead; the USD figure is the bookkeeping one and
 *  follows in parentheses. */
function priceLine(m: PricedMediaModel, t: TFunction<'marketing'>): string {
  if (m.type === 'VIDEO') {
    return t('aiModels.priceVideo', '{{credits}} credits/sec ({{usd}}/sec)', {
      credits: m.creditsPerSec ?? 0,
      usd: usd(m.pricePerSecUsd ?? 0),
    });
  }
  return t('aiModels.priceImage', '{{credits}} credits / image ({{usd}})', {
    credits: m.credits ?? 0,
    usd: usd(m.priceUsd ?? 0),
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
    <div className="flex items-start gap-3 rounded-lg border border-border p-3">
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
      <p id={`${id}-price`} className="shrink-0 text-sm font-medium tabular-nums text-foreground">
        {price}
      </p>
    </div>
  );
}
