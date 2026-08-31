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

/**
 * Faz 4 Task 2 — the session + audit view over AgentRun/ToolCallLog.
 *
 * `McpInvokerService` opens ONE AgentRun per MCP tool call with
 * `agent: 'mcp'`; runs from every other agent (researcher, strategist, the
 * Budget Autopilot, …) share those tables and must never leak in here.
 */
const run = (over: Record<string, unknown> = {}) => ({
  id: 'run-1',
  status: 'DONE',
  goal: 'jeeta.search_leads',
  startedAt: new Date('2026-07-25T10:00:00Z'),
  finishedAt: new Date('2026-07-25T10:00:02Z'),
  error: null,
  _count: { toolCalls: 1 },
  ...over,
});

describe('McpConsoleService — listSessions', () => {
  it('returns the workspace\'s MCP runs newest-first with a tool-call count', async () => {
    const { svc, prisma } = deps();
    prisma.agentRun.findMany.mockResolvedValue([run()]);
    prisma.agentRun.count.mockResolvedValue(1);

    const res = await svc.listSessions('ws-a', 1, 25);

    expect(prisma.agentRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: 'ws-a', agent: 'mcp' },
        orderBy: { startedAt: 'desc' },
        skip: 0,
        take: 25,
      }),
    );
    expect(res).toEqual({
      items: [
        {
          id: 'run-1',
          status: 'DONE',
          goal: 'jeeta.search_leads',
          startedAt: new Date('2026-07-25T10:00:00Z'),
          finishedAt: new Date('2026-07-25T10:00:02Z'),
          error: null,
          toolCallCount: 1,
          approvalCount: 0,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 25,
    });
  });

  it("excludes non-MCP AgentRuns — the filter pins agent: 'mcp' on BOTH the page and the total", async () => {
    const { svc, prisma } = deps();

    await svc.listSessions('ws-a');

    expect(prisma.agentRun.findMany.mock.calls[0][0].where).toEqual({ workspaceId: 'ws-a', agent: 'mcp' });
    expect(prisma.agentRun.count.mock.calls[0][0].where).toEqual({ workspaceId: 'ws-a', agent: 'mcp' });
  });

  it('caps the page size server-side — a caller cannot ask for 100000 rows', async () => {
    const { svc, prisma } = deps();

    const res = await svc.listSessions('ws-a', 1, 100_000);

    expect(prisma.agentRun.findMany.mock.calls[0][0].take).toBe(100);
    expect(res.pageSize).toBe(100);
  });

  it('coerces garbage paging input instead of handing Prisma a NaN skip', async () => {
    const { svc, prisma } = deps();

    const res = await svc.listSessions('ws-a', 'abc', 'xyz');

    expect(res.page).toBe(1);
    expect(res.pageSize).toBe(25);
    expect(prisma.agentRun.findMany.mock.calls[0][0].skip).toBe(0);
  });

  it('offsets by page', async () => {
    const { svc, prisma } = deps();

    await svc.listSessions('ws-a', 3, 10);

    expect(prisma.agentRun.findMany.mock.calls[0][0].skip).toBe(20);
  });

  it('marks a run whose tool went to the approval queue (0 tool calls is not 0 activity)', async () => {
    const { svc, prisma } = deps();
    prisma.agentRun.findMany.mockResolvedValue([run({ id: 'run-9', _count: { toolCalls: 0 } })]);
    prisma.agentRun.count.mockResolvedValue(1);
    prisma.approvalRequest.findMany.mockResolvedValue([{ requestedByRunId: 'run-9' }]);

    const res = await svc.listSessions('ws-a');

    expect(res.items[0]).toMatchObject({ toolCallCount: 0, approvalCount: 1 });
    // The approval lookup is workspace-scoped AND restricted to this page.
    expect(prisma.approvalRequest.findMany.mock.calls[0][0].where).toEqual({
      workspaceId: 'ws-a',
      requestedByRunId: { in: ['run-9'] },
    });
  });

  it('skips the approval lookup entirely on an empty page', async () => {
    const { svc, prisma } = deps();
    prisma.agentRun.findMany.mockResolvedValue([]);

    await svc.listSessions('ws-a');

    expect(prisma.approvalRequest.findMany).not.toHaveBeenCalled();
  });
});

describe('McpConsoleService — getSession', () => {
  const call = (over: Record<string, unknown> = {}) => ({
    id: 'tc-1',
    tool: 'jeeta.search_leads',
    ok: true,
    error: null,
    latencyMs: 42,
    createdAt: new Date('2026-07-25T10:00:01Z'),
    args: { query: 'ada@lovelace.example', limit: 10 },
    result: { items: [{ email: 'ada@lovelace.example', phone: '+905551112233' }] },
    ...over,
  });

  it('404s a session that belongs to another workspace', async () => {
    const { svc, prisma } = deps();
    // ws-b's run does not match a ws-a-scoped findFirst.
    prisma.agentRun.findFirst.mockResolvedValue(null);

    await expect(svc.getSession('ws-a', 'run-in-ws-b')).rejects.toMatchObject({ status: 404 });
    expect(prisma.agentRun.findFirst.mock.calls[0][0].where).toEqual({
      id: 'run-in-ws-b',
      workspaceId: 'ws-a',
      agent: 'mcp',
    });
    expect(prisma.toolCallLog.findMany).not.toHaveBeenCalled();
  });

  it('404s a non-MCP AgentRun of this workspace too', async () => {
    const { svc, prisma } = deps();
    prisma.agentRun.findFirst.mockResolvedValue(null);

    await expect(svc.getSession('ws-a', 'strategist-run')).rejects.toMatchObject({ status: 404 });
    expect(prisma.agentRun.findFirst.mock.calls[0][0].where.agent).toBe('mcp');
  });

  it('returns only the requested run\'s tool calls, scoped to the workspace', async () => {
    const { svc, prisma } = deps();
    prisma.agentRun.findFirst.mockResolvedValue({
      id: 'run-1',
      status: 'DONE',
      goal: 'jeeta.search_leads',
      startedAt: new Date('2026-07-25T10:00:00Z'),
      finishedAt: new Date('2026-07-25T10:00:02Z'),
      error: null,
    });
    prisma.toolCallLog.findMany.mockResolvedValue([call()]);

    const res = await svc.getSession('ws-a', 'run-1');

    expect(prisma.toolCallLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { runId: 'run-1', workspaceId: 'ws-a' },
        orderBy: { createdAt: 'asc' },
      }),
    );
    expect(res.id).toBe('run-1');
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0]).toMatchObject({
      id: 'tc-1',
      tool: 'jeeta.search_leads',
      ok: true,
      latencyMs: 42,
      at: new Date('2026-07-25T10:00:01Z'),
    });
  });

  it('caps the number of tool-call rows returned for one session', async () => {
    const { svc, prisma } = deps();
    prisma.agentRun.findFirst.mockResolvedValue({ id: 'run-1', status: 'DONE', goal: 'x', startedAt: new Date(), finishedAt: null, error: null });

    await svc.getSession('ws-a', 'run-1');

    expect(prisma.toolCallLog.findMany.mock.calls[0][0].take).toBe(200);
  });

  it('never returns the raw args/result blobs — only a size and the arg KEY NAMES', async () => {
    const { svc, prisma } = deps();
    prisma.agentRun.findFirst.mockResolvedValue({ id: 'run-1', status: 'DONE', goal: 'x', startedAt: new Date(), finishedAt: null, error: null });
    prisma.toolCallLog.findMany.mockResolvedValue([call()]);

    const res = await svc.getSession('ws-a', 'run-1');

    expect(res.toolCalls[0]).toMatchObject({
      argsKeys: ['limit', 'query'],
      argsBytes: Buffer.byteLength(JSON.stringify({ query: 'ada@lovelace.example', limit: 10 })),
      resultBytes: Buffer.byteLength(JSON.stringify({ items: [{ email: 'ada@lovelace.example', phone: '+905551112233' }] })),
    });
    // The customer data inside those blobs never crosses the wire.
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain('ada@lovelace.example');
    expect(serialized).not.toContain('905551112233');
    expect(res.toolCalls[0]).not.toHaveProperty('args');
    expect(res.toolCalls[0]).not.toHaveProperty('result');
    expect(res.toolCalls[0]).not.toHaveProperty('argsPreview');
    expect(res.toolCalls[0]).not.toHaveProperty('resultPreview');
  });

  it('reports zero bytes and no keys for a null args/result', async () => {
    const { svc, prisma } = deps();
    prisma.agentRun.findFirst.mockResolvedValue({ id: 'run-1', status: 'DONE', goal: 'x', startedAt: new Date(), finishedAt: null, error: null });
    prisma.toolCallLog.findMany.mockResolvedValue([call({ args: null, result: null })]);

    const res = await svc.getSession('ws-a', 'run-1');

    expect(res.toolCalls[0]).toMatchObject({ argsBytes: 0, argsKeys: [], resultBytes: 0 });
  });

  it('reports a size but no keys for a non-object args payload', async () => {
    const { svc, prisma } = deps();
    prisma.agentRun.findFirst.mockResolvedValue({ id: 'run-1', status: 'DONE', goal: 'x', startedAt: new Date(), finishedAt: null, error: null });
    prisma.toolCallLog.findMany.mockResolvedValue([call({ args: ['a', 'b'], result: 'plain' })]);

    const res = await svc.getSession('ws-a', 'run-1');

    expect(res.toolCalls[0]).toMatchObject({ argsKeys: [], argsBytes: 9, resultBytes: 7 });
  });

  it('surfaces the linked approval requests without their payload', async () => {
    const { svc, prisma } = deps();
    prisma.agentRun.findFirst.mockResolvedValue({ id: 'run-1', status: 'DONE', goal: 'x', startedAt: new Date(), finishedAt: null, error: null });
    prisma.approvalRequest.findMany.mockResolvedValue([
      { id: 'appr-1', kind: 'SEND', status: 'PENDING', summary: 'MCP agent requested "jeeta.send_message"', createdAt: new Date(), decidedAt: null, expiresAt: new Date() },
    ]);

    const res = await svc.getSession('ws-a', 'run-1');

    expect(res.queuedForApproval).toBe(true);
    expect(res.approvals).toHaveLength(1);
    expect(prisma.approvalRequest.findMany.mock.calls[0][0].where).toEqual({
      workspaceId: 'ws-a',
      requestedByRunId: 'run-1',
    });
    // `payload` is `{ tool, args }` for an MCP request — the same data the
    // tool-call blobs above are stripped of.
    expect(prisma.approvalRequest.findMany.mock.calls[0][0].select).not.toHaveProperty('payload');
    expect(JSON.stringify(res)).not.toContain('"payload"');
  });

  it('reports queuedForApproval false when nothing was enqueued', async () => {
    const { svc, prisma } = deps();
    prisma.agentRun.findFirst.mockResolvedValue({ id: 'run-1', status: 'DONE', goal: 'x', startedAt: new Date(), finishedAt: null, error: null });

    const res = await svc.getSession('ws-a', 'run-1');

    expect(res.queuedForApproval).toBe(false);
    expect(res.approvals).toEqual([]);
  });
});

/**
 * Faz 4 Task 3 — the write-mode read model. The TOGGLE already lives on
 * MarketingWorkspacesController; `canToggle` exists so the console renders it
 * honestly instead of offering a switch the real endpoint would 403.
 */
describe('McpConsoleService — overview', () => {
  const owner = { role: 'OWNER', customRoleId: null };

  it('reports the current write mode, the endpoint and the live counts', async () => {
    const { svc, prisma, apiKeys } = deps();
    prisma.workspace.findUnique.mockResolvedValue({ mcpWriteMode: 'AUTONOMOUS' });
    prisma.mcpOAuthToken.findMany.mockResolvedValue([liveToken()]);
    prisma.mcpOAuthToken.findFirst.mockResolvedValue({ createdAt: new Date('2026-07-01T00:00:00Z') });
    apiKeys.list.mockResolvedValue([
      { id: 'k1', name: 'cc', prefix: 'mk_live_a', scopes: [], status: 'ACTIVE', lastUsedAt: null, createdAt: new Date(), revokedAt: null },
      { id: 'k2', name: 'dead', prefix: 'mk_live_b', scopes: [], status: 'REVOKED', lastUsedAt: null, createdAt: new Date(), revokedAt: new Date() },
    ]);

    const res = await svc.overview('ws-a', owner);

    expect(res).toEqual({
      mcpWriteMode: 'AUTONOMOUS',
      researchExecution: 'SERVER',
      canToggle: true,
      mcpEndpoint: 'https://app.jeetagrowth.com/api/mcp',
      liveConnectionCount: 2, // 1 live OAuth client + 1 ACTIVE api key
      pendingApprovalCount: 0,
    });
    expect(prisma.workspace.findUnique.mock.calls[0][0].where).toEqual({ id: 'ws-a' });
  });

  /**
   * The research-execution switch reads through the SAME overview for the same
   * reason the write mode does: `GET marketing/workspaces/research-execution`
   * is OWNER-only and `@Audit`-logged, so a MANAGER opening the console would
   * be 403d off the page and every page load would write an audit row. Read
   * here, MANAGER-visible, with `canToggle` — whose gate (OWNER +
   * `settings.manage`) is identical to `setResearchExecution`'s — deciding
   * whether the switch is offered.
   */
  it('reports which side drains the nightly research queue', async () => {
    const { svc, prisma } = deps();
    prisma.workspace.findUnique.mockResolvedValue({
      mcpWriteMode: 'APPROVAL',
      researchExecution: 'MCP',
    });

    await expect(svc.overview('ws-a', owner)).resolves.toMatchObject({
      researchExecution: 'MCP',
    });
    expect(prisma.workspace.findUnique.mock.calls[0][0].select).toMatchObject({
      researchExecution: true,
    });
  });

  it('falls back to SERVER for an unset/unknown researchExecution', async () => {
    // Same fail-safe direction as `ResearchLeaseService.modeFor`: anything that
    // is not exactly 'MCP' means the platform is still draining. Guessing MCP
    // here would draw a switch claiming the owner's Claude is responsible for a
    // queue the platform is in fact still working.
    const { svc, prisma } = deps();
    prisma.workspace.findUnique.mockResolvedValue({
      mcpWriteMode: 'APPROVAL',
      researchExecution: 'nonsense',
    });

    await expect(svc.overview('ws-a', owner)).resolves.toMatchObject({
      researchExecution: 'SERVER',
    });
  });

  it('falls back to APPROVAL for an unset/unknown stored mode', async () => {
    const { svc, prisma } = deps();
    prisma.workspace.findUnique.mockResolvedValue({ mcpWriteMode: null });

    await expect(svc.overview('ws-a', owner)).resolves.toMatchObject({ mcpWriteMode: 'APPROVAL' });
  });

  it('degrades mcpEndpoint to null when PUBLIC_BASE_URL is unset instead of 503ing the console', async () => {
    const { svc, config } = deps();
    config.get.mockReturnValue(undefined);

    await expect(svc.overview('ws-a', owner)).resolves.toMatchObject({ mcpEndpoint: null });
  });

  describe('canToggle mirrors the setMcpWriteMode gate', () => {
    it('is true for an OWNER holding settings.manage', async () => {
      const { svc, roles } = deps();
      roles.hasPermission.mockResolvedValue(true);

      await expect(svc.overview('ws-a', { role: 'OWNER', customRoleId: null })).resolves.toMatchObject({
        canToggle: true,
      });
      expect(roles.hasPermission).toHaveBeenCalledWith(
        { workspaceId: 'ws-a', role: 'OWNER', customRoleId: null },
        'settings.manage',
      );
    });

    it('is false for a MANAGER even though MANAGER holds settings.manage', async () => {
      const { svc, roles } = deps();
      // The real endpoint is @MarketingRoles('OWNER'): the permission alone
      // would let a legacy MANAGER through, so the rank check must come first.
      roles.hasPermission.mockResolvedValue(true);

      await expect(svc.overview('ws-a', { role: 'MANAGER', customRoleId: null })).resolves.toMatchObject({
        canToggle: false,
      });
      expect(roles.hasPermission).not.toHaveBeenCalled();
    });

    it('is false for a REP', async () => {
      const { svc } = deps();
      await expect(svc.overview('ws-a', { role: 'REP', customRoleId: null })).resolves.toMatchObject({
        canToggle: false,
      });
    });

    it('is false for an OWNER-rank user whose custom role strips settings.manage', async () => {
      const { svc, roles } = deps();
      roles.hasPermission.mockResolvedValue(false);

      await expect(
        svc.overview('ws-a', { role: 'OWNER', customRoleId: 'cr-restricted' }),
      ).resolves.toMatchObject({ canToggle: false });
      expect(roles.hasPermission).toHaveBeenCalledWith(
        { workspaceId: 'ws-a', role: 'OWNER', customRoleId: 'cr-restricted' },
        'settings.manage',
      );
    });
  });

  describe('pendingApprovalCount', () => {
    it('counts only PENDING requests raised by an MCP run of THIS workspace', async () => {
      const { svc, prisma } = deps();
      prisma.approvalRequest.findMany.mockResolvedValue([
        { requestedByRunId: 'run-mcp' },
        { requestedByRunId: 'run-autopilot' },
      ]);
      // Only run-mcp is an agent:'mcp' run.
      prisma.agentRun.findMany.mockResolvedValue([{ id: 'run-mcp' }]);

      const res = await svc.overview('ws-a', owner);

      expect(res.pendingApprovalCount).toBe(1);
      expect(prisma.approvalRequest.findMany.mock.calls[0][0].where).toEqual({
        workspaceId: 'ws-a',
        status: 'PENDING',
        requestedByRunId: { not: null },
      });
      expect(prisma.agentRun.findMany.mock.calls[0][0].where).toEqual({
        workspaceId: 'ws-a',
        agent: 'mcp',
        id: { in: ['run-mcp', 'run-autopilot'] },
      });
    });

    it('counts every PENDING request of the same MCP run', async () => {
      const { svc, prisma } = deps();
      prisma.approvalRequest.findMany.mockResolvedValue([
        { requestedByRunId: 'run-mcp' },
        { requestedByRunId: 'run-mcp' },
      ]);
      prisma.agentRun.findMany.mockResolvedValue([{ id: 'run-mcp' }]);

      await expect(svc.overview('ws-a', owner)).resolves.toMatchObject({ pendingApprovalCount: 2 });
    });

    it('is 0 — with no second query — when nothing is pending', async () => {
      const { svc, prisma } = deps();
      prisma.approvalRequest.findMany.mockResolvedValue([]);

      const res = await svc.overview('ws-a', owner);

      expect(res.pendingApprovalCount).toBe(0);
      expect(prisma.agentRun.findMany).not.toHaveBeenCalled();
    });

    it('is 0 when every pending request came from a non-MCP run', async () => {
      const { svc, prisma } = deps();
      prisma.approvalRequest.findMany.mockResolvedValue([{ requestedByRunId: 'run-autopilot' }]);
      prisma.agentRun.findMany.mockResolvedValue([]); // no matching agent:'mcp' run

      await expect(svc.overview('ws-a', owner)).resolves.toMatchObject({ pendingApprovalCount: 0 });
    });
  });

  it('keeps every overview read inside the caller workspace', async () => {
    const { svc, prisma } = deps();
    prisma.mcpOAuthToken.findMany.mockResolvedValue([liveToken()]);
    prisma.approvalRequest.findMany.mockResolvedValue([{ requestedByRunId: 'run-mcp' }]);
    prisma.agentRun.findMany.mockResolvedValue([{ id: 'run-mcp' }]);

    await svc.overview('ws-a', owner);

    for (const where of allWheres(prisma)) {
      // The workspace row itself is keyed by id, and the CIMD document cache
      // has no tenant column (see the connections tests).
      if (where.id === 'ws-a') continue;
      if ('clientId' in where && !('workspaceId' in where) && typeof where.clientId === 'object') continue;
      expect(where.workspaceId).toBe('ws-a');
    }
  });
});
