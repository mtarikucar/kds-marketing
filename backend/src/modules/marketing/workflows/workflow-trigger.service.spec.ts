import { WorkflowTriggerService } from './workflow-trigger.service';
import { TRIGGER_TYPES } from './workflow-dsl.schema';

/**
 * The trigger matcher: on a domain event it starts only ACTIVE workflows whose
 * trigger type matches AND whose filters pass. Everything is workspace-scoped.
 */
describe('WorkflowTriggerService', () => {
  const WS = 'ws-1';

  function build(workflows: any[], matches = true) {
    const prisma: any = {
      workflow: { findMany: jest.fn().mockResolvedValue(workflows) },
      lead: { findFirst: jest.fn().mockResolvedValue({ id: 'lead-1', workspaceId: WS, status: 'NEW' }) },
    };
    const bus: any = { on: jest.fn() };
    const executor: any = { start: jest.fn().mockResolvedValue('run-1') };
    const handler: any = { matchesAll: jest.fn().mockReturnValue(matches) };
    const svc = new WorkflowTriggerService(prisma, bus, executor, handler);
    return { svc, prisma, executor, handler, bus };
  }

  const event = { payload: { workspaceId: WS, leadId: 'lead-1' }, tenantId: null } as any;

  it('starts a workflow whose trigger type + filters match', async () => {
    const h = build([{ id: 'wf-1', status: 'ACTIVE', trigger: { type: 'lead.created', filters: [] } }]);
    await (h.svc as any).onEvent('lead.created', event);
    expect(h.executor.start).toHaveBeenCalledTimes(1);
  });

  it('skips a workflow whose filters do not match', async () => {
    const h = build(
      [{ id: 'wf-1', status: 'ACTIVE', trigger: { type: 'lead.created', filters: [{ field: 'lead.status', op: 'eq', value: 'WON' }] } }],
      false,
    );
    await (h.svc as any).onEvent('lead.created', event);
    expect(h.executor.start).not.toHaveBeenCalled();
  });

  it('ignores workflows bound to a different trigger type', async () => {
    const h = build([{ id: 'wf-1', status: 'ACTIVE', trigger: { type: 'task.completed', filters: [] } }]);
    await (h.svc as any).onEvent('lead.created', event);
    expect(h.executor.start).not.toHaveBeenCalled();
  });

  it('does nothing without a workspace context', async () => {
    const h = build([{ id: 'wf-1', status: 'ACTIVE', trigger: { type: 'lead.created', filters: [] } }]);
    await (h.svc as any).onEvent('lead.created', { payload: {}, tenantId: null });
    expect(h.prisma.workflow.findMany).not.toHaveBeenCalled();
  });

  it('subscribes to every trigger-source event on init', () => {
    const h = build([]);
    h.svc.onModuleInit();
    expect(h.bus.on).toHaveBeenCalledTimes(TRIGGER_TYPES.length);
  });
});
