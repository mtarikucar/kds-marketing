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
 * throws) and nulls `SalesCall.recordingStorageKey` for any call whose
 * `endedAt` is older than that many days. The `SalesCall` row itself and its
 * `recordingUrl` (the provider fallback, which is likely long-expired by
 * retention time anyway) are left untouched — only the stored copy is
 * reclaimed. Workspaces with `recordingRetentionDays: null` are skipped
 * entirely (explicit "keep forever").
 */
@Injectable()
export class RecordingRetentionService {
  private readonly logger = new Logger(RecordingRetentionService.name);

  /** Bounded per workspace per tick. */
  private static readonly BATCH = 200;

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
    const calls = await this.prisma.salesCall.findMany({
      where: {
        workspaceId,
        recordingStorageKey: { not: null },
        endedAt: { not: null, lt: cutoff },
      },
      select: { id: true, recordingStorageKey: true },
      take: RecordingRetentionService.BATCH,
    });
    if (calls.length === 0) return 0;

    const keys = calls.map((c) => c.recordingStorageKey).filter(Boolean) as string[];
    await this.r2.deleteKeys(keys);

    const res = await this.prisma.salesCall.updateMany({
      where: { id: { in: calls.map((c) => c.id) }, workspaceId },
      data: { recordingStorageKey: null },
    });
    return res.count;
  }
}
