import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { withAdvisoryLock } from '../../../common/scheduling/advisory-lock';
import { R2StorageService } from '../../../common/storage/r2-storage.service';
import { safeFetch } from '../../../common/util/safe-fetch';

interface DueCall {
  id: string;
  workspaceId: string;
  recordingUrl: string;
}

/**
 * NetGSM Phase 4 Task 2 — proxy-downloads a CONNECTED call's provider
 * recording into R2 (stable, retention-managed storage) rather than depending
 * on the NetGSM tokenized-URL's longevity.
 *
 * Mirrors the deleted Epic-13 `RecordingSyncService` (removed in Phase 0 —
 * superseded by the webhook/CDR `recordingUrl` fields, see commit
 * c01b44a) for its advisory-locked sweep + `recordingCheckedAt` watermark
 * discipline: a CONNECTED call with `recordingUrl` set but no
 * `recordingStorageKey` yet is DUE; every processed call gets the watermark
 * stamped (success, no-op, or failure) so it leaves the front of the
 * nulls-first queue and the sweep always makes progress, never wedging on a
 * dead row. `recordingUrl` is always kept as the provider fallback.
 *
 * Gating (checked BEFORE any DB read of due calls, so the sweep is a total
 * no-op when off):
 *  - R2 not configured → the whole sweep is inert (global, env-driven).
 *  - A workspace's `TelephonyConfig.recordCalls` is off → that workspace's
 *    calls are excluded from the DUE set entirely (no watermark burn; they
 *    simply re-enter the set the moment recording is turned on).
 *
 * `recordingUrl` is a NetGSM tokenized bearer link — treated as a secret.
 * It is NEVER logged (not even on a fetch failure); only `call.id` and an
 * HTTP status/error message identify a failure in logs.
 */
@Injectable()
export class RecordingIngestService {
  private readonly logger = new Logger(RecordingIngestService.name);

  /** Bounded per tick — download+upload is heavier than a poll/report call. */
  private static readonly BATCH = 50;
  /** Re-check an already-tried call at most this often (recording may land late,
   *  or a transient download/upload failure deserves a retry — not a permanent skip). */
  private static readonly RECHECK_MS = 6 * 60 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly r2: R2StorageService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'recording-ingest' })
  async ingestDue(): Promise<void> {
    await withAdvisoryLock(
      this.prisma,
      'recording-ingest',
      async () => {
        await this.ingest();
      },
      this.logger,
    );
  }

  async ingest(): Promise<{ processed: number; ingested: number }> {
    if (!this.r2.isConfigured()) return { processed: 0, ingested: 0 }; // inert — no DB read at all

    // Batch-resolve which workspaces currently have recording ON (a plain,
    // un-decrypted read — recordCalls needs no secret access) rather than a
    // per-call resolve, so one query gates the whole tick regardless of how
    // many due calls span however many workspaces.
    const recordingWorkspaces = await this.prisma.telephonyConfig.findMany({
      where: { recordCalls: true },
      select: { workspaceId: true },
    });
    if (recordingWorkspaces.length === 0) return { processed: 0, ingested: 0 };
    const workspaceIds = recordingWorkspaces.map((w) => w.workspaceId);

    const recheckBefore = new Date(Date.now() - RecordingIngestService.RECHECK_MS);
    const due = await this.prisma.salesCall.findMany({
      where: {
        workspaceId: { in: workspaceIds },
        status: 'CONNECTED',
        recordingUrl: { not: null },
        recordingStorageKey: null,
        OR: [{ recordingCheckedAt: null }, { recordingCheckedAt: { lt: recheckBefore } }],
      },
      orderBy: { recordingCheckedAt: { sort: 'asc', nulls: 'first' } },
      take: RecordingIngestService.BATCH,
      select: { id: true, workspaceId: true, recordingUrl: true },
    });
    if (due.length === 0) return { processed: 0, ingested: 0 };

    let ingested = 0;
    for (const call of due as DueCall[]) {
      let ok = false;
      try {
        ok = await this.ingestOne(call);
      } catch (e: any) {
        // Never let one call's failure abort the tick; never interpolate the
        // tokenized recordingUrl into the log line. safeFetch's URL-parse-error
        // branch can echo a truncated URL into e.message, so redact any
        // http(s) URL (which carries the bearer token) before logging.
        const safeMsg = String(e?.message ?? 'unknown error').replace(/https?:\/\/\S+/gi, '***');
        this.logger.warn(`recording ingest failed for call ${call.id}: ${safeMsg}`);
      }
      // ALWAYS stamp the watermark (success, no-recording-yet, or error) so
      // this call leaves the front of the queue and the sweep keeps progressing.
      try {
        await this.prisma.salesCall.update({
          where: { id: call.id },
          data: { recordingCheckedAt: new Date() },
        });
      } catch (e: any) {
        this.logger.warn(`recording watermark write failed for call ${call.id}: ${e?.message ?? e}`);
      }
      if (ok) ingested++;
    }
    if (ingested > 0) this.logger.log(`recording-ingest: ingested ${ingested}/${due.length} recording(s)`);
    return { processed: due.length, ingested };
  }

  /** Download + upload one call's recording; stamps recordingStorageKey on
   *  success. Returns true iff this call ended with a stored key (either it
   *  just ingested one, or another concurrent pass already did — idempotent). */
  private async ingestOne(call: DueCall): Promise<boolean> {
    // NetGSM's documented download shape: append `&tomp3` to the tokenized
    // recording URL to get an mp3 stream. Never log `downloadUrl` — it embeds
    // the same bearer token as `call.recordingUrl`.
    const downloadUrl = `${call.recordingUrl}&tomp3`;
    const res = await safeFetch(downloadUrl, { timeoutMs: 30_000 });
    if (!res.ok) {
      this.logger.warn(`recording download failed for call ${call.id}: HTTP ${res.status}`);
      return false;
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0) {
      this.logger.warn(`recording download empty for call ${call.id}`);
      return false;
    }

    // Final-review HIGH-2 fix: a RANDOM segment makes this key impossible to
    // derive from workspaceId+callId alone. Pre-fix, the key was
    // `netgsm-recordings/<ws>/<callId>.mp3` — fully deterministic — while the
    // tokened proxy URL the browser sees (`recording-proxy-token.util`'s
    // `recordingProxyUrl`) carries exactly `<ws>/<callId>` in its path. Since
    // the R2 bucket is public-read (see `R2StorageService`'s docstring —
    // shared with social-planner's Meta/TikTok pull-from-URL media), anyone
    // who captured a proxy URL could compute `<R2_PUBLIC_BASE>/<key>` and get
    // a permanent, no-TTL, no-auth link to the audio — bypassing both the
    // 5-minute token AND the REP-own-calls check in `SalesCallService.get`.
    // The random suffix closes that: the key is only ever known via
    // `SalesCall.recordingStorageKey`, read from the DB by
    // `RecordingProxyController` — never recomputed from ws+callId.
    const key = `netgsm-recordings/${call.workspaceId}/${call.id}-${randomUUID()}.mp3`;
    await this.r2.uploadToKey(key, { mimetype: 'audio/mpeg', buffer, size: buffer.length });

    // Guarded updateMany (recordingStorageKey: null) — idempotent: a second
    // concurrent/duplicate ingest attempt for the same call is a no-op here,
    // never double-stamps or clobbers an already-stored key.
    const stamped = await this.prisma.salesCall.updateMany({
      where: { id: call.id, workspaceId: call.workspaceId, recordingStorageKey: null },
      data: { recordingStorageKey: key },
    });
    return stamped.count > 0;
  }
}
