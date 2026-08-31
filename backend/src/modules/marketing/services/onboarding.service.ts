import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { MCP_RESEARCH_AGENT } from '../research/research-execution';

export interface OnboardingState {
  /** True once the workspace has put the setup guide away. */
  dismissed: boolean;
  /**
   * Whether the MCP research lane has been PROVEN to work, by a real lease.
   *
   * The completion signal for the "connect your Claude" step, and deliberately
   * not "an API key exists". A key is intent: a workspace that created one and
   * never wrote the scheduled task looks, from every other angle, exactly like
   * a workspace whose lane works — and a half-finished setup is precisely what
   * this feature dies of. One `research.mcp` AgentRun means something actually
   * leased a job, end to end.
   */
  claudeLaneProven: boolean;
  /**
   * The workspace's MCP write mode, so the step can WARN when it applies.
   *
   * Measured in v2.286.0: under APPROVAL the three Jeeta-keyed data tools do
   * not merely queue, they are UNUSABLE — `McpApprovalExecutorService.apply()`
   * returns the tool result to the approving human's HTTP response, never to
   * the agent's turn, so the drainer receives `PENDING_APPROVAL` and can never
   * obtain the Google Maps records inside its own session, however fast anyone
   * clicks. The lane still runs; it silently falls back to plain web search and
   * loses the pain signal it was designed around. Somebody being walked through
   * this setup has to be told before they finish, not after.
   */
  mcpWriteMode: 'APPROVAL' | 'AUTONOMOUS';
}

/**
 * Whether the first-run setup guide has been dismissed, per WORKSPACE.
 *
 * This lived only in the browser (`localStorage['kds-onboarding']`), which made
 * it a per-device opinion rather than a workspace fact: dismiss it on a laptop
 * and it is still waiting on a phone; clear site data and a fully configured
 * workspace is nagged again; and a second team member sees a guide the owner
 * already worked through.
 *
 * Stored inside `Workspace.settings` — the schema's free-shape Jsonb bag,
 * explicitly there "so additions don't need migrations" — under an `onboarding`
 * key, so this needs no schema change. Reads and writes are narrow: everything
 * else in the bag is preserved on write.
 */
@Injectable()
export class OnboardingService {
  constructor(private readonly prisma: PrismaService) {}

  async get(workspaceId: string): Promise<OnboardingState> {
    const [ws, leased] = await Promise.all([
      this.prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { settings: true, mcpWriteMode: true },
      }),
      // `agent` is what makes this "a CLAIM" rather than "some agent ran here".
      // The platform's own nightly research opens `research` runs on every
      // SERVER workspace, and counting those would tick this step for a
      // customer who has never connected anything at all.
      this.prisma.agentRun.findFirst({
        where: { workspaceId, agent: MCP_RESEARCH_AGENT },
        select: { id: true },
      }),
    ]);
    return {
      dismissed: this.readDismissed(ws?.settings),
      claudeLaneProven: leased !== null,
      // Same fail-safe direction as `McpInvokerService.writeModeFor()`. Erring
      // towards APPROVAL here shows a warning that might not apply; erring the
      // other way hides one that does, and the whole point of the warning is
      // that its absence is indistinguishable from a lane working properly.
      mcpWriteMode: ws?.mcpWriteMode === 'AUTONOMOUS' ? 'AUTONOMOUS' : 'APPROVAL',
    };
  }

  /**
   * Flip the dismissal flag.
   *
   * Returns ONLY that flag, not the whole {@link OnboardingState}: the other
   * two fields are facts about the workspace that this write does not touch,
   * and re-reading them here would be two queries spent restating something
   * the caller already has. The client merges rather than replaces (see
   * useOnboardingChecklist) — replacing would blank the other two out of the
   * cache and flicker the completed steps back to incomplete.
   */
  async setDismissed(
    workspaceId: string,
    dismissed: boolean,
  ): Promise<Pick<OnboardingState, 'dismissed'>> {
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { settings: true },
    });

    // Merge rather than replace: `settings` is shared with businessTypes and
    // whatever else has been parked there, and clobbering it would silently
    // wipe unrelated workspace configuration.
    const current = this.asObject(ws?.settings);
    const onboarding = this.asObject(current.onboarding);
    const next: Prisma.InputJsonValue = {
      ...current,
      onboarding: { ...onboarding, dismissed },
    };

    await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: { settings: next },
    });
    return { dismissed };
  }

  private asObject(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private readDismissed(settings: unknown): boolean {
    const onboarding = this.asObject(this.asObject(settings).onboarding);
    return onboarding.dismissed === true;
  }
}
