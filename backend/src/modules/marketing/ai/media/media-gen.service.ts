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
import { R2StorageService } from '../../social-planner/r2-storage.service';
import {
  MediaProvider, MEDIA_PROVIDER, MediaGenResult,
} from '../providers/media-provider.interface';
import {
  DEFAULT_IMAGE_MODEL, DEFAULT_VIDEO_MODEL, estimateMediaCredits, estimateMediaUsd, getMediaModel,
} from './media-models.config';
import { TERMINAL_ASSET_STATUSES, isTerminalAssetStatus } from './media-asset.constants';

export const MEDIA_GEN_POLL_KIND = 'social.media.generate.poll';
export const MEDIA_GEN_CLEANUP_KIND = 'social.media.cleanup.orphans';

const MAX_INFLIGHT = Number(process.env.MEDIA_GEN_MAX_INFLIGHT ?? 4);
const MAX_VIDEO_SEC = Number(process.env.MEDIA_GEN_MAX_VIDEO_SEC ?? 10);
const POLL_DELAY_MS = 20_000;
const POLL_RETRY_MS = 30_000;
const RETENTION_DAYS = Number(process.env.MEDIA_GEN_RETENTION_DAYS ?? 30);
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TERMINAL = [...TERMINAL_ASSET_STATUSES]; // ['READY','FAILED','BLOCKED']

export interface RequestGenerationDto {
  type: 'IMAGE' | 'VIDEO';
  model?: string;
  prompt: string;
  negativePrompt?: string;
  aspectRatio?: string;
  durationSec?: number;
  referenceImageUrls?: string[];
  seed?: number;
  createdById: string;
  socialCampaignId?: string;
  campaignItemId?: string;
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
  ) {}

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

  async requestGeneration(workspaceId: string, dto: RequestGenerationDto): Promise<{ assetId: string }> {
    if (!this.provider.isConfigured()) {
      throw new ServiceUnavailableException({ code: 'MEDIA_GEN_NOT_CONFIGURED', message: 'Media generation is not configured' });
    }

    // Only catalogued models (known pricing) may be requested — an arbitrary
    // model id would be billed at the cheap fallback estimate while the provider
    // charges the real (possibly far higher) rate.
    if (dto.model && !getMediaModel(dto.model)) {
      throw new BadRequestException({ code: 'MEDIA_GEN_UNKNOWN_MODEL', message: `Unknown media model: ${dto.model}` });
    }

    const inflight = await this.prisma.generatedAsset.count({
      where: { workspaceId, status: { in: ['QUEUED', 'GENERATING'] } },
    });
    if (inflight >= MAX_INFLIGHT) {
      throw new BadRequestException({ code: 'MEDIA_GEN_TOO_MANY', message: `Too many running generations (max ${MAX_INFLIGHT})` });
    }

    const model = dto.model ?? (dto.type === 'VIDEO' ? DEFAULT_VIDEO_MODEL : DEFAULT_IMAGE_MODEL);
    const durationSec = dto.type === 'VIDEO' ? Math.min(dto.durationSec ?? 5, MAX_VIDEO_SEC) : undefined;
    const estimate = estimateMediaCredits(model, durationSec);

    await this.credits.reserve(workspaceId, estimate);

    const params: Prisma.InputJsonValue = {
      aspectRatio: dto.aspectRatio ?? null,
      durationSec: durationSec ?? null,
      seed: dto.seed ?? null,
      referenceImageUrls: dto.referenceImageUrls ?? [],
      campaignItemId: dto.campaignItemId ?? null,
    };
    const asset = await this.prisma.generatedAsset.create({
      data: {
        workspaceId,
        type: dto.type,
        status: 'QUEUED',
        provider: this.provider.name,
        model,
        prompt: dto.prompt,
        negativePrompt: dto.negativePrompt ?? null,
        params,
        durationSec: durationSec ?? null,
        costCreditsReserved: estimate,
        costUsd: new Prisma.Decimal(estimateMediaUsd(model, durationSec)),
        socialCampaignId: dto.socialCampaignId ?? null,
        createdById: dto.createdById,
      },
      select: { id: true },
    });

    try {
      const { providerRequestId } = await this.provider.submit({
        type: dto.type,
        model,
        prompt: dto.prompt,
        negativePrompt: dto.negativePrompt,
        aspectRatio: dto.aspectRatio,
        durationSec,
        referenceImageUrls: dto.referenceImageUrls,
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
      await this.credits.refund(workspaceId, estimate);
      await this.prisma.generatedAsset.update({
        where: { id: asset.id },
        data: { status: 'FAILED', error: String(e?.message ?? e) },
      });
      throw e;
    }

    return { assetId: asset.id };
  }

  async pollGeneration(assetId: string, _workspaceId: string): Promise<void | JobRescheduleDirective> {
    const asset = await this.prisma.generatedAsset.findUnique({
      where: { id: assetId },
      select: { status: true, model: true, providerRequestId: true },
    });
    if (!asset || isTerminalAssetStatus(asset.status) || !asset.providerRequestId) return;
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
      const dl = await this.download(primary.url);
      const stored = await this.r2.upload(asset.workspaceId, {
        originalname: `${assetId}`, mimetype: primary.mime, buffer: dl.buffer, size: dl.size,
      });
      const actual = estimateMediaCredits(asset.model, primary.durationSec ?? asset.durationSec ?? undefined);
      const claim = await this.prisma.generatedAsset.updateMany({
        where: { id: assetId, status: { notIn: TERMINAL } },
        data: {
          status: 'READY', url: stored.url, r2Key: stored.key, mime: stored.mime,
          width: primary.width ?? null, height: primary.height ?? null,
          durationSec: primary.durationSec ?? asset.durationSec ?? null,
          costCredits: actual, error: null,
        },
      });
      if (claim.count === 1) await this.reconcile(asset.workspaceId, reserved, actual);
      return;
    }

    const status = result.status === 'BLOCKED' ? 'BLOCKED' : 'FAILED';
    const claim = await this.prisma.generatedAsset.updateMany({
      where: { id: assetId, status: { notIn: TERMINAL } },
      data: { status, error: result.error ?? null },
    });
    if (claim.count === 1) await this.credits.refund(asset.workspaceId, reserved);
  }

  private async failTerminal(asset: { id: string; workspaceId: string }, error: string, reserved: number): Promise<void> {
    const claim = await this.prisma.generatedAsset.updateMany({
      where: { id: asset.id, status: { notIn: TERMINAL } },
      data: { status: 'FAILED', error },
    });
    if (claim.count === 1) await this.credits.refund(asset.workspaceId, reserved);
  }

  private async reconcile(workspaceId: string, reserved: number, actual: number): Promise<void> {
    const diff = reserved - actual;
    if (diff > 0) await this.credits.refund(workspaceId, diff);
    else if (diff < 0) await this.credits.reserve(workspaceId, -diff).catch((e) =>
      this.logger.warn(`reconcile top-up failed for ${workspaceId}: ${e?.message ?? e}`));
  }

  /** Download a provider result URL server-side (provider URLs expire). */
  private async download(url: string): Promise<{ buffer: Buffer; size: number }> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed (${res.status}) for ${url}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, size: buffer.length };
  }

  /** Remove READY-but-unattached assets older than the retention window
   *  (R2 objects first, then rows). Attached/campaign assets are exempt. */
  async sweepOrphanAssets(): Promise<{ deleted: number }> {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const rows = await this.prisma.generatedAsset.findMany({
      where: { status: 'READY', socialCampaignId: null, createdAt: { lt: cutoff } },
      select: { id: true, r2Key: true, thumbnailR2Key: true },
    });
    if (!rows.length) return { deleted: 0 };
    const keys = rows.flatMap((r) => [r.r2Key, r.thumbnailR2Key].filter(Boolean) as string[]);
    await this.r2.deleteKeys(keys);
    await this.prisma.generatedAsset.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    return { deleted: rows.length };
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
    return this.requestGeneration(workspaceId, {
      type: a.type as 'IMAGE' | 'VIDEO',
      model: a.model,
      prompt: a.prompt,
      negativePrompt: a.negativePrompt ?? undefined,
      aspectRatio: p.aspectRatio ?? undefined,
      durationSec: a.durationSec ?? undefined,
      referenceImageUrls: p.referenceImageUrls ?? undefined,
      seed: p.seed ?? undefined,
      createdById,
      socialCampaignId: a.socialCampaignId ?? undefined,
    });
  }

  async deleteAsset(workspaceId: string, id: string): Promise<{ deleted: boolean }> {
    const a = await this.getAsset(workspaceId, id);
    await this.r2.deleteKeys([a.r2Key, a.thumbnailR2Key].filter(Boolean) as string[]);
    await this.prisma.generatedAsset.delete({ where: { id } });
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
