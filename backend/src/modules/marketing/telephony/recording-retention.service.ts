import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../../prisma/prisma.service';
import { withAdvisoryLock } from '../../../common/scheduling/advisory-lock';
import { R2StorageService } from '../../../common/storage/r2-storage.service';

/**
 * NetGSM Phase 4 Task 2 — daily retention sweep for ingested call recordings.
 *
 * For each workspace with `TelephonyConfig.recordingRetentionDays` set,
 * deletes the R2 object (best-effort — `R2StorageService.deleteKeys` never
 * throws) and nulls BOTH `SalesCall.recordingStorageKey` AND `recordingUrl`
 * for any call whose `endedAt` is older than that many days. The `SalesCall`
 * row itself is otherwise left untouched — only the recording (stored copy +
 * provider link) is reclaimed.
 *
 * Final-review HIGH-1 fix — `recordingUrl` MUST be nulled in the same
 * `updateMany` as `recordingStorageKey`, not left in place: `RecordingIngestService`'s
 * DUE query matches `status: CONNECTED, recordingUrl NOT NULL,
 * recordingStorageKey NULL`, which is EXACTLY the row shape this sweep
 * produces if `recordingUrl` survives the purge — the very next ingest tick
 * re-downloads (from a link that's long-expired by retention time anyway,
 * per the reasoning that used to justify keeping it) and re-uploads the
 * "deleted" recording, silently defeating retention forever. Nulling
 * `recordingUrl` here closes that loop (the ingest DUE query's own `NOT NULL`
 * requirement then excludes the purged row) and correctly flips the
 * CallsPage "has recording" affordance off for a call whose recording no
 * longer exists anywhere.
 *
 * Workspaces with `recordingRetentionDays: null` are skipped entirely
 * (explicit "keep forever").
 */
@Injectable()
export class RecordingRetentionService {
  private readonly logger = new Logger(RecordingRetentionService.name);

  /** Rows reclaimed per DB round-trip. */
  private static readonly BATCH = 200;
  /** Safety cap on round-trips per workspace per tick (BATCH × this = max
   *  reclaimed/workspace/tick) so one busy tenant can't monopolise the sweep. */
  private static readonly MAX_BATCHES_PER_TICK = 50;

  constructor(
    private readonly prisma: PrismaService,
    private readonly r2: R2StorageService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_4AM, { name: 'recording-retention' })
  async retainDue(): Promise<void> {
    await withAdvisoryLock(
      this.prisma,
      'recording-retention',
      async () => {
        await this.retain();
      },
      this.logger,
    );
  }

  async retain(): Promise<{ deleted: number }> {
    const configs = await this.prisma.telephonyConfig.findMany({
      where: { recordingRetentionDays: { not: null } },
      select: { workspaceId: true, recordingRetentionDays: true },
    });
    if (configs.length === 0) return { deleted: 0 };

    let deleted = 0;
    for (const cfg of configs) {
      try {
        deleted += await this.retainWorkspace(cfg.workspaceId, cfg.recordingRetentionDays as number);
      } catch (e: any) {
        this.logger.warn(`recording retention failed for ws ${cfg.workspaceId}: ${e?.message ?? e}`);
      }
    }
    if (deleted > 0) this.logger.log(`recording-retention: reclaimed ${deleted} recording(s)`);
    return { deleted };
  }

  private async retainWorkspace(workspaceId: string, retentionDays: number): Promise<number> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 3_600_000);
    let total = 0;
    // DRAIN the past-retention backlog across up to MAX_BATCHES_PER_TICK batches,
    // not a single 200-row batch per day. A busy tenant ingests far more than 200
    // recordings/day (ingest runs every 10 min), so a one-batch/day sweep can never
    // catch up — audio would linger in R2 past the operator's recordingRetentionDays
    // (ongoing cost + a KVKK retention breach). Each iteration RE-QUERIES, so newly
    // aged rows and the ones just nulled are handled correctly; the per-tick cap
    // keeps one workspace from monopolising the sweep.
    for (let i = 0; i < RecordingRetentionService.MAX_BATCHES_PER_TICK; i++) {
      const calls = await this.prisma.salesCall.findMany({
        where: {
          workspaceId,
          recordingStorageKey: { not: null },
          endedAt: { not: null, lt: cutoff },
        },
        select: { id: true, recordingStorageKey: true },
        take: RecordingRetentionService.BATCH,
      });
      if (calls.length === 0) break;

      const keys = calls.map((c) => c.recordingStorageKey).filter(Boolean) as string[];
      await this.r2.deleteKeys(keys);

      // HIGH-1 fix: null recordingUrl in the SAME updateMany as
      // recordingStorageKey — see the class docstring for why leaving
      // recordingUrl set would let recording-ingest's DUE query re-select and
      // re-download this just-purged call within minutes.
      const res = await this.prisma.salesCall.updateMany({
        where: { id: { in: calls.map((c) => c.id) }, workspaceId },
        data: { recordingStorageKey: null, recordingUrl: null },
      });
      total += res.count;
      if (calls.length < RecordingRetentionService.BATCH) break;
    }
    return total;
  }
}
