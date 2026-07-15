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
import { GrowthWalletService } from '../../wallet/growth-wallet.service';
import { growthAutopilotAutonomyEnabled } from '../../budget/growth-autonomy.flag';
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
    private readonly wallet: GrowthWalletService,
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
    const estimateUsd = estimateMediaUsd(model, durationSec);
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
        durationSec: durationSec ?? null,
        seed: dto.seed ?? null,
        referenceImageUrls: dto.referenceImageUrls ?? [],
        campaignItemId: dto.campaignItemId ?? null,
      };
      asset = await this.prisma.generatedAsset.create({
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
      if (claim.count === 1) {
        await this.reconcile(asset.workspaceId, reserved, actual);
        // The credit meter is trued up to the provider's ACTUAL duration above,
        // so the real-cash wallet pre-debit (charged on the REQUESTED duration)
        // must be too — else a 10s request that returns a 4s clip refunds the
        // credit delta but keeps the wallet overcharged for capacity never used.
        const actualUsd = estimateMediaUsd(asset.model, primary.durationSec ?? asset.durationSec ?? undefined);
        await this.reconcileEngineWallet(asset.workspaceId, assetId, asset.params, actualUsd);
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
      const refundUsd = reservedUsd.minus(new Prisma.Decimal(actualUsd));
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
