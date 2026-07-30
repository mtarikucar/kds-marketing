import { McpConsoleService } from './mcp-console.service';

/**
 * Faz 4 Task 1 — the connector console's "connected clients" read model.
 *
 * The whole point of these tests is the tenant boundary. Every read here fans
 * out over tables that hold OTHER workspaces' rows (`mcp_oauth_tokens`,
 * `api_keys`), so each assertion below either pins `workspaceId` into the
 * Prisma filter or proves a foreign row cannot be reached/mutated.
 */

type PrismaMock = ReturnType<typeof prismaMock>;

function prismaMock() {
  return {
    mcpOAuthToken: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      delete: jest.fn(),
      deleteMany: jest.fn(),
    },
    mcpOAuthClient: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    agentRun: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
    },
    toolCallLog: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    approvalRequest: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    workspace: {
      findUnique: jest.fn().mockResolvedValue({ mcpWriteMode: 'APPROVAL' }),
    },
  };
}

function deps() {
  const prisma = prismaMock();
  const apiKeys = { list: jest.fn().mockResolvedValue([]) };
  const roles = { hasPermission: jest.fn().mockResolvedValue(true) };
  const config = { get: jest.fn().mockReturnValue('https://app.jeetagrowth.com') };
  const svc = new McpConsoleService(
    prisma as never,
    apiKeys as never,
    roles as never,
    config as never,
  );
  return { svc, prisma, apiKeys, roles, config };
}

/** Every `where` object handed to Prisma across the whole mock, flattened. */
function allWheres(prisma: PrismaMock): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const model of Object.values(prisma)) {
    for (const fn of Object.values(model)) {
      for (const call of (fn as jest.Mock).mock.calls) {
        const where = (call[0] as { where?: Record<string, unknown> })?.where;
        if (where) out.push(where);
      }
    }
  }
  return out;
}

const liveToken = (over: Partial<Record<string, unknown>> = {}) => ({
  clientId: 'https://claude.ai/mcp',
  type: 'ACCESS',
  scopes: ['leads.read'],
  createdAt: new Date('2026-07-20T10:00:00Z'),
  ...over,
});

describe('McpConsoleService — connections', () => {
  it('lists a connected OAuth client with its CIMD identity, the scope union and a live-token count', async () => {
    const { svc, prisma } = deps();
    prisma.mcpOAuthToken.findMany.mockResolvedValue([
      liveToken({ scopes: ['leads.read'], createdAt: new Date('2026-07-20T10:00:00Z') }),
      liveToken({ type: 'REFRESH', scopes: ['campaigns.read', 'leads.read'], createdAt: new Date('2026-07-22T09:00:00Z') }),
    ]);
    prisma.mcpOAuthToken.findFirst.mockResolvedValue({ createdAt: new Date('2026-07-01T08:00:00Z') });
    prisma.mcpOAuthClient.findMany.mockResolvedValue([
      {
        clientId: 'https://claude.ai/mcp',
        clientName: 'Claude',
        metadata: { logo_uri: 'https://claude.ai/logo.png', client_uri: 'https://claude.ai' },
      },
    ]);

    const res = await svc.listConnections('ws-a');

    expect(res.oauth).toEqual([
      {
        kind: 'OAUTH',
        clientId: 'https://claude.ai/mcp',
        clientName: 'Claude',
        logoUri: 'https://claude.ai/logo.png',
        clientUri: 'https://claude.ai',
        scopes: ['campaigns.read', 'leads.read'],
        connectedAt: new Date('2026-07-01T08:00:00Z'),
        lastActivityAt: new Date('2026-07-22T09:00:00Z'),
        liveTokenCount: 2,
      },
    ]);
  });

  it('counts only non-revoked, unexpired tokens as live', async () => {
    const { svc, prisma } = deps();
    await svc.listConnections('ws-a');

    const where = prisma.mcpOAuthToken.findMany.mock.calls[0][0].where;
    expect(where.workspaceId).toBe('ws-a');
    expect(where.revokedAt).toBeNull();
    expect((where.expiresAt as { gt: Date }).gt).toBeInstanceOf(Date);
  });

  it('returns no OAuth connection when every token is revoked or expired', async () => {
    const { svc, prisma } = deps();
    // The live filter matches nothing — a fully-revoked client is not connected.
    prisma.mcpOAuthToken.findMany.mockResolvedValue([]);

    const res = await svc.listConnections('ws-a');

    expect(res.oauth).toEqual([]);
    // No point resolving CIMD documents for zero clients.
    expect(prisma.mcpOAuthClient.findMany).not.toHaveBeenCalled();
  });

  it('scopes every read to the caller workspace — workspace B is unreachable from A', async () => {
    const { svc, prisma } = deps();
    prisma.mcpOAuthToken.findMany.mockResolvedValue([liveToken()]);

    await svc.listConnections('ws-a');

    const wheres = allWheres(prisma);
    expect(wheres.length).toBeGreaterThan(0);
    for (const where of wheres) {
      // The CIMD document cache is the one exception: it is a global cache of
      // PUBLIC client metadata keyed by the ids we just derived FROM ws-a's
      // own tokens, so it carries no tenant column to scope by.
      if ('clientId' in where && !('workspaceId' in where) && typeof where.clientId === 'object') continue;
      expect(where.workspaceId).toBe('ws-a');
    }
  });

  it('resolves the CIMD document cache only for ids derived from this workspace', async () => {
    const { svc, prisma } = deps();
    prisma.mcpOAuthToken.findMany.mockResolvedValue([
      liveToken({ clientId: 'https://a.example/mcp' }),
      liveToken({ clientId: 'https://a.example/mcp' }),
    ]);

    await svc.listConnections('ws-a');

    expect(prisma.mcpOAuthClient.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { clientId: { in: ['https://a.example/mcp'] } } }),
    );
  });

  it('falls back to the client_id URL when no CIMD document is cached', async () => {
    const { svc, prisma } = deps();
    prisma.mcpOAuthToken.findMany.mockResolvedValue([liveToken({ clientId: 'https://x.example/mcp' })]);
    prisma.mcpOAuthClient.findMany.mockResolvedValue([]);
    prisma.mcpOAuthToken.findFirst.mockResolvedValue({ createdAt: new Date('2026-07-20T10:00:00Z') });

    const res = await svc.listConnections('ws-a');

    expect(res.oauth[0]).toMatchObject({
      clientId: 'https://x.example/mcp',
      clientName: null,
      logoUri: null,
      clientUri: null,
    });
  });

  it('lists ACTIVE API keys as a second kind of connection and never their material or hash', async () => {
    const { svc, apiKeys } = deps();
    apiKeys.list.mockResolvedValue([
      {
        id: 'key-1',
        name: 'Claude Code',
        prefix: 'mk_live_AbCdEfGh',
        scopes: ['read', 'write'],
        status: 'ACTIVE',
        lastUsedAt: new Date('2026-07-25T12:00:00Z'),
        createdAt: new Date('2026-07-01T12:00:00Z'),
        revokedAt: null,
      },
    ]);

    const res = await svc.listConnections('ws-a');

    expect(apiKeys.list).toHaveBeenCalledWith('ws-a');
    expect(res.apiKeys).toEqual([
      {
        kind: 'API_KEY',
        id: 'key-1',
        name: 'Claude Code',
        scopes: ['read', 'write'],
        lastUsedAt: new Date('2026-07-25T12:00:00Z'),
        createdAt: new Date('2026-07-01T12:00:00Z'),
      },
    ]);
    // Not even the 16-char `prefix` leaves the service: it is a literal
    // substring of the live secret.
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain('mk_live_');
    expect(serialized).not.toContain('keyHash');
    expect(serialized).not.toContain('prefix');
  });

  it('omits revoked API keys — a revoked key is not a connection', async () => {
    const { svc, apiKeys } = deps();
    apiKeys.list.mockResolvedValue([
      { id: 'k1', name: 'live', prefix: 'mk_live_a', scopes: [], status: 'ACTIVE', lastUsedAt: null, createdAt: new Date(), revokedAt: null },
      { id: 'k2', name: 'dead', prefix: 'mk_live_b', scopes: [], status: 'REVOKED', lastUsedAt: null, createdAt: new Date(), revokedAt: new Date() },
    ]);

    const res = await svc.listConnections('ws-a');

    expect(res.apiKeys.map((k) => k.id)).toEqual(['k1']);
  });

  it('tolerates a non-array `scopes` JSON column on an API key', async () => {
    const { svc, apiKeys } = deps();
    apiKeys.list.mockResolvedValue([
      { id: 'k1', name: 'weird', prefix: 'mk_live_a', scopes: null, status: 'ACTIVE', lastUsedAt: null, createdAt: new Date(), revokedAt: null },
    ]);

    const res = await svc.listConnections('ws-a');

    expect(res.apiKeys[0].scopes).toEqual([]);
  });
});

describe('McpConsoleService — revokeOAuthClient', () => {
  it('revokes every not-yet-revoked token of that client in THIS workspace, without deleting rows', async () => {
    const { svc, prisma } = deps();
    prisma.mcpOAuthToken.updateMany.mockResolvedValue({ count: 3 });

    const res = await svc.revokeOAuthClient('ws-a', 'https://claude.ai/mcp');

    expect(prisma.mcpOAuthToken.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: 'ws-a', clientId: 'https://claude.ai/mcp', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(res).toEqual({ clientId: 'https://claude.ai/mcp', revoked: 3 });
    // The audit trail must survive a disconnect.
    expect(prisma.mcpOAuthToken.delete).not.toHaveBeenCalled();
    expect(prisma.mcpOAuthToken.deleteMany).not.toHaveBeenCalled();
  });

  it('is idempotent — a second revoke reports 0 and still succeeds', async () => {
    const { svc, prisma } = deps();
    prisma.mcpOAuthToken.updateMany.mockResolvedValue({ count: 0 });

    await expect(svc.revokeOAuthClient('ws-a', 'https://claude.ai/mcp')).resolves.toEqual({
      clientId: 'https://claude.ai/mcp',
      revoked: 0,
    });
  });

  it("cannot revoke another workspace's client — the filter pins the caller's workspaceId", async () => {
    const { svc, prisma } = deps();
    // Simulates the real DB: ws-b's rows do not match a ws-a-scoped updateMany.
    prisma.mcpOAuthToken.updateMany.mockResolvedValue({ count: 0 });

    const res = await svc.revokeOAuthClient('ws-a', 'https://only-in-ws-b.example/mcp');

    expect(prisma.mcpOAuthToken.updateMany.mock.calls[0][0].where.workspaceId).toBe('ws-a');
    expect(res.revoked).toBe(0);
  });

  it('refuses a blank clientId instead of building an unscoped filter', async () => {
    const { svc, prisma } = deps();

    await expect(svc.revokeOAuthClient('ws-a', '   ')).rejects.toThrow();
    expect(prisma.mcpOAuthToken.updateMany).not.toHaveBeenCalled();
  });
});
