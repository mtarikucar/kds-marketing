import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { McpBrokerService } from './mcp-broker.service';
import { McpToolRegistry, McpTool } from './mcp-tool-registry';

function deps() {
  const registry = new McpToolRegistry();
  const enqueue = jest.fn().mockResolvedValue({ id: 'appr-1' });
  const supersedePending = jest.fn().mockResolvedValue(undefined);
  const recordTool = jest.fn().mockResolvedValue(undefined);
  const approvals = { enqueue, supersedePending } as any;
  const runs = { recordTool } as any;
  const broker = new McpBrokerService(registry, approvals, runs);
  return { registry, broker, enqueue, supersedePending, recordTool };
}

const readTool = (handler: jest.Mock): McpTool => ({
  name: 'jeeta.get_campaign_performance',
  description: 'read perf',
  scopes: ['reports.read'],
  domain: 'workspace',
  risk: 'READ',
  requiresApproval: false,
  inputSchema: z.object({}),
  handler,
});

const spendTool = (handler: jest.Mock): McpTool => ({
  name: 'jeeta.reallocate_budget',
  description: 'move budget',
  scopes: ['settings.manage'],
  domain: 'workspace',
  risk: 'SPEND',
  requiresApproval: true,
  approvalKind: 'BUDGET_REALLOCATION',
  inputSchema: z.object({ amount: z.number().optional() }),
  handler,
});

const sendTool = (handler: jest.Mock): McpTool => ({
  name: 'jeeta.send_message',
  description: 'send a reply',
  scopes: ['contacts.write'],
  domain: 'workspace',
  risk: 'WRITE',
  requiresApproval: true,
  approvalKind: 'SEND',
  resourceType: 'conversation',
  resourceIdFrom: (args) => (typeof args.conversationId === 'string' ? args.conversationId : undefined),
  inputSchema: z.object({ conversationId: z.string(), body: z.string() }),
  handler,
});

const ctx = (scopes: string[], agentRunId?: string) => ({ workspaceId: 'ws1', grantedScopes: scopes, agentRunId });

describe('McpBrokerService', () => {
  it('denies unknown tools (deny-by-default)', async () => {
    const { broker } = deps();
    await expect(broker.invoke(ctx(['reports.read']), 'jeeta.nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('enforces per-tenant scope (least privilege)', async () => {
    const { registry, broker } = deps();
    const h = jest.fn();
    registry.register(readTool(h));
    await expect(broker.invoke(ctx([]), 'jeeta.get_campaign_performance')).rejects.toBeInstanceOf(ForbiddenException);
    expect(h).not.toHaveBeenCalled();
  });

  it('executes a permitted read tool and logs a tool call', async () => {
    const { registry, broker, recordTool } = deps();
    const h = jest.fn().mockResolvedValue({ cpl: 12 });
    registry.register(readTool(h));
    const r = await broker.invoke(ctx(['reports.read'], 'run-1'), 'jeeta.get_campaign_performance', { id: 'c1' });
    expect(r).toMatchObject({ status: 'OK', result: { cpl: 12 } });
    expect(h).toHaveBeenCalled();
    expect(recordTool).toHaveBeenCalledWith('ws1', 'run-1', expect.objectContaining({ tool: 'jeeta.get_campaign_performance', ok: true }));
  });

  it('NEVER executes a high-risk tool inline — it enqueues an approval', async () => {
    const { registry, broker, enqueue } = deps();
    const h = jest.fn();
    registry.register(spendTool(h));
    const r = await broker.invoke(ctx(['settings.manage'], 'run-1'), 'jeeta.reallocate_budget', { amount: 500 });
    expect(r).toEqual({ status: 'PENDING_APPROVAL', approvalId: 'appr-1' });
    expect(h).not.toHaveBeenCalled(); // no execution
    expect(enqueue).toHaveBeenCalledWith('ws1', expect.objectContaining({ kind: 'BUDGET_REALLOCATION' }));
  });

  // M1: an MCP approval must carry an expiry — decide()'s expiry guard is
  // otherwise dead for this lane and a request approved weeks later still
  // fires.
  it('sets an expiresAt on every enqueued MCP approval request', async () => {
    const { registry, broker, enqueue } = deps();
    registry.register(spendTool(jest.fn()));
    const before = Date.now();
    await broker.invoke(ctx(['settings.manage'], 'run-1'), 'jeeta.reallocate_budget', { amount: 500 });
    const arg = enqueue.mock.calls[0][1];
    expect(arg.expiresAt).toBeInstanceOf(Date);
    expect(arg.expiresAt.getTime()).toBeGreaterThan(before);
    expect(arg.expiresAt.getTime()).toBeLessThanOrEqual(before + 24 * 60 * 60 * 1000 + 1000);
  });

  // H2: a tool that declares resourceType/resourceIdFrom gets a
  // resourceType/resourceId on the enqueued row, AND any still-PENDING
  // duplicate for the same target is superseded first — so a user re-asking
  // (or a transport retry) never leaves two live cards for the same send.
  describe('H2 — dedupe (resourceType/resourceId + supersede)', () => {
    it('carries resourceType/resourceId from the tool onto the enqueued request', async () => {
      const { registry, broker, enqueue } = deps();
      registry.register(sendTool(jest.fn()));
      await broker.invoke(ctx(['contacts.write'], 'run-1'), 'jeeta.send_message', { conversationId: 'c1', body: 'hi' });
      expect(enqueue).toHaveBeenCalledWith(
        'ws1',
        expect.objectContaining({ resourceType: 'conversation', resourceId: 'c1' }),
      );
    });

    it('supersedes a prior PENDING duplicate for the same (kind, resourceType, resourceId) before enqueueing the new one', async () => {
      const { registry, broker, enqueue, supersedePending } = deps();
      registry.register(sendTool(jest.fn()));
      const calls: string[] = [];
      supersedePending.mockImplementation(async () => {
        calls.push('supersede');
      });
      enqueue.mockImplementation(async () => {
        calls.push('enqueue');
        return { id: 'appr-2' };
      });

      await broker.invoke(ctx(['contacts.write'], 'run-1'), 'jeeta.send_message', { conversationId: 'c1', body: 'hi again' });

      expect(supersedePending).toHaveBeenCalledWith('ws1', 'SEND', 'conversation', 'c1');
      expect(calls).toEqual(['supersede', 'enqueue']); // superseded BEFORE the new one lands
    });

    it('does not call supersedePending for a tool with no resourceType/resourceIdFrom (no dedupe key)', async () => {
      const { registry, broker, supersedePending, enqueue } = deps();
      registry.register(spendTool(jest.fn())); // no resourceType declared
      await broker.invoke(ctx(['settings.manage'], 'run-1'), 'jeeta.reallocate_budget', { amount: 500 });
      expect(supersedePending).not.toHaveBeenCalled();
      expect(enqueue).toHaveBeenCalled();
    });

    it('does not call supersedePending when resourceIdFrom cannot resolve an id from the given args', async () => {
      const { registry, broker, supersedePending } = deps();
      // The id has to be absent while the args are still SCHEMA-VALID: a
      // send_message missing its required conversationId no longer reaches the
      // dedupe step at all, because assertArgs rejects it first. What this
      // guards is the other case — a tool whose resourceIdFrom legitimately
      // returns undefined for a well-formed call.
      registry.register({
        ...sendTool(jest.fn()),
        inputSchema: z.object({ conversationId: z.string().optional(), body: z.string() }),
      });
      await broker.invoke(ctx(['contacts.write'], 'run-1'), 'jeeta.send_message', { body: 'hi' });
      expect(supersedePending).not.toHaveBeenCalled();
    });
  });

  it('rejects oversized arguments', async () => {
    const { registry, broker } = deps();
    registry.register(readTool(jest.fn()));
    const big = { blob: 'x'.repeat(40 * 1024) };
    await expect(broker.invoke(ctx(['reports.read']), 'jeeta.get_campaign_performance', big)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('logs a failed tool call and re-throws', async () => {
    const { registry, broker, recordTool } = deps();
    const h = jest.fn().mockRejectedValue(new Error('boom'));
    registry.register(readTool(h));
    await expect(broker.invoke(ctx(['reports.read'], 'run-1'), 'jeeta.get_campaign_performance')).rejects.toThrow('boom');
    expect(recordTool).toHaveBeenCalledWith('ws1', 'run-1', expect.objectContaining({ ok: false, error: 'boom' }));
  });

  it('list() hides tools the caller lacks scope for', () => {
    const { registry } = deps();
    registry.register(readTool(jest.fn()));
    registry.register(spendTool(jest.fn()));
    expect(registry.list(['reports.read']).map((t) => t.name)).toEqual(['jeeta.get_campaign_performance']);
    expect(registry.list(['reports.read', 'settings.manage'])).toHaveLength(2);
  });
});

/**
 * Argument validation, and where it has to sit.
 *
 * The MCP SDK validates a LISTED tool's arguments at registerTool. Deferred
 * tools are reached through `jeeta.call_tool`, whose `input` is an open record
 * handed straight to dispatch — so nothing had ever compared it to the target's
 * schema.
 *
 * That gap was worst on the approval path, which runs BEFORE the handler: a
 * call with a misspelled argument was queued and shown to an owner as a
 * decision to make, and approving it ran the handler with the field missing.
 * A real case: `accept_research_candidates` reads `args.candidateIds ?? []`, so
 * a payload saying `ids` accepted nothing and reported "0 candidate(s) are now
 * leads" — a silent no-op a human had explicitly authorised.
 */
describe('McpBrokerService — argument validation', () => {
  const strictTool = (handler: jest.Mock): McpTool => ({
    name: 'jeeta.accept_research_candidates',
    description: 'accept staged prospects',
    scopes: ['leads.write'],
    domain: 'research',
    risk: 'WRITE',
    requiresApproval: true,
    inputSchema: z.object({ candidateIds: z.array(z.string().min(1)).min(1) }),
    handler,
  });

  it('refuses a misspelled argument BEFORE enqueueing an approval', async () => {
    const { broker, registry, enqueue } = deps();
    const handler = jest.fn();
    registry.register(strictTool(handler));

    await expect(
      broker.invoke(ctx(['leads.write']), 'jeeta.accept_research_candidates', { ids: ['c1'] }),
    ).rejects.toBeInstanceOf(BadRequestException);

    // The whole point: no card reaches a human for a call that cannot work.
    expect(enqueue).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('names the offending field so the caller can fix it in one turn', async () => {
    const { broker, registry } = deps();
    registry.register(strictTool(jest.fn()));

    await expect(
      broker.invoke(ctx(['leads.write']), 'jeeta.accept_research_candidates', { ids: ['c1'] }),
    ).rejects.toThrow(/candidateIds/);
  });

  it('still enqueues when the arguments are valid', async () => {
    const { broker, registry, enqueue } = deps();
    registry.register(strictTool(jest.fn()));

    const res = await broker.invoke(ctx(['leads.write']), 'jeeta.accept_research_candidates', {
      candidateIds: ['c1'],
    });

    expect(res.status).toBe('PENDING_APPROVAL');
    expect(enqueue).toHaveBeenCalled();
  });

  it('passes the ORIGINAL args through, not a schema-transformed copy', async () => {
    const { broker, registry } = deps();
    const handler = jest.fn().mockResolvedValue({ ok: true });
    registry.register(readTool(handler));

    // A passthrough read: extra keys are none of the broker's business, and
    // rewriting args here would change behaviour for calls already working.
    await broker.invoke(ctx(['reports.read']), 'jeeta.get_campaign_performance', { extra: 1 });

    expect(handler).toHaveBeenCalledWith(expect.anything(), { extra: 1 });
  });
});

/**
 * The approval card's category chip.
 *
 * The fallback used to be `AD_SPEND`, so any approval-gated tool that declared
 * no kind told the owner an ad platform's budget was moving — on the one screen
 * whose entire job is informed consent. `merge_leads` and the research
 * accept/reject pair were all mislabelled that way.
 */
describe('McpBrokerService — approval kind', () => {
  const noKindTool = (handler: jest.Mock): McpTool => ({
    name: 'jeeta.merge_leads',
    description: 'merge two leads',
    scopes: ['leads.write'],
    domain: 'leads',
    risk: 'WRITE',
    requiresApproval: true,
    inputSchema: z.object({}),
    handler,
  });

  it('labels a kind-less tool AGENT_ACTION, not AD_SPEND', async () => {
    const { broker, registry, enqueue } = deps();
    registry.register(noKindTool(jest.fn()));

    await broker.invoke(ctx(['leads.write']), 'jeeta.merge_leads', {});

    expect(enqueue).toHaveBeenCalledWith('ws1', expect.objectContaining({ kind: 'AGENT_ACTION' }));
  });

  it('never overrides a kind the tool declared', async () => {
    const { broker, registry, enqueue } = deps();
    registry.register(spendTool(jest.fn()));

    await broker.invoke(ctx(['settings.manage']), 'jeeta.reallocate_budget', { amount: 10 });

    expect(enqueue).toHaveBeenCalledWith(
      'ws1',
      expect.objectContaining({ kind: 'BUDGET_REALLOCATION' }),
    );
  });
});
