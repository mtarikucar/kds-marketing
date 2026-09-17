import {
  BadRequestException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { PrismaService } from "../../../prisma/prisma.service";
import { assertJobProvider } from "./ai-job-policy";
import type { AiCallOpts, AiCompletion } from "./anthropic.service";

const KIND = "ai.mcp.inference";
const TTL_MS = 30 * 60_000;
const LEASE_MS = 5 * 60_000;
export const MCP_MAX_RESULT_BYTES = 24 * 1024;

/** Object insertion order is not request identity; message/array order still is. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
}

interface ToolExecution {
  toolId: string;
  token: string;
  state: "RUNNING" | "DONE" | "UNCERTAIN";
  result?: unknown;
}

/** Persistent mailbox for a user's connected Claude. Never invokes a paid model. */
@Injectable()
export class McpAiTaskService {
  constructor(private readonly prisma: PrismaService) {}

  async generate(opts: AiCallOpts): Promise<AiCompletion> {
    if (!opts.workspaceId || !opts.action)
      throw new BadRequestException(
        "MCP inference needs a workspace and action",
      );
    await assertJobProvider(this.prisma, opts.workspaceId, opts.action, "MCP");
    const input = {
      system: opts.system,
      messages: opts.messages,
      tools: opts.tools ?? [],
      toolChoice: opts.toolChoice ?? null,
      maxTokens: opts.maxTokens ?? 1024,
    };
    const encoded = JSON.stringify(input);
    if (Buffer.byteLength(encoded) > 200_000)
      throw new BadRequestException("MCP task context exceeds 200 KB");
    const idempotencyScope = opts.idempotencyScope ?? null;
    const hash = createHash("sha256")
      .update(canonicalJson([opts.action, idempotencyScope, input]))
      .digest("hex");
    const task = await this.prisma.$transaction(async (tx) => {
      // Queue admission is workspace-wide; different prompts must share the cap.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`mcp-infer:${opts.workspaceId}`}))::text AS locked`;
      // Unresolved writes are durable blockers, not cached model responses.
      // Include old/cancelled rows: neither TTL nor a previous sweep proves
      // that a write did not happen. Only explicit reconciliation can clear it.
      const blocked = await tx.scheduledJob.findFirst({
        where: {
          workspaceId: opts.workspaceId!,
          kind: KIND,
          dedupKey: hash,
          OR: ["RUNNING", "UNCERTAIN"].map((state) => ({
            payload: { path: ["toolExecutions"], array_contains: [{ state }] },
          })),
        },
      });
      if (blocked) {
        const execution = (blocked.payload as any).toolExecutions.find(
          (entry: ToolExecution) =>
            entry.state === "RUNNING" || entry.state === "UNCERTAIN",
        );
        throw this.uncertain(blocked.id, execution.toolId);
      }
      const existing = await tx.scheduledJob.findFirst({
        where: {
          workspaceId: opts.workspaceId!,
          kind: KIND,
          dedupKey: hash,
          status: { in: ["MCP_WAITING", "MCP_CLAIMED", "MCP_DONE"] },
          createdAt: { gt: new Date(Date.now() - TTL_MS) },
        },
        orderBy: { createdAt: "desc" },
      });
      if (existing) return existing;
      const pending = await tx.scheduledJob.count({
        where: {
          workspaceId: opts.workspaceId!,
          kind: KIND,
          status: { in: ["MCP_WAITING", "MCP_CLAIMED"] },
          createdAt: { gt: new Date(Date.now() - TTL_MS) },
        },
      });
      if (pending >= 50)
        throw new ServiceUnavailableException(
          "AI_MCP_QUEUE_FULL: Bağlı Claude bekleyen görevleri tamamlamalı.",
        );
      return tx.scheduledJob.create({
        data: {
          workspaceId: opts.workspaceId!,
          kind: KIND,
          status: "MCP_WAITING",
          runAt: new Date(),
          dedupKey: hash,
          payload: { action: opts.action!, input, idempotencyScope } as any,
        },
      });
    });
    // Brief wait keeps an actively polling connector synchronous to the caller.
    // A timeout leaves the durable request available. Keep completed responses
    // replayable for TTL_MS: a later turn may time out after earlier tools ran.
    const configuredWait = Number(process.env.AI_MCP_WAIT_MS ?? 20_000);
    const waitMs = Number.isFinite(configuredWait)
      ? Math.min(45_000, Math.max(0, configuredWait))
      : 20_000;
    const deadline = Date.now() + waitMs;
    let row = task;
    for (;;) {
      if (row?.status === "MCP_DONE") {
        await assertJobProvider(
          this.prisma,
          opts.workspaceId,
          opts.action,
          "MCP",
        );
        const result = (row.payload as any).result as AiCompletion;
        return { ...result, mcpTaskId: row.id };
      }
      if (Date.now() >= deadline || row?.status === "CANCELLED") break;
      await new Promise((resolve) => setTimeout(resolve, 500));
      row =
        (await this.prisma.scheduledJob.findFirst({
          where: { id: task.id, workspaceId: opts.workspaceId, kind: KIND },
        })) ?? task;
    }
    throw new ServiceUnavailableException({
      code: "AI_MCP_WAITING",
      taskId: task.id,
      message:
        "İş bağlı Claude hesabınızı bekliyor. API kullanılmadı. Asistan görevi tamamladıktan sonra işlemi yeniden deneyin.",
    });
  }

  async claim(workspaceId: string) {
    // Dedicated statuses keep the generic scheduled-job runner from stealing
    // work and starting a vendor API after its usual grace period.
    // DONE rows carry durable tool journals. Their normal response cache still
    // expires at admission, but their status must survive an in-flight write.
    await this.prisma.scheduledJob.updateMany({
      where: {
        workspaceId,
        kind: KIND,
        status: { in: ["MCP_WAITING", "MCP_CLAIMED"] },
        createdAt: { lte: new Date(Date.now() - TTL_MS) },
      },
      data: { status: "CANCELLED", lastError: "MCP task expired" },
    });
    await this.prisma.scheduledJob.updateMany({
      where: {
        workspaceId,
        kind: KIND,
        status: "MCP_CLAIMED",
        lockedAt: { lte: new Date(Date.now() - LEASE_MS) },
        createdAt: { gt: new Date(Date.now() - TTL_MS) },
      },
      data: { status: "MCP_WAITING", lockedAt: null },
    });
    const rows = await this.prisma.scheduledJob.findMany({
      where: { workspaceId, kind: KIND, status: "MCP_WAITING" },
      orderBy: { createdAt: "asc" },
      take: 20,
    });
    for (const row of rows) {
      const payload = row.payload as any;
      try {
        await assertJobProvider(
          this.prisma,
          workspaceId,
          payload.action,
          "MCP",
        );
      } catch (error) {
        // An infrastructure failure is not a policy change. Preserve the task
        // and propagate it so a later poll can recover.
        const response =
          error instanceof HttpException ? error.getResponse() : null;
        const code =
          response && typeof response === "object"
            ? (response as { code?: string }).code
            : null;
        if (code !== "AI_SPEND_DISABLED" && code !== "AI_PROVIDER_REQUIRED")
          throw error;
        await this.prisma.scheduledJob.updateMany({
          where: { workspaceId, id: row.id, kind: KIND, status: "MCP_WAITING" },
          data: { status: "CANCELLED", lastError: "Execution policy changed" },
        });
        continue;
      }
      const leaseToken = randomUUID();
      const lockedAt = new Date();
      const changed = await this.prisma.scheduledJob.updateMany({
        where: { id: row.id, workspaceId, kind: KIND, status: "MCP_WAITING" },
        data: {
          status: "MCP_CLAIMED",
          lockedAt,
          payload: { ...payload, leaseToken },
        },
      });
      if (changed.count === 1)
        return {
          taskId: row.id,
          action: payload.action,
          input: payload.input,
          leaseToken,
          expiresAt: new Date(lockedAt.getTime() + LEASE_MS).toISOString(),
          maxResultBytes: MCP_MAX_RESULT_BYTES,
          resultInstructions:
            "Return {text, toolUses} as at most 24 KiB of UTF-8 JSON, including JSON escaping. Keep prose compact; preserve required tool fields. Do not execute the tool calls yourself. Jeeta executes and journals them. Completed responses may be replayed on retry.",
        };
    }
    return null;
  }

  async complete(
    workspaceId: string,
    taskId: string,
    leaseToken: string,
    raw: unknown,
  ) {
    const row = await this.prisma.scheduledJob.findFirst({
      where: { id: taskId, workspaceId, kind: KIND, status: "MCP_CLAIMED" },
    });
    const payload = row?.payload as any;
    if (
      !row ||
      payload?.leaseToken !== leaseToken ||
      !row.lockedAt ||
      row.lockedAt.getTime() <= Date.now() - LEASE_MS
    )
      throw new BadRequestException("MCP lease is missing or expired");
    await assertJobProvider(this.prisma, workspaceId, payload.action, "MCP");
    const result = this.validateResult(raw, payload.input);
    const changed = await this.prisma.scheduledJob.updateMany({
      where: {
        id: taskId,
        workspaceId,
        kind: KIND,
        status: "MCP_CLAIMED",
        lockedAt: row.lockedAt,
        payload: { path: ["leaseToken"], equals: leaseToken },
      },
      data: {
        status: "MCP_DONE",
        completedAt: new Date(),
        payload: { ...payload, result },
      },
    });
    if (changed.count !== 1)
      throw new BadRequestException(
        "MCP lease changed; result was not applied",
      );
    return { completed: true };
  }

  /**
   * Claim BEFORE invoking a tool, outside the transaction. A process death,
   * thrown callback, or failed result write leaves RUNNING/UNCERTAIN, never a
   * retryable claim. This intentionally prefers a visible manual-recovery
   * requirement over executing an external write twice.
   */
  async runToolOnce<T>(
    workspaceId: string,
    taskId: string,
    toolId: string,
    callback: () => Promise<T>,
    idempotencyScope?: string,
  ): Promise<T> {
    const claim = await this.prisma.$transaction(async (tx) => {
      // Same lock/order as admission: an old task cannot start a write while
      // a retry crosses TTL and admits a replacement for its hash.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`mcp-infer:${workspaceId}`}))::text AS locked`;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`mcp-tool:${workspaceId}:${taskId}`}))::text AS locked`;
      const row = await tx.scheduledJob.findFirst({
        where: {
          id: taskId,
          workspaceId,
          kind: KIND,
          status: "MCP_DONE",
        },
      });
      const payload = row?.payload as any;
      if (
        !row ||
        (payload.idempotencyScope ?? null) !== (idempotencyScope ?? null) ||
        !payload.result?.toolUses?.some((tool: any) => tool.id === toolId)
      ) {
        throw new BadRequestException(
          "MCP tool task, actor scope, or tool does not match",
        );
      }
      await assertJobProvider(tx, workspaceId, payload.action, "MCP");
      const executions: ToolExecution[] = payload.toolExecutions ?? [];
      const previous = executions.find(
        (execution) => execution.toolId === toolId,
      );
      if (previous && previous.state !== "DONE")
        throw this.uncertain(taskId, toolId);
      if (row.createdAt.getTime() <= Date.now() - TTL_MS)
        throw new BadRequestException("MCP tool task expired");
      if (previous?.state === "DONE")
        return {
          replay: true as const,
          result: JSON.parse(canonicalJson(previous.result)) as T,
        };
      const token = randomUUID();
      const next = {
        ...payload,
        toolExecutions: [...executions, { toolId, token, state: "RUNNING" }],
      };
      const changed = await tx.scheduledJob.updateMany({
        where: {
          id: taskId,
          workspaceId,
          kind: KIND,
          status: "MCP_DONE",
          payload: { equals: row.payload! },
        },
        data: { payload: next },
      });
      if (changed.count !== 1) throw this.uncertain(taskId, toolId);
      return { replay: false as const, token };
    });
    if (claim.replay) return claim.result;

    try {
      const result = await callback();
      // Return the exact JSON representation we persist on the FIRST run too,
      // so Dates/undefined cannot change the next-turn transcript on replay.
      const encoded = canonicalJson(result === undefined ? null : result);
      if (encoded === undefined || Buffer.byteLength(encoded) > 200_000)
        throw new Error("MCP tool result is not persistable");
      const stored = JSON.parse(encoded) as T;
      await this.finishTool(
        workspaceId,
        taskId,
        toolId,
        claim.token,
        "DONE",
        stored,
      );
      return stored;
    } catch {
      await this.finishTool(
        workspaceId,
        taskId,
        toolId,
        claim.token,
        "UNCERTAIN",
      ).catch(() => undefined);
      throw this.uncertain(taskId, toolId);
    }
  }

  private uncertain(
    taskId: string,
    toolId: string,
  ): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code: "AI_MCP_TOOL_UNCERTAIN",
      taskId,
      toolId,
      message:
        "AI_MCP_TOOL_UNCERTAIN: This tool may already have run. Automatic replay is blocked; inspect its outcome before starting new work.",
    });
  }

  private async finishTool(
    workspaceId: string,
    taskId: string,
    toolId: string,
    token: string,
    state: "DONE" | "UNCERTAIN",
    result?: unknown,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`mcp-tool:${workspaceId}:${taskId}`}))::text AS locked`;
      const row = await tx.scheduledJob.findFirst({
        where: { id: taskId, workspaceId, kind: KIND, status: "MCP_DONE" },
      });
      const payload = row?.payload as any;
      const executions: ToolExecution[] = payload?.toolExecutions ?? [];
      const index = executions.findIndex(
        (entry) =>
          entry.toolId === toolId &&
          entry.token === token &&
          entry.state === "RUNNING",
      );
      if (!row || index < 0) throw this.uncertain(taskId, toolId);
      const next = executions.map((entry, i) =>
        i === index
          ? { ...entry, state, ...(state === "DONE" ? { result } : {}) }
          : entry,
      );
      const changed = await tx.scheduledJob.updateMany({
        where: {
          id: taskId,
          workspaceId,
          kind: KIND,
          status: "MCP_DONE",
          payload: { equals: row.payload! },
        },
        data: { payload: { ...payload, toolExecutions: next } },
      });
      if (changed.count !== 1) throw this.uncertain(taskId, toolId);
    });
  }

  private validateResult(raw: unknown, input: any): AiCompletion {
    const r =
      raw && typeof raw === "object"
        ? { ...(raw as any), toolUses: (raw as any).toolUses ?? [] }
        : null;
    if (r && Buffer.byteLength(JSON.stringify(r)) > MCP_MAX_RESULT_BYTES)
      throw new BadRequestException(
        "MCP inference result exceeds 24 KiB of UTF-8 JSON",
      );
    if (
      !r ||
      typeof r.text !== "string" ||
      !Array.isArray(r.toolUses) ||
      r.toolUses.length > 20
    )
      throw new BadRequestException("Invalid MCP inference result");
    const names = new Set((input.tools ?? []).map((t: any) => t.name));
    const ids = new Set<string>();
    for (const tool of r.toolUses) {
      if (
        tool.type !== "tool_use" ||
        typeof tool.id !== "string" ||
        !tool.id ||
        ids.has(tool.id) ||
        !names.has(tool.name) ||
        !tool.input ||
        typeof tool.input !== "object" ||
        Array.isArray(tool.input)
      )
        throw new BadRequestException(
          "Invalid or undeclared tool in MCP result",
        );
      ids.add(tool.id);
    }
    if (
      input.toolChoice?.type === "tool" &&
      !r.toolUses.some((t: any) => t.name === input.toolChoice.name)
    )
      throw new BadRequestException("Required output tool is missing");
    return {
      text: r.text,
      toolUses: r.toolUses,
      stopReason: r.toolUses.length ? "tool_use" : "end_turn",
      usage: { input: 0, output: 0 },
    };
  }
}
