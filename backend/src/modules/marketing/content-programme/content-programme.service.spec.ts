import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ContentProgrammeService, PROGRAMME_GOALS, spreadDaysOfWeek } from './content-programme.service';

const WS = 'ws-1';
const CAMPAIGN_ID = 'camp-1';

function programmeRow(over: Record<string, unknown> = {}) {
  return {
    id: 'prog-1',
    workspaceId: WS,
    name: 'Sonbahar',
    status: 'ACTIVE',
    socialCampaignId: CAMPAIGN_ID,
    goal: 'COMPOSITE',
    brief: 'Figurunica 3D baskı figürleri',
    personaId: null,
    perWeek: 5,
    weeklyCreditCap: 600,
    explorationRate: 0.15,
    maturityHours: 72,
    halfLifeDays: 30,
    editWindowHours: 2,
    lookaheadDays: 14,
    planLeadHours: 36,
    produceLeadHours: 12,
    seedWeeks: 2,
    phase: 'SEED',
    killSwitch: false,
    lastPlannedAt: null,
    lastMeasuredAt: null,
    lastReweightedAt: null,
    createdById: 'u-1',
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    ...over,
  };
}

function campaignRow(over: Record<string, unknown> = {}) {
  return {
    id: CAMPAIGN_ID,
    workspaceId: WS,
    name: 'Sonbahar',
    status: 'DRAFT',
    cadence: { daysOfWeek: [1, 2, 3, 4, 5], timeOfDay: '18:00', timezone: 'Europe/Istanbul' },
    dailyPublishCap: 1,
    programmeId: null,
    ...over,
  };
}

function harness(over: { accounts?: unknown[]; programme?: unknown; campaign?: unknown } = {}) {
  const prisma: any = {
    socialAccount: {
      findMany: jest.fn().mockResolvedValue(
        over.accounts ?? [
          { id: 'acc-1', workspaceId: WS, network: 'INSTAGRAM', enabled: true },
          { id: 'acc-2', workspaceId: WS, network: 'TIKTOK', enabled: true },
        ],
      ),
    },
    socialCampaign: {
      findFirst: jest.fn().mockResolvedValue(over.campaign === undefined ? campaignRow() : over.campaign),
      update: jest.fn().mockImplementation(async ({ where, data }: any) => campaignRow({ ...where, ...data })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    contentProgramme: {
      create: jest.fn().mockImplementation(async ({ data }: any) => programmeRow(data)),
      findFirst: jest.fn().mockResolvedValue(over.programme === undefined ? programmeRow() : over.programme),
      update: jest.fn().mockImplementation(async ({ where, data }: any) => programmeRow({ ...where, ...data })),
    },
    contentSlot: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
    contentProgrammeEvent: {
      create: jest.fn().mockResolvedValue({ id: 'ev-1' }),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  // The order of calls across the two fakes is what the "programmeId before
  // activate" test reads; one shared log makes that observable.
  const calls: string[] = [];
  prisma.socialCampaign.update.mockImplementation(async ({ where, data }: any) => {
    calls.push(`prisma.socialCampaign.update:${Object.keys(data).join(',')}`);
    return campaignRow({ ...where, ...data });
  });
  const socialCampaigns = {
    create: jest.fn().mockImplementation(async (_ws: string, input: any) => {
      calls.push('campaign.create');
      return campaignRow({ name: input.name, cadence: input.cadence, dailyPublishCap: input.dailyPublishCap });
    }),
    activate: jest.fn().mockImplementation(async () => {
      calls.push('campaign.activate');
      return campaignRow({ status: 'ACTIVE' });
    }),
    pause: jest.fn().mockResolvedValue(campaignRow({ status: 'PAUSED' })),
    resume: jest.fn().mockResolvedValue(campaignRow({ status: 'ACTIVE' })),
  };
  const contentTypes = {
    ensureDefaults: jest.fn().mockImplementation(async () => {
      calls.push('types.ensureDefaults');
      return [];
    }),
  };
  const svc = new ContentProgrammeService(prisma, socialCampaigns as any, contentTypes as any);
  return { svc, prisma, socialCampaigns, contentTypes, calls };
}

const input = (over: Record<string, unknown> = {}) => ({
  name: 'Sonbahar',
  brief: 'Figurunica 3D baskı figürleri',
  accountIds: ['acc-1', 'acc-2'],
  createdById: 'u-1',
  ...over,
});

describe('spreadDaysOfWeek', () => {
  it('spreads a weekly count evenly over the week', () => {
    expect(spreadDaysOfWeek(5)).toEqual([1, 2, 3, 4, 5]);
    expect(spreadDaysOfWeek(7)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(spreadDaysOfWeek(3)).toEqual([1, 3, 5]);
    expect(spreadDaysOfWeek(1)).toHaveLength(1);
    expect(spreadDaysOfWeek(14)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});

describe('ContentProgrammeService.create', () => {
  it('creates the FULL_AUTO video campaign, links it, activates it, seeds the types and writes the programme', async () => {
    const { svc, prisma, socialCampaigns, contentTypes } = harness();

    const out = await svc.create(WS, input());

    expect(socialCampaigns.create).toHaveBeenCalledWith(
      WS,
      expect.objectContaining({
        name: 'Sonbahar',
        theme: 'Figurunica 3D baskı figürleri',
        brief: { theme: 'Figurunica 3D baskı figürleri', programme: true },
        automationMode: 'FULL_AUTO',
        planningMode: 'AI_FULL',
        cadence: { daysOfWeek: [1, 2, 3, 4, 5], timeOfDay: '18:00', timezone: 'Europe/Istanbul' },
        targetAccountIds: ['acc-1', 'acc-2'],
        mediaKinds: ['VIDEO'],
        dailyPublishCap: 1,
        createdById: 'u-1',
      }),
    );
    expect(socialCampaigns.activate).toHaveBeenCalledWith(WS, CAMPAIGN_ID);
    expect(contentTypes.ensureDefaults).toHaveBeenCalledWith(WS);
    const data = prisma.contentProgramme.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      workspaceId: WS,
      name: 'Sonbahar',
      socialCampaignId: CAMPAIGN_ID,
      goal: 'COMPOSITE',
      perWeek: 5,
      weeklyCreditCap: 600,
      status: 'ACTIVE',
      createdById: 'u-1',
    });
    expect(out.status).toBe('ACTIVE');
    expect(prisma.contentProgrammeEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ workspaceId: WS, kind: 'CREATED' }) }),
    );
  });

  it('stamps programmeId on the campaign BEFORE activating it, so its own plan tick creates nothing', async () => {
    const { svc, prisma, calls } = harness();
    await svc.create(WS, input());
    const link = calls.indexOf('prisma.socialCampaign.update:programmeId');
    const activate = calls.indexOf('campaign.activate');
    expect(link).toBeGreaterThan(-1);
    expect(activate).toBeGreaterThan(link);
    // The link is the id the programme row is then written with.
    const linked = prisma.socialCampaign.update.mock.calls[0][0];
    expect(linked.where).toEqual({ id: CAMPAIGN_ID });
    expect(linked.data.programmeId).toBe(prisma.contentProgramme.create.mock.calls[0][0].data.id);
  });

  it('honours an explicit cadence and the perWeek-derived daily cap', async () => {
    const { svc, socialCampaigns } = harness();
    await svc.create(WS, input({ perWeek: 10, daysOfWeek: [1, 4], timeOfDay: '09:30' }));
    expect(socialCampaigns.create.mock.calls[0][1]).toMatchObject({
      cadence: { daysOfWeek: [1, 4], timeOfDay: '09:30', timezone: 'Europe/Istanbul' },
      dailyPublishCap: 2,
    });
  });

  it('refuses an empty account list before touching anything', async () => {
    const { svc, socialCampaigns } = harness();
    await expect(svc.create(WS, input({ accountIds: [] }))).rejects.toThrow(BadRequestException);
    expect(socialCampaigns.create).not.toHaveBeenCalled();
  });

  it('refuses an account that is not this workspace\'s, or is disconnected', async () => {
    const { svc, socialCampaigns, prisma } = harness({
      accounts: [{ id: 'acc-1', workspaceId: WS, network: 'INSTAGRAM', enabled: true }],
    });
    await expect(svc.create(WS, input({ accountIds: ['acc-1', 'acc-foreign'] }))).rejects.toThrow(/acc-foreign/);
    expect(prisma.socialAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ workspaceId: WS, enabled: true }) }),
    );
    expect(socialCampaigns.create).not.toHaveBeenCalled();
  });

  it.each([
    ['perWeek 0', { perWeek: 0 }],
    ['perWeek 15', { perWeek: 15 }],
    ['weeklyCreditCap 49', { weeklyCreditCap: 49 }],
    ['unknown goal', { goal: 'VIRALITY' }],
    ['bad day', { daysOfWeek: [7] }],
    ['bad time', { timeOfDay: '25:00' }],
    ['empty name', { name: '  ' }],
    ['empty brief', { brief: '' }],
  ])('refuses %s', async (_label, over) => {
    const { svc, socialCampaigns } = harness();
    await expect(svc.create(WS, input(over))).rejects.toThrow(BadRequestException);
    expect(socialCampaigns.create).not.toHaveBeenCalled();
  });

  it('accepts every documented goal', () => {
    expect(PROGRAMME_GOALS).toEqual(['ENGAGEMENT', 'VIEWS', 'SAVES_SHARES', 'LEADS', 'COMPOSITE']);
  });

  it('pauses the campaign and rethrows when a step after the campaign creation fails', async () => {
    const { svc, prisma, socialCampaigns } = harness();
    prisma.contentProgramme.create.mockRejectedValueOnce(new Error('db down'));

    await expect(svc.create(WS, input())).rejects.toThrow('db down');

    // The campaign was activated by then; it is paused so it cannot publish
    // for a programme that does not exist.
    expect(socialCampaigns.pause).toHaveBeenCalledWith(WS, CAMPAIGN_ID);
  });

  it('marks the campaign PAUSED directly when it was never activated', async () => {
    const { svc, prisma, socialCampaigns } = harness();
    // The link write fails: the campaign is still DRAFT, which `pause` refuses.
    prisma.socialCampaign.update.mockRejectedValueOnce(new Error('link failed'));
    socialCampaigns.pause.mockRejectedValueOnce(new BadRequestException('Cannot pause from DRAFT'));

    await expect(svc.create(WS, input())).rejects.toThrow('link failed');

    expect(socialCampaigns.activate).not.toHaveBeenCalled();
    expect(prisma.socialCampaign.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: CAMPAIGN_ID, workspaceId: WS }, data: { status: 'PAUSED' } }),
    );
  });
});

describe('ContentProgrammeService.get / getOrThrow', () => {
  it('get returns the newest non-KILLED programme of the workspace', async () => {
    const { svc, prisma } = harness();
    await svc.get(WS);
    expect(prisma.contentProgramme.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: WS, status: { not: 'KILLED' } },
        orderBy: { createdAt: 'desc' },
      }),
    );
  });

  it('getOrThrow scopes by workspace and says NotFound', async () => {
    const { svc, prisma } = harness({ programme: null });
    await expect(svc.getOrThrow(WS, 'prog-x')).rejects.toThrow(NotFoundException);
    expect(prisma.contentProgramme.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'prog-x', workspaceId: WS } }),
    );
  });
});

describe('ContentProgrammeService.update', () => {
  it('writes the settings it accepts, through a workspace-scoped update', async () => {
    const { svc, prisma } = harness();
    await svc.update(WS, 'prog-1', {
      name: 'Kış',
      brief: 'yeni brief',
      goal: 'VIEWS',
      weeklyCreditCap: 900,
      explorationRate: 0.2,
      maturityHours: 48,
      halfLifeDays: 14,
      editWindowHours: 3,
      lookaheadDays: 21,
      planLeadHours: 48,
      produceLeadHours: 24,
      personaId: 'persona-1',
    });
    const call = prisma.contentProgramme.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'prog-1' });
    expect(call.data).toEqual({
      name: 'Kış',
      brief: 'yeni brief',
      goal: 'VIEWS',
      weeklyCreditCap: 900,
      explorationRate: 0.2,
      maturityHours: 48,
      halfLifeDays: 14,
      editWindowHours: 3,
      lookaheadDays: 21,
      planLeadHours: 48,
      produceLeadHours: 24,
      personaId: 'persona-1',
    });
    // The row was proven to be the workspace's before the write.
    expect(prisma.contentProgramme.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'prog-1', workspaceId: WS } }),
    );
  });

  it('perWeek also moves the campaign cadence and its daily cap', async () => {
    const { svc, prisma } = harness();
    await svc.update(WS, 'prog-1', { perWeek: 3 });
    expect(prisma.contentProgramme.update.mock.calls[0][0].data).toEqual({ perWeek: 3 });
    expect(prisma.socialCampaign.updateMany).toHaveBeenCalledWith({
      where: { id: CAMPAIGN_ID, workspaceId: WS },
      data: {
        cadence: { daysOfWeek: [1, 3, 5], timeOfDay: '18:00', timezone: 'Europe/Istanbul' },
        dailyPublishCap: 1,
      },
    });
  });

  it.each([
    ['a field it does not own', { status: 'KILLED' }],
    ['killSwitch', { killSwitch: true }],
    ['phase', { phase: 'EXPLOIT' }],
    ['explorationRate above 0.5', { explorationRate: 0.6 }],
    ['explorationRate below 0.05', { explorationRate: 0.01 }],
    ['maturityHours 12', { maturityHours: 12 }],
    ['halfLifeDays 100', { halfLifeDays: 100 }],
    ['editWindowHours 0', { editWindowHours: 0 }],
    ['lookaheadDays 30', { lookaheadDays: 30 }],
    ['produceLead not below planLead', { planLeadHours: 12, produceLeadHours: 12 }],
    ['produceLead alone at or above the stored planLead', { produceLeadHours: 36 }],
    ['perWeek 0', { perWeek: 0 }],
    ['weeklyCreditCap 10', { weeklyCreditCap: 10 }],
    ['unknown goal', { goal: 'FAME' }],
    ['empty name', { name: '' }],
  ])('refuses %s', async (_label, patch) => {
    const { svc, prisma } = harness();
    await expect(svc.update(WS, 'prog-1', patch as any)).rejects.toThrow(BadRequestException);
    expect(prisma.contentProgramme.update).not.toHaveBeenCalled();
  });

  it('refuses a KILLED programme', async () => {
    const { svc, prisma } = harness({ programme: programmeRow({ status: 'KILLED' }) });
    await expect(svc.update(WS, 'prog-1', { name: 'x' })).rejects.toThrow(BadRequestException);
    expect(prisma.contentProgramme.update).not.toHaveBeenCalled();
  });
});

describe('ContentProgrammeService.pause / resume / kill', () => {
  it('pause: PAUSED, campaign paused, event written', async () => {
    const { svc, prisma, socialCampaigns } = harness({ campaign: campaignRow({ status: 'ACTIVE' }) });
    const out = await svc.pause(WS, 'prog-1');
    expect(prisma.contentProgramme.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'prog-1' }, data: { status: 'PAUSED' } }),
    );
    expect(socialCampaigns.pause).toHaveBeenCalledWith(WS, CAMPAIGN_ID);
    expect(out.status).toBe('PAUSED');
    expect(prisma.contentProgrammeEvent.create.mock.calls[0][0].data.kind).toBe('PAUSED');
  });

  it('pause refuses a programme that is not ACTIVE', async () => {
    const { svc, socialCampaigns } = harness({ programme: programmeRow({ status: 'PAUSED' }) });
    await expect(svc.pause(WS, 'prog-1')).rejects.toThrow(BadRequestException);
    expect(socialCampaigns.pause).not.toHaveBeenCalled();
  });

  it('pause does not fail when the campaign is already not ACTIVE', async () => {
    const { svc, socialCampaigns } = harness({ campaign: campaignRow({ status: 'PAUSED' }) });
    await svc.pause(WS, 'prog-1');
    expect(socialCampaigns.pause).not.toHaveBeenCalled();
  });

  it('resume: ACTIVE, campaign resumed, event written', async () => {
    const { svc, prisma, socialCampaigns } = harness({
      programme: programmeRow({ status: 'PAUSED' }),
      campaign: campaignRow({ status: 'PAUSED' }),
    });
    const out = await svc.resume(WS, 'prog-1');
    expect(prisma.contentProgramme.update.mock.calls[0][0].data).toEqual({ status: 'ACTIVE' });
    expect(socialCampaigns.resume).toHaveBeenCalledWith(WS, CAMPAIGN_ID);
    expect(out.status).toBe('ACTIVE');
    expect(prisma.contentProgrammeEvent.create.mock.calls[0][0].data.kind).toBe('RESUMED');
  });

  it('resume activates a campaign still in DRAFT rather than resuming it', async () => {
    const { svc, socialCampaigns } = harness({
      programme: programmeRow({ status: 'PAUSED' }),
      campaign: campaignRow({ status: 'DRAFT' }),
    });
    await svc.resume(WS, 'prog-1');
    expect(socialCampaigns.activate).toHaveBeenCalledWith(WS, CAMPAIGN_ID);
    expect(socialCampaigns.resume).not.toHaveBeenCalled();
  });

  it('resume refuses ACTIVE and KILLED programmes', async () => {
    const a = harness();
    await expect(a.svc.resume(WS, 'prog-1')).rejects.toThrow(BadRequestException);
    const k = harness({ programme: programmeRow({ status: 'KILLED' }) });
    await expect(k.svc.resume(WS, 'prog-1')).rejects.toThrow(BadRequestException);
  });

  it('kill: KILLED + killSwitch, campaign paused, open slots SKIPPED, event written', async () => {
    const { svc, prisma, socialCampaigns } = harness({ campaign: campaignRow({ status: 'ACTIVE' }) });
    const out = await svc.kill(WS, 'prog-1');
    expect(prisma.contentProgramme.update.mock.calls[0][0].data).toEqual({ status: 'KILLED', killSwitch: true });
    expect(socialCampaigns.pause).toHaveBeenCalledWith(WS, CAMPAIGN_ID);
    expect(prisma.contentSlot.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: WS, programmeId: 'prog-1', status: { in: ['PLANNED', 'IDEATED'] } },
      data: { status: 'SKIPPED', error: 'programme killed' },
    });
    expect(out.status).toBe('KILLED');
    expect(prisma.contentProgrammeEvent.create.mock.calls[0][0].data.kind).toBe('KILLED');
  });

  it('kill is idempotent — a KILLED programme is returned, nothing written twice', async () => {
    const { svc, prisma } = harness({ programme: programmeRow({ status: 'KILLED', killSwitch: true }) });
    const out = await svc.kill(WS, 'prog-1');
    expect(out.status).toBe('KILLED');
    expect(prisma.contentProgramme.update).not.toHaveBeenCalled();
  });
});

describe('ContentProgrammeService.logEvent / events', () => {
  it('writes an event with the workspace, programme, kind, message and data', async () => {
    const { svc, prisma } = harness();
    await svc.logEvent(WS, 'prog-1', 'REWEIGHT', 'weights moved', { a: 1 });
    expect(prisma.contentProgrammeEvent.create).toHaveBeenCalledWith({
      data: { workspaceId: WS, programmeId: 'prog-1', kind: 'REWEIGHT', message: 'weights moved', data: { a: 1 } },
    });
  });

  it('never throws from a log write — the log must not fail the thing it describes', async () => {
    const { svc, prisma } = harness();
    prisma.contentProgrammeEvent.create.mockRejectedValueOnce(new Error('db'));
    await expect(svc.logEvent(WS, 'prog-1', 'X', 'y')).resolves.toBeUndefined();
  });

  it('reads the newest events first, bounded, inside the workspace', async () => {
    const { svc, prisma } = harness();
    await svc.events(WS, 'prog-1');
    expect(prisma.contentProgrammeEvent.findMany).toHaveBeenCalledWith({
      where: { workspaceId: WS, programmeId: 'prog-1' },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    await svc.events(WS, 'prog-1', 5);
    expect(prisma.contentProgrammeEvent.findMany.mock.calls[1][0].take).toBe(5);
  });
});
