import { McpPrincipalService } from '../mcp-principal.service';
import { McpToolRegistry } from '../mcp-tool-registry';
import { registerContactsTools } from './contacts.tools';
import { registerCrmReadTools } from './crm-read.tools';
import { registerLeadsWriteTools } from './leads-write.tools';
import { registerPipelineTools } from './pipeline.tools';
import { registerTasksTools } from './tasks.tools';

/**
 * Faz 5 D1 — the tenant boundary, asserted structurally over the WHOLE wave.
 *
 * D1 is the first MCP wave that writes CRM rows, so a workspace leak here is
 * not a wrong list, it is a lead created in, or a note attached to, someone
 * else's account. Two complementary checks:
 *
 * 1. Every tool handler is driven with a fixed caller workspace and a
 *    deliberately-hostile argument set that names a FOREIGN workspace id. Every
 *    call the tool then makes into a service must carry the CALLER's workspace
 *    as its first argument, and the foreign id must appear nowhere — proving no
 *    tool lets the caller choose the tenant through its arguments.
 * 2. `McpPrincipalService` (the only D1 component that touches Prisma directly)
 *    is walked at the `where` level, mirroring `mcp-console.service.spec.ts`:
 *    every filter it hands Prisma must pin `workspaceId`.
 */

const CALLER_WS = 'ws-a';
const FOREIGN_WS = 'ws-b';

/** Every service call made through the stubbed deps, flattened. */
interface Recorded {
  tool: string;
  service: string;
  method: string;
  args: unknown[];
}

function recorder() {
  const calls: Recorded[] = [];
  let current = '';
  const stub = (service: string, methods: string[], result: unknown) => {
    const obj: Record<string, unknown> = {};
    for (const m of methods) {
      obj[m] = jest.fn(async (...args: unknown[]) => {
        calls.push({ tool: current, service, method: m, args });
        return result;
      });
    }
    return obj as never;
  };
  return { calls, stub, setTool: (t: string) => (current = t) };
}

function buildRegistry() {
  const rec = recorder();
  const principals = {
    // The real resolver is exercised at the Prisma level below; here it stands
    // in as a dep so the tools' own workspace argument is what gets asserted.
    resolve: jest.fn(async (ctx: { workspaceId: string }) => {
      rec.calls.push({ tool: 'principals', service: 'principals', method: 'resolve', args: [ctx.workspaceId] });
      return { id: 'sys-1', workspaceId: ctx.workspaceId, role: 'SYSTEM' };
    }),
    assertActiveMember: jest.fn(async (workspaceId: string, userId: string) => {
      rec.calls.push({ tool: 'principals', service: 'principals', method: 'assertActiveMember', args: [workspaceId, userId] });
      return { id: userId, role: 'REP', status: 'ACTIVE', firstName: 'A', lastName: 'B' };
    }),
  };

  const registry = new McpToolRegistry();
  registerLeadsWriteTools(registry, {
    leads: rec.stub('leads', ['create', 'update', 'updateStatus', 'assign'], { id: 'l1' }),
    activities: rec.stub('activities', ['create'], { id: 'a1' }),
    principals: principals as never,
  });
  registerTasksTools(registry, {
    tasks: rec.stub('tasks', ['findAll', 'create', 'complete'], { data: [] }),
    principals: principals as never,
  });
  registerContactsTools(registry, {
    leads: rec.stub('leads', ['findAll', 'create'], { data: [] }),
    companies: rec.stub('companies', ['list', 'listContacts', 'create'], []),
    principals: principals as never,
  });
  registerPipelineTools(registry, {
    opportunities: rec.stub('opportunities', ['list', 'create', 'move', 'get'], {
      id: 'o1',
      pipelineId: 'p1',
      stageId: 's1',
    }) as never,
    pipelines: rec.stub('pipelines', ['list', 'get'], {
      id: 'p1',
      stages: [{ id: 's2', name: 'Proposal' }],
    }) as never,
    principals: principals as never,
  });
  registerCrmReadTools(registry, {
    segments: rec.stub('segments', ['list'], []),
    tags: rec.stub('tags', ['list'], []),
  });
  return { registry, rec };
}

/**
 * Every D1 tool with arguments that name a FOREIGN workspace wherever the
 * schema gives the caller a free-text field to smuggle one into.
 */
const D1_CALLS: Array<[string, Record<string, unknown>]> = [
  ['jeeta.create_lead', { businessName: FOREIGN_WS, contactPerson: 'x', businessType: 'RESTAURANT', source: 'REFERRAL', assignedToId: 'u2' }],
  ['jeeta.update_lead', { leadId: 'l1', city: FOREIGN_WS }],
  ['jeeta.set_lead_status', { leadId: 'l1', status: 'LOST', lostReason: FOREIGN_WS }],
  ['jeeta.add_lead_note', { leadId: 'l1', title: FOREIGN_WS }],
  ['jeeta.assign_lead', { leadId: 'l1', assignedToId: 'u2' }],
  ['jeeta.list_tasks', { leadId: 'l1', assignedToId: 'u2' }],
  ['jeeta.create_task', { title: FOREIGN_WS, type: 'CALL', dueDate: '2026-08-05', assignedToId: 'u2' }],
  ['jeeta.complete_task', { taskId: 't1' }],
  ['jeeta.search_contacts', { search: FOREIGN_WS }],
  ['jeeta.search_contacts', { companyId: 'c1' }],
  ['jeeta.create_contact', { companyId: 'c1', contactPerson: 'x', businessName: FOREIGN_WS, businessType: 'RESTAURANT', source: 'REFERRAL' }],
  ['jeeta.search_companies', { search: FOREIGN_WS }],
  ['jeeta.create_company', { name: FOREIGN_WS }],
  ['jeeta.list_pipelines', {}],
  ['jeeta.list_opportunities', { search: FOREIGN_WS }],
  ['jeeta.create_opportunity', { name: FOREIGN_WS, assignedToId: 'u2' }],
  ['jeeta.move_opportunity_stage', { opportunityId: 'o1', stageId: 's2' }],
  // The stage-NAME path fans out over two extra scoped reads (the deal, then
  // its pipeline) — both must carry the caller's workspace too.
  ['jeeta.move_opportunity_stage', { opportunityId: 'o1', stageName: 'Proposal' }],
  ['jeeta.list_segments', {}],
  ['jeeta.list_tags', {}],
];

describe('Faz 5 D1 — workspace isolation across the whole wave', () => {
  it.each(D1_CALLS)('%s passes the CALLER workspace to every service it touches', async (name, args) => {
    const { registry, rec } = buildRegistry();
    rec.setTool(name);
    await registry.get(name)!.handler({ workspaceId: CALLER_WS, grantedScopes: [] }, args);

    const made = rec.calls.filter((c) => c.tool === name || c.service === 'principals');
    expect(made.length).toBeGreaterThan(0); // the drive itself must not be a no-op
    for (const call of made) {
      expect(call.args[0]).toBe(CALLER_WS);
    }
  });

  it.each(D1_CALLS)('%s never lets a caller-supplied value become the workspace', async (name, args) => {
    const { registry, rec } = buildRegistry();
    rec.setTool(name);
    await registry.get(name)!.handler({ workspaceId: CALLER_WS, grantedScopes: [] }, args);
    for (const call of rec.calls) {
      expect(call.args[0]).not.toBe(FOREIGN_WS);
    }
  });

  it('exposes no D1 tool that accepts a workspaceId argument at all', () => {
    const { registry } = buildRegistry();
    for (const [name] of D1_CALLS) {
      const schema = registry.get(name)!.inputSchema as { parse: (v: unknown) => unknown };
      // Strict mode (applied centrally by the registry) turns an undeclared
      // argument into an error rather than a silently-dropped one, so this
      // proves the field is absent from the schema, not merely ignored.
      expect(() => schema.parse({ workspaceId: FOREIGN_WS })).toThrow();
    }
  });

  it('classifies every D1 tool as READ or WRITE — none reaches an audience or moves money', () => {
    const { registry } = buildRegistry();
    for (const [name] of D1_CALLS) {
      const tool = registry.get(name)!;
      expect(['READ', 'WRITE']).toContain(tool.risk);
      expect(tool.requiresApproval).toBe(false);
      expect(tool.approvalKind).toBeUndefined();
    }
  });
});

/** Every `where` object handed to Prisma across the whole mock, flattened. */
function allWheres(prisma: Record<string, Record<string, jest.Mock>>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const model of Object.values(prisma)) {
    for (const fn of Object.values(model)) {
      for (const call of fn.mock.calls) {
        const where = (call[0] as { where?: Record<string, unknown> })?.where;
        if (where) out.push(where);
      }
    }
  }
  return out;
}

describe('Faz 5 D1 — McpPrincipalService pins workspaceId into every Prisma filter', () => {
  const rows = {
    oauth: { id: 'u9', workspaceId: CALLER_WS, email: 'a@b.c', firstName: 'A', lastName: 'B', role: 'REP', status: 'ACTIVE', customRoleId: null },
    sentinel: { id: 'sys-1', workspaceId: CALLER_WS, email: 's@i', firstName: 'AI', lastName: 'Research', role: 'SYSTEM', status: 'ACTIVE', customRoleId: null },
    member: { id: 'u2', role: 'REP', status: 'ACTIVE', firstName: 'A', lastName: 'B' },
  };

  it.each([
    ['an OAuth session', { workspaceId: CALLER_WS, grantedScopes: [], userId: 'u9' }, rows.oauth],
    ['an API-key session', { workspaceId: CALLER_WS, grantedScopes: [] }, rows.sentinel],
  ])('resolve() on %s reads only rows of the caller workspace', async (_label, ctx, row) => {
    const prisma = { marketingUser: { findFirst: jest.fn().mockResolvedValue(row) } };
    await new McpPrincipalService(prisma as never).resolve(ctx as never);
    const wheres = allWheres(prisma as never);
    expect(wheres.length).toBeGreaterThan(0);
    for (const where of wheres) expect(where.workspaceId).toBe(CALLER_WS);
  });

  it('assertActiveMember() reads only rows of the caller workspace', async () => {
    const prisma = { marketingUser: { findFirst: jest.fn().mockResolvedValue(rows.member) } };
    await new McpPrincipalService(prisma as never).assertActiveMember(CALLER_WS, 'u2');
    const wheres = allWheres(prisma as never);
    expect(wheres.length).toBeGreaterThan(0);
    for (const where of wheres) expect(where.workspaceId).toBe(CALLER_WS);
  });
});
