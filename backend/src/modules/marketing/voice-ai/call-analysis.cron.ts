import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../../prisma/prisma.service';
import { withAdvisoryLock } from '../../../common/scheduling/advisory-lock';
import { AnthropicService } from '../ai/anthropic.service';
import { isSttConfigured } from './voice-ai.config';
import { CallAnalysisService } from './call-analysis.service';

/**
 * Voice-AI Phase 1 — post-call analysis sweep. Every 30 minutes, finds CONNECTED
 * SalesCalls that have a recording but no CallAnalysis yet (ended in the trailing
 * 7 days) and runs the analysis pipeline on each. Single-replica via advisory
 * lock; best-effort per row (a failure is logged, never aborts the sweep).
 *
 * Inert until both STT (recordings → text) and Claude are configured — mirrors
 * the same inert-guard convention used by other Epic 13 sweeps.
 */
@Injectable()
export class CallAnalysisCron {
  private readonly logger = new Logger(CallAnalysisCron.name);
  /** Only analyze calls ended in the trailing window. */
  private static readonly WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
  private static readonly BATCH = 25;

  constructor(
    private readonly prisma: PrismaService,
    private readonly anthropic: AnthropicService,
    private readonly analysis: CallAnalysisService,
  ) {}

  @Cron(CronExpression.EVERY_30_MINUTES, { name: 'call-analysis-sweep' })
  async sweep(): Promise<void> {
    // Inert until recordings can be transcribed AND Claude can analyze them.
    if (!isSttConfigured() || !this.anthropic.isEnabled()) return;

    await withAdvisoryLock(
      this.prisma,
      'voice:call-analysis',
      async () => {
        const since = new Date(Date.now() - CallAnalysisCron.WINDOW_MS);
        // System-global read (a system job, like AdsPullService): CONNECTED
        // calls with a recording, ended in the window. Over-fetch a little so that
        // after excluding already-analyzed calls we can still fill a batch.
        const candidates = await this.prisma.salesCall.findMany({
          where: {
            status: 'CONNECTED',
            recordingUrl: { not: null },
            endedAt: { not: null, gte: since },
          },
          orderBy: { endedAt: 'desc' },
          take: CallAnalysisCron.BATCH,
          select: { id: true },
        });
        if (candidates.length === 0) return;

        // Relation-free exclusion: which of these calls are already analyzed?
        const ids = candidates.map((c) => c.id);
        const done = await this.prisma.callAnalysis.findMany({
          where: { salesCallId: { in: ids } },
          select: { salesCallId: true },
        });
        const doneSet = new Set(done.map((d) => d.salesCallId));
        const due = candidates.filter((c) => !doneSet.has(c.id));
        if (due.length === 0) return;

        let ok = 0;
        for (const call of due) {
          try {
            const r = await this.analysis.analyzeSalesCall(call.id);
            if (r.status === 'OK') ok++;
          } catch (e) {
            this.logger.error(`analysis failed for call ${call.id}: ${(e as Error)?.message ?? e}`);
          }
        }
        if (ok > 0) this.logger.log(`call-analysis sweep: analyzed ${ok}/${due.length} call(s)`);
      },
      this.logger,
    );
  }
}
