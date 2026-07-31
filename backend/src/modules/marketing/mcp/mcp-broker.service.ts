import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { McpTool, McpToolContext, McpToolRegistry, ToolRisk } from './mcp-tool-registry';
import { ApprovalRequestService } from '../agents/approval-request.service';
import { AgentRunService } from '../agents/agent-run.service';

export interface InvokeResult {
  status: 'OK' | 'PENDING_APPROVAL';
  result?: unknown;
  approvalId?: string;
}

const MAX_ARGS_BYTES = 32 * 1024;

/**
 * TTL for an MCP-originated approval request (M1). Deliberately much shorter
 * than the Budget Autopilot lane's 72h (`PROPOSAL_TTL_MS` in
 * budget-autopilot.service.ts): a reallocation proposal goes stale because
 * the performance numbers behind it age; a queued `send_message`/
 * `publish_social_post`/campaign-launch goes stale because the CONVERSATION
 * or MOMENT it was written for does — a customer's question may already be
 * answered, a campaign's news already old, hours (not days) later. 24h
 * covers one full business day/night cycle (a request opened at close of
 * business is still approvable the next morning) while guaranteeing nothing
 * can be approved or applied "weeks later" against a stale context.
 */
const MCP_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Faz 5 D2 — the risk classes an AUTONOMOUS workspace may NOT run unattended
 * (design spec §4: *"`SPEND` ve yeni `DESTRUCTIVE` sınıfı, `mcpWriteMode` ne
 * olursa olsun onay kuyruğuna düşer — otonom mod bile bunları geçemez."*).
 *
 * `mcpWriteMode: AUTONOMOUS` is a statement about SPEED — "stop making me
 * click approve on every send/publish" — not a blanket power of attorney. Two
 * classes of action are not recoverable by noticing them afterwards:
 *
 * - `SPEND` — real money leaves the workspace (an ad budget change, a fal.ai
 *   generation). Money spent by a wrong agent turn is not refundable by
 *   reading the audit log an hour later.
 * - `DESTRUCTIVE` — a row is permanently removed. There is no undo table.
 *
 * Everything else (`READ`/`WRITE`, and the `SEND`/`PUBLISH` approval kinds,
 * which ride on `WRITE`) keeps the original bypass: risky, but a bad one is
 * visible and correctable. Keeping this as a risk-CLASS rule rather than a
 * per-tool opt-out is deliberate — a tool author cannot forget to set it, and
 * `mcp-broker.destructive.spec.ts` pins both directions.
 *
 * The gate is unconditional on write mode, but NOT on `approvedBy`: once a
 * human has approved a queued request, `McpApprovalExecutorService` re-enters
 * the broker with `approvedBy` set and the tool runs. That is the whole point
 * of the queue.
 */
const ALWAYS_APPROVED_RISKS: ReadonlySet<ToolRisk> = new Set<ToolRisk>(['SPEND', 'DESTRUCTIVE']);

/**
 * The safe MCP broker (Faz 6) — the single choke point between an external agent
 * and Jeeta's internals. Enforces, in order: deny-by-default allow-list →
 * per-tenant scope (least privilege) → approval-gating for high-risk
 * (spend/publish/send) ops (which NEVER execute inline; they enqueue a human
 * approval) → argument-size sanitization → execution with a ToolCallLog audit
 * entry. This is the report's "AI → MCP Broker → internal API" boundary; tokens
 * and business logic stay behind it.
 */
@Injectable()
export class McpBrokerService {
  private readonly logger = new Logger(McpBrokerService.name);

  constructor(
    private readonly registry: McpToolRegistry,
    private readonly approvals: ApprovalRequestService,
    private readonly runs: AgentRunService,
  ) {}

  async invoke(ctx: McpToolContext, toolName: string, args: Record<string, unknown> = {}): Promise<InvokeResult> {
    const tool = this.registry.get(toolName);
    if (!tool) throw new NotFoundException(`unknown tool: ${toolName}`); // deny-by-default

    if (ctx.requireAudit && !ctx.agentRunId) {
      throw new ForbiddenException('audit context required: no agentRunId');
    }

    this.assertScopes(tool, ctx);
    this.assertArgsSize(args);

    // High-risk ops never execute inline — they enqueue a human approval.
    // AUTONOMOUS lifts that for the recoverable classes only; SPEND and
    // DESTRUCTIVE are gated in EVERY mode (see ALWAYS_APPROVED_RISKS).
    const autonomyMayBypass =
      ctx.writeMode === 'AUTONOMOUS' && !ALWAYS_APPROVED_RISKS.has(tool.risk);
    if (tool.requiresApproval && !autonomyMayBypass && !ctx.approvedBy) {
      const kind = tool.approvalKind ?? 'AD_SPEND';
      const resourceType = tool.resourceType;
      const resourceId = tool.resourceIdFrom?.(args);
      if (resourceType && resourceId) {
        // A re-ask (the same agent turn retried, or a user re-asking the same
        // thing) must not leave two live cards for the same target — expire
        // the stale duplicate before enqueueing the fresh one (H2; mirrors
        // BudgetAutopilotService.propose()'s supersede sweep for
        // BUDGET_REALLOCATION).
        await this.approvals.supersedePending(ctx.workspaceId, kind, resourceType, resourceId);
      }
      const req = await this.approvals.enqueue(ctx.workspaceId, {
        kind,
        summary: `MCP agent requested "${tool.name}"`,
        payload: { tool: tool.name, args },
        requestedByRunId: ctx.agentRunId,
        resourceType,
        resourceId,
        // M1: without an expiry, decide()'s expiry guard is dead for this
        // lane and a request approved weeks later still fires. See
        // MCP_APPROVAL_TTL_MS above for why 24h.
        expiresAt: new Date(Date.now() + MCP_APPROVAL_TTL_MS),
      });
      return { status: 'PENDING_APPROVAL', approvalId: req.id };
    }

    const startedAt = Date.now();
    try {
      const result = await tool.handler(ctx, args);
      await this.log(ctx, tool, args, result, true, undefined, Date.now() - startedAt);
      return { status: 'OK', result };
    } catch (err) {
      await this.log(ctx, tool, args, undefined, false, String((err as Error)?.message ?? err), Date.now() - startedAt);
      throw err;
    }
  }

  private assertScopes(tool: McpTool, ctx: McpToolContext): void {
    const granted = new Set(ctx.grantedScopes ?? []);
    const missing = tool.scopes.filter((s) => !granted.has(s));
    if (missing.length) {
      throw new ForbiddenException(`missing scope(s): ${missing.join(', ')}`);
    }
  }

  private assertArgsSize(args: Record<string, unknown>): void {
    let size = 0;
    try {
      size = Buffer.byteLength(JSON.stringify(args ?? {}));
    } catch {
      throw new ForbiddenException('arguments are not serializable');
    }
    if (size > MAX_ARGS_BYTES) throw new ForbiddenException('arguments too large');
  }

  private async log(ctx: McpToolContext, tool: McpTool, args: unknown, result: unknown, ok: boolean, error: string | undefined, latencyMs: number): Promise<void> {
    if (!ctx.agentRunId) return; // logging is tied to an agent run
    try {
      await this.runs.recordTool(ctx.workspaceId, ctx.agentRunId, { tool: tool.name, args, result, ok, error, latencyMs });
    } catch (e) {
      this.logger.warn(`tool-call log failed for ${tool.name}: ${String((e as Error)?.message ?? e)}`);
    }
  }
}
