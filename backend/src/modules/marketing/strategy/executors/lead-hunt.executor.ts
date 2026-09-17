import { BadRequestException, ForbiddenException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { ResearchJobService } from '../../research/research-job.service';
import { ResearchWorkerService } from '../../research/research-worker.service';
import { ResearchRunnerService } from '../../research/research-runner.service';
import { jobPolicy } from '../../ai/ai-job-policy';
import { Executor, ExecutorResult, QUEUED_RESEARCH_REF } from '../strategy.types';

/** The executor-ready config a LEAD_HUNT action carries (synthesis emits this as
 *  the action `payload`). Mirrors the ResearchProfile fields the hunter needs. */
interface LeadHuntPayload {
  icpDescription: string;
  geo?: unknown;
  businessTypes?: unknown;
  exclusions?: string;
  productPitch?: string;
  language?: string;
  name?: string;
}

/**
 * LEAD_HUNT executor — turns a strategy action into a live prospect hunt: it
 * materializes the action payload as a `ResearchProfile`, builds the same
 * `ResearchJob` the nightly cron consumes, and runs the native research worker.
 * Explicit MCP hands the profile to the existing durable research queue and
 * returns a pending reference for the orchestrator to track.
 * The `resultRef` is `research:<runId>`. If the workspace is out of quota /
 * inactive (no eligible job) or research sources are unconfigured (the worker
 * skips, returning a null runId), it degrades to `resultRef: undefined` rather
 * than failing — the orchestrator still marks the action DONE.
 */
@Injectable()
export class LeadHuntExecutor implements Executor {
  readonly kind = 'LEAD_HUNT' as const;
  private readonly logger = new Logger(LeadHuntExecutor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: ResearchJobService,
    private readonly worker: ResearchWorkerService,
    private readonly runner: ResearchRunnerService,
  ) {}

  async run(workspaceId: string, payload: unknown): Promise<ExecutorResult> {
    const p = this.parse(payload);
    // Refuse disabled/incompatible choices before creating persistent state.
    await this.providerFor(workspaceId);

    const data: Prisma.ResearchProfileUncheckedCreateInput = {
      workspaceId,
      name: p.name,
      status: 'ACTIVE',
      icpDescription: p.icpDescription,
      productPitch: p.productPitch ?? null,
      exclusions: p.exclusions ?? null,
      language: p.language ?? 'en',
    };
    if (p.geo !== undefined) data.geo = p.geo as Prisma.InputJsonValue;
    if (p.businessTypes !== undefined) data.businessTypes = p.businessTypes as Prisma.InputJsonValue;

    const profile = await this.prisma.researchProfile.create({ data });
    if ((await this.providerFor(workspaceId)) === 'MCP') {
      return this.enqueue(workspaceId, profile.id);
    }

    // Reuse the exact ResearchJob the cron/"Run now" path builds (workspace must
    // be ACTIVE with daily lead quota left; else buildJob returns null).
    const job = await this.jobs.buildJob(workspaceId, profile.id);
    // Settings can change while the profile/quota reads are in flight.
    if ((await this.providerFor(workspaceId)) === 'MCP') {
      return this.enqueue(workspaceId, profile.id);
    }
    if (!job) {
      this.logger.warn(
        `lead-hunt: no eligible research job for ws ${workspaceId} (quota exhausted / inactive) — profile ${profile.id} created but not run`,
      );
      return { resultRef: undefined };
    }

    const result = await this.worker.runProfile(job);
    return { resultRef: result.runId ? `research:${result.runId}` : undefined };
  }

  private async enqueue(workspaceId: string, profileId: string): Promise<ExecutorResult> {
    const jobId = await this.runner.enqueueNow(workspaceId, profileId);
    return { pending: true, resultRef: `${QUEUED_RESEARCH_REF}${jobId}` };
  }

  private async providerFor(workspaceId: string) {
    const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { aiSpendPolicy: true } });
    const policy = ws?.aiSpendPolicy as Record<string, unknown> | null;
    const choices = ['research.turn', 'research.qualify'].map((action) => ({ action, ...jobPolicy(policy, action) }));
    for (const choice of choices) {
      if (!choice.enabled) throw new ForbiddenException(`${choice.action} is disabled by the current research policy.`);
    }
    // Match the lease and scheduler: one shared job cannot use mixed runners.
    if (choices.some((choice) => choice.provider === 'LOCAL' || choice.provider !== choices[0].provider)) {
      throw new ServiceUnavailableException('Research provider conflict: both actions must use the same supported provider.');
    }
    return choices[0].provider;
  }

  /** Validate + normalize the action payload into a ResearchProfile shape. */
  private parse(payload: unknown): LeadHuntPayload & { name: string } {
    if (!payload || typeof payload !== 'object') {
      throw new BadRequestException('LEAD_HUNT payload must be an object with an icpDescription');
    }
    const p = payload as Record<string, unknown>;
    const icpDescription = typeof p.icpDescription === 'string' ? p.icpDescription.trim() : '';
    if (!icpDescription) {
      throw new BadRequestException('LEAD_HUNT payload requires a non-empty icpDescription');
    }
    const name =
      typeof p.name === 'string' && p.name.trim()
        ? p.name.trim()
        : `Strategy lead hunt — ${icpDescription.slice(0, 60)}`;
    return {
      icpDescription,
      name,
      geo: p.geo,
      businessTypes: p.businessTypes,
      exclusions: typeof p.exclusions === 'string' ? p.exclusions : undefined,
      productPitch: typeof p.productPitch === 'string' ? p.productPitch : undefined,
      language: typeof p.language === 'string' && p.language.trim() ? p.language.trim() : undefined,
    };
  }
}
