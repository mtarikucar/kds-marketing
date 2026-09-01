import { IsIanaTimeZone } from '../common/iana-timezone';

/**
 * The zone this workspace's day boundaries are computed in.
 *
 * Mirrors `Workspace.timezone` exactly, the same way `set-mcp-write-mode.dto.ts`
 * mirrors `mcpWriteMode` — anything that is not a zone `Intl` can resolve is a
 * 400 here, so no downstream reader ever has to reason about a value this
 * endpoint could have written. That matters more than usual for this column,
 * because every reader of it (dashboard aggregates, tasks, sales targets, the
 * daily digest, the client's todayBounds) fails SOFT on a bad zone: it catches,
 * falls back, and draws dates that are quietly wrong for one workspace with
 * nothing in any log. The validation at the edge is the only place a mistake is
 * ever visible.
 */
export class SetWorkspaceTimezoneDto {
  @IsIanaTimeZone()
  timezone: string;
}
