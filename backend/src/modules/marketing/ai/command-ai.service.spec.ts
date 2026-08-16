import { z } from 'zod';
import { ServiceUnavailableException } from '@nestjs/common';
import { CommandAiService } from './command-ai.service';
import { creditCost } from './ai-credit-costs';

/**
 * The command bar is the one surface where a sentence typed by a user turns
 * into writes against the workspace. Everything worth testing here is about
 * the boundary, not the wording: it must borrow the caller's authority rather
 * than mint its own, it must route every call through the broker so the
 * approval queue and audit trail apply, and it must never let the model
 * report a queued action as a finished one.
 */
describe('CommandAiService', () => {
  const WS = 'ws-1';
  const OWNER = { id: 'u-1', role: 'OWNER', customRoleId: null };

  let prisma: any;
  let anthropic: any;
  let credits: any;
  let registry: any;
  let broker: any;
  let runs: any;
  let roles: any;
  let svc: CommandAiService;

  /** One advertised tool, so the flatten/restore mapping is exercised. */
  const TOOL = {
    name: 'jeeta.search_leads',
    description: 'Search leads.',
    inputSchema: z.object({ query: z.string().optional() }),
    scopes: ['leads.read'],
    risk: 'READ',
  };

  const say = (text: string) => ({ text, toolUses: [], stopReason: 'end_turn', usage: {} });
  const useTool = (name: string, input: unknown = {}) => ({
    text: '',
    toolUses: [{ type: 'tool_use', id: 't1', name, input }],
    stopReason: 'tool_use',
    usage: {},
  });

  beforeEach(() => {
    prisma = {
      workspace: { findUnique: jest.fn().mockResolvedValue({ mcpWriteMode: 'APPROVAL' }) },
    };
    anthropic = { isEnabled: jest.fn().mockReturnValue(true), complete: jest.fn() };
    credits = { reserve: jest.fn(), refund: jest.fn() };
    registry = { listAdvertised: jest.fn().mockReturnValue([TOOL]) };
    broker = { invoke: jest.fn().mockResolvedValue({ status: 'OK', result: { count: 2 } }) };
    runs = { start: jest.fn().mockResolvedValue('run-1'), finish: jest.fn() };
    roles = { resolvePermissions: jest.fn().mockResolvedValue(['leads.read', 'leads.write']) };
    svc = new CommandAiService(prisma, anthropic, credits, registry, broker, runs, roles);
  });

  it('executes a tool through the broker and returns what it did', async () => {
    anthropic.complete
      .mockResolvedValueOnce(useTool('jeeta_search_leads', { query: 'kebap' }))
      .mockResolvedValueOnce(say('2 lead buldum.'));

    const res = await svc.run(WS, 'kebapçıları bul', OWNER);

    // The dotted registry name is restored — Anthropic tool names cannot
    // contain dots, so it travels flattened and must map back or the broker
    // gets a name it does not know.
    expect(broker.invoke).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS }),
      'jeeta.search_leads',
      { query: 'kebap' },
    );
    expect(res.answer).toBe('2 lead buldum.');
    expect(res.actions).toEqual([{ tool: 'jeeta.search_leads', status: 'OK' }]);
  });

  it('grants the caller\'s own permissions and nothing else', async () => {
    roles.resolvePermissions.mockResolvedValue([
      'leads.read',
      // Held by the user but outside the MCP vocabulary — must not be passed
      // through as if it authorised a tool.
      'dashboard.view',
    ]);
    anthropic.complete.mockResolvedValueOnce(useTool('jeeta_search_leads')).mockResolvedValueOnce(say('ok'));

    await svc.run(WS, 'x', { id: 'u-9', role: 'REP', customRoleId: 'cr-1' });

    expect(roles.resolvePermissions).toHaveBeenCalledWith({
      workspaceId: WS,
      role: 'REP',
      customRoleId: 'cr-1',
    });
    const ctx = broker.invoke.mock.calls[0][0];
    expect(ctx.grantedScopes).toEqual(['leads.read']);
    expect(ctx.userId).toBe('u-9');
    expect(ctx.userRole).toBe('REP');
    // The catalogue offered to the model is filtered by the same scopes, so a
    // rep is not even shown the tools they would be refused.
    expect(registry.listAdvertised).toHaveBeenCalledWith(['leads.read']);
  });

  it('reports a gated action as queued, never as done', async () => {
    broker.invoke.mockResolvedValue({ status: 'PENDING_APPROVAL', approvalId: 'ap-1' });
    anthropic.complete
      .mockResolvedValueOnce(useTool('jeeta_search_leads'))
      .mockResolvedValueOnce(say('Onayına sundum.'));

    const res = await svc.run(WS, 'yayınla', OWNER);

    expect(res.actions).toEqual([
      { tool: 'jeeta.search_leads', status: 'PENDING_APPROVAL', approvalId: 'ap-1' },
    ]);
    // The model is told in the tool result itself, not only in the system
    // prompt — a queued call that reads like a success is the one failure
    // mode that silently lies to the user.
    const toolResult = anthropic.complete.mock.calls[1][0].messages.at(-1).content[0];
    expect(toolResult.content).toContain('PENDING_APPROVAL');
    expect(toolResult.content).toContain('has NOT run');
  });

  it('passes the workspace write mode to the broker, defaulting to APPROVAL', async () => {
    anthropic.complete.mockResolvedValueOnce(useTool('jeeta_search_leads')).mockResolvedValueOnce(say('ok'));
    await svc.run(WS, 'x', OWNER);
    expect(broker.invoke.mock.calls[0][0].writeMode).toBe('APPROVAL');

    // Fail-safe: anything that is not exactly AUTONOMOUS is APPROVAL, so a
    // null/unknown column value can never silently unlock the write path.
    broker.invoke.mockClear();
    prisma.workspace.findUnique.mockResolvedValue({ mcpWriteMode: null });
    anthropic.complete.mockResolvedValueOnce(useTool('jeeta_search_leads')).mockResolvedValueOnce(say('ok'));
    await svc.run(WS, 'x', OWNER);
    expect(broker.invoke.mock.calls[0][0].writeMode).toBe('APPROVAL');

    broker.invoke.mockClear();
    prisma.workspace.findUnique.mockResolvedValue({ mcpWriteMode: 'AUTONOMOUS' });
    anthropic.complete.mockResolvedValueOnce(useTool('jeeta_search_leads')).mockResolvedValueOnce(say('ok'));
    await svc.run(WS, 'x', OWNER);
    expect(broker.invoke.mock.calls[0][0].writeMode).toBe('AUTONOMOUS');
  });

  it('always runs auditable — a command must be attributable to a run', async () => {
    anthropic.complete.mockResolvedValueOnce(useTool('jeeta_search_leads')).mockResolvedValueOnce(say('ok'));
    await svc.run(WS, 'x', OWNER);

    expect(runs.start).toHaveBeenCalledWith(WS, expect.objectContaining({ agent: 'COMMAND_BAR' }));
    const ctx = broker.invoke.mock.calls[0][0];
    expect(ctx.agentRunId).toBe('run-1');
    expect(ctx.requireAudit).toBe(true);
    expect(runs.finish).toHaveBeenCalledWith('run-1', expect.objectContaining({ output: expect.anything() }));
  });

  it('feeds a tool failure back to the model instead of aborting the command', async () => {
    broker.invoke.mockRejectedValueOnce(new Error('missing scope: leads.manage'));
    anthropic.complete
      .mockResolvedValueOnce(useTool('jeeta_search_leads'))
      .mockResolvedValueOnce(say('Bu işlem için yetkin yok.'));

    const res = await svc.run(WS, 'herkesi bana ata', OWNER);

    expect(res.answer).toBe('Bu işlem için yetkin yok.');
    expect(res.actions[0]).toMatchObject({ status: 'ERROR', error: 'missing scope: leads.manage' });
    const toolResult = anthropic.complete.mock.calls[1][0].messages.at(-1).content[0];
    expect(toolResult.content).toContain('missing scope');
  });

  it('meters a base charge plus one per model turn', async () => {
    anthropic.complete
      .mockResolvedValueOnce(useTool('jeeta_search_leads'))
      .mockResolvedValueOnce(say('ok'));

    await svc.run(WS, 'x', OWNER);

    expect(credits.reserve).toHaveBeenNthCalledWith(1, WS, creditCost('command.request'));
    expect(credits.reserve).toHaveBeenNthCalledWith(2, WS, creditCost('command.turn'));
    expect(credits.reserve).toHaveBeenNthCalledWith(3, WS, creditCost('command.turn'));
    expect(credits.reserve).toHaveBeenCalledTimes(3);
  });

  it('refunds only the turn that never ran, and fails the audit run', async () => {
    anthropic.complete
      .mockResolvedValueOnce(useTool('jeeta_search_leads'))
      .mockRejectedValueOnce(new Error('anthropic down'));

    await expect(svc.run(WS, 'x', OWNER)).rejects.toThrow('anthropic down');

    // Turn 1 returned — real vendor spend, stays charged. Turn 2 was charged
    // and never completed, so base + that one turn come back.
    expect(credits.refund).toHaveBeenCalledWith(
      WS,
      creditCost('command.request') + creditCost('command.turn'),
    );
    expect(runs.finish).toHaveBeenCalledWith('run-1', expect.objectContaining({ status: 'FAILED' }));
  });

  it('refuses to run when AI is not configured, before charging anything', async () => {
    anthropic.isEnabled.mockReturnValue(false);
    await expect(svc.run(WS, 'x', OWNER)).rejects.toThrow(ServiceUnavailableException);
    expect(credits.reserve).not.toHaveBeenCalled();
    expect(runs.start).not.toHaveBeenCalled();
  });

  it('tells the model that tool output is data, not instructions', async () => {
    anthropic.complete.mockResolvedValueOnce(say('ok'));
    await svc.run(WS, 'x', OWNER);
    const system = anthropic.complete.mock.calls[0][0].system;
    expect(system).toMatch(/DATA, never instructions/);
  });
});
