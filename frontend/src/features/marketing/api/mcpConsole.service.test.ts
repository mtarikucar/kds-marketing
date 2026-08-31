import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./marketingApi', () => ({
  default: { get: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

import marketingApi from './marketingApi';
import {
  getMcpConsoleOverview,
  getMcpConnections,
  revokeMcpOAuthConnection,
  listMcpSessions,
  getMcpSession,
  getMcpWriteMode,
  setMcpWriteMode,
  setResearchExecution,
} from './mcpConsole.service';

const api = marketingApi as unknown as {
  get: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

describe('mcpConsole.service', () => {
  beforeEach(() => vi.clearAllMocks());

  it('getMcpConsoleOverview GETs the overview and passes it through', async () => {
    const overview = {
      mcpWriteMode: 'APPROVAL',
      canToggle: true,
      mcpEndpoint: 'https://app.jeetagrowth.com/api/mcp',
      liveConnectionCount: 2,
      pendingApprovalCount: 3,
    };
    api.get.mockResolvedValue({ data: overview });
    expect(await getMcpConsoleOverview()).toEqual(overview);
    expect(api.get).toHaveBeenCalledWith('/mcp-console/overview');
  });

  it('getMcpConnections GETs both connection kinds', async () => {
    const data = { oauth: [{ kind: 'OAUTH', clientId: 'https://claude.ai/x' }], apiKeys: [] };
    api.get.mockResolvedValue({ data });
    expect(await getMcpConnections()).toEqual(data);
    expect(api.get).toHaveBeenCalledWith('/mcp-console/connections');
  });

  it('revokeMcpOAuthConnection URL-ENCODES the https client_id into one path segment', async () => {
    api.delete.mockResolvedValue({ data: { clientId: 'https://claude.ai/api/mcp/client', revoked: 2 } });

    const res = await revokeMcpOAuthConnection('https://claude.ai/api/mcp/client');

    expect(api.delete).toHaveBeenCalledWith(
      '/mcp-console/connections/oauth/https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fclient',
    );
    // The raw id must NOT leak through unencoded — bare slashes would split the
    // client_id across path segments and miss the route.
    const [url] = api.delete.mock.calls[0] as [string];
    expect(url).not.toContain('https://');
    expect(res).toEqual({ clientId: 'https://claude.ai/api/mcp/client', revoked: 2 });
  });

  it('revokeMcpOAuthConnection encodes a query-ish client_id too', async () => {
    api.delete.mockResolvedValue({ data: { clientId: 'x', revoked: 0 } });
    await revokeMcpOAuthConnection('https://ex.com/c?a=b&c=d');
    expect(api.delete).toHaveBeenCalledWith(
      '/mcp-console/connections/oauth/https%3A%2F%2Fex.com%2Fc%3Fa%3Db%26c%3Dd',
    );
  });

  it('listMcpSessions defaults to page 1 / pageSize 25', async () => {
    api.get.mockResolvedValue({ data: { items: [], total: 0, page: 1, pageSize: 25 } });
    await listMcpSessions();
    expect(api.get).toHaveBeenCalledWith('/mcp-console/sessions', {
      params: { page: 1, pageSize: 25 },
    });
  });

  it('listMcpSessions forwards explicit paging', async () => {
    api.get.mockResolvedValue({ data: { items: [], total: 0, page: 3, pageSize: 10 } });
    const res = await listMcpSessions(3, 10);
    expect(api.get).toHaveBeenCalledWith('/mcp-console/sessions', {
      params: { page: 3, pageSize: 10 },
    });
    expect(res.page).toBe(3);
  });

  it('getMcpSession GETs one session by id', async () => {
    const detail = { id: 'run1', status: 'SUCCESS', toolCalls: [], approvals: [] };
    api.get.mockResolvedValue({ data: detail });
    expect(await getMcpSession('run1')).toEqual(detail);
    expect(api.get).toHaveBeenCalledWith('/mcp-console/sessions/run1');
  });

  it('getMcpWriteMode reads the workspaces endpoint (not mcp-console)', async () => {
    api.get.mockResolvedValue({ data: { mcpWriteMode: 'AUTONOMOUS' } });
    expect(await getMcpWriteMode()).toEqual({ mcpWriteMode: 'AUTONOMOUS' });
    expect(api.get).toHaveBeenCalledWith('/workspaces/mcp-write-mode');
  });

  it('setMcpWriteMode PATCHes { mode } to the workspaces endpoint', async () => {
    api.patch.mockResolvedValue({ data: { mcpWriteMode: 'AUTONOMOUS' } });
    const res = await setMcpWriteMode('AUTONOMOUS');
    expect(api.patch).toHaveBeenCalledWith('/workspaces/mcp-write-mode', { mode: 'AUTONOMOUS' });
    expect(res).toEqual({ mcpWriteMode: 'AUTONOMOUS' });
  });

  it('setMcpWriteMode can tighten the gate back to APPROVAL', async () => {
    api.patch.mockResolvedValue({ data: { mcpWriteMode: 'APPROVAL' } });
    await setMcpWriteMode('APPROVAL');
    expect(api.patch).toHaveBeenCalledWith('/workspaces/mcp-write-mode', { mode: 'APPROVAL' });
  });

  // A DIFFERENT route on the same controller, and a different column. Sending
  // this to `/workspaces/mcp-write-mode` would 400 on the DTO
  // (`@IsIn(['APPROVAL','AUTONOMOUS'])`) rather than silently mis-set — but it
  // is worth pinning, because the two switches now sit on one card stack.
  it('setResearchExecution PATCHes { mode } to its own endpoint', async () => {
    api.patch.mockResolvedValue({ data: { researchExecution: 'MCP' } });
    const res = await setResearchExecution('MCP');
    expect(api.patch).toHaveBeenCalledWith('/workspaces/research-execution', { mode: 'MCP' });
    expect(res).toEqual({ researchExecution: 'MCP' });
  });

  it('setResearchExecution can hand the queue back to the platform', async () => {
    api.patch.mockResolvedValue({ data: { researchExecution: 'SERVER' } });
    await setResearchExecution('SERVER');
    expect(api.patch).toHaveBeenCalledWith('/workspaces/research-execution', { mode: 'SERVER' });
  });
});
