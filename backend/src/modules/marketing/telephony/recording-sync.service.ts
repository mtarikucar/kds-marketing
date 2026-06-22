import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../../prisma/prisma.service';
import { withAdvisoryLock } from '../../../common/scheduling/advisory-lock';
import { NetsantralClient } from './netsantral.client';
import { TelephonyConfigService } from './telephony-config.service';

/**
 * Hourly call-recording retrieval sweep (Epic 13, needs-external — INERT until
 * NetGSM exposes a recording/CDR download API, enabled via NETGSM_RECORDING_BASE_URL).
 *
 * Mirrors AdsPullService: a single-replica advisory lock guards the tick. The
 * DUE-ROW query is the one legitimately cross-workspace read (a system job) —
 * whitelisted in the workspace-scoping fitness test; the per-call write is an
 * id-keyed update. Each call is processed best-effort (a failure stamps
 * `recordingUrl` only on success and never aborts the loop). Inert by default:
 * the sweep early-returns until the recording endpoint env is set.
 */
@Injectable()
export class RecordingSyncService {
  private readonly logger = new Logger(RecordingSyncService.name);
  private static readonly BATCH = 200;
  /** Only chase recordings for calls ended in the trailing window. */
  private static readonly WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
  /** Re-check an already-tried call at most this often (recordings appear late). */
  private static readonly RECHECK_MS = 6 * 60 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: NetsantralClient,
    private readonly telephonyConfig: TelephonyConfigService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'recordings-sync' })
  async pullDueRecordings(): Promise<void> {
    if (!NetsantralClient.recordingEnabled()) return; // no recording endpoint → inert
    await withAdvisoryLock(
      this.prisma,
      'recordings:sync',
      async () => {
        const now = Date.now();
        const since = new Date(now - RecordingSyncService.WINDOW_MS);
        const recheckBefore = new Date(now - RecordingSyncService.RECHECK_MS);
        // System-global read: CONNECTED api-dial calls (only these can have a
        // recording) with no recording yet, ended in the window, across ALL
        // workspaces (whitelisted in the scoping test). The recordingCheckedAt
        // watermark + nulls-first ordering pushes a tried call to the BACK so a
        // dead/never-recorded call can't wedge the front of the queue.
        const due = await this.prisma.salesCall.findMany({
          where: {
            providerId: 'netgsm-netsantral',
            status: 'CONNECTED',
            externalCallId: { not: null },
            recordingUrl: null,
            endedAt: { not: null, gte: since },
            OR: [{ recordingCheckedAt: null }, { recordingCheckedAt: { lt: recheckBefore } }],
          },
          orderBy: { recordingCheckedAt: { sort: 'asc', nulls: 'first' } },
          take: RecordingSyncService.BATCH,
          select: { id: true, workspaceId: true, externalCallId: true },
        });
        if (due.length === 0) return;

        // Per-workspace creds are resolved once and reused across that ws's calls.
        const credsByWs = new Map<string, { username: string; password: string } | null>();
        let stamped = 0;
        for (const call of due) {
          let url: string | null = null;
          try {
            if (!credsByWs.has(call.workspaceId)) {
              const resolved = await this.telephonyConfig.resolveForWorkspace(call.workspaceId);
              credsByWs.set(call.workspaceId, resolved ? { username: resolved.username, password: resolved.password } : null);
            }
            const creds = credsByWs.get(call.workspaceId) ?? undefined;
            url = await this.client.fetchRecordingUrl(call.externalCallId!, creds);
          } catch (e) {
            this.logger.error(`recording fetch failed for call ${call.id}: ${(e as Error)?.message ?? e}`);
          }
          // ALWAYS stamp the watermark (success, no-recording, or error) so this
          // call leaves the front of the queue and the sweep keeps making progress.
          try {
            await this.prisma.salesCall.update({
              where: { id: call.id },
              data: { recordingCheckedAt: new Date(), ...(url ? { recordingUrl: url } : {}) },
            });
            if (url) stamped++;
          } catch (e) {
            this.logger.error(`recording watermark write failed for call ${call.id}: ${(e as Error)?.message ?? e}`);
          }
        }
        if (stamped > 0) this.logger.log(`recordings sweep: stamped ${stamped}/${due.length} call(s)`);
      },
      this.logger,
    );
  }
}
