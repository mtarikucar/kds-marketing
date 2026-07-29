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

/** What McpTokenVerifierService produces on the OAuth path: a real human. */
const oauthAuthInfo = (workspaceId: string, userId: string, scopes: string[] = ['leads.read']): AuthInfo =>
  ({
    token: 'mcp_at_x',
    clientId: 'https://claude.ai/api/mcp/client',
    scopes,
    expiresAt: Math.floor(Date.now() / 1000) + 60,
    extra: { workspaceId, userId, oauthTokenId: 'tok-1' },
  }) as AuthInfo;

function deps(membership: unknown = { id: 'm1', workspaceId: 'ws1', role: 'REP', customRoleId: null }) {
  const invoke = jest.fn().mockResolvedValue({ status: 'OK', result: { ok: 1 } });
  const track = jest.fn(async (_ws: string, _input: unknown, fn: (runId: string) => Promise<unknown>) => fn('run-1'));
  const getActiveMembership = jest.fn().mockResolvedValue(membership);
  const invoker = new McpInvokerService(
    { invoke } as any,
    { track } as any,
    { workspace: { findUnique: jest.fn().mockResolvedValue({ mcpWriteMode: 'APPROVAL' }) } } as any,
    { getActiveMembership } as any,
  );
  return { invoker, invoke, track, getActiveMembership };
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

  /**
   * Faz 3 Task 8. An OAuth token names the human who consented; the tool
   * context must carry that human AND the role they hold in THIS workspace,
   * so row-level visibility (leads.tools) is the caller's own.
   *
   * The role is resolved per call, not read off the token: consent happened
   * once, possibly weeks ago, and a demotion since then must take effect on
   * the very next tool call.
   */
  it('carries the real user and their workspace role into the broker context on an OAuth session', async () => {
    const { invoker, invoke, getActiveMembership } = deps();
    await invoker.invoke(oauthAuthInfo('ws1', 'u9'), 'jeeta.search_leads', {});
    expect(getActiveMembership).toHaveBeenCalledWith('u9', 'ws1');
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws1', userId: 'u9', userRole: 'REP' }),
      'jeeta.search_leads',
      {},
    );
  });

  it('leaves an API-key session with no user principal at all (regression)', async () => {
    const { invoker, invoke, getActiveMembership } = deps();
    await invoker.invoke(authInfo('ws1', ['leads.read']), 'jeeta.search_leads', {});
    // No user to resolve — the membership lookup must not even be attempted.
    expect(getActiveMembership).not.toHaveBeenCalled();
    const ctx = invoke.mock.calls[0][0];
    expect(ctx.userId).toBeUndefined();
    expect(ctx.userRole).toBeUndefined();
  });

  it('refuses an OAuth session whose membership is no longer active', async () => {
    // Consent is not a standing grant: removing someone from the workspace has
    // to cut off the connector they authorised while they were a member, on
    // the next call, without anyone having to hunt down their tokens.
    const { invoker, invoke } = deps(null);
    await expect(invoker.invoke(oauthAuthInfo('ws1', 'u9'), 'jeeta.search_leads', {})).rejects.toThrow(
      /member/i,
    );
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
