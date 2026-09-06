import {
  Injectable, Logger, BadRequestException, ServiceUnavailableException,
  NotFoundException, Inject, OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { AiCreditsService } from '../ai-credits.service';
import { ScheduledJobService } from '../../scheduling/scheduled-job.service';
import {
  ScheduledJobRunnerService, JobRescheduleDirective,
} from '../../scheduling/scheduled-job-runner.service';
import { R2StorageService } from '../../../../common/storage/r2-storage.service';
import { MediaProbeService } from './media-probe.service';
import { GrowthWalletService } from '../../wallet/growth-wallet.service';
import { MediaSpendService } from '../../budget/media-spend.service';
import { growthAutopilotAutonomyEnabled } from '../../budget/growth-autonomy.flag';
import {
  MediaProvider, MEDIA_PROVIDER, MediaGenResult, MediaGenSources,
} from '../providers/media-provider.interface';
import {
  MediaEstimateOpts, MediaModel, MediaVendor,
  defaultModelFor, estimateMediaCredits, estimateMediaUsd, estimateVendorUsd, getMediaModel,
  isCataloguedModel, isMediaModelWithheld, meteredUnits, resolveMediaModelId,
} from './media-models.config';
import { GeneratedAssetType, TERMINAL_ASSET_STATUSES, isTerminalAssetStatus } from './media-asset.constants';

export const MEDIA_GEN_POLL_KIND = 'social.media.generate.poll';
export const MEDIA_GEN_CLEANUP_KIND = 'social.media.cleanup.orphans';

const MAX_INFLIGHT = Number(process.env.MEDIA_GEN_MAX_INFLIGHT ?? 4);
const MAX_VIDEO_SEC = Number(process.env.MEDIA_GEN_MAX_VIDEO_SEC ?? 10);
// Audio has its own ceiling: a music bed or a voiceover routinely outruns a
// clip, and ElevenLabs Music bills in whole minutes anyway, so capping it at the
// video ceiling would make the MUSIC technique useless without making it cheaper.
const MAX_AUDIO_SEC = Number(process.env.MEDIA_GEN_MAX_AUDIO_SEC ?? 60);
const POLL_DELAY_MS = 20_000;
const POLL_RETRY_MS = 30_000;
const RETENTION_DAYS = Number(process.env.MEDIA_GEN_RETENTION_DAYS ?? 30);
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TERMINAL = [...TERMINAL_ASSET_STATUSES]; // ['READY','FAILED','BLOCKED']
// A generation still QUEUED/GENERATING past this age is treated as abandoned: it
// is failed + refunded so a lost webhook/poll (or a provider stuck IN_PROGRESS)
// can never leak the reservation or permanently pin a MAX_INFLIGHT slot.
const MAX_GEN_AGE_MS = Number(process.env.MEDIA_GEN_MAX_AGE_MS ?? 60 * 60 * 1000);
// Server-side download of provider result URLs: bounded so a huge/slow body can't
// OOM or hang the single-replica scheduled-job worker.
const DOWNLOAD_TIMEOUT_MS = Number(process.env.MEDIA_GEN_DOWNLOAD_TIMEOUT_MS ?? 60_000);
const MAX_DOWNLOAD_BYTES = Number(process.env.MEDIA_GEN_MAX_DOWNLOAD_BYTES ?? 250 * 1024 * 1024);

/** Engine context (Growth Autopilot D4): the generation belongs to a
 *  social-campaign pipeline item — i.e. the ENGINE requested it, not a user. */
function isEngineAsset(params: unknown): boolean {
  return Boolean((params as { campaignItemId?: unknown } | null | undefined)?.campaignItemId);
}

/** Reject a request the model's input contract cannot serve BEFORE credits are
 *  reserved and the provider is engaged. Without this the failure surfaces as a
 *  fal 422 after a reserve/refund round trip — or worse, as a silently dropped
 *  parameter (a required source image that never reaches the wire). */
function assertContractSatisfied(m: MediaModel, dto: RequestGenerationDto, sources: MediaGenSources): void {
  const c = m.contract;
  const bad = (message: string): never => {
    throw new BadRequestException({ code: 'MEDIA_GEN_INVALID_INPUT', message });
  };

  if (dto.aspectRatio && c.aspect && !c.aspect.values[dto.aspectRatio]) {
    bad(`${m.id} does not support aspect ratio ${dto.aspectRatio}`);
  }
  if (dto.aspectRatio && !c.aspect) bad(`${m.id} does not take an aspect ratio`);
  if (dto.resolution && !c.resolution?.values.includes(dto.resolution)) {
    bad(`${m.id} does not support resolution ${dto.resolution}`);
  }

  for (const req of c.sources ?? []) {
    if (!req.required) continue;
    const present = req.slot === 'images' || req.slot === 'firstImage'
      ? (sources.images?.length ?? 0) > 0
      : Boolean(sources[req.slot as 'lastImage' | 'video' | 'audio' | 'mask']);
    if (!present) bad(`${m.id} requires a source ${req.slot} (${req.param})`);
  }

  // The only source-metered quantity the REQUEST can honestly carry, and the
  // only one this service serves: a metered script IS the prompt, and the
  // prompt is ours to read. Every model billed on a property of a customer's
  // FILE is withheld instead (see `assertNotWithheld`), because measuring that
  // file needs a real probe we do not have.
  if (m.contract.sourceMetering?.from === 'script' && !dto.prompt?.trim()) {
    bad(`${m.label} is billed by how long its script takes to read, so it cannot be `
      + 'priced without one. Write the script you want read and try again.');
  }
}

/**
 * A catalogued model that is not for sale is refused HERE — before the reserve,
 * before the provider, before anything is charged.
 *
 * Withdrawal is enforced in two places for two different callers: the models
 * endpoint drops these so no picker can offer one, and this drops them so an
 * API caller naming one directly gets a 400 rather than a render priced off a
 * quantity nobody measured. Serving-side filtering alone would leave the second
 * door open, which is the door that costs money.
 */
function assertNotWithheld(m: MediaModel): void {
  if (!m.withheld) return;
  throw new BadRequestException({
    code: 'MEDIA_GEN_MODEL_WITHHELD',
    message: `${m.label} is not available. ${m.withheld}`,
  });
}

/** Past the endpoint's own published ceiling there is no rate to bill at, so
 *  the request is refused rather than silently charged the top rung. No served
 *  model publishes a ceiling today (the ones that did are withheld), but the
 *  rule is generic and rides on the contract, so a ceiling added to a served
 *  model is enforced the moment it is declared rather than the moment someone
 *  remembers to check for it. */
function assertWithinPublishedCeiling(
  m: MediaModel, opts: MediaEstimateOpts, bad: (message: string) => never,
): void {
  const sm = m.contract.sourceMetering;
  const units = meteredUnits(m, opts);
  if (!sm || sm.maxUnits === undefined || units === null || units <= sm.maxUnits) return;
  bad(`${m.label} tops out at ${sm.maxUnits} ${sm.quantity === 'megapixels' ? 'megapixels' : 'seconds'}`
    + `, and this one works out at ${Math.round(units)}. Use a smaller source.`);
}

/** Block SSRF to internal targets: reject loopback/private/link-local hosts. */
function isBlockedDownloadHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local (cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  if (h === '::1' || h === '::') return true;
  if (/^fe80:/.test(h)) return true; // IPv6 link-local
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // IPv6 ULA fc00::/7
  if (h.startsWith('::ffff:')) return isBlockedDownloadHost(h.slice('::ffff:'.length)); // IPv4-mapped
  return false;
}

export interface RequestGenerationDto {
  /** Only consulted to pick a default model; a catalogued model's own type wins. */
  type: GeneratedAssetType;
  model?: string;
  prompt: string;
  negativePrompt?: string;
  aspectRatio?: string;
  /** Wire resolution value ('720p', '4k', '2K', '1024x1024' — casing matters). */
  resolution?: string;
  durationSec?: number;
  // NOTE — there is deliberately NO sourceDurationSec/sourceWidth/sourceHeight
  // here, and there never will be. A caller-stated property of a file is not a
  // measurement, it is a number the payer chooses: one curl claiming
  // `sourceDurationSec: 0.1` for a ten-minute 4K clip reserves a single credit
  // against a $96 Topaz render, and that endpoint reports no duration back, so
  // nothing ever trues it up. The models whose price is such a property are
  // withheld from the catalogue until the server can measure the file itself.
  generateAudio?: boolean;
  referenceImageUrls?: string[];
  /** Source media for the edit/animate/lipsync/extend techniques. */
  lastImageUrl?: string;
  videoUrl?: string;
  audioUrl?: string;
  maskUrl?: string;
  /** Catalogue-declared enum choices (TTS voice/language, stock avatar id). */
  voice?: string;
  language?: string;
  avatar?: string;
  seed?: number;
  createdById: string;
  socialCampaignId?: string;
  campaignItemId?: string;
}

/**
 * True when this model's price is a property of a FILE the caller supplied, and
 * therefore cannot be known until that file is measured.
 *
 * A script-metered model is deliberately excluded: its quantity is the prompt,
 * which is in the request and is ours to read.
 */
export function needsSourceMeasurement(m: MediaModel): boolean {
  const sm = m.contract.sourceMetering;
  return !!sm && sm.from !== 'script';
}

/** Which request field holds the file for a given contract slot. Exported so
 *  the catalogue rule test can prove every metered slot is one the service can
 *  actually reach — a slot it cannot resolve measures nothing, and the model
 *  would fail at request time instead of being withheld honestly. */
export function urlForSlot(slot: string, sources: MediaGenSources): string | undefined {
  switch (slot) {
    // Both spellings mean "the first reference image" — `firstImage` is the
    // single-source name and `images` the array one, and the metered quantity
    // is a property of one file either way.
    case 'firstImage':
    case 'images':
      return sources.images?.[0];
    case 'lastImage':
      return sources.lastImage;
    case 'video':
      return sources.video;
    case 'audio':
      return sources.audio;
    case 'mask':
      return sources.mask;
    default:
      return undefined;
  }
}

/** What a source measurement yielded, and whether it is enough to price on. */
interface SourceMeasurement {
  durationSec?: number;
  width?: number;
  height?: number;
  /** False means: do not price this, refuse it. */
  usable: boolean;
  error?: string;
}

/** The fields the credit estimate is a function of, as persisted on the asset.
 *  finalize re-runs the estimate against the provider's ACTUAL duration, so it
 *  has to reconstruct the rest of the estimate's inputs or it silently trues up
 *  a 1080p Seedance generation at the 720p base rate. */
function estimateOptsFrom(
  params: unknown, durationSec: number | null | undefined, prompt: string | null | undefined,
): MediaEstimateOpts {
  const p = (params ?? {}) as {
    resolution?: string | null;
    sourceDurationSec?: number | null;
    sourceWidth?: number | null;
    sourceHeight?: number | null;
  };
  return {
    durationSec: durationSec ?? undefined,
    resolution: p.resolution ?? undefined,
    textLength: (prompt ?? '').length,
    // The MEASUREMENT the reserve was sized from. Dropping it here is the same
    // defect as dropping the resolution tier, and worse in one way: a
    // source-metered model whose quantity goes missing does not merely true up
    // at the wrong rate, it falls through to a DEFAULT duration — which is how
    // a 60-second upscale ends up costing what a 5-second one does.
    sourceDurationSec: p.sourceDurationSec ?? undefined,
    sourceWidth: p.sourceWidth ?? undefined,
    sourceHeight: p.sourceHeight ?? undefined,
  };
}

@Injectable()
export class MediaGenService implements OnModuleInit {
  private readonly logger = new Logger(MediaGenService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly credits: AiCreditsService,
    @Inject(MEDIA_PROVIDER) private readonly provider: MediaProvider,
    private readonly scheduledJobs: ScheduledJobService,
    private readonly r2: R2StorageService,
    private readonly runner: ScheduledJobRunnerService,
    private readonly wallet: GrowthWalletService,
    private readonly mediaSpend: MediaSpendService,
    // LAST on purpose. Every spec in this directory constructs the service
    // positionally, so inserting a dependency in the middle would silently
    // shift each one of them onto the wrong argument.
    private readonly probe: MediaProbeService,
  ) {}

  /**
   * Measure the caller's own file, for the models whose price is a property of
   * it rather than of the request.
   *
   * `usable: false` is the answer that matters. It is what the withheld note
   * asked for in place of a guess: these endpoints report nothing back that a
   * finalize true-up could correct, so a quantity invented here is billed
   * permanently. Refusing a generation is recoverable; a permanent wrong charge
   * on someone else's money is not.
   */
  private async measureMeteredSources(
    m: MediaModel | undefined,
    sources: MediaGenSources,
  ): Promise<SourceMeasurement> {
    if (!m || !needsSourceMeasurement(m)) return { usable: true };
    const sm = m.contract.sourceMetering!;
    const slots = Array.isArray(sm.from) ? sm.from : [];

    let durationSec: number | undefined;
    let width: number | undefined;
    let height: number | undefined;
    let error: string | undefined;

    for (const slot of slots) {
      const url = urlForSlot(slot, sources);
      if (!url) continue;
      const r = await this.probe.measure(url);
      if (r.error) {
        error = error ?? r.error;
        continue;
      }
      // The LONGEST of the named slots. A lipsync bills for the whole render,
      // and the render is as long as the longer of its video and its audio —
      // taking the first, or the shortest, under-charges every mismatched pair.
      if (r.durationSec != null && (durationSec == null || r.durationSec > durationSec)) {
        durationSec = r.durationSec;
      }
      if (width == null && r.width != null && r.height != null) {
        width = r.width;
        height = r.height;
      }
    }

    const usable = sm.quantity === 'durationSec'
      ? durationSec != null && durationSec > 0
      : width != null && height != null;
    return { durationSec, width, height, usable, error };
  }

  onModuleInit(): void {
    this.runner.registerHandler(MEDIA_GEN_POLL_KIND, (job) =>
      this.pollGeneration(job.payload.assetId, job.payload.workspaceId));
    this.runner.registerHandler(MEDIA_GEN_CLEANUP_KIND, async () => {
      await this.sweepOrphanAssets();
      return { reschedule: { runAt: new Date(Date.now() + SWEEP_INTERVAL_MS) } };
    });
    void this.scheduledJobs.schedule({
      workspaceId: 'system',
      kind: MEDIA_GEN_CLEANUP_KIND,
      runAt: new Date(Date.now() + SWEEP_INTERVAL_MS),
      payload: {},
      dedupKey: 'media-gen-orphan-sweep',
    }).catch(() => undefined);
  }

  /**
   * The middle term of the resolution order — `campaign override ?? THIS ?? code
   * constant` — and the only place it is applied.
   *
   * WHY HERE and not in the producers. Two services buy clips
   * (`concept-promotion.service.ts` and `social-campaigns.service.ts`) and both
   * already pass the campaign's override when it has one and pass nothing when
   * it does not. Resolving in either leaves the other on the constant. Resolving
   * at this single shared write also makes a sentence that has been printed in
   * `jeeta.generate_image` / `jeeta.generate_video`'s published descriptions
   * since they shipped — "Defaults to the workspace default" — true for the
   * first time.
   *
   * Only reached when the caller named NO model, so an override still costs no
   * query.
   *
   * A stored default that is no longer catalogued, or is of the wrong kind,
   * falls back to the constant AND SAYS SO. Running it is not an option (its
   * price is unknown, which is precisely what the guard above refuses), and
   * refusing the generation outright is worse: retiring one entry from the
   * catalogue would stop every workspace that had chosen it from generating at
   * all, at deploy time, with no warning. The log line is what keeps that from
   * being silent — a workspace billed at a rate its settings screen does not
   * show is the failure this comment exists to make findable.
   */
  // PUBLIC, because one caller needs the ANSWER before it submits, not merely
  // the effect of it: `ConceptPromotionService.produce` must know which endpoint
  // will run in order to ask whether that endpoint offers the plan's aspect
  // ratio and whether it accepts reference images at all. Re-deriving the same
  // `campaign override ?? workspace default ?? constant` order there is exactly
  // the second copy this method's own docblock exists to prevent.
  async workspaceDefaultModel(
    workspaceId: string,
    type: GeneratedAssetType,
  ): Promise<string> {
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { defaultImageModel: true, defaultVideoModel: true },
    });
    // AUDIO is deliberately absent: the voice/music techniques arrived after
    // these two columns, and nobody has been offered a choice to store yet, so
    // the code constant is the honest answer rather than an image default.
    const stored = (type === 'AUDIO' ? null
      : type === 'VIDEO' ? ws?.defaultVideoModel : ws?.defaultImageModel) ?? null;
    if (!stored) return defaultModelFor(type);
    if (!isCataloguedModel(stored, type)) {
      this.logger.warn(
        `workspace ${workspaceId} has "${stored}" as its default ${type} model, which is not in the catalogue for that kind — ` +
          `falling back to ${defaultModelFor(type)}. The stored value cannot be priced, so it cannot be run.`,
      );
      return defaultModelFor(type);
    }
    return stored;
  }

  async requestGeneration(workspaceId: string, dto: RequestGenerationDto): Promise<{ assetId: string }> {
    if (!this.provider.isConfigured()) {
      throw new ServiceUnavailableException({ code: 'MEDIA_GEN_NOT_CONFIGURED', message: 'Media generation is not configured' });
    }

    // Only catalogued models (known pricing) may be requested — an arbitrary
    // model id would be billed at the cheap fallback estimate while the provider
    // charges the real (possibly far higher) rate.
    //
    // The membership question includes the KIND. It did not used to, and the
    // hole was the same one this guard exists to close: `fal-ai/qwen-image` on a
    // VIDEO request passed (it IS catalogued) and then priced the clip at the
    // flat 2-credit per-image rate instead of per second.
    if (dto.model && !isCataloguedModel(dto.model, dto.type)) {
      throw new BadRequestException({
        code: 'MEDIA_GEN_UNKNOWN_MODEL',
        message: `Unknown ${dto.type.toLowerCase()} model: ${dto.model}`,
      });
    }

    // The campaign linkage is PROVEN, not trusted, and it is checked before the
    // reservation so an unowned id is a rejected request rather than a refunded
    // one. Both ids are consequential: `socialCampaignId` exempts the asset from
    // `sweepOrphanAssets`' 30-day delete AND is a real FK, so an unchecked value
    // would let one workspace hang a row off another's campaign; `campaignItemId`
    // puts the generation on the ENGINE path, where an armed autonomous budget
    // pre-debits the growth wallet in real cash. Both were safe on trust while
    // every caller was server-side code passing ids it had just read; they stop
    // being safe the moment a model can supply them (`jeeta.generate_video`),
    // and the check belongs here — at the write — so no future caller reopens it.
    if (dto.socialCampaignId) {
      const owned = await this.prisma.socialCampaign.findFirst({
        where: { id: dto.socialCampaignId, workspaceId },
        select: { id: true },
      });
      if (!owned) {
        throw new BadRequestException({
          code: 'MEDIA_GEN_UNKNOWN_CAMPAIGN',
          message: `Social campaign ${dto.socialCampaignId} does not exist in this workspace`,
        });
      }
    }
    if (dto.campaignItemId) {
      const owned = await this.prisma.socialCampaignItem.findFirst({
        where: { id: dto.campaignItemId, workspaceId },
        select: { id: true },
      });
      if (!owned) {
        throw new BadRequestException({
          code: 'MEDIA_GEN_UNKNOWN_CAMPAIGN_ITEM',
          message: `Social campaign item ${dto.campaignItemId} does not exist in this workspace`,
        });
      }
    }
    const requested = dto.model ?? (await this.workspaceDefaultModel(workspaceId, dto.type));
    // A fal-retired id — a stored default, a campaign override, or a regenerate
    // of an old row — runs on its successor. The row records the successor, so
    // history and regenerate converge on the live model; the log line is the
    // only trace, and it is what makes a silently re-priced workspace findable.
    const model = resolveMediaModelId(requested);
    if (model !== requested) {
      this.logger.warn(
        `${requested} was retired by its provider; generating on ${model} instead (workspace ${workspaceId})`,
      );
    }
    // The catalogue's type is authoritative: a caller asking for VIDEO while
    // naming an ElevenLabs model must not have an mp3 stored as a video.
    const catalogued = getMediaModel(model);

    // Catalogued but withdrawn. Checked here rather than only where the
    // catalogue is served, so naming one on the API is refused too — and
    // refused BEFORE the inflight count, the reserve and the provider, because
    // the whole point is that nothing about it may be charged.
    //
    // Keyed on the RESOLVED model, not on `dto.model`: a request that names no
    // model at all still generates one — the type's default — and that is the
    // shape of the ordinary call (the MCP tools and the campaign engine both
    // omit the id routinely). Gating on `dto.model` left that path unguarded,
    // so withholding a default would have dropped it from the picker while the
    // modelless POST kept reserving and submitting it.
    if (catalogued && isMediaModelWithheld(model)) assertNotWithheld(catalogued);

    const inflight = await this.prisma.generatedAsset.count({
      where: { workspaceId, status: { in: ['QUEUED', 'GENERATING'] } },
    });
    if (inflight >= MAX_INFLIGHT) {
      throw new BadRequestException({ code: 'MEDIA_GEN_TOO_MANY', message: `Too many running generations (max ${MAX_INFLIGHT})` });
    }

    const type: GeneratedAssetType = catalogued?.type ?? dto.type;

    const sources: MediaGenSources = {
      images: dto.referenceImageUrls?.length ? dto.referenceImageUrls : undefined,
      lastImage: dto.lastImageUrl,
      video: dto.videoUrl,
      audio: dto.audioUrl,
      mask: dto.maskUrl,
    };
    if (catalogued) assertContractSatisfied(catalogued, dto, sources);

    const durationSec = type === 'IMAGE'
      ? undefined
      : Math.min(dto.durationSec ?? 5, type === 'AUDIO' ? MAX_AUDIO_SEC : MAX_VIDEO_SEC);
    // The estimate is a function of duration, the resolution TIER and — for the
    // TTS models, which bill per 1000 characters — the script length.
    // Measure the caller's own file when the price is a property of it. This is
    // the whole reason those models were withheld, and the measurement has to
    // happen HERE — before the reserve, which is the only gate that can say no.
    const measured = await this.measureMeteredSources(catalogued, sources);
    const estimateOpts: MediaEstimateOpts = {
      durationSec, resolution: dto.resolution, textLength: dto.prompt.length,
      sourceDurationSec: measured.durationSec,
      sourceWidth: measured.width,
      sourceHeight: measured.height,
    };
    // Refuse rather than fall back. `estimateMediaUsd` does NOT fail closed on a
    // missing measurement: it drops through to the flat rate, and for a
    // duration-metered model to DEFAULT_DURATION_SEC — which prices a
    // ten-minute upscale as a five-second one. That fallthrough was harmless
    // only while every such model was withheld; it stops being harmless the
    // moment one is on sale, so the refusal is what replaces the withholding.
    if (catalogued && needsSourceMeasurement(catalogued) && !measured.usable) {
      throw new BadRequestException({
        code: 'MEDIA_GEN_UNMEASURABLE_SOURCE',
        message:
          `${catalogued.label} is billed by the size of the file you supply, and that file could not be `
          + `measured${measured.error ? ` (${measured.error})` : ''}. Try a different source, or a model that is priced per request.`,
      });
    }
    if (catalogued) {
      assertWithinPublishedCeiling(catalogued, estimateOpts, (message) => {
        throw new BadRequestException({ code: 'MEDIA_GEN_INVALID_INPUT', message });
      });
    }
    const estimate = estimateMediaCredits(model, estimateOpts);
    const estimateUsd = estimateMediaUsd(model, estimateOpts);
    // Growth Autopilot D4: an ENGINE generation (campaign-item linkage) under the
    // workspace's current-period armed-AUTONOMOUS budget pre-debits the growth
    // wallet with the USD estimate BEFORE the provider is engaged — fail-closed,
    // so an empty wallet rejects engine work. Manual generations are untouched.
    const engineBudget = dto.campaignItemId ? await this.resolveArmedBudget(workspaceId) : null;

    await this.credits.reserve(workspaceId, estimate);

    // Everything after the reservation runs under one try so ANY failure —
    // including the create() itself — issues the compensating refund. Otherwise a
    // failed create leaks the reservation with no row for the poll/webhook to
    // finalize (the refund would never fire).
    let asset: { id: string } | undefined;
    try {
      const params: Prisma.InputJsonValue = {
        aspectRatio: dto.aspectRatio ?? null,
        // Persisted because finalize re-runs the estimate: without the tier, a
        // 1080p Seedance clip would true up at the 720p rate and under-charge.
        resolution: dto.resolution ?? null,
        durationSec: durationSec ?? null,
        // What the source actually measured, so finalize re-runs the estimate
        // against the same quantity the reserve was sized from.
        sourceDurationSec: measured.durationSec ?? null,
        sourceWidth: measured.width ?? null,
        sourceHeight: measured.height ?? null,
        generateAudio: dto.generateAudio ?? null,
        seed: dto.seed ?? null,
        referenceImageUrls: dto.referenceImageUrls ?? [],
        lastImageUrl: dto.lastImageUrl ?? null,
        videoUrl: dto.videoUrl ?? null,
        audioUrl: dto.audioUrl ?? null,
        maskUrl: dto.maskUrl ?? null,
        voice: dto.voice ?? null,
        language: dto.language ?? null,
        avatar: dto.avatar ?? null,
        campaignItemId: dto.campaignItemId ?? null,
      };
      asset = await this.prisma.generatedAsset.create({
        data: {
          workspaceId,
          type,
          status: 'QUEUED',
          // The vendor that will actually render it — a routed provider names
          // it per model; a single-vendor provider is its own name.
          provider: this.provider.resolveName?.(model) ?? this.provider.name,
          model,
          prompt: dto.prompt,
          negativePrompt: dto.negativePrompt ?? null,
          params,
          durationSec: durationSec ?? null,
          costCreditsReserved: estimate,
          costUsd: new Prisma.Decimal(estimateUsd),
          socialCampaignId: dto.socialCampaignId ?? null,
          createdById: dto.createdById,
        },
        select: { id: true },
      });

      if (engineBudget && estimateUsd > 0) {
        // Fail-closed pre-debit (real cash drawdown). An insufficient wallet
        // throws here — the catch below terminalizes the asset and refunds the
        // credit reservation; the wallet itself was never touched (atomic).
        await this.wallet.debit(workspaceId, {
          amount: estimateUsd,
          kind: 'ENGINE_SPEND',
          ref: `mediagen:${asset.id}`,
          note: `engine media generation ${model} (budget ${engineBudget.id})`,
        });
      }

      const { providerRequestId } = await this.provider.submit({
        type,
        model,
        prompt: dto.prompt,
        negativePrompt: dto.negativePrompt,
        aspectRatio: dto.aspectRatio,
        resolution: dto.resolution,
        durationSec,
        generateAudio: dto.generateAudio,
        sources,
        voice: dto.voice,
        language: dto.language,
        avatar: dto.avatar,
        seed: dto.seed,
        webhookUrl: this.webhookUrl(),
      });
      await this.prisma.generatedAsset.update({
        where: { id: asset.id },
        data: { status: 'GENERATING', providerRequestId },
      });
      await this.scheduledJobs.schedule({
        workspaceId,
        kind: MEDIA_GEN_POLL_KIND,
        runAt: new Date(Date.now() + POLL_DELAY_MS),
        payload: { assetId: asset.id, workspaceId },
        dedupKey: `media-gen-${asset.id}`,
        maxAttempts: 30,
      });
    } catch (e: any) {
      if (asset) {
        // Terminalize + refund via the SAME conditional-claim path the poll/
        // webhook failures use (failTerminal), so the reservation is refunded
        // EXACTLY once. The old code refunded UNCONDITIONALLY then best-effort set
        // FAILED; if that update was swallowed (or the worker crashed between the
        // two), the row stayed QUEUED and the orphan sweep later reaped it and
        // refunded the SAME reservation a second time — over-crediting the meter.
        // params carries the engine hint so a wallet pre-debit is refunded too.
        await this.failTerminal(
          { id: asset.id, workspaceId, params: { campaignItemId: dto.campaignItemId ?? null } },
          String(e?.message ?? e).slice(0, 500), estimate,
        );
      } else {
        // create() itself threw — the reservation exists but no asset row does,
        // so the sweep can't reap it; refund directly (no double-refund possible).
        await this.credits.refund(workspaceId, estimate);
      }
      throw e;
    }

    return { assetId: asset.id };
  }

  async pollGeneration(assetId: string, _workspaceId: string): Promise<void | JobRescheduleDirective> {
    const asset = await this.prisma.generatedAsset.findUnique({
      where: { id: assetId },
      select: { status: true, model: true, providerRequestId: true, createdAt: true, workspaceId: true, costCreditsReserved: true, params: true },
    });
    if (!asset || isTerminalAssetStatus(asset.status) || !asset.providerRequestId) return;
    // Bound the polling loop: the runner resets attempts=0 on every reschedule, so
    // maxAttempts never terminates an IN_PROGRESS (or repeatedly-throwing) job. A
    // generation older than MAX_GEN_AGE is abandoned → fail + refund so the
    // reservation is released and the inflight slot freed. (Checked before
    // getResult so a throwing status endpoint is bounded too.)
    if (Date.now() - asset.createdAt.getTime() > MAX_GEN_AGE_MS) {
      await this.failTerminal(
        { id: assetId, workspaceId: asset.workspaceId, params: asset.params },
        'generation timed out', asset.costCreditsReserved ?? 0,
      );
      return;
    }
    const result = await this.provider.getResult(asset.providerRequestId, asset.model);
    if (result.status === 'IN_QUEUE' || result.status === 'IN_PROGRESS') {
      return { reschedule: { runAt: new Date(Date.now() + POLL_RETRY_MS) } };
    }
    await this.finalizeAsset(assetId, result);
  }

  async finalizeAsset(assetId: string, result: MediaGenResult): Promise<void> {
    const asset = await this.prisma.generatedAsset.findUnique({ where: { id: assetId } });
    if (!asset || isTerminalAssetStatus(asset.status)) return; // idempotent / terminal-safe
    const reserved = asset.costCreditsReserved ?? 0;

    if (result.status === 'COMPLETED') {
      const primary = (result.outputs ?? [])[0];
      if (!primary) return this.failTerminal(asset, 'provider returned no output', reserved);
      let stored: { url: string; key: string; mime: string };
      try {
        const dl = await this.download(primary.url);
        stored = await this.r2.upload(asset.workspaceId, {
          originalname: `${assetId}`, mimetype: primary.mime, buffer: dl.buffer, size: dl.size,
        });
      } catch (e: any) {
        // Download/upload failed. Terminalize + refund rather than letting it throw
        // and retry forever — an un-terminalized asset leaks its reservation and
        // permanently pins a MAX_INFLIGHT slot (sweepOrphanAssets only reaps READY).
        return this.failTerminal(asset, `finalize failed: ${String(e?.message ?? e)}`.slice(0, 500), reserved);
      }
      // What fal says it actually rendered outranks what was requested. This is
      // the whole settlement for a `returnsDuration` model like the Kling
      // avatar, whose length follows its AUDIO and cannot be requested at all:
      // the reserve rode the service's default, and this is where a 60-second
      // read stops being priced as a 5-second one. Where the model HAS no
      // duration in the response there is nothing to true up to, and the
      // requested (wire-encoded) length — which is what fal rendered and
      // billed — stands.
      const rendered = primary.durationSec;
      const trueUp = estimateOptsFrom(asset.params, rendered ?? asset.durationSec, asset.prompt);
      const actual = estimateMediaCredits(asset.model, trueUp);
      // What the generation cost US, at the vendor that actually rendered it.
      // Runware reports its own figure per task; fal never does, so the
      // catalogue's fal rate stands there. The credit meter above is untouched
      // by this: the customer's price is the catalogue's, whichever vendor ran.
      const vendor: MediaVendor = asset.provider === 'runware' ? 'runware' : 'fal';
      const vendorUsd = result.costUsd ?? estimateVendorUsd(asset.model, trueUp, vendor);
      const claim = await this.prisma.generatedAsset.updateMany({
        where: { id: assetId, status: { notIn: TERMINAL } },
        data: {
          status: 'READY', url: stored.url, r2Key: stored.key, mime: stored.mime,
          // What the provider reports beats what was requested on every field
          // the row carries — these are what the library later shows.
          width: primary.width ?? null,
          height: primary.height ?? null,
          durationSec: rendered ?? asset.durationSec ?? null,
          costCredits: actual, costUsd: new Prisma.Decimal(vendorUsd), error: null,
        },
      });
      if (claim.count === 1) {
        await this.reconcile(asset.workspaceId, reserved, actual);
        // The credit meter is trued up to the provider's ACTUAL duration above,
        // so the real-cash wallet pre-debit (charged on the REQUESTED duration)
        // must be too — else a 10s request that returns a 4s clip refunds the
        // credit delta but keeps the wallet overcharged for capacity never used.
        // At the CATALOGUE rate, deliberately: the customer-facing charge is the
        // catalogue's on both meters, whichever vendor rendered. The vendor's
        // own figure is bookkeeping (costUsd above, the ledger below) — a
        // cheaper vendor is margin, not a customer refund (design §2.3).
        await this.reconcileEngineWallet(asset.workspaceId, assetId, asset.params, estimateMediaUsd(asset.model, trueUp));
        // Record the vendor cost on the SAME trued-up figure. This is the
        // vendor-cost ledger, not the customer's credit meter above: every other
        // vendor lands there and fal never did, so the spend report read 0 for
        // it while the invoices were real.
        await this.mediaSpend.settle(asset.workspaceId, { assetId, credits: actual, vendor, vendorUsd });
      } else {
        // Lost the finalize race (webhook + poll both completed the same asset):
        // the winner already stored its own object, so delete ours to avoid an
        // orphaned R2 file the sweep can never reclaim (it only knows row r2Keys).
        await this.r2.deleteKeys([stored.key]).catch(() => undefined);
      }
      return;
    }

    const status = result.status === 'BLOCKED' ? 'BLOCKED' : 'FAILED';
    const claim = await this.prisma.generatedAsset.updateMany({
      where: { id: assetId, status: { notIn: TERMINAL } },
      data: { status, error: result.error ?? null },
    });
    if (claim.count === 1) {
      await this.credits.refund(asset.workspaceId, reserved);
      await this.refundEngineWalletDebit(asset.workspaceId, assetId, asset.params);
    }
  }

  private async failTerminal(
    asset: { id: string; workspaceId: string; params?: unknown },
    error: string,
    reserved: number,
  ): Promise<void> {
    const claim = await this.prisma.generatedAsset.updateMany({
      where: { id: asset.id, status: { notIn: TERMINAL } },
      data: { status: 'FAILED', error },
    });
    if (claim.count === 1) {
      await this.credits.refund(asset.workspaceId, reserved);
      await this.refundEngineWalletDebit(asset.workspaceId, asset.id, asset.params);
    }
  }

  /**
   * Growth Autopilot D4: resolve the budget that makes an engine generation
   * wallet-funded — the workspace's CURRENT-period, ACTIVE, armed-AUTONOMOUS
   * GrowthBudget. Only consulted when the env flag is armed; manual
   * generations never reach here.
   */
  private async resolveArmedBudget(workspaceId: string): Promise<{ id: string } | null> {
    if (!growthAutopilotAutonomyEnabled()) return null;
    return this.prisma.growthBudget.findFirst({
      where: {
        workspaceId,
        periodKey: new Date().toISOString().slice(0, 7),
        status: 'ACTIVE',
        autonomyLevel: 'AUTONOMOUS',
      },
      select: { id: true },
    });
  }

  /**
   * Refund an engine generation's wallet pre-debit (D4). Looks up the actual
   * debit under its deterministic ref — if the debit never landed (fail-closed
   * rejection) there is nothing to refund, and a cross-workspace ledger row is
   * never honored. The refund credit is itself ref-idempotent
   * (mediagen-refund:{assetId}), so double-invocation cannot double-credit.
   * Deliberately NOT flag-gated: a debit that was taken while armed must be
   * refundable even after the flag is turned off.
   */
  private async refundEngineWalletDebit(workspaceId: string, assetId: string, params: unknown): Promise<void> {
    if (!isEngineAsset(params)) return;
    try {
      const entry = await this.prisma.growthWalletLedgerEntry.findUnique({
        where: { ref: `mediagen:${assetId}` },
        select: { workspaceId: true, delta: true },
      });
      if (!entry || entry.workspaceId !== workspaceId) return;
      const debited = new Prisma.Decimal(entry.delta).negated();
      if (debited.lte(0)) return;
      await this.wallet.credit(workspaceId, {
        amount: debited,
        kind: 'REFUND',
        ref: `mediagen-refund:${assetId}`,
        note: 'engine media generation refund',
      });
    } catch (e) {
      // Best-effort: a refund failure must not mask the terminalization; the
      // ledger ref stays claimable by a later retry of the same terminal path.
      this.logger.warn(`engine wallet refund failed for asset ${assetId}: ${String((e as Error)?.message ?? e)}`);
    }
  }

  /**
   * True up an engine generation's real-cash wallet pre-debit to the ACTUAL
   * output (D4). The debit was taken on the REQUESTED duration; when the
   * provider returns a shorter clip, credit the unused USD back. Mirrors
   * refundEngineWalletDebit's ledger lookup + ref-idempotency, but for the
   * partial estimate-vs-actual delta on a SUCCESS (that method only fires on a
   * terminal failure). Only credits a positive diff (actual can never exceed the
   * requested, capped duration), and is a no-op for non-engine / undebited rows.
   */
  private async reconcileEngineWallet(
    workspaceId: string,
    assetId: string,
    params: unknown,
    actualUsd: number,
  ): Promise<void> {
    if (!isEngineAsset(params) || !(actualUsd >= 0)) return;
    try {
      const entry = await this.prisma.growthWalletLedgerEntry.findUnique({
        where: { ref: `mediagen:${assetId}` },
        select: { workspaceId: true, delta: true },
      });
      if (!entry || entry.workspaceId !== workspaceId) return;
      const reservedUsd = new Prisma.Decimal(entry.delta).negated();
      // At the ledger's own precision: the two figures come from the same
      // per-second rate multiplied in floating point, and a 2e-16 remainder is
      // not a refund, it is a dust row.
      const refundUsd = reservedUsd.minus(new Prisma.Decimal(actualUsd)).toDecimalPlaces(4);
      if (refundUsd.lte(0)) return;
      await this.wallet.credit(workspaceId, {
        amount: refundUsd,
        kind: 'REFUND',
        ref: `mediagen-reconcile:${assetId}`, // ref-idempotent: never double-credits
        note: 'engine media generation partial refund (shorter than requested)',
      });
    } catch (e) {
      // Best-effort, like refundEngineWalletDebit — a reconcile hiccup must not
      // fail the already-committed finalize; the ref stays claimable on retry.
      this.logger.warn(`engine wallet reconcile failed for asset ${assetId}: ${String((e as Error)?.message ?? e)}`);
    }
  }

  private async reconcile(workspaceId: string, reserved: number, actual: number): Promise<void> {
    const diff = reserved - actual;
    if (diff > 0) await this.credits.refund(workspaceId, diff);
    // Overage: the asset is already delivered, so the extra cost MUST be metered
    // even at the cap. chargeOverage is an unconditional bump — reserve() would
    // throw AI_CREDITS_EXHAUSTED at the cap and leave the meter understated.
    else if (diff < 0) await this.credits.chargeOverage(workspaceId, -diff);
  }

  /** Download a provider result URL server-side (provider URLs expire).
   *  Guards SSRF (https-only, no internal hosts — the URL can originate from a
   *  webhook body), times out, and caps the body so a huge/slow response can't
   *  OOM or hang the single-replica scheduled-job worker. */
  private async download(url: string): Promise<{ buffer: Buffer; size: number }> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('invalid download url');
    }
    if (parsed.protocol !== 'https:') throw new Error(`unsupported download scheme: ${parsed.protocol}`);
    if (isBlockedDownloadHost(parsed.hostname)) throw new Error(`blocked download host: ${parsed.hostname}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`download failed (${res.status}) for ${url}`);
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared && declared > MAX_DOWNLOAD_BYTES) {
        throw new Error(`download too large: ${declared} bytes`);
      }
      const reader = res.body?.getReader();
      if (!reader) {
        const buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.length > MAX_DOWNLOAD_BYTES) throw new Error('download exceeded size cap');
        return { buffer, size: buffer.length };
      }
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_DOWNLOAD_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new Error(`download exceeded size cap (${MAX_DOWNLOAD_BYTES} bytes)`);
        }
        chunks.push(Buffer.from(value));
      }
      const buffer = Buffer.concat(chunks);
      return { buffer, size: buffer.length };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Remove READY-but-unattached assets older than the retention window
   *  (R2 objects first, then rows). Attached/campaign assets are exempt. */
  async sweepOrphanAssets(): Promise<{ deleted: number; reaped: number }> {
    const now = Date.now();

    // 1) Reap abandoned non-terminal generations (a lost webhook/poll, or a poll
    //    job that FAILED after exhausting maxAttempts): fail + refund so the
    //    reservation is released and the MAX_INFLIGHT slot freed. This is the
    //    backstop to the per-poll age check in pollGeneration.
    const stuckCutoff = new Date(now - MAX_GEN_AGE_MS);
    const stuck = await this.prisma.generatedAsset.findMany({
      where: { status: { in: ['QUEUED', 'GENERATING'] }, createdAt: { lt: stuckCutoff } },
      // `params` must ride along (audit B5): failTerminal needs it to see the
      // engine marker and refund the real-cash ENGINE_SPEND wallet pre-debit —
      // without it the reap kept the customer's money on every abandoned
      // engine generation.
      select: { id: true, workspaceId: true, costCreditsReserved: true, params: true },
    });
    for (const s of stuck) {
      await this.failTerminal(
        { id: s.id, workspaceId: s.workspaceId, params: s.params },
        'generation abandoned (timeout sweep)', s.costCreditsReserved ?? 0,
      );
    }

    // 2) Delete READY-but-unattached assets past the retention window (R2 objects
    //    first, then rows). Attached/campaign assets are exempt.
    const cutoff = new Date(now - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const rows = await this.prisma.generatedAsset.findMany({
      where: { status: 'READY', socialCampaignId: null, createdAt: { lt: cutoff } },
      select: { id: true, r2Key: true, thumbnailR2Key: true },
    });
    if (!rows.length) return { deleted: 0, reaped: stuck.length };
    const keys = rows.flatMap((r) => [r.r2Key, r.thumbnailR2Key].filter(Boolean) as string[]);
    await this.r2.deleteKeys(keys);
    await this.prisma.generatedAsset.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    return { deleted: rows.length, reaped: stuck.length };
  }

  listAssets(workspaceId: string, filter: { type?: string; status?: string; socialCampaignId?: string } = {}) {
    return this.prisma.generatedAsset.findMany({
      where: {
        workspaceId,
        ...(filter.type ? { type: filter.type } : {}),
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.socialCampaignId ? { socialCampaignId: filter.socialCampaignId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async getAsset(workspaceId: string, id: string) {
    const a = await this.prisma.generatedAsset.findFirst({ where: { id, workspaceId } });
    if (!a) throw new NotFoundException('asset not found');
    return a;
  }

  async regenerate(workspaceId: string, id: string, createdById: string) {
    const a = await this.getAsset(workspaceId, id);
    const p = (a.params ?? {}) as any;
    // Rows written before the input contract existed stored whatever ratio the
    // old flat provider was handed — including ones the endpoint never published
    // (`fal-ai/qwen-image` takes none at all; Seedream v4 sizes through ImageSize
    // presets, which have no 4:5). Replaying such a value verbatim now trips the
    // pre-reserve contract check and 400s a re-run of the workspace's OWN
    // history. It was ignored on the wire when the asset was first made, so
    // dropping it reproduces the original generation rather than blocking it.
    //
    // Checked against the SUCCESSOR's contract where the row names an id fal
    // has retired: that is the model requestGeneration will resolve to and
    // enforce, and a ratio the old model published but the new one does not
    // (Lite's 4:5) would otherwise 400 the re-run of the workspace's own history.
    const aspect = getMediaModel(resolveMediaModelId(a.model))?.contract.aspect;
    const aspectRatio = p.aspectRatio && aspect?.values[p.aspectRatio] ? p.aspectRatio : undefined;
    return this.requestGeneration(workspaceId, {
      type: a.type as GeneratedAssetType,
      model: a.model,
      prompt: a.prompt,
      negativePrompt: a.negativePrompt ?? undefined,
      aspectRatio,
      resolution: p.resolution ?? undefined,
      durationSec: a.durationSec ?? undefined,
      // No source measurement is replayed: the re-run re-measures the same
      // source files server-side. Replaying the stored numbers would let a row
      // written when the quantity was still caller-supplied re-spend that
      // quantity forever, which is the one thing the measurement replaced.
      generateAudio: p.generateAudio ?? undefined,
      referenceImageUrls: p.referenceImageUrls ?? undefined,
      // Source media has to ride along too: a re-run of an edit/animate/lipsync
      // without it fails the contract check (and, before that check existed,
      // would have reached fal as an unsatisfiable request).
      lastImageUrl: p.lastImageUrl ?? undefined,
      videoUrl: p.videoUrl ?? undefined,
      audioUrl: p.audioUrl ?? undefined,
      maskUrl: p.maskUrl ?? undefined,
      voice: p.voice ?? undefined,
      language: p.language ?? undefined,
      avatar: p.avatar ?? undefined,
      seed: p.seed ?? undefined,
      createdById,
      socialCampaignId: a.socialCampaignId ?? undefined,
    });
  }

  async deleteAsset(workspaceId: string, id: string): Promise<{ deleted: boolean }> {
    const a = await this.getAsset(workspaceId, id);
    // Refund a still-running reservation before deleting, else the poll/webhook
    // (which resolve the row by id/providerRequestId → null after delete) can never
    // refund it. The updateMany claim keeps the refund idempotent against a
    // finalize that terminalizes the same asset concurrently.
    if (!isTerminalAssetStatus(a.status)) {
      const claim = await this.prisma.generatedAsset.updateMany({
        where: { id, status: { notIn: TERMINAL } },
        data: { status: 'FAILED', error: 'deleted by user' },
      });
      if (claim.count === 1) {
        await this.credits.refund(workspaceId, a.costCreditsReserved ?? 0);
        await this.refundEngineWalletDebit(workspaceId, id, (a as { params?: unknown }).params);
      }
    }
    // Delete the row FIRST and read the R2 keys off the DELETED record, not the
    // pre-claim snapshot `a`: if a concurrent finalize stored an object and set
    // r2Key AFTER getAsset read it (a.r2Key still null), deleting the stale keys
    // would miss the freshly-stored blob and orphan it forever (the sweep only
    // knows surviving rows). delete() returns the row's CURRENT keys atomically.
    const deleted = await this.prisma.generatedAsset.delete({ where: { id } });
    await this.r2
      .deleteKeys([deleted.r2Key, deleted.thumbnailR2Key].filter(Boolean) as string[])
      .catch(() => undefined);
    return { deleted: true };
  }

  /** Webhook idempotency: resolve the asset by providerRequestId, then finalize. */
  async finalizeByRequestId(providerRequestId: string, result: MediaGenResult): Promise<void> {
    const a = await this.prisma.generatedAsset.findFirst({ where: { providerRequestId }, select: { id: true } });
    if (!a) return; // unknown/duplicate request → ignore
    await this.finalizeAsset(a.id, result);
  }

  private webhookUrl(): string | undefined {
    const base = process.env.PUBLIC_BASE_URL;
    const secret = process.env.FAL_WEBHOOK_SECRET;
    if (!base || !secret) return undefined;
    // PUBLIC_BASE_URL is the bare origin; the API is served under the global
    // '/api' prefix (app.config setGlobalPrefix('api')).
    return `${base.replace(/\/+$/, '')}/api/marketing/ai/media/webhook?token=${encodeURIComponent(secret)}`;
  }
}
