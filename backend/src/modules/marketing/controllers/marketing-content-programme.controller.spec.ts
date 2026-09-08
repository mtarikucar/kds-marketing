import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { MarketingContentProgrammeController } from './marketing-content-programme.controller';
import { REQUIRE_PERMISSION_KEY } from '../roles/require-permission.decorator';
import { AUDIT_METADATA } from '../../audit/audit.decorator';
import { REQUIRES_FEATURE_KEY } from '../guards/feature.guard';

const user = { id: 'u-1', workspaceId: 'ws-1' } as never;
const programme = { id: 'prog-1', workspaceId: 'ws-1', status: 'ACTIVE', lookaheadDays: 14 };
const dash = { phase: 'SEED', status: 'ACTIVE', killSwitch: false, week: { weekStart: 'w', spent: 0, cap: 600 }, slots: [], types: [], learning: {}, trends: [], events: [] };
const slotView = { id: 'slot-1', status: 'PLANNED' };
const typeView = { id: 't-1', key: 'hook-demo' };

function build() {
  const programmes = {
    get: jest.fn().mockResolvedValue(programme),
    getOrThrow: jest.fn().mockImplementation(async (_ws: string, id: string) => {
      if (id !== 'prog-1') throw new NotFoundException('Programme not found');
      return programme;
    }),
    create: jest.fn().mockResolvedValue(programme),
    update: jest.fn().mockResolvedValue(programme),
    pause: jest.fn().mockResolvedValue({ ...programme, status: 'PAUSED' }),
    resume: jest.fn().mockResolvedValue(programme),
    kill: jest.fn().mockResolvedValue({ ...programme, status: 'KILLED' }),
  };
  const types = {
    create: jest.fn().mockResolvedValue({ id: 't-1', key: 'hook-demo' }),
    update: jest.fn().mockResolvedValue({ id: 't-1', key: 'hook-demo' }),
  };
  const dashboard = {
    dashboard: jest.fn().mockResolvedValue(dash),
    slots: jest.fn().mockResolvedValue([slotView]),
    slotView: jest.fn().mockImplementation(async (_ws: string, _p: string, slotId: string) => {
      if (slotId !== 'slot-1') throw new NotFoundException('Slot not found');
      return slotView;
    }),
    typeViews: jest.fn().mockResolvedValue([typeView, { id: 't-2', key: 'story' }]),
    learning: jest.fn().mockResolvedValue({ phase: 'SEED' }),
    trendViews: jest.fn().mockResolvedValue([]),
    events: jest.fn().mockResolvedValue([]),
  };
  const editor = {
    updateSlot: jest.fn().mockResolvedValue({ id: 'slot-1' }),
    skipSlot: jest.fn().mockResolvedValue({ id: 'slot-1', status: 'SKIPPED' }),
    regenerateSlot: jest.fn().mockResolvedValue({ id: 'slot-1' }),
    slotMetrics: jest.fn().mockResolvedValue({ slot: slotView, targets: [] }),
  };
  const ctrl = new MarketingContentProgrammeController(programmes as never, types as never, dashboard as never, editor as never);
  return { ctrl, programmes, types, dashboard, editor };
}

const proto = MarketingContentProgrammeController.prototype;

describe('MarketingContentProgrammeController — guards and metadata', () => {
  it('sits behind the socialCampaigns feature like the content line', () => {
    expect(Reflect.getMetadata(REQUIRES_FEATURE_KEY, MarketingContentProgrammeController)).toBe('socialCampaigns');
  });

  it('every read route needs campaigns.read and audits nothing', () => {
    for (const name of ['get', 'listTypes', 'listSlots', 'slotMetrics', 'learning', 'trends', 'events'] as const) {
      expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, proto[name])).toBe('campaigns.read');
      expect(Reflect.getMetadata(AUDIT_METADATA, proto[name])).toBeUndefined();
    }
  });

  it('every write route needs campaigns.write and audits the programme it acts on', () => {
    const writes = {
      create: 'content.programme.create',
      update: 'content.programme.update',
      pause: 'content.programme.pause',
      resume: 'content.programme.resume',
      kill: 'content.programme.kill',
      createType: 'content.programme.type.create',
      updateType: 'content.programme.type.update',
      updateSlot: 'content.programme.slot.update',
      skipSlot: 'content.programme.slot.skip',
      regenerateSlot: 'content.programme.slot.regenerate',
    } as const;
    for (const [name, action] of Object.entries(writes)) {
      const handler = proto[name as keyof typeof writes];
      expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handler)).toBe('campaigns.write');
      const audit = Reflect.getMetadata(AUDIT_METADATA, handler);
      expect(audit).toMatchObject({ action, resourceType: 'content_programme' });
      // Create has no :id yet; every other write names the programme param.
      if (name !== 'create') expect(audit.resourceIdParam).toBe('id');
    }
  });
});

describe('MarketingContentProgrammeController — the programme envelope', () => {
  it('GET / answers { programme, dashboard } for the workspace\'s programme', async () => {
    const { ctrl, programmes, dashboard } = build();
    await expect(ctrl.get(user)).resolves.toEqual({ programme, dashboard: dash });
    expect(programmes.get).toHaveBeenCalledWith('ws-1');
    expect(dashboard.dashboard).toHaveBeenCalledWith('ws-1', programme);
  });

  it('GET / answers { programme: null, dashboard: null } when there is none — and builds no dashboard', async () => {
    const { ctrl, programmes, dashboard } = build();
    programmes.get.mockResolvedValue(null);
    await expect(ctrl.get(user)).resolves.toEqual({ programme: null, dashboard: null });
    expect(dashboard.dashboard).not.toHaveBeenCalled();
  });

  it('POST / creates as the signed-in person and answers the same envelope', async () => {
    const { ctrl, programmes } = build();
    const body = { name: 'Sonbahar', brief: 'figürler', accountIds: ['acc-1'], perWeek: 3, goal: 'VIEWS' };
    await expect(ctrl.create(user, body)).resolves.toEqual({ programme, dashboard: dash });
    expect(programmes.create).toHaveBeenCalledWith('ws-1', { ...body, createdById: 'u-1' });
  });

  it('PATCH /:id, pause, resume and kill all go through the service workspace-scoped and answer the envelope', async () => {
    const { ctrl, programmes } = build();
    await expect(ctrl.update(user, 'prog-1', { perWeek: 4 })).resolves.toMatchObject({ dashboard: dash });
    expect(programmes.update).toHaveBeenCalledWith('ws-1', 'prog-1', { perWeek: 4 });
    await expect(ctrl.pause(user, 'prog-1')).resolves.toMatchObject({ programme: { status: 'PAUSED' } });
    expect(programmes.pause).toHaveBeenCalledWith('ws-1', 'prog-1');
    await ctrl.resume(user, 'prog-1');
    expect(programmes.resume).toHaveBeenCalledWith('ws-1', 'prog-1');
    await expect(ctrl.kill(user, 'prog-1')).resolves.toMatchObject({ programme: { status: 'KILLED' } });
    expect(programmes.kill).toHaveBeenCalledWith('ws-1', 'prog-1');
  });
});

describe('MarketingContentProgrammeController — sub-resources', () => {
  it('a foreign programme id is a 404 on every :id read, before any sub-query runs', async () => {
    const { ctrl, dashboard, editor } = build();
    await expect(ctrl.listTypes(user, 'prog-x')).rejects.toBeInstanceOf(NotFoundException);
    await expect(ctrl.listSlots(user, 'prog-x', {})).rejects.toBeInstanceOf(NotFoundException);
    await expect(ctrl.learning(user, 'prog-x')).rejects.toBeInstanceOf(NotFoundException);
    await expect(ctrl.trends(user, 'prog-x')).rejects.toBeInstanceOf(NotFoundException);
    await expect(ctrl.events(user, 'prog-x')).rejects.toBeInstanceOf(NotFoundException);
    await expect(ctrl.slotMetrics(user, 'prog-x', 'slot-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(dashboard.typeViews).not.toHaveBeenCalled();
    expect(dashboard.slots).not.toHaveBeenCalled();
    expect(editor.slotMetrics).not.toHaveBeenCalled();
  });

  it('GET /:id/types lists, POST creates then returns THAT type\'s view, PATCH updates likewise', async () => {
    const { ctrl, types, dashboard } = build();
    await expect(ctrl.listTypes(user, 'prog-1')).resolves.toHaveLength(2);
    const body = { key: 'hook-demo', name: 'Hook + demo' };
    await expect(ctrl.createType(user, 'prog-1', body)).resolves.toBe(typeView);
    expect(types.create).toHaveBeenCalledWith('ws-1', body);
    await expect(ctrl.updateType(user, 'prog-1', 't-1', { active: false })).resolves.toBe(typeView);
    expect(types.update).toHaveBeenCalledWith('ws-1', 't-1', { active: false });
    expect(dashboard.typeViews).toHaveBeenCalledWith('ws-1', 'prog-1');
  });

  it('GET /:id/slots defaults the window to yesterday → lookaheadDays and honours explicit bounds', async () => {
    const { ctrl, dashboard } = build();
    await ctrl.listSlots(user, 'prog-1', {});
    const [ws, pid, from, to, now] = dashboard.slots.mock.calls[0];
    expect([ws, pid]).toEqual(['ws-1', 'prog-1']);
    expect(now.getTime() - from.getTime()).toBe(24 * 60 * 60 * 1000);
    expect(to.getTime() - now.getTime()).toBe(14 * 24 * 60 * 60 * 1000);

    await ctrl.listSlots(user, 'prog-1', { from: '2026-09-01T00:00:00Z', to: '2026-09-30T00:00:00Z' });
    const [, , f2, t2] = dashboard.slots.mock.calls[1];
    expect(f2).toEqual(new Date('2026-09-01T00:00:00Z'));
    expect(t2).toEqual(new Date('2026-09-30T00:00:00Z'));
  });

  it('PATCH /:id/slots/:slotId edits as the signed-in person, parsing the date, and answers the fresh SlotView', async () => {
    const { ctrl, editor, dashboard } = build();
    const res = await ctrl.updateSlot(user, 'prog-1', 'slot-1', { idea: 'new idea', scheduledFor: '2026-09-12T15:00:00Z' });
    expect(editor.updateSlot).toHaveBeenCalledWith('ws-1', 'slot-1', { idea: 'new idea', scheduledFor: new Date('2026-09-12T15:00:00Z') }, 'u-1');
    expect(res).toBe(slotView);
    // The slot is verified as the programme's BEFORE the edit, and re-read after.
    expect(dashboard.slotView).toHaveBeenCalledTimes(2);
  });

  it('a slot that is not the programme\'s is a 404 and nothing is edited, skipped or regenerated', async () => {
    const { ctrl, editor } = build();
    await expect(ctrl.updateSlot(user, 'prog-1', 'slot-x', { idea: 'x' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(ctrl.skipSlot(user, 'prog-1', 'slot-x')).rejects.toBeInstanceOf(NotFoundException);
    await expect(ctrl.regenerateSlot(user, 'prog-1', 'slot-x')).rejects.toBeInstanceOf(NotFoundException);
    expect(editor.updateSlot).not.toHaveBeenCalled();
    expect(editor.skipSlot).not.toHaveBeenCalled();
    expect(editor.regenerateSlot).not.toHaveBeenCalled();
  });

  it('skip and regenerate go through the editor as the signed-in person and answer the SlotView', async () => {
    const { ctrl, editor } = build();
    await expect(ctrl.skipSlot(user, 'prog-1', 'slot-1')).resolves.toBe(slotView);
    expect(editor.skipSlot).toHaveBeenCalledWith('ws-1', 'slot-1', 'u-1');
    await expect(ctrl.regenerateSlot(user, 'prog-1', 'slot-1')).resolves.toBe(slotView);
    expect(editor.regenerateSlot).toHaveBeenCalledWith('ws-1', 'slot-1', 'u-1');
  });

  it('GET /:id/slots/:slotId/metrics answers the editor\'s metrics view for the programme\'s slot', async () => {
    const { ctrl, editor } = build();
    await expect(ctrl.slotMetrics(user, 'prog-1', 'slot-1')).resolves.toEqual({ slot: slotView, targets: [] });
    expect(editor.slotMetrics).toHaveBeenCalledWith('ws-1', 'slot-1');
  });

  it('learning, trends and events read through the dashboard service for the resolved programme', async () => {
    const { ctrl, dashboard } = build();
    await expect(ctrl.learning(user, 'prog-1')).resolves.toEqual({ phase: 'SEED' });
    expect(dashboard.learning).toHaveBeenCalledWith('ws-1', programme);
    await ctrl.trends(user, 'prog-1');
    expect(dashboard.trendViews).toHaveBeenCalledWith('ws-1', programme);
    await ctrl.events(user, 'prog-1');
    expect(dashboard.events).toHaveBeenCalledWith('ws-1', 'prog-1', 100);
  });
});
