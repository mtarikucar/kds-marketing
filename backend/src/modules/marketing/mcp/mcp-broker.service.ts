import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
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
 * The one risk class an AUTONOMOUS workspace still may not run unattended.
 *
 * This set used to be {SPEND, DESTRUCTIVE} (design spec §4), on the theory
 * that money leaving the workspace is unrecoverable-by-audit. Live use proved
 * the theory wrong in practice: the owner who flips AUTONOMOUS is saying
 * "stop asking me", and being bounced to the panel for every synthesis,
 * research run and generation made the mode meaningless for exactly the flows
 * an agent is FOR — the owner's verdict, verbatim: "panelden izin alacaksak ne
 * anlamı kaldı MCP'nin". SPEND is also not actually unbounded: every spend
 * path in the product settles against the workspace's own metered credits and
 * wallet, so the blast radius of a wrong agent turn is capped by balances the
 * owner already controls — unlike a deletion.
 *
 * `DESTRUCTIVE` stays gated in every mode: a permanently removed row has no
 * undo table, no balance to bound it, and no way to notice-and-correct. That
 * is a different kind of irreversible than "credits were used".
 *
 * Kept as a risk-CLASS rule rather than per-tool opt-outs — an author cannot
 * forget to set it — and the gate stays unconditional on write mode but NOT on
 * `approvedBy`: an approved queued request re-enters with `approvedBy` set and
 * runs. That is the whole point of the queue.
 */
const ALWAYS_APPROVED_RISKS: ReadonlySet<ToolRisk> = new Set<ToolRisk>(['DESTRUCTIVE']);

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
    this.assertArgs(tool, args);

    // High-risk ops never execute inline — they enqueue a human approval.
    // AUTONOMOUS lifts that for everything except DESTRUCTIVE (see
    // ALWAYS_APPROVED_RISKS for why spend is bounded but deletion is not).
    const autonomyMayBypass =
      ctx.writeMode === 'AUTONOMOUS' && !ALWAYS_APPROVED_RISKS.has(tool.risk);
    if (tool.requiresApproval && !autonomyMayBypass && !ctx.approvedBy) {
      const kind = tool.approvalKind ?? 'AGENT_ACTION';
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

  /**
   * Validate against the tool's own `inputSchema` BEFORE anything else happens
   * to the call.
   *
   * Listed tools were already checked by the MCP SDK, which validates at
   * `registerTool`. Deferred tools reached through `jeeta.call_tool` were not:
   * that wrapper types its `input` as an open record and hands it straight to
   * `dispatch`, so nothing had ever compared it to the target's schema.
   *
   * The damage was worst on the approval path, which runs before the handler.
   * A call with a misspelled argument was accepted, queued, and rendered to an
   * owner as a decision to make — and approving it ran the handler with the
   * field missing. `accept_research_candidates` reads `args.candidateIds ?? []`,
   * so a payload that said `ids` accepted nothing and reported "0 candidate(s)
   * are now leads": a silent no-op that a human had explicitly authorised.
   *
   * Deliberately validate-only: the ORIGINAL args are still what the handler
   * receives, so this cannot change the behaviour of a call that was already
   * correct — it only refuses one that never could be.
   */
  private assertArgs(tool: McpTool, args: Record<string, unknown>): void {
    const parsed = tool.inputSchema.safeParse(args ?? {});
    if (parsed.success) return;

    // Unknown keys are NOT an error here. Zod 4 reports them by default, but
    // callers have always been able to pass extra fields — handlers read what
    // they need and ignore the rest — so rejecting them would break calls that
    // work today, which is exactly what this guard promises not to do.
    //
    // The trade this accepts: a misspelled OPTIONAL field still slips through,
    // because nothing distinguishes it from a deliberate extra. What it does
    // catch is the case that actually caused harm — a misspelling that leaves a
    // REQUIRED field missing, which is how `candidateIds` became `ids`.
    const issues = parsed.error.issues.filter((i) => i.code !== 'unrecognized_keys');
    if (!issues.length) return;

    const detail = issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new BadRequestException(`invalid arguments for "${tool.name}": ${detail}`);
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
