import { McpToolRegistry } from '../mcp-tool-registry';
import { registerWorkflowTools, WorkflowToolDeps } from './workflows.tools';

const VALID_TRIGGER = { type: 'lead.created', filters: [] };
const VALID_STEPS = [{ type: 'create_task', title: 'Call them' }];

function build(over: { workflow?: unknown; features?: Record<string, boolean> } = {}) {
  const workflows = {
    list: jest.fn().mockResolvedValue([{ id: 'w1', name: 'Nurture', status: 'DRAFT' }]),
    get: jest.fn().mockResolvedValue(over.workflow ?? { id: 'w1', name: 'Nurture', status: 'ACTIVE' }),
    create: jest.fn().mockResolvedValue({ id: 'w1', status: 'DRAFT' }),
    setStatus: jest.fn().mockResolvedValue({ id: 'w1', status: 'ACTIVE' }),
  };
  const leadBulk = { bulkEnroll: jest.fn().mockResolvedValue({ queued: 2 }) };
  const principals = { resolve: jest.fn().mockResolvedValue({ id: 'sys-1' }) };
  const entitlements = {
    getEffective: jest.fn().mockResolvedValue({ features: over.features ?? { workflows: true } }),
  };
  const registry = new McpToolRegistry();
  registerWorkflowTools(registry, { workflows, leadBulk, principals, entitlements } as unknown as WorkflowToolDeps);
  return { registry, workflows, leadBulk, principals, entitlements };
}

const CTX = { workspaceId: 'ws1', grantedScopes: [] as string[] };
const ALL = ['automations.manage'];

describe('Faz 5 D4 — workflow MCP tools', () => {
  it('registers exactly the five workflow tools in the workflows domain, all on automations.manage', () => {
    const { registry } = build();
    const tools = registry.list(ALL);
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'jeeta.list_workflows',
        'jeeta.get_workflow',
        'jeeta.create_workflow',
        'jeeta.set_workflow_enabled',
        'jeeta.trigger_workflow',
      ].sort(),
    );
    for (const t of tools) {
      expect(t.domain).toBe('workflows');
      // The REST controller gates every workflow mutation on
      // `automations.manage` and the whole controller on MANAGER. Reads use the
      // same scope rather than a generic read one, so MCP is never MORE
      // permissive than the panel.
      expect(t.scopes).toEqual(['automations.manage']);
    }
  });

  it('mirrors the REST @RequiresFeature("workflows") gate on every tool', async () => {
    const { registry } = build({ features: {} });
    const calls: Array<[string, Record<string, unknown>]> = [
      ['jeeta.list_workflows', {}],
      ['jeeta.get_workflow', { workflowId: 'w1' }],
      ['jeeta.create_workflow', { name: 'n', trigger: VALID_TRIGGER, steps: VALID_STEPS }],
      ['jeeta.set_workflow_enabled', { workflowId: 'w1', enabled: true }],
      ['jeeta.trigger_workflow', { workflowId: 'w1', leadIds: ['l1'] }],
    ];
    for (const [name, args] of calls) {
      await expect(registry.get(name)!.handler(CTX, args)).rejects.toMatchObject({
        response: { code: 'FEATURE_NOT_IN_PACKAGE', feature: 'workflows' },
      });
    }
  });

  it('lists and gets through the service', async () => {
    const { registry, workflows } = build();
    await registry.get('jeeta.list_workflows')!.handler(CTX, {});
    expect(workflows.list).toHaveBeenCalledWith('ws1');
    await registry.get('jeeta.get_workflow')!.handler(CTX, { workflowId: 'w1' });
    expect(workflows.get).toHaveBeenCalledWith('ws1', 'w1');
  });

  /**
   * The two-verb safety split of this group: authoring is free, ARMING is the
   * gated verb. `WorkflowsService.create` hardcodes `status: 'DRAFT'` and the
   * trigger listener only ever fires `status: 'ACTIVE'` workflows, so a created
   * workflow is inert by construction — the tool must not expose any way to
   * pass a status.
   */
  it('creates a DRAFT workflow and offers no way to ask for anything else', async () => {
    const { registry, workflows } = build();
    const tool = registry.get('jeeta.create_workflow')!;
    expect(tool.risk).toBe('WRITE');
    expect(tool.requiresApproval).toBe(false);
    const schema = tool.inputSchema as { parse: (v: unknown) => unknown };
    expect(() => schema.parse({ name: 'n', trigger: VALID_TRIGGER, steps: VALID_STEPS, status: 'ACTIVE' })).toThrow();
    expect(() => schema.parse({ name: 'n', trigger: VALID_TRIGGER, steps: VALID_STEPS, enabled: true })).toThrow();

    const out = (await tool.handler(CTX, {
      name: 'Nurture',
      trigger: VALID_TRIGGER,
      steps: VALID_STEPS,
    })) as { status: string };
    expect(workflows.create).toHaveBeenCalledWith('ws1', expect.objectContaining({ name: 'Nurture' }));
    expect(workflows.create.mock.calls[0][1]).not.toHaveProperty('status');
    expect(out.status).toBe('DRAFT');
  });

  describe('set_workflow_enabled — arming is the gated verb', () => {
    it('is approval-gated, and maps enabled to the product ACTIVE/PAUSED statuses', async () => {
      const { registry, workflows } = build();
      const tool = registry.get('jeeta.set_workflow_enabled')!;
      expect(tool.risk).toBe('WRITE');
      expect(tool.requiresApproval).toBe(true);
      expect(tool.approvalKind).toBe('CHANNEL_LAUNCH');
      expect(tool.resourceType).toBe('workflow');
      expect(tool.resourceIdFrom!({ workflowId: 'w1' })).toBe('w1');

      await tool.handler(CTX, { workflowId: 'w1', enabled: true });
      expect(workflows.setStatus).toHaveBeenCalledWith('ws1', 'w1', 'ACTIVE');
      await tool.handler(CTX, { workflowId: 'w1', enabled: false });
      expect(workflows.setStatus).toHaveBeenLastCalledWith('ws1', 'w1', 'PAUSED');
    });
  });

  describe('trigger_workflow', () => {
    it('is SPEND — it runs a real automation over real leads', () => {
      const { registry } = build();
      const tool = registry.get('jeeta.trigger_workflow')!;
      expect(tool.risk).toBe('SPEND');
      expect(tool.requiresApproval).toBe(true);
      expect(tool.approvalKind).toBe('SEND');
      expect(tool.resourceType).toBe('workflow');
    });

    it('enrolls the named leads through the existing bulk-enroll service, as the resolved principal', async () => {
      const { registry, leadBulk, principals } = build();
      const out = await registry
        .get('jeeta.trigger_workflow')!
        .handler(CTX, { workflowId: 'w1', leadIds: ['l1', 'l2'] });
      expect(principals.resolve).toHaveBeenCalled();
      expect(leadBulk.bulkEnroll).toHaveBeenCalledWith('ws1', ['l1', 'l2'], 'w1', 'sys-1');
      expect(out).toEqual({ queued: 2 });
    });

    /**
     * `LeadBulkService.bulkEnroll` does NOT check the workflow's status — a
     * DRAFT or PAUSED automation executes in full when manually enrolled. Left
     * as-is, `jeeta.trigger_workflow` would be a way to run an automation that
     * was never armed, which would make `jeeta.set_workflow_enabled`'s approval
     * gate decorative. Applying the product's own ACTIVE predicate before the
     * call closes that, without changing the shared service.
     */
    it('refuses to run a workflow that was never armed', async () => {
      const { registry, leadBulk } = build({ workflow: { id: 'w1', name: 'Nurture', status: 'DRAFT' } });
      await expect(
        registry.get('jeeta.trigger_workflow')!.handler(CTX, { workflowId: 'w1', leadIds: ['l1'] }),
      ).rejects.toThrow(/DRAFT/);
      expect(leadBulk.bulkEnroll).not.toHaveBeenCalled();
    });

    it('bounds the batch size in the schema', () => {
      const { registry } = build();
      const schema = registry.get('jeeta.trigger_workflow')!.inputSchema as { parse: (v: unknown) => unknown };
      expect(() => schema.parse({ workflowId: 'w1', leadIds: [] })).toThrow();
      expect(() =>
        schema.parse({ workflowId: 'w1', leadIds: Array.from({ length: 201 }, (_, i) => `l${i}`) }),
      ).toThrow();
    });
  });

  it('defers everything except the primary read', () => {
    const { registry } = build();
    expect(registry.listAdvertised(ALL).map((t) => t.name)).toEqual(['jeeta.list_workflows']);
  });
});
