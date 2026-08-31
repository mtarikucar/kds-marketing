import { IsIn } from 'class-validator';
import {
  RESEARCH_EXECUTION_MODES,
  type StoredResearchExecution,
} from '../research/research-execution';

/**
 * Which side gets FIRST REFUSAL on this workspace's nightly research queue.
 *
 * Mirrors `Workspace.researchExecution` exactly, for the same reason
 * `set-mcp-write-mode.dto.ts` mirrors `mcpWriteMode`: anything outside these
 * values is a 400 here, so the fail-safe readers downstream
 * (`effectiveResearchExecution()` and the matching SQL in
 * `ScheduledJobRunnerService.claimBatch` — both of which treat anything
 * unrecognised as SERVER) never have to reason about a value this endpoint
 * could have written.
 *
 * AUTO   — the default, and the only value this endpoint's own UI does not
 *          normally write: MCP while a Claude is actually connected to the
 *          workspace, SERVER otherwise. Accepted here so an owner who has
 *          touched the switch can hand the decision back.
 * SERVER — today's behaviour: the in-process worker runs the Anthropic
 *          tool-loop on the platform's key, immediately.
 * MCP    — the owner's own Claude is asked first, so the reasoning is billed
 *          to their subscription.
 *
 * Neither explicit value can silently stop research any more: under MCP the
 * platform takes an unclaimed job back after `RESEARCH_MCP_GRACE_HOURS` and
 * says so on the panel. That is what makes AUTO safe as a default.
 *
 * The single source of truth for the value list is `research-execution.ts`,
 * which the generic scheduled-job runner also reads — a second copy here is
 * how the DTO and the claim predicate would come to disagree.
 */
export { RESEARCH_EXECUTION_MODES };
export type ResearchExecutionMode = StoredResearchExecution;

export class SetResearchExecutionDto {
  @IsIn(RESEARCH_EXECUTION_MODES as unknown as string[])
  mode: ResearchExecutionMode;
}
