import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Sparkles, Download, RefreshCw, Trash2, Plus } from 'lucide-react';
import {
  PageHeader,
  Card,
  CardContent,
  Button,
  IconButton,
  Field,
  Textarea,
  Input,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Badge,
  EmptyState,
  Spinner,
} from '@/components/ui';
import {
  generateMedia,
  listGenerations,
  getGeneration,
  regenerateMedia,
  deleteGeneration,
  isTerminal,
  type GeneratedAsset,
  type GeneratedAssetType,
  type GenerateMediaPayload,
} from '../../../features/marketing/api/media.service';
import type { MediaItemValue } from './socialSchemas';

const ASPECT_RATIOS = ['1:1', '9:16', '16:9', '4:5'] as const;
const IMAGE_MODELS = [
  { value: 'fal-ai/qwen-image', labelKey: 'aiStudio.modelLabel.draftImage', fallback: 'Draft image' },
  { value: 'fal-ai/bytedance/seedream/v4/text-to-image', labelKey: 'aiStudio.modelLabel.finalImage', fallback: 'Final image' },
];
const VIDEO_MODELS = [
  { value: 'fal-ai/bytedance/seedance/v1/lite/text-to-video', labelKey: 'aiStudio.modelLabel.cheapVideo', fallback: 'Standard video' },
  { value: 'fal-ai/bytedance/seedance/v1/pro/text-to-video', labelKey: 'aiStudio.modelLabel.premiumVideo', fallback: 'Premium video' },
  { value: 'fal-ai/veo3/fast', labelKey: 'aiStudio.modelLabel.videoAudio', fallback: 'Video + audio' },
];
const MAX_VIDEO_SEC = 10;
const STATUS_TONE: Record<GeneratedAsset['status'], 'neutral' | 'success' | 'danger' | 'warning'> = {
  QUEUED: 'neutral', GENERATING: 'warning', READY: 'success', FAILED: 'danger', BLOCKED: 'danger',
};

export default function AiStudioPage() {
  const { t } = useTranslation('marketing');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [type, setType] = useState<GeneratedAssetType>('IMAGE');
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState(IMAGE_MODELS[0].value);
  const [aspectRatio, setAspectRatio] = useState<GenerateMediaPayload['aspectRatio']>('1:1');
  const [durationSec, setDurationSec] = useState(5);
  const [count, setCount] = useState(1);
  const [filterType, setFilterType] = useState<'' | GeneratedAssetType>('');
  const [pendingIds, setPendingIds] = useState<string[]>([]);

  const models = type === 'IMAGE' ? IMAGE_MODELS : VIDEO_MODELS;

  const library = useQuery({
    queryKey: ['marketing', 'aiStudio', 'generations', filterType],
    queryFn: () => listGenerations(filterType ? { type: filterType } : {}),
  });

  const invalidateLibrary = () =>
    queryClient.invalidateQueries({ queryKey: ['marketing', 'aiStudio', 'generations'] });

  const generate = useMutation({
    mutationFn: async () => {
      const payload: GenerateMediaPayload = {
        type,
        prompt: prompt.trim(),
        model,
        aspectRatio,
        ...(type === 'VIDEO' ? { durationSec } : {}),
      };
      const n = Math.max(1, Math.min(4, count));
      // allSettled, not all: a single rejection must not discard the sibling
      // generations that were already accepted (and charged) server-side.
      const settled = await Promise.allSettled(
        Array.from({ length: n }, () => generateMedia(payload)),
      );
      const ids = settled
        .filter((r): r is PromiseFulfilledResult<{ assetId: string }> => r.status === 'fulfilled')
        .map((r) => r.value.assetId);
      const failed = settled.length - ids.length;
      // Only a wholesale failure is a hard error; otherwise keep the winners.
      if (ids.length === 0) throw settled.find((r) => r.status === 'rejected')?.reason;
      return { ids, failed };
    },
    onSuccess: ({ ids, failed }) => {
      setPendingIds((prev) => [...ids, ...prev]);
      if (failed > 0) {
        toast.error(
          t('aiStudio.toast.partial', '{{done}} started, {{failed}} failed', {
            done: ids.length,
            failed,
          }),
        );
      } else {
        toast.success(t('aiStudio.toast.started', 'Generation started'));
      }
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message ?? t('aiStudio.toast.failed', 'Generation failed')),
  });

  const regenerate = useMutation({
    mutationFn: (id: string) => regenerateMedia(id),
    onSuccess: ({ assetId }) => {
      setPendingIds((prev) => [assetId, ...prev]);
      toast.success(t('aiStudio.toast.started', 'Generation started'));
    },
    onError: () => toast.error(t('aiStudio.toast.failed', 'Generation failed')),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteGeneration(id),
    onSuccess: () => {
      invalidateLibrary();
      toast.success(t('aiStudio.toast.deleted', 'Asset deleted'));
    },
    onError: () => toast.error(t('aiStudio.toast.deleteFailed', 'Delete failed')),
  });

  const addToPost = (a: GeneratedAsset) => {
    if (!a.url) return;
    const media: MediaItemValue = { url: a.url, key: a.r2Key ?? undefined, mime: a.mime ?? undefined };
    navigate('/social', { state: { seedMedia: [media] } });
  };

  const onType = (next: GeneratedAssetType) => {
    setType(next);
    setModel((next === 'IMAGE' ? IMAGE_MODELS : VIDEO_MODELS)[0].value);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('aiStudio.title', 'AI Content Studio')}
        description={t('aiStudio.subtitle', 'Generate images and video for your social posts.')}
      />

      {/* Generation panel */}
      <Card>
        <CardContent className="space-y-4 pt-6">
          <SegmentedControl<GeneratedAssetType>
            aria-label={t('aiStudio.mediaType', 'Media type')}
            value={type}
            onChange={onType}
            options={[
              { value: 'IMAGE', label: t('aiStudio.type.image', 'Image') },
              { value: 'VIDEO', label: t('aiStudio.type.video', 'Video') },
            ]}
          />

          <Field label={t('aiStudio.prompt', 'Prompt')}>
            {({ id }) => (
              <Textarea
                id={id}
                rows={3}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={t('aiStudio.promptPlaceholder', 'Describe the image or video to generate…')}
              />
            )}
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('aiStudio.model', 'Model')}>
              {({ id }) => (
                <Select value={model} onValueChange={setModel}>
                  <SelectTrigger id={id} aria-label={t('aiStudio.model', 'Model')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {models.map((m) => (
                      <SelectItem key={m.value} value={m.value}>
                        {t(m.labelKey, m.fallback)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>

            <Field label={t('aiStudio.aspectRatio', 'Aspect ratio')}>
              {({ id }) => (
                <Select value={aspectRatio} onValueChange={(v) => setAspectRatio(v as typeof aspectRatio)}>
                  <SelectTrigger id={id} aria-label={t('aiStudio.aspectRatio', 'Aspect ratio')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ASPECT_RATIOS.map((r) => (
                      <SelectItem key={r} value={r}>{r}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>

            {type === 'VIDEO' && (
              <Field label={t('aiStudio.duration', 'Duration (sec)')} hint={`1 – ${MAX_VIDEO_SEC}`}>
                {({ id }) => (
                  <Input
                    id={id}
                    type="number"
                    min={1}
                    max={MAX_VIDEO_SEC}
                    value={durationSec}
                    onChange={(e) =>
                      setDurationSec(Math.max(1, Math.min(MAX_VIDEO_SEC, Number(e.target.value))))
                    }
                  />
                )}
              </Field>
            )}

            <Field label={t('aiStudio.count', 'How many')} hint="1 – 4">
              {({ id }) => (
                <Input
                  id={id}
                  type="number"
                  min={1}
                  max={4}
                  value={count}
                  onChange={(e) => setCount(Math.max(1, Math.min(4, Number(e.target.value))))}
                />
              )}
            </Field>
          </div>

          <Button
            onClick={() => generate.mutate()}
            loading={generate.isPending}
            disabled={!prompt.trim()}
          >
            <Sparkles className="h-4 w-4" aria-hidden="true" />
            {t('aiStudio.generate', 'Generate')}
          </Button>
        </CardContent>
      </Card>

      {/* Live generation cards */}
      {pendingIds.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-foreground">
            {t('aiStudio.generating', 'Generating')}
          </h2>
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {pendingIds.map((id) => (
              <GenerationCard
                key={id}
                assetId={id}
                onTerminal={(a) => {
                  setPendingIds((prev) => prev.filter((x) => x !== id));
                  invalidateLibrary();
                  if (a.status === 'BLOCKED') toast.error(t('aiStudio.toast.blocked', 'Blocked by moderation'));
                }}
              />
            ))}
          </div>
        </section>
      )}

      {/* Asset library */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">{t('aiStudio.library', 'Library')}</h2>
          <SegmentedControl<'' | GeneratedAssetType>
            aria-label={t('aiStudio.filterType', 'Filter by type')}
            value={filterType}
            onChange={setFilterType}
            options={[
              { value: '', label: t('aiStudio.filter.all', 'All') },
              { value: 'IMAGE', label: t('aiStudio.type.image', 'Image') },
              { value: 'VIDEO', label: t('aiStudio.type.video', 'Video') },
            ]}
          />
        </div>

        {library.isLoading ? (
          <Spinner />
        ) : !library.data?.length ? (
          <EmptyState
            title={t('aiStudio.empty.title', 'No assets yet')}
            description={t('aiStudio.empty.desc', 'Generate your first image or video above.')}
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {library.data.map((a) => (
              <Card key={a.id} className="overflow-hidden">
                <div className="aspect-square bg-surface-muted">
                  {a.type === 'VIDEO' && a.url ? (
                    <video src={a.url} className="h-full w-full object-cover" controls muted />
                  ) : a.url ? (
                    <img src={a.url} alt={a.prompt} className="h-full w-full object-cover" />
                  ) : null}
                </div>
                <CardContent className="space-y-2 p-3">
                  <Badge tone={STATUS_TONE[a.status]}>{a.status}</Badge>
                  <p className="line-clamp-2 text-caption text-muted-foreground" title={a.prompt}>
                    {a.prompt}
                  </p>
                  <div className="flex flex-wrap gap-1">
                    <Button size="sm" variant="outline" disabled={a.status !== 'READY'} onClick={() => addToPost(a)}>
                      <Plus className="h-4 w-4" aria-hidden="true" />
                      {t('aiStudio.addToPost', 'Add to post')}
                    </Button>
                    {a.url && (
                      <IconButton
                        size="sm"
                        variant="ghost"
                        aria-label={t('aiStudio.download', 'Download')}
                        onClick={() => window.open(a.url!, '_blank', 'noopener')}
                      >
                        <Download className="h-4 w-4" aria-hidden="true" />
                      </IconButton>
                    )}
                    <IconButton
                      size="sm"
                      variant="ghost"
                      aria-label={t('aiStudio.regenerate', 'Regenerate')}
                      onClick={() => regenerate.mutate(a.id)}
                    >
                      <RefreshCw className="h-4 w-4" aria-hidden="true" />
                    </IconButton>
                    <IconButton
                      size="sm"
                      variant="ghost"
                      aria-label={t('aiStudio.delete', 'Delete')}
                      onClick={() => remove.mutate(a.id)}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </IconButton>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/** A single in-flight generation; polls until terminal, then notifies the parent. */
function GenerationCard({
  assetId,
  onTerminal,
}: {
  assetId: string;
  onTerminal: (a: GeneratedAsset) => void;
}) {
  const { t } = useTranslation('marketing');
  // Guard so the parent is notified exactly once, whether we finish via a
  // terminal status or by giving up on a persistently-failing status endpoint.
  const notified = useRef(false);
  const notifyOnce = (a: GeneratedAsset) => {
    if (notified.current) return;
    notified.current = true;
    onTerminal(a);
  };

  const q = useQuery({
    queryKey: ['marketing', 'aiStudio', 'asset', assetId],
    queryFn: async () => {
      const a = await getGeneration(assetId);
      if (isTerminal(a.status)) notifyOnce(a);
      return a;
    },
    refetchInterval: (query) => {
      // Stop polling once the asset is terminal OR the status endpoint keeps
      // failing (deleted server-side / persistent 5xx) — never loop forever.
      if (query.state.status === 'error') return false;
      if (query.state.data && isTerminal(query.state.data.status)) return false;
      return 4000;
    },
  });

  // A persistently-failing poll is terminal too: drop it from the pending list
  // (in an effect, never during render) so the card can't spin indefinitely.
  useEffect(() => {
    if (q.isError) notifyOnce({ id: assetId, status: 'FAILED' } as GeneratedAsset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.isError]);

  return (
    <Card className="flex aspect-square items-center justify-center bg-surface-muted">
      <div className="flex flex-col items-center gap-2 text-caption text-muted-foreground">
        {q.isError ? (
          <span className="text-danger">{t('aiStudio.status.failed', 'FAILED')}</span>
        ) : (
          <>
            <Spinner />
            <span>{q.data?.status ?? t('aiStudio.status.queued', 'QUEUED')}</span>
          </>
        )}
      </div>
    </Card>
  );
}
