import { IsIn } from 'class-validator';

/**
 * Which side drains this workspace's nightly research queue.
 *
 * Mirrors `Workspace.researchExecution` exactly, for the same reason
 * `set-mcp-write-mode.dto.ts` mirrors `mcpWriteMode`: anything outside these
 * two values is a 400 here, so the fail-safe readers downstream
 * (`ResearchLeaseService.modeFor()`, `ScheduledJobRunnerService.claimBatch`'s
 * `= 'MCP'` predicate — both of which treat "not exactly MCP" as SERVER) never
 * have to reason about a value this endpoint could have written.
 *
 * SERVER — today's behaviour: the in-process worker runs the Anthropic
 *          tool-loop on the platform's key.
 * MCP    — the queue is left for the owner's own Claude to lease over MCP, so
 *          the reasoning is billed to their subscription. Only usable by a
 *          workspace that has connected MCP AND scheduled a drainer on its own
 *          side; without one, jobs simply pile up (and the home timeline says
 *          so by name).
 */
export const RESEARCH_EXECUTION_MODES = ['SERVER', 'MCP'] as const;

export type ResearchExecutionMode = (typeof RESEARCH_EXECUTION_MODES)[number];

export class SetResearchExecutionDto {
  @IsIn(RESEARCH_EXECUTION_MODES as unknown as string[])
  mode: ResearchExecutionMode;
}
