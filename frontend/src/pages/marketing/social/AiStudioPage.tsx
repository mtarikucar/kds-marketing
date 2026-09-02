import { useEffect, useMemo, useRef, useState } from 'react';
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
  Label,
  Textarea,
  Input,
  Switch,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Badge,
  Callout,
  EmptyState,
  Spinner,
  cn,
} from '@/components/ui';
import {
  generateMedia,
  listGenerations,
  listMediaModels,
  getGeneration,
  regenerateMedia,
  deleteGeneration,
  estimateMediaCredits,
  meteredQuantityMissing,
  isTerminal,
  MEDIA_MAX_AUDIO_SEC,
  MEDIA_MAX_VIDEO_SEC,
  type GeneratedAsset,
  type GeneratedAssetType,
  type GenerateMediaPayload,
  type MediaChoiceSlot,
  type MediaModelInfo,
  type MediaSourceSlot,
  type MediaTechnique,
} from '../../../features/marketing/api/media.service';
import { useEntitlements } from '../../../features/marketing/hooks/useEntitlements';
import { useOutOfCredits } from '../../../features/marketing/hooks/useOutOfCredits';
import { UpgradeCallout } from '../studio/UpgradeCallout';
import { MediaSourcePicker } from './MediaSourcePicker';
import { SLOT_MEDIA_TYPE, SOURCE_LABELS, TECHNIQUE_META } from './mediaTechniques';
import type { MediaItemValue } from './socialSchemas';

const STATUS_TONE: Record<GeneratedAsset['status'], 'neutral' | 'success' | 'danger' | 'warning'> = {
  QUEUED: 'neutral', GENERATING: 'warning', READY: 'success', FAILED: 'danger', BLOCKED: 'danger',
};

/** Every slot the panel can hold a value for, as arrays — a single-value slot is
 *  simply a one-element one. Which of these actually reach the wire is decided by
 *  the chosen model's contract, never by what happens to be filled in. */
type SourceState = Record<MediaSourceSlot, string[]>;
const EMPTY_SOURCES: SourceState = {
  images: [], firstImage: [], lastImage: [], video: [], audio: [], mask: [],
};

type ChoiceState = Partial<Record<MediaChoiceSlot, string>>;

/** `firstImage` and `images` are ONE slot on our side: the backend reads
 *  sources.images[0] wherever a model spells the source image singular
 *  (`image_url`), so the panel keeps a single image list either way. */
function storageSlotFor(slot: MediaSourceSlot): MediaSourceSlot {
  return slot === 'firstImage' ? 'images' : slot;
}

/** The server's own ceiling for this asset type (it clamps regardless), so the
 *  panel never quotes a length it cannot buy. */
function ceilingFor(type: GeneratedAssetType): number {
  return type === 'AUDIO' ? MEDIA_MAX_AUDIO_SEC : MEDIA_MAX_VIDEO_SEC;
}

/** The lengths a model will actually produce. When it publishes an enum we offer
 *  only those values: anything else is snapped DOWN provider-side, which would
 *  hand the user a shorter clip than the estimate they agreed to. */
function durationChoices(m: MediaModelInfo): number[] | null {
  const d = m.contract.duration;
  if (!d?.allowedSec?.length) return null;
  const max = Math.min(d.maxSec, ceilingFor(m.type));
  return d.allowedSec.filter((s) => s >= d.minSec && s <= max);
}

function defaultDurationFor(m: MediaModelInfo): number | undefined {
  const d = m.contract.duration;
  if (!d) return undefined;
  const max = Math.min(d.maxSec, ceilingFor(m.type));
  const allowed = durationChoices(m);
  // 5s is the house default; on an enum model take the longest allowed value that
  // does not exceed it, so the default is never MORE than what was asked for.
  if (allowed) return [...allowed].reverse().find((s) => s <= 5) ?? allowed[0];
  return Math.min(Math.max(5, d.minSec), max);
}

/** A ratio is only offered if the model publishes it; 1:1 is preferred as the
 *  default where it exists because it is the one every network crops safely. */
function defaultAspectFor(m: MediaModelInfo): string | undefined {
  const keys = Object.keys(m.contract.aspect?.values ?? {});
  if (!keys.length) return undefined;
  return keys.includes('1:1') ? '1:1' : keys[0];
}

function defaultChoicesFor(m: MediaModelInfo): ChoiceState {
  const out: ChoiceState = {};
  for (const [slot, c] of Object.entries(m.contract.choices ?? {})) {
    out[slot as MediaChoiceSlot] = c.default;
  }
  return out;
}

export default function AiStudioPage({ embedded }: { embedded?: boolean } = {}) {
  const { t } = useTranslation('marketing');
  const { isCreditsExhausted, notify: notifyOutOfCredits } = useOutOfCredits();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // Media generation (POST /ai/media/generate) and its library are gated by
  // 'mediaGen'. Gate the whole page so the Generate button and the library query
  // don't silently 403 when the plan doesn't entitle it.
  const { has } = useEntitlements();
  const entitled = has('mediaGen');

  // The catalogue is the panel's only source of truth about what exists, what it
  // costs and which controls it accepts. Nothing here is hardcoded: an endpoint
  // id the UI invented is a live 404 that a customer pays for.
  const catalogue = useQuery({
    queryKey: ['marketing', 'aiStudio', 'models'],
    queryFn: listMediaModels,
    enabled: entitled,
    staleTime: Infinity, // static per deploy
  });

  const [technique, setTechnique] = useState<MediaTechnique | null>(null);
  const [modelId, setModelId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState('');
  const [aspectRatio, setAspectRatio] = useState<string | undefined>();
  const [resolution, setResolution] = useState<string | undefined>();
  const [durationSec, setDurationSec] = useState<number | undefined>();
  const [generateAudio, setGenerateAudio] = useState<boolean | undefined>();
  const [sources, setSources] = useState<SourceState>(EMPTY_SOURCES);
  const [choices, setChoices] = useState<ChoiceState>({});
  const [count, setCount] = useState(1);
  const [filterType, setFilterType] = useState<'' | GeneratedAssetType>('');
  const [pendingIds, setPendingIds] = useState<string[]>([]);

  // Memoised so the `?? []` fallback is not a fresh array on every render, which
  // would re-run the tier sort (and re-sort prices) on every keystroke.
  const models = useMemo(() => catalogue.data?.models ?? [], [catalogue.data]);

  /** Models for a technique, cheapest tier first — the price order is the one the
   *  user is choosing along, and it makes the default selection the cheap one. */
  const tiers = useMemo(() => {
    if (!technique) return [];
    return models
      .filter((m) => m.technique === technique)
      .map((m) => ({ model: m, credits: estimateMediaCredits(m, { durationSec: defaultDurationFor(m) }) }))
      .sort((a, b) => a.credits - b.credits);
  }, [models, technique]);

  const model = tiers.find((x) => x.model.id === modelId)?.model ?? tiers[0]?.model;

  const applyModelDefaults = (m: MediaModelInfo) => {
    setModelId(m.id);
    setAspectRatio(defaultAspectFor(m));
    setResolution(m.contract.resolution?.default);
    setDurationSec(defaultDurationFor(m));
    setGenerateAudio(m.contract.audio?.default);
    setChoices(defaultChoicesFor(m));
  };

  const onTechnique = (next: MediaTechnique) => {
    setTechnique(next);
    const first = models
      .filter((m) => m.technique === next)
      .map((m) => ({ m, c: estimateMediaCredits(m, { durationSec: defaultDurationFor(m) }) }))
      .sort((a, b) => a.c - b.c)[0]?.m;
    if (first) applyModelDefaults(first);
  };

  // Seed the panel from the catalogue the moment it arrives. Done in an effect
  // rather than as query state because everything below is user-editable after.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !catalogue.data?.techniques.length) return;
    seeded.current = true;
    const first = catalogue.data.techniques.find((tq) =>
      catalogue.data.models.some((m) => m.technique === tq));
    if (first) onTechnique(first);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogue.data]);

  const library = useQuery({
    queryKey: ['marketing', 'aiStudio', 'generations', filterType],
    queryFn: () => listGenerations(filterType ? { type: filterType } : {}),
    // Don't hit the (403-ing) library endpoint when the plan doesn't entitle it.
    enabled: entitled,
  });

  const invalidateLibrary = () =>
    queryClient.invalidateQueries({ queryKey: ['marketing', 'aiStudio', 'generations'] });

  const promptText = prompt.trim();
  const contract = model?.contract;
  // Hoisted out of the JSX: TypeScript cannot keep `contract.aspect` narrowed
  // across a render callback, and the alternative is a `!` on every use.
  const aspect = contract?.aspect;
  const avatarChoice = contract?.choices?.avatar;
  const voiceChoice = contract?.choices?.voice;
  const languageChoice = contract?.choices?.language;
  const durationOptions = model ? durationChoices(model) : null;

  // ---- metered models ------------------------------------------------------
  // One served model bills on a quantity the request carries rather than on a
  // length it was asked for: the VEED avatar's clip is as long as its SCRIPT
  // takes to read. The script is the prompt, so the panel can price it exactly.
  //
  // The models billed on a property of the customer's FILE — the length of the
  // clip an upscaler is handed, the pixels it enlarges — are not here to be
  // priced: measuring a file honestly needs a real probe on the server, where
  // the charge is actually decided, so those models are withheld from the
  // catalogue entirely and never reach this picker.

  const estimateOpts = { durationSec, resolution, textLength: promptText.length };
  // Not "0 credits" and not the base rate: there is no price yet, and showing
  // one would be the same wrong number the meter used to reserve — a flat 5
  // credits for a minute-long avatar read that costs $0.35.
  const unpriced = Boolean(model) && meteredQuantityMissing(model!, estimateOpts);
  const creditsEach = model && !unpriced ? estimateMediaCredits(model, estimateOpts) : 0;
  const batch = Math.max(1, Math.min(4, count));
  const creditsTotal = creditsEach * batch;

  /** Required source slots still empty. The backend rejects these before the
   *  reserve (`… requires a source video (video_url)`), so the button is what
   *  waits — a spent round trip is not a validation message. */
  const missingSources = (contract?.sources ?? []).filter(
    (s) => s.required && sources[storageSlotFor(s.slot)].length === 0,
  );
  const needsPrompt = Boolean(contract?.promptParam);
  const canGenerate = Boolean(model)
    && missingSources.length === 0
    && (!needsPrompt || promptText.length > 0)
    // No measurement, no price, and the server would refuse it anyway.
    && !unpriced;

  /** Build the request from the CONTRACT, not from whatever the panel happens to
   *  hold: a field the model does not publish is a 400 before the reserve, and a
   *  stale value left over from another technique must never ride along. */
  const buildPayload = (m: MediaModelInfo): GenerateMediaPayload => {
    const c = m.contract;
    const payload: GenerateMediaPayload = { type: m.type, prompt: promptText, model: m.id };
    if (c.negativePrompt && negativePrompt.trim()) payload.negativePrompt = negativePrompt.trim();
    if (c.aspect && aspectRatio) payload.aspectRatio = aspectRatio;
    if (c.resolution && resolution) payload.resolution = resolution;
    if (c.duration && durationSec !== undefined) payload.durationSec = durationSec;
    // The measurement deliberately does NOT travel with the request: on a
    // source-metered model the server measures the file itself (and refuses a
    // source it cannot), so a number sent from here could only ever disagree
    // with the one actually charged. What is measured here is the QUOTE.
    if (c.audio && generateAudio !== undefined) payload.generateAudio = generateAudio;
    for (const s of c.sources ?? []) {
      if (s.slot === 'images' || s.slot === 'firstImage') {
        const urls = sources.images.slice(0, s.arity === 'array' ? (s.maxCount ?? 14) : 1);
        if (urls.length) payload.referenceImageUrls = urls;
      } else if (sources[s.slot][0]) {
        const url = sources[s.slot][0];
        if (s.slot === 'lastImage') payload.lastImageUrl = url;
        else if (s.slot === 'video') payload.videoUrl = url;
        else if (s.slot === 'audio') payload.audioUrl = url;
        else if (s.slot === 'mask') payload.maskUrl = url;
      }
    }
    for (const slot of Object.keys(c.choices ?? {}) as MediaChoiceSlot[]) {
      const v = choices[slot]?.trim();
      if (v) payload[slot] = v;
    }
    return payload;
  };

  const generate = useMutation({
    mutationFn: async () => {
      if (!model) throw new Error('no model');
      const payload = buildPayload(model);
      const n = batch;
      // allSettled, not all: a single rejection must not discard the sibling
      // generations that were already accepted (and charged) server-side.
      const settled = await Promise.allSettled(
        Array.from({ length: n }, () => generateMedia(payload)),
      );
      const ids = settled
        .filter((r): r is PromiseFulfilledResult<{ assetId: string }> => r.status === 'fulfilled')
        .map((r) => r.value.assetId);
      const rejections = settled
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map((r) => r.reason);
      const failed = rejections.length;
      // Only a wholesale failure is a hard error; otherwise keep the winners.
      if (ids.length === 0) throw rejections[0];
      return { ids, failed, rejections };
    },
    onSuccess: ({ ids, failed, rejections }) => {
      setPendingIds((prev) => [...ids, ...prev]);
      if (failed > 0) {
        toast.error(
          t('aiStudio.toast.partial', '{{done}} started, {{failed}} failed', {
            done: ids.length,
            failed,
          }),
        );
        // A count is not a reason. When the ones that died died on credits, say
        // so — otherwise "3 started, 1 failed" hides the fact that the wall is
        // money and the next click will fail the same way.
        const creditsFailure = rejections.find(isCreditsExhausted);
        if (creditsFailure) notifyOutOfCredits(creditsFailure, '');
      } else {
        toast.success(t('aiStudio.toast.started', 'Generation started'));
      }
    },
    // Echoing `e.response.data.message` printed the backend's English sentence
    // ("Monthly AI credit limit reached (100)…") into a Turkish UI, and said
    // nothing about who could fix it.
    onError: (e: unknown) => notifyOutOfCredits(e, t('aiStudio.toast.failed', 'Generation failed')),
  });

  const regenerate = useMutation({
    mutationFn: (id: string) => regenerateMedia(id),
    onSuccess: ({ assetId }) => {
      setPendingIds((prev) => [assetId, ...prev]);
      toast.success(t('aiStudio.toast.started', 'Generation started'));
    },
    onError: (e: unknown) => notifyOutOfCredits(e, t('aiStudio.toast.failed', 'Generation failed')),
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
    // Straight to the planner INSIDE Growth Studio — the legacy /social
    // redirect would drop location.state and lose the seeded media.
    navigate('/studio?view=tools&tab=campaigns&sub=planner', { state: { seedMedia: [media] } });
  };

  const setSlot = (slot: MediaSourceSlot, urls: string[]) =>
    setSources((prev) => ({ ...prev, [slot]: urls }));

  if (!entitled) {
    return (
      <div className="space-y-6">
        {!embedded && (
          <PageHeader
            title={t('aiStudio.title', 'AI Content Studio')}
            description={t('aiStudio.subtitle', 'Generate images and video for your social posts.')}
          />
        )}
        <UpgradeCallout />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {!embedded && (
      <PageHeader
        title={t('aiStudio.title', 'AI Content Studio')}
        description={t('aiStudio.subtitle', 'Generate images and video for your social posts.')}
      />
      )}

      {/* 1 — what do you want to make */}
      <Card>
        <CardContent className="space-y-3 pt-6">
          <h2 className="text-sm font-semibold text-foreground">
            {t('aiStudio.step.technique', 'What do you want to make?')}
          </h2>
          {catalogue.isLoading ? (
            <Spinner />
          ) : catalogue.isError ? (
            <Callout tone="danger" title={t('aiStudio.catalogueError.title', 'Could not load the model list')}>
              {t(
                'aiStudio.catalogueError.desc',
                'Generation is unavailable until the model list loads. Try again in a moment.',
              )}
            </Callout>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {(catalogue.data?.techniques ?? [])
                // A technique with no models behind it is not offerable.
                .filter((tq) => models.some((m) => m.technique === tq))
                .map((tq) => {
                  const meta = TECHNIQUE_META[tq];
                  const Icon = meta?.icon;
                  const active = tq === technique;
                  return (
                    <button
                      key={tq}
                      type="button"
                      aria-pressed={active}
                      onClick={() => onTechnique(tq)}
                      className={cn(
                        'flex gap-3 rounded-lg border p-3 text-start transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        active
                          ? 'border-primary bg-primary/5'
                          : 'border-border hover:border-primary/50',
                      )}
                    >
                      {Icon && <Icon className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />}
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-foreground">
                          {t(`aiStudio.technique.${tq}.title`, meta?.title ?? tq)}
                        </span>
                        <span className="block text-caption text-muted-foreground">
                          {t(`aiStudio.technique.${tq}.desc`, meta?.desc ?? '')}
                        </span>
                      </span>
                    </button>
                  );
                })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 2 + 3 — the tier inside that technique, then only its own controls */}
      {model && contract && (
        <Card>
          <CardContent className="space-y-4 pt-6">
            <div className="space-y-2">
              <h2 className="text-sm font-semibold text-foreground">
                {t('aiStudio.step.tier', 'Quality and price')}
              </h2>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {tiers.map(({ model: m }) => {
                  const active = m.id === model.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => applyModelDefaults(m)}
                      className={cn(
                        'rounded-lg border p-3 text-start transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        active ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50',
                      )}
                    >
                      <span className="block text-sm font-medium text-foreground">{m.label}</span>
                      <span className="block text-caption text-muted-foreground">
                        <RateLine model={m} />
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {contract.promptParam && (
              <Field
                label={
                  model.technique === 'VOICE' || model.technique === 'AVATAR'
                    ? t('aiStudio.script', 'Script')
                    : t('aiStudio.prompt', 'Prompt')
                }
              >
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
            )}

            {(contract.sources ?? []).map((s) => {
              const labels = SOURCE_LABELS[s.param];
              const slot = storageSlotFor(s.slot);
              return (
                <MediaSourcePicker
                  key={s.param}
                  label={t(`aiStudio.source.${s.param}.title`, labels?.title ?? s.param)}
                  hint={labels ? t(`aiStudio.source.${s.param}.hint`, labels.hint) : undefined}
                  mediaType={SLOT_MEDIA_TYPE[s.slot]}
                  required={s.required}
                  multiple={s.arity === 'array'}
                  maxCount={s.maxCount ?? 1}
                  value={sources[slot]}
                  onChange={(urls) => setSlot(slot, urls)}
                />
              );
            })}

            <div className="grid gap-4 sm:grid-cols-2">
              {contract.negativePrompt && (
                <Field
                  label={t('aiStudio.negativePrompt', 'Avoid')}
                  hint={t('aiStudio.negativePromptHint', 'What must not appear.')}
                >
                  {({ id }) => (
                    <Input id={id} value={negativePrompt} onChange={(e) => setNegativePrompt(e.target.value)} />
                  )}
                </Field>
              )}

              {aspect && (
                <Field label={t('aiStudio.aspectRatio', 'Aspect ratio')}>
                  {({ id }) => (
                    <Select value={aspectRatio} onValueChange={setAspectRatio}>
                      <SelectTrigger id={id} aria-label={t('aiStudio.aspectRatio', 'Aspect ratio')}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.keys(aspect.values).map((r) => (
                          <SelectItem key={r} value={r}>{r}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </Field>
              )}

              {avatarChoice && (
                <Field label={t('aiStudio.avatar', 'Presenter')}>
                  {({ id }) => (
                    <Select
                      value={choices.avatar}
                      onValueChange={(v) => setChoices((p) => ({ ...p, avatar: v }))}
                    >
                      <SelectTrigger id={id} aria-label={t('aiStudio.avatar', 'Presenter')}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {avatarChoice.values.map((v) => (
                          <SelectItem key={v} value={v}>{v}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </Field>
              )}

              {voiceChoice && (
                <Field
                  label={t('aiStudio.voice', 'Voice')}
                  hint={t('aiStudio.voiceHint', 'An ElevenLabs voice name.')}
                >
                  {({ id }) => (
                    <Input
                      id={id}
                      value={choices.voice ?? ''}
                      onChange={(e) => setChoices((p) => ({ ...p, voice: e.target.value }))}
                    />
                  )}
                </Field>
              )}

              {languageChoice && (
                <Field
                  label={t('aiStudio.language', 'Language')}
                  hint={t('aiStudio.languageHint', 'Two-letter code — tr for Turkish.')}
                >
                  {({ id }) => (
                    <Input
                      id={id}
                      value={choices.language ?? ''}
                      onChange={(e) => setChoices((p) => ({ ...p, language: e.target.value }))}
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

            {contract.resolution && (
              <div className="space-y-1.5">
                <Label>{t('aiStudio.resolution', 'Resolution')}</Label>
                <div>
                  <SegmentedControl
                    aria-label={t('aiStudio.resolution', 'Resolution')}
                    value={resolution ?? contract.resolution.default}
                    onChange={setResolution}
                    options={contract.resolution.values.map((v) => ({ value: v, label: v }))}
                  />
                </div>
              </div>
            )}

            {contract.duration && durationOptions && (
              <div className="space-y-1.5">
                <Label>{t('aiStudio.duration', 'Duration (sec)')}</Label>
                <div>
                  <SegmentedControl
                    aria-label={t('aiStudio.duration', 'Duration (sec)')}
                    value={String(durationSec ?? durationOptions[0])}
                    onChange={(v) => setDurationSec(Number(v))}
                    options={durationOptions.map((s) => ({ value: String(s), label: `${s}` }))}
                  />
                </div>
              </div>
            )}

            {contract.duration && !durationOptions && (
              <Field
                label={t('aiStudio.duration', 'Duration (sec)')}
                hint={`${contract.duration.minSec} – ${Math.min(contract.duration.maxSec, ceilingFor(model.type))}`}
              >
                {({ id }) => {
                  const min = contract.duration!.minSec;
                  const max = Math.min(contract.duration!.maxSec, ceilingFor(model.type));
                  return (
                    <Input
                      id={id}
                      type="number"
                      min={min}
                      max={max}
                      value={durationSec ?? min}
                      onChange={(e) =>
                        // Round to mirror the backend GenerateDto.durationSec @IsInt —
                        // a fractional 7.5 otherwise 400s.
                        setDurationSec(Math.round(Math.max(min, Math.min(max, Number(e.target.value)))))
                      }
                    />
                  );
                }}
              </Field>
            )}

            {contract.audio && (
              <div className="flex items-center gap-2">
                <Switch
                  id="ai-studio-audio"
                  checked={generateAudio ?? contract.audio.default}
                  onCheckedChange={setGenerateAudio}
                />
                <Label htmlFor="ai-studio-audio">
                  {t('aiStudio.generateAudio', 'Generate sound with the video')}
                </Label>
              </div>
            )}

            {model.note && (
              <p className="text-caption text-muted-foreground">{model.note}</p>
            )}

            {/* The estimate is deliberately next to the button, not buried in the
                tier list: a 5-second Seedance clip is ~240 credits and nobody may
                find that out after the click. */}
            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={() => generate.mutate()}
                loading={generate.isPending}
                disabled={!canGenerate}
              >
                <Sparkles className="h-4 w-4" aria-hidden="true" />
                {t('aiStudio.generate', 'Generate')}
              </Button>
              {/* This model's length is its script's, so there is no price until
                  the script is written — showing the base rate instead is exactly
                  how a minute-long avatar read used to quote 5 credits. */}
              {unpriced ? (
                <p className="text-sm text-muted-foreground" data-testid="credit-estimate-unpriced">
                  {t(
                    'aiStudio.estimateNeedsScript',
                    'This one is as long as its script, so write the script above to see what it costs.',
                  )}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t('aiStudio.estimate', 'Estimated cost')}:{' '}
                  <strong className="text-foreground" data-testid="credit-estimate">{creditsTotal}</strong>{' '}
                  {t('aiStudio.creditsUnit', 'credits')}
                  {batch > 1 && (
                    <span data-testid="credit-estimate-each">
                      {' '}({batch} × {creditsEach})
                    </span>
                  )}
                </p>
              )}
            </div>

            {missingSources.length > 0 && (
              <p className="text-caption text-muted-foreground">
                {t('aiStudio.needSource', 'Add the source media above to generate.')}
              </p>
            )}
          </CardContent>
        </Card>
      )}

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
              { value: 'AUDIO', label: t('aiStudio.type.audio', 'Audio') },
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
                <div className={cn('bg-surface-muted', a.type === 'AUDIO' ? 'flex items-center p-3' : 'aspect-square')}>
                  {a.url && a.type === 'AUDIO' ? (
                    // An mp3 behind an <img> is a broken-image icon; a voiceover
                    // is only judgeable by listening to it.
                    <audio src={a.url} className="w-full" controls data-testid="asset-audio" />
                  ) : a.type === 'VIDEO' && a.url ? (
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
                    {/* The composer's media list is image/video only, so an audio
                        asset has nowhere to land in a post. */}
                    {a.type !== 'AUDIO' && (
                      <Button size="sm" variant="outline" disabled={a.status !== 'READY'} onClick={() => addToPost(a)}>
                        <Plus className="h-4 w-4" aria-hidden="true" />
                        {t('aiStudio.addToPost', 'Add to post')}
                      </Button>
                    )}
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

/** The model's headline rate, in the unit it is actually metered in. Composed
 *  from a number plus a unit rather than an interpolated sentence so the unit is
 *  all a translator has to carry. */
function RateLine({ model }: { model: MediaModelInfo }) {
  const { t } = useTranslation('marketing');
  if (model.creditsPerSec !== undefined) {
    return <>{model.creditsPerSec} {t('aiStudio.rate.perSec', 'credits/sec')}</>;
  }
  if (model.creditsPerKChar !== undefined) {
    return <>{model.creditsPerKChar} {t('aiStudio.rate.perKChar', 'credits / 1000 characters')}</>;
  }
  if (model.creditsPerMinute !== undefined) {
    return <>{model.creditsPerMinute} {t('aiStudio.rate.perMinute', 'credits/minute')}</>;
  }
  return <>{model.credits ?? 0} {t('aiStudio.rate.perRun', 'credits each')}</>;
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
