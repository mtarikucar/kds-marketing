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
  const invoker = new McpInvokerService(
    { invoke } as any,
    { track } as any,
    { workspace: { findUnique: jest.fn().mockResolvedValue({ mcpWriteMode: 'APPROVAL' }) } } as any,
  );
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

  // H1 (ungated path): mirrors mcp-approval-executor.service.spec.ts's
  // regression test. The plain `fn => fn('run-1')` mock above can never
  // exercise AgentRunService.track's real shape — call fn(), THEN await its
  // own finish() write, which can itself throw. Without the fix, that throw
  // propagates out of invoke() and McpServerFactoryService.handlerFor turns
  // ANY thrown error into `isError: true`, inviting the calling model to
  // retry a call whose side effect (send/publish/spend) already landed.
  it('H1: a post-execution bookkeeping failure after the broker call already succeeded returns the real result, not an error', async () => {
    const { invoker, invoke, track } = deps();
    invoke.mockResolvedValue({ status: 'OK', result: { sent: true } });
    track.mockImplementation(async (_ws: string, _input: unknown, fn: (runId: string) => Promise<unknown>) => {
      await fn('run-1'); // the tool call succeeds inside fn()
      throw new Error('agent_runs UPDATE failed (simulated DB failover)'); // finish() throws AFTER
    });

    await expect(invoker.invoke(authInfo('ws1'), 'jeeta.send_message', { conversationId: 'c1', body: 'hi' })).resolves.toEqual({
      status: 'OK',
      result: { sent: true },
    });
    expect(invoke).toHaveBeenCalledTimes(1); // the tool ran exactly once — no retry-shaped double call
  });

  it('H1: a bookkeeping failure BEFORE the broker call resolves OK (e.g. PENDING_APPROVAL) still propagates as an error', async () => {
    const { invoker, invoke, track } = deps();
    invoke.mockResolvedValue({ status: 'PENDING_APPROVAL', approvalId: 'appr-1' }); // nothing executed
    track.mockImplementation(async (_ws: string, _input: unknown, fn: (runId: string) => Promise<unknown>) => {
      await fn('run-1');
      throw new Error('agent_runs UPDATE failed');
    });

    await expect(invoker.invoke(authInfo('ws1'), 'jeeta.reallocate_budget', {})).rejects.toThrow('agent_runs UPDATE failed');
  });
});
