import { McpBrokerService } from '../mcp-broker.service';
import { McpToolRegistry } from '../mcp-tool-registry';
import { registerBrandTools } from './brand.tools';

/**
 * Brand knowledge documents over MCP — the tenant boundary and the delete gate,
 * proved on the REAL tools (mirrors `d4-isolation.spec.ts` and
 * `d5-approval-gate.spec.ts`).
 *
 * The docs written here are pasted into every AI reply the workspace sends, so
 * a leak is not a wrong list: it is one tenant's agent writing the policy
 * another tenant's inbox answers customers from, or deleting it.
 */

const CALLER_WS = 'ws-a';
const FOREIGN_WS = 'ws-b';
const TOOLS = ['jeeta.add_brand_knowledge', 'jeeta.list_brand_knowledge', 'jeeta.delete_brand_knowledge'];

function build() {
  const calls: Array<{ service: string; method: string; args: unknown[] }> = [];
  const stub = (service: string, methods: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(methods).map(([m, result]) => [
        m,
        jest.fn(async (...args: unknown[]) => {
          calls.push({ service, method: m, args });
          return result;
        }),
      ]),
    ) as never;
  const knowledge = stub('knowledge', {
    create: { id: 'kd1', title: 't', status: 'ACTIVE' },
    list: [],
    remove: { message: 'Knowledge doc deleted' },
  });
  const brand = stub('brand', { search: [], indexDoc: 1 });
  const registry = new McpToolRegistry();
  registerBrandTools(registry, { brand, knowledge, profiles: stub('profiles', { get: null, upsert: {} }) });
  return { registry, calls, knowledge: knowledge as any };
}

const HOSTILE: Record<string, Record<string, unknown>> = {
  'jeeta.add_brand_knowledge': { title: FOREIGN_WS, content: FOREIGN_WS, tags: [FOREIGN_WS] },
  'jeeta.list_brand_knowledge': {},
  'jeeta.delete_brand_knowledge': { docId: FOREIGN_WS },
};

describe('brand knowledge tools — workspace isolation', () => {
  it.each(TOOLS)('%s passes only the CALLER workspace to every service it touches', async (name) => {
    const { registry, calls } = build();
    await registry.get(name)!.handler({ workspaceId: CALLER_WS, grantedScopes: [] }, HOSTILE[name]);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.args[0]).toBe(CALLER_WS);
      expect(call.args[0]).not.toBe(FOREIGN_WS);
    }
  });

  it.each(TOOLS)('%s accepts no workspaceId argument at all', (name) => {
    const { registry } = build();
    const schema = registry.get(name)!.inputSchema as { parse: (v: unknown) => unknown };
    expect(() => schema.parse({ ...HOSTILE[name], workspaceId: FOREIGN_WS })).toThrow();
  });
});

describe('brand knowledge tools — the delete is approval-gated in every write mode', () => {
  const BASE = {
    workspaceId: CALLER_WS,
    grantedScopes: ['reports.read', 'settings.manage'],
    agentRunId: 'run-1',
    requireAudit: true,
  };

  function broker() {
    const b = build();
    const enqueue = jest.fn().mockResolvedValue({ id: 'appr-1' });
    const supersedePending = jest.fn().mockResolvedValue(undefined);
    const svc = new McpBrokerService(b.registry, { enqueue, supersedePending } as never, { recordTool: jest.fn() } as never);
    return { ...b, broker: svc, enqueue, supersedePending };
  }

  it.each(['APPROVAL', 'AUTONOMOUS'] as const)('queues delete_brand_knowledge under %s and deletes nothing', async (writeMode) => {
    const { broker: svc, enqueue, supersedePending, knowledge } = broker();
    const out = await svc.invoke({ ...BASE, writeMode }, 'jeeta.delete_brand_knowledge', { docId: 'kd1' });
    expect(out).toEqual({ status: 'PENDING_APPROVAL', approvalId: 'appr-1' });
    expect(knowledge.remove).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(
      CALLER_WS,
      expect.objectContaining({
        kind: 'DESTRUCTIVE',
        resourceType: 'knowledge_doc',
        resourceId: 'kd1',
        payload: { tool: 'jeeta.delete_brand_knowledge', args: { docId: 'kd1' } },
      }),
    );
    // A re-ask for the same doc replaces the stale card instead of stacking two.
    expect(supersedePending).toHaveBeenCalledWith(CALLER_WS, 'DESTRUCTIVE', 'knowledge_doc', 'kd1');
  });

  it('runs the delete once a human has approved it', async () => {
    const { broker: svc, knowledge } = broker();
    const out = await svc.invoke({ ...BASE, writeMode: 'APPROVAL', approvedBy: 'user-1' }, 'jeeta.delete_brand_knowledge', {
      docId: 'kd1',
    });
    expect(out).toMatchObject({ status: 'OK' });
    expect(knowledge.remove).toHaveBeenCalledWith(CALLER_WS, 'kd1');
  });

  it('runs add and list inline (authoring and reading must not clog the queue)', async () => {
    const { broker: svc, enqueue, knowledge } = broker();
    await svc.invoke({ ...BASE, writeMode: 'APPROVAL' }, 'jeeta.add_brand_knowledge', { title: 't', content: 'c' });
    await svc.invoke({ ...BASE, writeMode: 'APPROVAL' }, 'jeeta.list_brand_knowledge', {});
    expect(enqueue).not.toHaveBeenCalled();
    expect(knowledge.create).toHaveBeenCalled();
    expect(knowledge.list).toHaveBeenCalled();
  });

  it('refuses add without settings.manage, and list without reports.read', async () => {
    const { broker: svc, knowledge } = broker();
    await expect(
      svc.invoke({ ...BASE, grantedScopes: ['reports.read'] }, 'jeeta.add_brand_knowledge', { title: 't', content: 'c' }),
    ).rejects.toThrow();
    await expect(
      svc.invoke({ ...BASE, grantedScopes: ['settings.manage'] }, 'jeeta.list_brand_knowledge', {}),
    ).rejects.toThrow();
    expect(knowledge.create).not.toHaveBeenCalled();
    expect(knowledge.list).not.toHaveBeenCalled();
  });
});
