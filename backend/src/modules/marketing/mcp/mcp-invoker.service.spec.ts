import { McpInvokerService } from './mcp-invoker.service';
import type { AuthInfo } from '@modelcontextprotocol/server';

const authInfo = (workspaceId: string | undefined, scopes: string[] = ['reports.read']): AuthInfo =>
  ({
    token: 't',
    clientId: 'k1',
    scopes,
    expiresAt: Math.floor(Date.now() / 1000) + 60,
    extra: workspaceId ? { workspaceId, apiKeyId: 'k1' } : {},
  }) as AuthInfo;

function deps() {
  const invoke = jest.fn().mockResolvedValue({ status: 'OK', result: { ok: 1 } });
  const track = jest.fn(async (_ws: string, _input: unknown, fn: (runId: string) => Promise<unknown>) => fn('run-1'));
  const invoker = new McpInvokerService({ invoke } as any, { track } as any);
  return { invoker, invoke, track };
}

describe('McpInvokerService', () => {
  it('opens an AgentRun and passes its id to the broker', async () => {
    const { invoker, invoke, track } = deps();
    await invoker.invoke(authInfo('ws1'), 'jeeta.get_funnel', { days: 7 });
    expect(track).toHaveBeenCalledWith('ws1', expect.objectContaining({ agent: 'mcp', goal: 'jeeta.get_funnel' }), expect.any(Function));
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws1', agentRunId: 'run-1' }),
      'jeeta.get_funnel',
      { days: 7 },
    );
  });

  it('forwards the granted scopes to the broker context', async () => {
    const { invoker, invoke } = deps();
    await invoker.invoke(authInfo('ws1', ['leads.read']), 'jeeta.search_leads', {});
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ grantedScopes: ['leads.read'] }), 'jeeta.search_leads', {});
  });

  it('returns the broker result unchanged', async () => {
    const { invoker } = deps();
    await expect(invoker.invoke(authInfo('ws1'), 'jeeta.get_funnel', {})).resolves.toEqual({ status: 'OK', result: { ok: 1 } });
  });

  it('refuses to invoke when the token carries no workspace', async () => {
    const { invoker, invoke } = deps();
    await expect(invoker.invoke(authInfo(undefined), 'jeeta.get_funnel', {})).rejects.toThrow(/workspace/i);
    expect(invoke).not.toHaveBeenCalled();
  });
});
