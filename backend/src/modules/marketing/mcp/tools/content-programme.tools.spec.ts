import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { McpToolRegistry } from '../mcp-tool-registry';
import { registerContentProgrammeTools } from './content-programme.tools';

const programme = { id: 'prog-1', workspaceId: 'ws1', status: 'ACTIVE', perWeek: 5, weeklyCreditCap: 600, lookaheadDays: 14, planLeadHours: 36, produceLeadHours: 12 };
const dash = { phase: 'SEED', slots: [] };
const slotView = { id: 'slot-1', status: 'PLANNED', editable: true };

function build(over: { features?: Record<string, boolean>; programme?: unknown } = {}) {
  const registry = new McpToolRegistry();
  const programmes = {
    get: jest.fn().mockResolvedValue(over.programme === undefined ? programme : over.programme),
    getOrThrow: jest.fn().mockImplementation(async (_ws: string, id: string) => {
      if (id !== 'prog-1') throw new NotFoundException('Programme not found');
      return programme;
    }),
    update: jest.fn().mockResolvedValue({ ...programme, perWeek: 3 }),
    pause: jest.fn().mockResolvedValue({ ...programme, status: 'PAUSED' }),
    resume: jest.fn().mockResolvedValue({ ...programme, status: 'ACTIVE' }),
    kill: jest.fn(),
  };
  const dashboard = {
    dashboard: jest.fn().mockResolvedValue(dash),
    slotView: jest.fn().mockResolvedValue(slotView),
  };
  const editor = {
    updateSlot: jest.fn().mockResolvedValue({ id: 'slot-1', programmeId: 'prog-1' }),
    skipSlot: jest.fn().mockResolvedValue({ id: 'slot-1', programmeId: 'prog-1', status: 'SKIPPED' }),
    regenerateSlot: jest.fn().mockResolvedValue({ id: 'slot-1', programmeId: 'prog-1' }),
  };
  const principals = {
    resolve: jest.fn().mockResolvedValue({ id: 'sys-1', workspaceId: 'ws1', role: 'SYSTEM' }),
    assertActiveMember: jest.fn(),
  };
  const entitlements = {
    getEffective: jest.fn().mockResolvedValue({ features: over.features ?? { socialCampaigns: true } }),
  };
  registerContentProgrammeTools(registry, {
    programmes: programmes as never,
    dashboard: dashboard as never,
    editor: editor as never,
    principals: principals as never,
    entitlements: entitlements as never,
  });
  return { registry, programmes, dashboard, editor, principals };
}

const ctx = (extra: Record<string, unknown> = {}) => ({ workspaceId: 'ws1', grantedScopes: [], ...extra });

describe('the three programme tools, as declared', () => {
  it('are all deferred content tools with no approval card; read is READ, the two writes are WRITE', () => {
    const { registry } = build();
    const get = registry.get('jeeta.get_content_programme')!;
    const update = registry.get('jeeta.update_content_programme')!;
    const edit = registry.get('jeeta.edit_content_slot')!;
    for (const t of [get, update, edit]) {
      expect(t.defer).toBe(true);
      expect(t.domain).toBe('content');
      expect(t.requiresApproval).toBe(false);
    }
    expect(get.risk).toBe('READ');
    expect(get.scopes).toEqual(['campaigns.read']);
    expect(update.risk).toBe('WRITE');
    expect(update.scopes).toEqual(['campaigns.write']);
    expect(edit.risk).toBe('WRITE');
    expect(edit.scopes).toEqual(['campaigns.write']);
  });

  it('say in their own words what spends money: the programme spends autonomously within the cap, an edit never spends until produced, regenerate re-buys', () => {
    const { registry } = build();
    expect(registry.get('jeeta.get_content_programme')!.description).toMatch(/AUTONOMOUS CREDIT SPEND/);
    expect(registry.get('jeeta.get_content_programme')!.description).toMatch(/weeklyCreditCap/);
    expect(registry.get('jeeta.update_content_programme')!.description).toMatch(/SPENDS CREDITS AUTONOMOUSLY/);
    expect(registry.get('jeeta.update_content_programme')!.description).toMatch(/weeklyCreditCap/);
    const edit = registry.get('jeeta.edit_content_slot')!.description;
    expect(edit).toMatch(/SPENDS NOTHING now/);
    expect(edit).toMatch(/REGENERATE RE-BUYS/);
  });

  it('offers no kill — that door is hub-only', () => {
    const { registry } = build();
    expect(registry.get('jeeta.update_content_programme')!.inputSchema.safeParse({ programmeId: 'p', action: 'kill' }).success).toBe(false);
    expect(registry.list(['campaigns.write']).map((t) => t.name)).not.toContain('jeeta.kill_content_programme');
  });
});

describe('jeeta.get_content_programme', () => {
  it('answers the programme with its dashboard', async () => {
    const { registry, dashboard } = build();
    const res = await registry.get('jeeta.get_content_programme')!.handler(ctx(), {});
    expect(res).toEqual({ programme, dashboard: dash });
    expect(dashboard.dashboard).toHaveBeenCalledWith('ws1', programme);
  });

  it('answers { programme: null, dashboard: null } when there is none, without building a dashboard', async () => {
    const { registry, dashboard } = build({ programme: null });
    await expect(registry.get('jeeta.get_content_programme')!.handler(ctx(), {})).resolves.toEqual({ programme: null, dashboard: null });
    expect(dashboard.dashboard).not.toHaveBeenCalled();
  });

  it('is refused by a workspace whose package lacks socialCampaigns, before any read', async () => {
    const { registry, programmes } = build({ features: { socialCampaigns: false } });
    await expect(registry.get('jeeta.get_content_programme')!.handler(ctx(), {})).rejects.toBeInstanceOf(ForbiddenException);
    expect(programmes.get).not.toHaveBeenCalled();
  });
});

describe('jeeta.update_content_programme', () => {
  it('forwards the settings workspace-scoped and answers the updated programme', async () => {
    const { registry, programmes } = build();
    const res = await registry.get('jeeta.update_content_programme')!.handler(ctx(), {
      programmeId: 'prog-1',
      settings: { perWeek: 3, goal: 'VIEWS' },
    });
    expect(programmes.update).toHaveBeenCalledWith('ws1', 'prog-1', { perWeek: 3, goal: 'VIEWS' });
    expect(res).toEqual({ programme: { ...programme, perWeek: 3 } });
    expect(programmes.pause).not.toHaveBeenCalled();
  });

  it('pauses / resumes through the programme service, and applies settings BEFORE the action', async () => {
    const { registry, programmes } = build();
    const tool = registry.get('jeeta.update_content_programme')!;
    const order: string[] = [];
    programmes.update.mockImplementation(async () => { order.push('update'); return programme; });
    programmes.pause.mockImplementation(async () => { order.push('pause'); return { ...programme, status: 'PAUSED' }; });
    const res = await tool.handler(ctx(), { programmeId: 'prog-1', action: 'pause', settings: { weeklyCreditCap: 300 } });
    expect(order).toEqual(['update', 'pause']);
    expect(res).toEqual({ programme: { ...programme, status: 'PAUSED' } });
    await tool.handler(ctx(), { programmeId: 'prog-1', action: 'resume' });
    expect(programmes.resume).toHaveBeenCalledWith('ws1', 'prog-1');
  });

  it('refuses an empty call rather than silently doing nothing', async () => {
    const { registry, programmes } = build();
    const tool = registry.get('jeeta.update_content_programme')!;
    await expect(tool.handler(ctx(), { programmeId: 'prog-1' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(tool.handler(ctx(), { programmeId: 'prog-1', settings: {} })).rejects.toBeInstanceOf(BadRequestException);
    expect(programmes.update).not.toHaveBeenCalled();
  });

  it('a foreign programme id is a 404 — the workspace comes from the session, never the caller', async () => {
    const { registry, programmes } = build();
    await expect(
      registry.get('jeeta.update_content_programme')!.handler(ctx(), { programmeId: 'prog-other', action: 'pause' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(programmes.pause).not.toHaveBeenCalled();
  });

  it('only accepts the owner\'s settings and the two real actions', () => {
    const schema = build().registry.get('jeeta.update_content_programme')!.inputSchema;
    expect(schema.safeParse({ programmeId: 'p', settings: { status: 'KILLED' } }).success).toBe(false);
    expect(schema.safeParse({ programmeId: 'p', settings: { killSwitch: true } }).success).toBe(false);
    expect(schema.safeParse({ programmeId: 'p', settings: { goal: 'FAME' } }).success).toBe(false);
    expect(schema.safeParse({ programmeId: 'p', settings: { personaId: null, perWeek: 5 } }).success).toBe(true);
    expect(schema.safeParse({ programmeId: 'p', settings: { daysOfWeek: [1, 3, 5], perWeek: 3 } }).success).toBe(true);
    expect(schema.safeParse({ programmeId: 'p', action: 'resume' }).success).toBe(true);
  });

  it('holds the schema to the service bounds: perWeek at most 7, weeklyCreditCap at most 20000, weekdays 0-6', () => {
    const schema = build().registry.get('jeeta.update_content_programme')!.inputSchema;
    expect(schema.safeParse({ programmeId: 'p', settings: { perWeek: 8 } }).success).toBe(false);
    expect(schema.safeParse({ programmeId: 'p', settings: { perWeek: 7 } }).success).toBe(true);
    expect(schema.safeParse({ programmeId: 'p', settings: { weeklyCreditCap: 20001 } }).success).toBe(false);
    expect(schema.safeParse({ programmeId: 'p', settings: { weeklyCreditCap: 20000 } }).success).toBe(true);
    expect(schema.safeParse({ programmeId: 'p', settings: { daysOfWeek: [7] } }).success).toBe(false);
    expect(schema.safeParse({ programmeId: 'p', settings: { daysOfWeek: [] } }).success).toBe(false);
  });

  it('bounds the look-ahead and the two lead times above as well as below — an unbounded lead pulls later weeks into one week\'s spend check', () => {
    const schema = build().registry.get('jeeta.update_content_programme')!.inputSchema;
    expect(schema.safeParse({ programmeId: 'p', settings: { planLeadHours: 800, produceLeadHours: 799 } }).success).toBe(false);
    expect(schema.safeParse({ programmeId: 'p', settings: { planLeadHours: 97 } }).success).toBe(false);
    expect(schema.safeParse({ programmeId: 'p', settings: { planLeadHours: 5 } }).success).toBe(false);
    expect(schema.safeParse({ programmeId: 'p', settings: { produceLeadHours: 49 } }).success).toBe(false);
    expect(schema.safeParse({ programmeId: 'p', settings: { produceLeadHours: 1 } }).success).toBe(false);
    expect(schema.safeParse({ programmeId: 'p', settings: { lookaheadDays: 29 } }).success).toBe(false);
    expect(schema.safeParse({ programmeId: 'p', settings: { planLeadHours: 96, produceLeadHours: 48, lookaheadDays: 28 } }).success).toBe(true);
    expect(schema.safeParse({ programmeId: 'p', settings: { planLeadHours: 6, produceLeadHours: 2, lookaheadDays: 7 } }).success).toBe(true);
  });

  /**
   * Create and kill are hub-only because they start and end autonomous spend;
   * the lever that SCALES it has to be hub-only in the upward direction too, or
   * one injected instruction raises the only money bound on the autopilot.
   */
  describe('the cap, the cadence, the look-ahead and the lead times only move DOWN from an agent', () => {
    it.each([
      ['a higher weeklyCreditCap', { weeklyCreditCap: 601 }],
      ['a higher perWeek', { perWeek: 6 }],
      ['both, with other settings alongside', { weeklyCreditCap: 10000000, perWeek: 7, brief: 'x' }],
      // The three that decide how many weeks' slots one week's cap check sees.
      ['a longer lookaheadDays', { lookaheadDays: 15 }],
      ['a longer planLeadHours', { planLeadHours: 37 }],
      ['a longer produceLeadHours', { produceLeadHours: 13 }],
      ['every lever at its schema ceiling', { lookaheadDays: 28, planLeadHours: 96, produceLeadHours: 48 }],
    ])('refuses %s by name, updates nothing and applies no action', async (_label, settings) => {
      const { registry, programmes } = build();
      await expect(
        registry.get('jeeta.update_content_programme')!.handler(ctx(), { programmeId: 'prog-1', settings, action: 'pause' }),
      ).rejects.toThrow(/Raising the weekly cap, the cadence, the look-ahead or the lead times is done from the hub, not by an agent/);
      expect(programmes.update).not.toHaveBeenCalled();
      expect(programmes.pause).not.toHaveBeenCalled();
    });

    it('names the levers it refused', async () => {
      const { registry } = build();
      await expect(
        registry.get('jeeta.update_content_programme')!.handler(ctx(), { programmeId: 'prog-1', settings: { planLeadHours: 48, produceLeadHours: 12, lookaheadDays: 7 } }),
      ).rejects.toThrow(/\(planLeadHours\)$/);
    });

    it.each([
      ['the same cap and cadence', { weeklyCreditCap: 600, perWeek: 5 }],
      ['a lower cap', { weeklyCreditCap: 300 }],
      ['a lower cadence', { perWeek: 2 }],
      ['the same or shorter look-ahead and leads', { lookaheadDays: 14, planLeadHours: 24, produceLeadHours: 6 }],
      ['settings that touch none of them', { brief: 'new brief', explorationRate: 0.1 }],
    ])('lets %s through', async (_label, settings) => {
      const { registry, programmes } = build();
      await registry.get('jeeta.update_content_programme')!.handler(ctx(), { programmeId: 'prog-1', settings });
      expect(programmes.update).toHaveBeenCalledWith('ws1', 'prog-1', settings);
    });

    it('compares against the CURRENT row, read workspace-scoped, not against a default', async () => {
      const { registry, programmes } = build();
      programmes.getOrThrow.mockResolvedValueOnce({ ...programme, weeklyCreditCap: 1000, perWeek: 2 });
      await registry.get('jeeta.update_content_programme')!.handler(ctx(), { programmeId: 'prog-1', settings: { weeklyCreditCap: 900 } });
      expect(programmes.update).toHaveBeenCalled();
      await expect(
        registry.get('jeeta.update_content_programme')!.handler(ctx(), { programmeId: 'prog-1', settings: { perWeek: 6 } }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});

describe('jeeta.edit_content_slot', () => {
  it('rewrites the slot as the signed-in person, parsing the date, and answers the panel\'s SlotView', async () => {
    const { registry, editor, dashboard } = build();
    const res = await registry.get('jeeta.edit_content_slot')!.handler(ctx({ userId: 'u9' }), {
      slotId: 'slot-1',
      idea: 'a figure emerging from the printer',
      scheduledFor: '2026-09-12T15:00:00Z',
    });
    expect(editor.updateSlot).toHaveBeenCalledWith(
      'ws1',
      'slot-1',
      { idea: 'a figure emerging from the printer', scheduledFor: new Date('2026-09-12T15:00:00Z') },
      'u9',
    );
    expect(dashboard.slotView).toHaveBeenCalledWith('ws1', 'prog-1', 'slot-1');
    expect(res).toBe(slotView);
  });

  it('falls back to the service principal when no human is behind the session', async () => {
    const { registry, editor, principals } = build();
    await registry.get('jeeta.edit_content_slot')!.handler(ctx(), { slotId: 'slot-1', contentTypeKey: 'story' });
    expect(principals.resolve).toHaveBeenCalled();
    expect(editor.updateSlot).toHaveBeenCalledWith('ws1', 'slot-1', { contentTypeKey: 'story' }, 'sys-1');
  });

  it('skip and regenerate go to the editor and ignore the edit fields', async () => {
    const { registry, editor } = build();
    const tool = registry.get('jeeta.edit_content_slot')!;
    await tool.handler(ctx({ userId: 'u9' }), { slotId: 'slot-1', action: 'skip', idea: 'ignored' });
    expect(editor.skipSlot).toHaveBeenCalledWith('ws1', 'slot-1', 'u9');
    await tool.handler(ctx({ userId: 'u9' }), { slotId: 'slot-1', action: 'regenerate' });
    expect(editor.regenerateSlot).toHaveBeenCalledWith('ws1', 'slot-1', 'u9');
    expect(editor.updateSlot).not.toHaveBeenCalled();
  });

  it('refuses an empty call', async () => {
    const { registry, editor } = build();
    await expect(registry.get('jeeta.edit_content_slot')!.handler(ctx(), { slotId: 'slot-1' })).rejects.toBeInstanceOf(BadRequestException);
    expect(editor.updateSlot).not.toHaveBeenCalled();
  });

  it('validates the date and the action at the schema', () => {
    const schema = build().registry.get('jeeta.edit_content_slot')!.inputSchema;
    expect(schema.safeParse({ slotId: 's', scheduledFor: 'tomorrow' }).success).toBe(false);
    expect(schema.safeParse({ slotId: 's', scheduledFor: '2026-09-12T15:00:00+03:00' }).success).toBe(true);
    expect(schema.safeParse({ slotId: 's', action: 'kill' }).success).toBe(false);
  });

  it('is gated on the socialCampaigns feature like the rest of the line', async () => {
    const { registry, editor } = build({ features: { socialCampaigns: false } });
    await expect(registry.get('jeeta.edit_content_slot')!.handler(ctx(), { slotId: 'slot-1', action: 'skip' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(editor.skipSlot).not.toHaveBeenCalled();
  });
});
