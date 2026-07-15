import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

/** A RUNNING row older than this was stranded by a crash/deploy — no live agent
 *  run takes an hour; the longest (research) is bounded well under it. */
const STALE_RUN_MS = 60 * 60 * 1000;

export interface StartRunInput {
  agent: string;
  goal?: string;
  input?: unknown;
  parentRunId?: string;
}

export interface FinishRunInput {
  status?: 'DONE' | 'FAILED';
  output?: unknown;
  error?: string;
  costCredits?: number;
  tokensIn?: number;
  tokensOut?: number;
}

export interface ToolCallInput {
  tool: string;
  args?: unknown;
  result?: unknown;
  ok?: boolean;
  error?: string;
  latencyMs?: number;
}

/**
 * Records the audit trail for role-specialized marketing agents (Faz 3): one
 * AgentRun per invocation, one ToolCallLog per side effect. This is the "why did
 * the AI do this?" substrate the whole multi-agent + MCP surface depends on.
 * Observability only — it never decides anything.
 */
@Injectable()
export class AgentRunService {
  private readonly logger = new Logger(AgentRunService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Crash recovery: a deploy/restart mid-run leaves rows permanently RUNNING
   *  with no finishedAt in the user-visible audit feed (track()'s finally only
   *  runs in a live process). Sweep them FAILED, mirroring the scheduled-jobs
   *  reaper. */
  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'agent-run-reaper' })
  async reapStaleRuns(): Promise<void> {
    try {
      const res = await this.prisma.agentRun.updateMany({
        where: { status: 'RUNNING', startedAt: { lt: new Date(Date.now() - STALE_RUN_MS) } },
        data: { status: 'FAILED', error: 'stranded by a process restart', finishedAt: new Date() },
      });
      if (res.count > 0) this.logger.warn(`agent-run reaper: failed ${res.count} stale RUNNING run(s)`);
    } catch (e) {
      this.logger.error(`agent-run reaper failed: ${(e as Error)?.message ?? e}`);
    }
  }

  async start(workspaceId: string, input: StartRunInput): Promise<string> {
    const run = await this.prisma.agentRun.create({
      data: {
        workspaceId,
        agent: input.agent,
        goal: input.goal,
        parentRunId: input.parentRunId ?? null,
        input: toJson(input.input),
      },
      select: { id: true },
    });
    return run.id;
  }

  async recordTool(workspaceId: string, runId: string, call: ToolCallInput): Promise<void> {
    await this.prisma.toolCallLog.create({
      data: {
        workspaceId,
        runId,
        tool: call.tool,
        args: toJson(call.args),
        result: toJson(call.result),
        ok: call.ok ?? true,
        error: call.error,
        latencyMs: call.latencyMs,
      },
    });
  }

  async finish(runId: string, input: FinishRunInput = {}): Promise<void> {
    await this.prisma.agentRun.update({
      where: { id: runId },
      data: {
        status: input.status ?? 'DONE',
        output: toJson(input.output),
        error: input.error,
        costCredits: input.costCredits ?? 0,
        tokensIn: input.tokensIn ?? 0,
        tokensOut: input.tokensOut ?? 0,
        finishedAt: new Date(),
      },
    });
  }

  /**
   * Convenience wrapper: start a run, execute `fn` (which may record tool calls
   * via the passed runId), finish DONE on success or FAILED on throw (re-throws).
   */
  async track<T>(workspaceId: string, input: StartRunInput, fn: (runId: string) => Promise<T>): Promise<T> {
    const runId = await this.start(workspaceId, input);
    try {
      const out = await fn(runId);
      await this.finish(runId, { status: 'DONE', output: out });
      return out;
    } catch (err) {
      await this.finish(runId, { status: 'FAILED', error: String((err as Error)?.message ?? err) });
      throw err;
    }
  }

  list(workspaceId: string, take = 50) {
    return this.prisma.agentRun.findMany({
      where: { workspaceId },
      orderBy: { startedAt: 'desc' },
      take: Math.min(Math.max(take, 1), 200),
      include: { toolCalls: { orderBy: { createdAt: 'asc' } } },
    });
  }
}

function toJson(v: unknown): Prisma.InputJsonValue | undefined {
  return v === undefined ? undefined : (v as Prisma.InputJsonValue);
}
