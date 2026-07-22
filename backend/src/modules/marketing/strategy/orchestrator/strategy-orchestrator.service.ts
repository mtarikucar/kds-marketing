import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../../prisma/prisma.service';
import { ActionKind, Executor } from '../strategy.types';
import { LeadHuntExecutor } from '../executors/lead-hunt.executor';
import { ContentExecutor } from '../executors/content.executor';

export type ExecuteResult =
  | { status: 'DONE'; resultRef: string | null }
  | { status: 'FAILED'; error: string }
  | { skipped: 'executor-not-available' };

/**
 * Strategy Orchestrator — dispatches an APPROVED `StrategyAction` to the
 * `Executor` registered for its kind. This is the ASSISTED lane's execute step
 * (approve → execute). It owns the action's execution lifecycle:
 * APPROVED → RUNNING → DONE (stamping the executor's `resultRef`) or → FAILED
 * (recording the error, never crashing the caller). Kinds without an executor
 * yet (AD_CAMPAIGN / COMMUNITY_ENGAGE / CHANNEL_SETUP — later phases) no-op
 * gracefully: the action stays APPROVED and `{ skipped }` is returned.
 */
@Injectable()
export class StrategyOrchestrator {
  private readonly logger = new Logger(StrategyOrchestrator.name);
  private readonly registry: Map<ActionKind, Executor>;

  constructor(
    private readonly prisma: PrismaService,
    leadHunt: LeadHuntExecutor,
    content: ContentExecutor,
  ) {
    this.registry = new Map<ActionKind, Executor>([
      [leadHunt.kind, leadHunt],
      [content.kind, content],
    ]);
  }

  async execute(workspaceId: string, actionId: string): Promise<ExecuteResult> {
    const action = await this.prisma.strategyAction.findFirst({
      where: { id: actionId, workspaceId },
    });
    if (!action) throw new NotFoundException('strategy action not found');
    if (action.status !== 'APPROVED') {
      throw new BadRequestException(`action is ${action.status}, only APPROVED actions can be executed`);
    }

    const executor = this.registry.get(action.kind as ActionKind);
    if (!executor) {
      // AD_CAMPAIGN / COMMUNITY_ENGAGE / CHANNEL_SETUP are later phases — leave the
      // action APPROVED so it can run once its executor ships. Not a failure.
      this.logger.log(`no executor for kind ${action.kind} yet — leaving action ${actionId} APPROVED`);
      return { skipped: 'executor-not-available' };
    }

    await this.prisma.strategyAction.update({
      where: { id: action.id },
      data: { status: 'RUNNING' },
    });

    try {
      const { resultRef } = await executor.run(workspaceId, action.payload);
      await this.prisma.strategyAction.update({
        where: { id: action.id },
        data: { status: 'DONE', resultRef: resultRef ?? null },
      });
      this.logger.log(`action ${actionId} (${action.kind}) DONE${resultRef ? ` → ${resultRef}` : ''}`);
      return { status: 'DONE', resultRef: resultRef ?? null };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error(`action ${actionId} (${action.kind}) FAILED: ${message}`);
      // Record the failure without crashing the approve/execute caller. There is
      // no dedicated error column, so the reason rides in resultRef (`error:…`).
      await this.prisma.strategyAction
        .update({
          where: { id: action.id },
          data: { status: 'FAILED', resultRef: `error:${message}`.slice(0, 500) },
        })
        .catch(() => undefined);
      return { status: 'FAILED', error: message };
    }
  }
}
