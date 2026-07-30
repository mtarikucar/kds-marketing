import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { ApiKeysService } from '../services/api-keys.service';
import { RolesService } from '../roles/roles.service';

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
}

/** Pull a string field out of a cached CIMD document's free-form metadata. */
function metadataString(metadata: unknown, key: string): string | null {
  const value = (metadata as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
