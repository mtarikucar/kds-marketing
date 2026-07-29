import { IsIn } from 'class-validator';

/**
 * MCP write-surface activation — the human-approval gate switch.
 * Mirrors `Workspace.mcpWriteMode` exactly: anything outside these two
 * values is a 400 here, so `McpInvokerService.writeModeFor()`'s fail-safe
 * ("not exactly 'AUTONOMOUS' → APPROVAL") never has to catch a bad write —
 * only a bad READ of a row this endpoint didn't create.
 */
export const MCP_WRITE_MODES = ['APPROVAL', 'AUTONOMOUS'] as const;

export class SetMcpWriteModeDto {
  @IsIn(MCP_WRITE_MODES as unknown as string[])
  mode: 'APPROVAL' | 'AUTONOMOUS';
}
