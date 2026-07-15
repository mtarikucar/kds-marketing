import { WorkflowTriggerService } from './workflow-trigger.service';
import { TRIGGER_TYPES } from './workflow-dsl.schema';
import { MarketingEventTypes } from '../events/marketing-event-types';

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

  const event = { id: 'evt-1', payload: { workspaceId: WS, leadId: 'lead-1' }, tenantId: null } as any;

  it('starts a workflow whose trigger type + filters match, threading the source event id for idempotency', async () => {
    const h = build([{ id: 'wf-1', status: 'ACTIVE', trigger: { type: 'lead.created', filters: [] } }]);
    await (h.svc as any).onEvent('lead.created', event);
    expect(h.executor.start).toHaveBeenCalledTimes(1);
    // event.id is passed so a redelivered event (incl. a leadless one the
    // active-per-lead index can't dedupe) is a P2002 no-op, not a double-enroll.
    expect(h.executor.start).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), 0, 'evt-1');
  });

  it('a LEADLESS trigger still threads the event id (its only dedup on redelivery)', async () => {
    const h = build([{ id: 'wf-1', status: 'ACTIVE', trigger: { type: 'webhook.received', filters: [] } }]);
    const leadless = { id: 'evt-hook', payload: { workspaceId: WS }, tenantId: null } as any;
    await (h.svc as any).onEvent('webhook.received', leadless);
    expect(h.executor.start).toHaveBeenCalledWith(
      expect.anything(), { leadId: null, conversationId: null }, expect.anything(), 0, 'evt-hook',
    );
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

  // NetGSM Phase 5 Task 3 — press-1 on a VOICE campaign call. Asserts the
  // 'voice_keypress' trigger type is actually wired to
  // MarketingEventTypes.VoiceKeypress in EVENT_FOR_TRIGGER: if that mapping
  // were missing, `bus.on` would be called with `undefined` instead, which
  // this pins down explicitly (the generic length-only assertion above
  // wouldn't catch it).
  it('wires the voice_keypress trigger to marketing.voice.keypress.v1 on init', () => {
    const h = build([]);
    h.svc.onModuleInit();
    expect(h.bus.on).toHaveBeenCalledWith(MarketingEventTypes.VoiceKeypress, expect.any(Function));
  });

  it('starts a workflow whose trigger is voice_keypress, filtered by trigger.key', async () => {
    const h = build([
      { id: 'wf-voice', status: 'ACTIVE', trigger: { type: 'voice_keypress', filters: [{ field: 'trigger.key', op: 'eq', value: '1' }] } },
    ]);
    const keypressEvent = {
      payload: { workspaceId: WS, leadId: 'lead-1', campaignId: 'camp-1', recipientId: 'recip-1', key: '1' },
      tenantId: null,
    } as any;

    await (h.svc as any).onEvent('voice_keypress', keypressEvent);

    expect(h.executor.start).toHaveBeenCalledTimes(1);
  });
});
