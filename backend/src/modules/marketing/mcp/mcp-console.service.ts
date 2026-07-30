import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { ApiKeysService } from '../services/api-keys.service';
import { RolesService } from '../roles/roles.service';
import { safeLimit, safePage } from '../common/paging';

/**
 * Faz 4 — the read model behind the connector management console.
 *
 * Faz 1-3 built the MCP surface; this service is the mirror an operator looks
 * into: which clients are connected, what they did, and whether the human
 * approval gate is armed. It is READ-ONLY except for one action — revoking a
 * client's tokens — and it holds no policy: the broker keeps owning what an
 * MCP caller may do.
 *
 * Tenant boundary: every query here runs over tables that hold other
 * workspaces' rows, so `workspaceId` is pinned into every filter. The one
 * unscoped read is `mcp_oauth_clients`, a global cache of PUBLIC CIMD
 * documents that carries no tenant column at all — and it is only ever
 * queried for client ids already derived from the caller's own tokens.
 */

/** The `AgentRun.agent` value McpInvokerService opens every MCP run under. */
const MCP_AGENT = 'mcp';

/**
 * The permission `MarketingWorkspacesController.setMcpWriteMode` demands
 * alongside `@MarketingRoles('OWNER')`. Mirrored, not guessed — `canToggle`
 * must not claim a toggle the real endpoint would refuse.
 */
const MCP_WRITE_MODE_PERMISSION = 'settings.manage';

/** Session-list paging (repo convention: `{ items, total, page, pageSize }`). */
export const MCP_SESSIONS_DEFAULT_PAGE_SIZE = 25;
export const MCP_SESSIONS_MAX_PAGE_SIZE = 100;

/**
 * Ceiling on tool-call rows returned for ONE session. Today an MCP AgentRun
 * wraps a single tool call, so this is pure defence in depth against a future
 * multi-call session turning a detail read into an unbounded response.
 */
export const MCP_SESSION_TOOL_CALL_LIMIT = 200;

export interface McpOAuthConnection {
  kind: 'OAUTH';
  /** The CIMD `client_id` — an https URL, and the client's identity. */
  clientId: string;
  clientName: string | null;
  logoUri: string | null;
  clientUri: string | null;
  /** Union of the scopes across this client's live tokens, sorted. */
  scopes: string[];
  /** Oldest token ever issued to this client here — including revoked ones. */
  connectedAt: Date | null;
  /** Newest live token. Token issuance/refresh is the only per-client activity
   *  signal we have: neither AgentRun nor ToolCallLog records a clientId. */
  lastActivityAt: Date | null;
  liveTokenCount: number;
}

export interface McpApiKeyConnection {
  kind: 'API_KEY';
  id: string;
  name: string;
  scopes: string[];
  lastUsedAt: Date | null;
  createdAt: Date;
}

export interface McpConnections {
  oauth: McpOAuthConnection[];
  apiKeys: McpApiKeyConnection[];
}

export interface McpSessionSummary {
  id: string;
  status: string;
  /** What the run recorded. Today `McpInvokerService` stores the TOOL NAME
   *  here (one run per tool call); it is passed through verbatim rather than
   *  reformatted, so the console can never claim more than was logged. */
  goal: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  error: string | null;
  toolCallCount: number;
  /** Approval requests this run enqueued. A run with 0 tool calls and >0
   *  approvals did NOT do nothing — it hit the human gate. */
  approvalCount: number;
}

export interface McpToolCallAudit {
  id: string;
  tool: string;
  at: Date;
  ok: boolean;
  error: string | null;
  latencyMs: number | null;
  /** Size of the recorded argument blob, in bytes. */
  argsBytes: number;
  /** Top-level argument NAMES only — never their values. */
  argsKeys: string[];
  /** Size of the recorded result blob, in bytes. */
  resultBytes: number;
}

export interface McpApprovalSummary {
  id: string;
  kind: string;
  status: string;
  summary: string;
  createdAt: Date;
  decidedAt: Date | null;
  expiresAt: Date | null;
}

export interface McpSessionDetail extends Omit<McpSessionSummary, 'toolCallCount' | 'approvalCount'> {
  queuedForApproval: boolean;
  toolCalls: McpToolCallAudit[];
  approvals: McpApprovalSummary[];
}

@Injectable()
export class McpConsoleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly apiKeys: ApiKeysService,
    private readonly roles: RolesService,
    private readonly config: ConfigService,
  ) {}

  /** Both kinds of connection into this workspace's MCP surface. */
  async listConnections(workspaceId: string): Promise<McpConnections> {
    const [oauth, apiKeys] = await Promise.all([
      this.listOAuthConnections(workspaceId),
      this.listApiKeyConnections(workspaceId),
    ]);
    return { oauth, apiKeys };
  }

  /**
   * Claude.ai / Desktop connectors (Faz 3). "Connected" means the client still
   * holds at least one live token — non-revoked AND unexpired. A client whose
   * every token is dead is disconnected and is not listed, even though its rows
   * (and its audit trail) are still there.
   */
  private async listOAuthConnections(workspaceId: string): Promise<McpOAuthConnection[]> {
    const live = await this.prisma.mcpOAuthToken.findMany({
      where: { workspaceId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { clientId: true, scopes: true, createdAt: true },
    });
    if (live.length === 0) return [];

    const clientIds = [...new Set(live.map((t) => t.clientId))];

    const [docs, firstSeen] = await Promise.all([
      this.prisma.mcpOAuthClient.findMany({
        where: { clientId: { in: clientIds } },
        select: { clientId: true, clientName: true, metadata: true },
      }),
      // One query per connected client. `n` is the number of DISTINCT clients a
      // single workspace has live tokens for (single digits in practice), which
      // is why this beats loading every token row the workspace ever had just
      // to find the oldest one per client.
      Promise.all(
        clientIds.map(async (clientId) => {
          const oldest = await this.prisma.mcpOAuthToken.findFirst({
            where: { workspaceId, clientId },
            orderBy: { createdAt: 'asc' },
            select: { createdAt: true },
          });
          return [clientId, oldest?.createdAt ?? null] as const;
        }),
      ),
    ]);

    const docByClient = new Map(docs.map((d) => [d.clientId, d]));
    const firstByClient = new Map(firstSeen);

    return clientIds
      .map((clientId) => {
        const tokens = live.filter((t) => t.clientId === clientId);
        const scopes = new Set<string>();
        let lastActivityAt: Date | null = null;
        for (const t of tokens) {
          for (const s of t.scopes ?? []) scopes.add(s);
          if (!lastActivityAt || t.createdAt > lastActivityAt) lastActivityAt = t.createdAt;
        }
        const doc = docByClient.get(clientId);
        return {
          kind: 'OAUTH' as const,
          clientId,
          clientName: doc?.clientName ?? null,
          logoUri: metadataString(doc?.metadata, 'logo_uri'),
          clientUri: metadataString(doc?.metadata, 'client_uri'),
          scopes: [...scopes].sort(),
          connectedAt: firstByClient.get(clientId) ?? null,
          lastActivityAt,
          liveTokenCount: tokens.length,
        };
      })
      .sort((a, b) => (b.lastActivityAt?.getTime() ?? 0) - (a.lastActivityAt?.getTime() ?? 0));
  }

  /**
   * Claude Code's `mk_live_…` keys (Faz 1) — the other way into the same MCP
   * endpoint, so the console has to show them as connections too.
   *
   * `ApiKeysService.list` is reused rather than re-querying the model, and its
   * rows are re-projected: `keyHash` it never selects, and `prefix` is dropped
   * HERE on purpose. The prefix is a literal 16-character substring of the live
   * secret, and the console only needs to tell keys apart — `name` and `id` do
   * that without putting any part of a credential on screen.
   */
  private async listApiKeyConnections(workspaceId: string): Promise<McpApiKeyConnection[]> {
    const rows = await this.apiKeys.list(workspaceId);
    return rows
      .filter((r) => r.status === 'ACTIVE')
      .map((r) => ({
        kind: 'API_KEY' as const,
        id: r.id,
        name: r.name,
        scopes: Array.isArray(r.scopes) ? (r.scopes as string[]) : [],
        lastUsedAt: r.lastUsedAt,
        createdAt: r.createdAt,
      }));
  }

  /**
   * Disconnect one OAuth client from THIS workspace.
   *
   * Rows are stamped `revokedAt`, never deleted: the connector's audit trail —
   * which client held which scopes, and for how long — has to outlive the
   * disconnect. Idempotent by construction (`revokedAt: null` matches nothing
   * the second time), and it returns the count so the UI can say what happened
   * instead of guessing.
   *
   * The filter deliberately does NOT also require an unexpired token: an
   * expired-but-unrevoked row belongs to a client being disconnected, and
   * leaving it unstamped would make "does this client still hold anything?"
   * depend on the clock rather than on one column.
   */
  async revokeOAuthClient(workspaceId: string, clientId: string) {
    const id = (clientId ?? '').trim();
    // A blank id would drop out of the filter and widen it to the whole
    // workspace (the Prisma undefined-where trap, one level up).
    if (!id) throw new BadRequestException('clientId is required');

    const res = await this.prisma.mcpOAuthToken.updateMany({
      where: { workspaceId, clientId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { clientId: id, revoked: res.count };
  }

  /**
   * The workspace's MCP sessions, newest first.
   *
   * `agent: 'mcp'` is pinned into BOTH the page query and the total: the
   * `agent_runs` table is shared with every other agent (researcher,
   * strategist, the Budget Autopilot), and a total that counted those would
   * make the console show pages that do not exist.
   *
   * Paging goes through the repo's `safePage`/`safeLimit` helpers, so the page
   * size is capped SERVER-SIDE and garbage input degrades to the first page
   * instead of handing Prisma a NaN `skip`.
   */
  async listSessions(workspaceId: string, page?: unknown, pageSize?: unknown) {
    const p = safePage(page);
    const size = safeLimit(pageSize, MCP_SESSIONS_DEFAULT_PAGE_SIZE, MCP_SESSIONS_MAX_PAGE_SIZE);
    const where = { workspaceId, agent: MCP_AGENT };

    const [rows, total] = await Promise.all([
      this.prisma.agentRun.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        skip: (p - 1) * size,
        take: size,
        select: {
          id: true,
          status: true,
          goal: true,
          startedAt: true,
          finishedAt: true,
          error: true,
          _count: { select: { toolCalls: true } },
        },
      }),
      this.prisma.agentRun.count({ where }),
    ]);

    const approvals = await this.approvalCountsByRun(
      workspaceId,
      rows.map((r) => r.id),
    );

    const items: McpSessionSummary[] = rows.map((r) => ({
      id: r.id,
      status: r.status,
      goal: r.goal,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      error: r.error,
      toolCallCount: r._count.toolCalls,
      approvalCount: approvals.get(r.id) ?? 0,
    }));

    return { items, total, page: p, pageSize: size };
  }

  /**
   * One session with its audit rows.
   *
   * The lookup is a workspace-scoped `findFirst` that ALSO requires
   * `agent: 'mcp'`, so another tenant's session — and this tenant's non-MCP
   * runs — are both a 404 rather than a partial disclosure.
   */
  async getSession(workspaceId: string, id: string): Promise<McpSessionDetail> {
    const run = await this.prisma.agentRun.findFirst({
      where: { id, workspaceId, agent: MCP_AGENT },
      select: {
        id: true,
        status: true,
        goal: true,
        startedAt: true,
        finishedAt: true,
        error: true,
      },
    });
    if (!run) throw new NotFoundException('MCP session not found');

    const [calls, approvals] = await Promise.all([
      this.prisma.toolCallLog.findMany({
        // `runId` alone would be enough (the run was just proven to be ours),
        // but `workspaceId` is carried on the log row too and pinning it keeps
        // the tenant filter uniform across every read in this service.
        where: { runId: id, workspaceId },
        orderBy: { createdAt: 'asc' },
        take: MCP_SESSION_TOOL_CALL_LIMIT,
        select: {
          id: true,
          tool: true,
          ok: true,
          error: true,
          latencyMs: true,
          createdAt: true,
          args: true,
          result: true,
        },
      }),
      // A tool that hit the approval gate NEVER produced a ToolCallLog row
      // (the broker returns PENDING_APPROVAL before it logs), so "did this go
      // to the approval queue?" can only be answered from the requests this
      // run enqueued. `payload` is deliberately not selected: for an
      // MCP-originated request it is `{ tool, args }`, i.e. exactly the data
      // the tool-call blobs below are stripped of.
      this.prisma.approvalRequest.findMany({
        where: { workspaceId, requestedByRunId: id },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          kind: true,
          status: true,
          summary: true,
          createdAt: true,
          decidedAt: true,
          expiresAt: true,
        },
      }),
    ]);

    return {
      ...run,
      queuedForApproval: approvals.length > 0,
      toolCalls: calls.map((c) => ({
        id: c.id,
        tool: c.tool,
        at: c.createdAt,
        ok: c.ok,
        error: c.error,
        latencyMs: c.latencyMs,
        // BLOB POLICY — decided here, deliberately: `args` and `result` are
        // whole tool payloads and routinely hold customer PII (a lead's
        // email/phone, a message body). This view returns their SIZE plus the
        // top-level argument KEY NAMES, and nothing else. A "first N
        // characters" preview was rejected: the head of a result is precisely
        // where the first customer record sits, so a preview would leak the
        // very thing the truncation exists to contain. The full payloads stay
        // in `tool_call_logs` for a forensic read behind a stronger gate; the
        // console gets enough to answer "which tool, when, did it work, how
        // much data moved".
        argsBytes: jsonByteLength(c.args),
        argsKeys: topLevelKeys(c.args),
        resultBytes: jsonByteLength(c.result),
      })),
      approvals,
    };
  }

  /** How many approval requests each of these runs enqueued (bounded by page). */
  private async approvalCountsByRun(
    workspaceId: string,
    runIds: string[],
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (runIds.length === 0) return counts;
    const rows = await this.prisma.approvalRequest.findMany({
      where: { workspaceId, requestedByRunId: { in: runIds } },
      select: { requestedByRunId: true },
    });
    for (const r of rows) {
      if (!r.requestedByRunId) continue;
      counts.set(r.requestedByRunId, (counts.get(r.requestedByRunId) ?? 0) + 1);
    }
    return counts;
  }
}

/** Serialized size of a recorded blob, in bytes. 0 for null/undefined. */
function jsonByteLength(value: unknown): number {
  if (value === null || value === undefined) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '');
  } catch {
    return 0;
  }
}

/**
 * Top-level key names of a recorded argument object — a schema fact, not
 * customer data. Anything that is not a plain object (an array, a scalar) has
 * no key names worth reporting and yields [].
 */
function topLevelKeys(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>).sort();
}

/** Pull a string field out of a cached CIMD document's free-form metadata. */
function metadataString(metadata: unknown, key: string): string | null {
  const value = (metadata as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
