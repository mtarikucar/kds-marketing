import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  BOUNDS,
  ContentProgrammeService,
  PER_WEEK_MAX,
  PROGRAMME_GOALS,
  WEEKLY_CREDIT_CAP_MAX,
  cadenceForIstanbul,
  spreadDaysOfWeek,
} from './content-programme.service';
import { CONTENT_SLOT_PLAN_KIND, CONTENT_SLOT_PRODUCE_KIND, slotPlanDedup, slotProduceDedup } from './programme-planner.service';

const WS = 'ws-1';
const CAMPAIGN_ID = 'camp-1';
const NOW = new Date('2026-09-14T06:00:00Z');
const HOUR = 60 * 60 * 1000;

/** The cadence `create` writes for the default 5/week at 18:00 Istanbul: 15:00 UTC, same weekdays. */
const DEFAULT_CADENCE = {
  daysOfWeek: [1, 2, 3, 4, 5],
  timeOfDay: '15:00',
  timezone: 'Europe/Istanbul',
  localTimeOfDay: '18:00',
  localDaysOfWeek: [1, 2, 3, 4, 5],
};

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
    cadence: { ...DEFAULT_CADENCE },
    dailyPublishCap: 1,
    programmeId: null,
    ...over,
  };
}

function slotRow(over: Record<string, unknown> = {}) {
  return {
    id: 'slot-1',
    workspaceId: WS,
    programmeId: 'prog-1',
    scheduledFor: new Date(NOW.getTime() + 3 * 24 * HOUR),
    status: 'PLANNED',
    conceptId: null,
    campaignItemId: null,
    ...over,
  };
}

function harness(
  over: {
    accounts?: unknown[];
    programme?: unknown;
    /** What the one-live-programme guard finds. */
    live?: unknown;
    campaign?: unknown;
    persona?: unknown;
    slots?: unknown[];
  } = {},
) {
  const prisma: any = {
    socialAccount: {
      findMany: jest.fn().mockResolvedValue(
        over.accounts ?? [
          { id: 'acc-1', workspaceId: WS, network: 'INSTAGRAM', enabled: true },
          { id: 'acc-2', workspaceId: WS, network: 'TIKTOK', enabled: true },
        ],
      ),
    },
    videoPersona: {
      findFirst: jest.fn().mockResolvedValue(
        over.persona === undefined ? { id: 'persona-1', name: 'Deniz', status: 'ACTIVE' } : over.persona,
      ),
    },
    socialCampaign: {
      findFirst: jest.fn().mockResolvedValue(over.campaign === undefined ? campaignRow() : over.campaign),
      update: jest.fn().mockImplementation(async ({ where, data }: any) => campaignRow({ ...where, ...data })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    contentProgramme: {
      create: jest.fn().mockImplementation(async ({ data }: any) => programmeRow(data)),
      // The same door answers two questions: "the row by id" (getOrThrow) and
      // "is a live programme in the way" (create's guard, which asks by status).
      findFirst: jest.fn().mockImplementation(async ({ where }: any) => {
        if (where?.status?.in) return over.live ?? null;
        return over.programme === undefined ? programmeRow() : over.programme;
      }),
      update: jest.fn().mockImplementation(async ({ where, data }: any) => programmeRow({ ...where, ...data })),
    },
    contentSlot: {
      findMany: jest.fn().mockResolvedValue(over.slots ?? []),
      updateMany: jest.fn().mockImplementation(async ({ where }: any) => ({ count: where?.id?.in?.length ?? 0 })),
    },
    contentConcept: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
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
    rejectItem: jest.fn().mockResolvedValue({ id: 'item-1', status: 'SKIPPED' }),
  };
  const contentTypes = {
    ensureDefaults: jest.fn().mockImplementation(async () => {
      calls.push('types.ensureDefaults');
      return [];
    }),
  };
  const scheduledJobs = { schedule: jest.fn().mockResolvedValue('job-1'), cancel: jest.fn().mockResolvedValue(true) };
  const svc = new ContentProgrammeService(prisma, socialCampaigns as any, contentTypes as any, scheduledJobs as any);
  return { svc, prisma, socialCampaigns, contentTypes, scheduledJobs, calls };
}

const input = (over: Record<string, unknown> = {}) => ({
  name: 'Sonbahar',
  brief: 'Figurunica 3D baskı figürleri',
  accountIds: ['acc-1', 'acc-2'],
  createdById: 'u-1',
  ...over,
});

const eventOf = (prisma: any, kind: string) =>
  prisma.contentProgrammeEvent.create.mock.calls.map((c: any) => c[0].data).find((d: any) => d.kind === kind);

describe('spreadDaysOfWeek', () => {
  it('spreads a weekly count evenly over the week, seven being every day', () => {
    expect(spreadDaysOfWeek(5)).toEqual([1, 2, 3, 4, 5]);
    expect(spreadDaysOfWeek(7)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(spreadDaysOfWeek(3)).toEqual([1, 3, 5]);
    expect(spreadDaysOfWeek(1)).toHaveLength(1);
    expect(spreadDaysOfWeek(2)).toEqual([2, 5]);
  });
});

/**
 * `nextCadenceSlot` reads `daysOfWeek`/`timeOfDay` as UTC. The owner types
 * Turkey time, so what reaches the campaign has to be shifted by the fixed
 * +03:00 — including the day, for the small hours.
 */
describe('cadenceForIstanbul', () => {
  it('18:00 Istanbul is 15:00 UTC on the same weekdays, and remembers what was typed', () => {
    expect(cadenceForIstanbul([1, 3, 5], '18:00')).toEqual({
      daysOfWeek: [1, 3, 5],
      timeOfDay: '15:00',
      timezone: 'Europe/Istanbul',
      localTimeOfDay: '18:00',
      localDaysOfWeek: [1, 3, 5],
    });
  });

  it('a time before 03:00 falls on the PREVIOUS UTC day: 01:30 Mon/Wed is 22:30 Sun/Tue', () => {
    expect(cadenceForIstanbul([1, 3], '01:30')).toMatchObject({ daysOfWeek: [0, 2], timeOfDay: '22:30', localDaysOfWeek: [1, 3], localTimeOfDay: '01:30' });
    // Sunday wraps to Saturday.
    expect(cadenceForIstanbul([0], '00:15')).toMatchObject({ daysOfWeek: [6], timeOfDay: '21:15' });
  });

  it('03:00 is exactly midnight UTC of the same day', () => {
    expect(cadenceForIstanbul([2], '03:00')).toMatchObject({ daysOfWeek: [2], timeOfDay: '00:00' });
  });

  it('sorts and de-duplicates the weekdays', () => {
    expect(cadenceForIstanbul([5, 1, 5], '10:00')).toMatchObject({ daysOfWeek: [1, 5], localDaysOfWeek: [1, 5], timeOfDay: '07:00' });
  });
});

describe('BOUNDS', () => {
  it('caps perWeek at one a day and the weekly credit cap at 20000, for every door', () => {
    expect(PER_WEEK_MAX).toBe(7);
    expect(WEEKLY_CREDIT_CAP_MAX).toBe(20000);
    expect(BOUNDS.perWeek).toEqual([1, 7]);
    expect(BOUNDS.weeklyCreditCap).toEqual([50, 20000]);
  });
});

describe('ContentProgrammeService.create', () => {
  it('creates the FULL_AUTO video campaign on the UTC cadence, links it, activates it as the programme, seeds the types and writes the programme', async () => {
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
        cadence: DEFAULT_CADENCE,
        targetAccountIds: ['acc-1', 'acc-2'],
        mediaKinds: ['VIDEO'],
        dailyPublishCap: 1,
        createdById: 'u-1',
      }),
    );
    // Activated AS the programme: the campaign's own door refuses a lane.
    expect(socialCampaigns.activate).toHaveBeenCalledWith(WS, CAMPAIGN_ID, { byProgramme: true });
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
    expect(eventOf(prisma, 'CREATED')).toMatchObject({ workspaceId: WS, message: expect.stringContaining('5/week per account') });
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

  it('honours an explicit Turkey-time cadence, converted to UTC, with the daily cap always one', async () => {
    const { svc, socialCampaigns } = harness();
    await svc.create(WS, input({ perWeek: 2, daysOfWeek: [1, 4], timeOfDay: '09:30' }));
    expect(socialCampaigns.create.mock.calls[0][1]).toMatchObject({
      cadence: { daysOfWeek: [1, 4], timeOfDay: '06:30', timezone: 'Europe/Istanbul', localTimeOfDay: '09:30', localDaysOfWeek: [1, 4] },
      dailyPublishCap: 1,
    });
  });

  it('an early-morning Turkey time lands on the previous UTC weekday', async () => {
    const { svc, socialCampaigns } = harness();
    await svc.create(WS, input({ perWeek: 1, daysOfWeek: [1], timeOfDay: '01:30' }));
    expect(socialCampaigns.create.mock.calls[0][1].cadence).toMatchObject({ daysOfWeek: [0], timeOfDay: '22:30', localDaysOfWeek: [1], localTimeOfDay: '01:30' });
  });

  it('takes perWeek from the weekday list when only the list is given', async () => {
    const { svc, prisma } = harness();
    await svc.create(WS, input({ daysOfWeek: [2, 4, 6] }));
    expect(prisma.contentProgramme.create.mock.calls[0][0].data.perWeek).toBe(3);
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
    ['perWeek 8 — the cadence carries one post per weekday', { perWeek: 8 }],
    ['weeklyCreditCap 49', { weeklyCreditCap: 49 }],
    ['weeklyCreditCap above 20000', { weeklyCreditCap: 20001 }],
    ['unknown goal', { goal: 'VIRALITY' }],
    ['bad day', { daysOfWeek: [7] }],
    ['bad time', { timeOfDay: '25:00' }],
    ['a weekday list that disagrees with perWeek', { perWeek: 3, daysOfWeek: [1, 4] }],
    ['empty name', { name: '  ' }],
    ['empty brief', { brief: '' }],
  ])('refuses %s', async (_label, over) => {
    const { svc, socialCampaigns } = harness();
    await expect(svc.create(WS, input(over))).rejects.toThrow(BadRequestException);
    expect(socialCampaigns.create).not.toHaveBeenCalled();
  });

  it('proves the persona is this workspace\'s and ACTIVE at the door, not 36 hours later in a slot', async () => {
    const ok = harness();
    await ok.svc.create(WS, input({ personaId: 'persona-1' }));
    expect(ok.prisma.videoPersona.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'persona-1', workspaceId: WS } }),
    );
    expect(ok.prisma.contentProgramme.create.mock.calls[0][0].data.personaId).toBe('persona-1');

    const foreign = harness({ persona: null });
    await expect(foreign.svc.create(WS, input({ personaId: 'persona-theirs' }))).rejects.toThrow(/does not exist in this workspace/);
    expect(foreign.socialCampaigns.create).not.toHaveBeenCalled();

    const archived = harness({ persona: { id: 'persona-1', name: 'Deniz', status: 'ARCHIVED' } });
    await expect(archived.svc.create(WS, input({ personaId: 'persona-1' }))).rejects.toThrow(/ARCHIVED/);
    expect(archived.socialCampaigns.create).not.toHaveBeenCalled();
  });

  it('refuses while the workspace already runs a programme (ACTIVE or PAUSED), naming it; a KILLED one does not block', async () => {
    for (const status of ['ACTIVE', 'PAUSED']) {
      const { svc, prisma, socialCampaigns } = harness({ live: programmeRow({ status, name: 'Yaz' }) });
      await expect(svc.create(WS, input())).rejects.toThrow('This workspace already runs programme "Yaz"; pause or kill it first.');
      expect(prisma.contentProgramme.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { workspaceId: WS, status: { in: ['ACTIVE', 'PAUSED'] } } }),
      );
      expect(socialCampaigns.create).not.toHaveBeenCalled();
    }
    const { svc, socialCampaigns } = harness({ live: null });
    await svc.create(WS, input());
    expect(socialCampaigns.create).toHaveBeenCalled();
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
    // So was the persona.
    expect(prisma.videoPersona.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'persona-1', workspaceId: WS } }));
  });

  it('refuses a persona that is not this workspace\'s, writing nothing; null clears without a lookup', async () => {
    const foreign = harness({ persona: null });
    await expect(foreign.svc.update(WS, 'prog-1', { personaId: 'persona-theirs' })).rejects.toThrow(BadRequestException);
    expect(foreign.prisma.contentProgramme.update).not.toHaveBeenCalled();

    const clear = harness({ persona: null });
    await clear.svc.update(WS, 'prog-1', { personaId: null });
    expect(clear.prisma.videoPersona.findFirst).not.toHaveBeenCalled();
    expect(clear.prisma.contentProgramme.update.mock.calls[0][0].data).toEqual({ personaId: null });
  });

  it('perWeek moves the campaign cadence: a spread of the new count when the old weekdays cannot carry it', async () => {
    const { svc, prisma } = harness();
    await svc.update(WS, 'prog-1', { perWeek: 3 });
    expect(prisma.contentProgramme.update.mock.calls[0][0].data).toEqual({ perWeek: 3 });
    expect(prisma.socialCampaign.updateMany).toHaveBeenCalledWith({
      where: { id: CAMPAIGN_ID, workspaceId: WS },
      data: {
        cadence: { daysOfWeek: [1, 3, 5], timeOfDay: '15:00', timezone: 'Europe/Istanbul', localTimeOfDay: '18:00', localDaysOfWeek: [1, 3, 5] },
        dailyPublishCap: 1,
      },
    });
    expect(eventOf(prisma, 'UPDATED').message).toMatch(/3\/week per account/);
  });

  it('perWeek keeps the owner\'s own weekdays when they already number the new count', async () => {
    // Tue/Thu at 09:30 was chosen by hand; perWeek 2 is a no-op on the days and
    // must not become the spread's Wed/Fri.
    const { svc, prisma } = harness({
      programme: programmeRow({ perWeek: 3 }),
      campaign: campaignRow({ cadence: cadenceForIstanbul([2, 4], '09:30') }),
    });
    await svc.update(WS, 'prog-1', { perWeek: 2 });
    expect(prisma.socialCampaign.updateMany.mock.calls[0][0].data.cadence).toEqual(cadenceForIstanbul([2, 4], '09:30'));
  });

  it('accepts daysOfWeek, alone or with perWeek, converted to UTC and logged', async () => {
    const alone = harness();
    await alone.svc.update(WS, 'prog-1', { daysOfWeek: [0, 1, 2, 3, 4] });
    // Not a programme column: the row is untouched, the campaign moves.
    expect(alone.prisma.contentProgramme.update).not.toHaveBeenCalled();
    expect(alone.prisma.socialCampaign.updateMany.mock.calls[0][0].data.cadence).toEqual(cadenceForIstanbul([0, 1, 2, 3, 4], '18:00'));
    expect(eventOf(alone.prisma, 'UPDATED')).toMatchObject({ message: expect.stringContaining('daysOfWeek'), data: { daysOfWeek: [0, 1, 2, 3, 4] } });

    const both = harness();
    await both.svc.update(WS, 'prog-1', { perWeek: 2, daysOfWeek: [6, 0] });
    expect(both.prisma.contentProgramme.update.mock.calls[0][0].data).toEqual({ perWeek: 2 });
    expect(both.prisma.socialCampaign.updateMany.mock.calls[0][0].data.cadence).toMatchObject({ localDaysOfWeek: [0, 6], daysOfWeek: [0, 6] });
  });

  it('repairs a cadence written before the Istanbul conversion: its typed time is re-read as Turkey time', async () => {
    const { svc, prisma } = harness({
      campaign: campaignRow({ cadence: { daysOfWeek: [1, 2, 3, 4, 5], timeOfDay: '22:00', timezone: 'Europe/Istanbul' } }),
    });
    await svc.update(WS, 'prog-1', { perWeek: 5, daysOfWeek: [1, 2, 3, 4, 5] });
    expect(prisma.socialCampaign.updateMany.mock.calls[0][0].data.cadence).toEqual(cadenceForIstanbul([1, 2, 3, 4, 5], '22:00'));
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
    ['perWeek 8', { perWeek: 8 }],
    ['weeklyCreditCap 10', { weeklyCreditCap: 10 }],
    ['weeklyCreditCap 20001', { weeklyCreditCap: 20001 }],
    ['daysOfWeek that disagree with the stored perWeek', { daysOfWeek: [1, 2] }],
    ['daysOfWeek that disagree with the new perWeek', { perWeek: 2, daysOfWeek: [1, 2, 3] }],
    ['an empty daysOfWeek', { daysOfWeek: [] }],
    ['unknown goal', { goal: 'FAME' }],
    ['empty name', { name: '' }],
  ])('refuses %s', async (_label, patch) => {
    const { svc, prisma } = harness();
    await expect(svc.update(WS, 'prog-1', patch as any)).rejects.toThrow(BadRequestException);
    expect(prisma.contentProgramme.update).not.toHaveBeenCalled();
    expect(prisma.socialCampaign.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a KILLED programme', async () => {
    const { svc, prisma } = harness({ programme: programmeRow({ status: 'KILLED' }) });
    await expect(svc.update(WS, 'prog-1', { name: 'x' })).rejects.toThrow(BadRequestException);
    expect(prisma.contentProgramme.update).not.toHaveBeenCalled();
  });

  /**
   * The cap is checked against the week the JOB runs in, and a slot's jobs are
   * clamped to "now" when its lead reaches back past it — so a lead long enough
   * to pull every slot of the look-ahead into tonight has each of them checked
   * against this week's sum and booked into weeks no check reads. The leads
   * are therefore bounded above, in BOUNDS, like every other setting.
   */
  it('holds the two lead times to BOUNDS above as well as below, and BOUNDS carries them', async () => {
    expect(BOUNDS.planLeadHours).toEqual([6, 96]);
    expect(BOUNDS.produceLeadHours).toEqual([2, 48]);
    expect(BOUNDS.lookaheadDays).toEqual([7, 28]);
    expect(BOUNDS.editWindowHours).toEqual([1, 24]);
    for (const patch of [
      { planLeadHours: 97 },
      { planLeadHours: 800, produceLeadHours: 799 },
      { produceLeadHours: 49, planLeadHours: 96 },
      { planLeadHours: 5, produceLeadHours: 2 },
      { produceLeadHours: 1 },
      { lookaheadDays: 29 },
    ]) {
      const { svc, prisma } = harness();
      await expect(svc.update(WS, 'prog-1', patch)).rejects.toThrow(BadRequestException);
      expect(prisma.contentProgramme.update).not.toHaveBeenCalled();
    }
    const { svc, prisma } = harness();
    await svc.update(WS, 'prog-1', { planLeadHours: 96, produceLeadHours: 48 });
    expect(prisma.contentProgramme.update.mock.calls[0][0].data).toEqual({ planLeadHours: 96, produceLeadHours: 48 });
  });
});

describe('ContentProgrammeService.pause', () => {
  it('pause: PAUSED, campaign paused, event written — and NOTHING rejected or cancelled', async () => {
    const { svc, prisma, socialCampaigns, scheduledJobs } = harness({
      campaign: campaignRow({ status: 'ACTIVE' }),
      slots: [slotRow({ status: 'READY', campaignItemId: 'item-1' })],
    });
    const out = await svc.pause(WS, 'prog-1');
    expect(prisma.contentProgramme.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'prog-1' }, data: { status: 'PAUSED' } }),
    );
    expect(socialCampaigns.pause).toHaveBeenCalledWith(WS, CAMPAIGN_ID);
    expect(out.status).toBe('PAUSED');
    expect(prisma.contentProgrammeEvent.create.mock.calls[0][0].data.kind).toBe('PAUSED');
    // A READY slot's armed item waits behind the paused gate; it is not thrown away.
    expect(socialCampaigns.rejectItem).not.toHaveBeenCalled();
    expect(scheduledJobs.cancel).not.toHaveBeenCalled();
    expect(prisma.contentSlot.updateMany).not.toHaveBeenCalled();
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
});

describe('ContentProgrammeService.resume', () => {
  const paused = () => programmeRow({ status: 'PAUSED' });

  it('resume: ACTIVE, campaign resumed AS the programme, event written', async () => {
    const { svc, prisma, socialCampaigns } = harness({ programme: paused(), campaign: campaignRow({ status: 'PAUSED' }) });
    const out = await svc.resume(WS, 'prog-1', NOW);
    expect(prisma.contentProgramme.update.mock.calls[0][0].data).toEqual({ status: 'ACTIVE' });
    expect(socialCampaigns.resume).toHaveBeenCalledWith(WS, CAMPAIGN_ID, { byProgramme: true });
    expect(out.status).toBe('ACTIVE');
    expect(eventOf(prisma, 'RESUMED')).toMatchObject({ data: { rearmedSlots: 0, missedSlots: 0 } });
  });

  it('resume activates a campaign still in DRAFT rather than resuming it', async () => {
    const { svc, socialCampaigns } = harness({ programme: paused(), campaign: campaignRow({ status: 'DRAFT' }) });
    await svc.resume(WS, 'prog-1', NOW);
    expect(socialCampaigns.activate).toHaveBeenCalledWith(WS, CAMPAIGN_ID, { byProgramme: true });
    expect(socialCampaigns.resume).not.toHaveBeenCalled();
  });

  it('re-arms the plan and produce jobs of every PLANNED/IDEATED slot still ahead — a job consumed during the pause would otherwise never fire again', async () => {
    const wed = slotRow({ id: 'slot-wed', status: 'PLANNED', scheduledFor: new Date(NOW.getTime() + 60 * HOUR) });
    const thu = slotRow({ id: 'slot-thu', status: 'IDEATED', conceptId: 'c-thu', scheduledFor: new Date(NOW.getTime() + 84 * HOUR) });
    const { svc, prisma, scheduledJobs } = harness({ programme: paused(), campaign: campaignRow({ status: 'PAUSED' }), slots: [wed, thu] });

    await svc.resume(WS, 'prog-1', NOW);

    expect(prisma.contentSlot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: WS, programmeId: 'prog-1', status: { in: ['PLANNED', 'IDEATED'] } } }),
    );
    const jobs = scheduledJobs.schedule.mock.calls.map((c: any[]) => c[0]);
    expect(jobs).toHaveLength(4);
    // Same kinds, same dedup keys, same lead times as the planner's fill —
    // the helper is the planner's own, so a re-arm collapses onto any job
    // that survived rather than adding a second.
    expect(jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: CONTENT_SLOT_PLAN_KIND, dedupKey: slotPlanDedup('slot-wed'), runAt: new Date(wed.scheduledFor.getTime() - 36 * HOUR), payload: { workspaceId: WS, slotId: 'slot-wed', programmeId: 'prog-1' } }),
        expect.objectContaining({ kind: CONTENT_SLOT_PRODUCE_KIND, dedupKey: slotProduceDedup('slot-wed'), runAt: new Date(wed.scheduledFor.getTime() - 12 * HOUR) }),
        expect.objectContaining({ kind: CONTENT_SLOT_PLAN_KIND, dedupKey: slotPlanDedup('slot-thu') }),
        expect.objectContaining({ kind: CONTENT_SLOT_PRODUCE_KIND, dedupKey: slotProduceDedup('slot-thu') }),
      ]),
    );
    // A slot already inside its lead window is planned NOW, not never.
    expect(jobs.every((j: any) => (j.runAt as Date).getTime() >= NOW.getTime())).toBe(true);
    expect(prisma.contentSlot.updateMany).not.toHaveBeenCalled();
    expect(prisma.contentConcept.updateMany).not.toHaveBeenCalled();
    expect(eventOf(prisma, 'RESUMED')).toMatchObject({ message: expect.stringContaining('2 slot(s) re-armed'), data: { rearmedSlots: 2, missedSlots: 0 } });
  });

  it('a slot whose publish time passed while paused is SKIPPED "missed while paused", its proposed concept discarded, and not re-armed', async () => {
    const gone = slotRow({ id: 'slot-gone', status: 'IDEATED', conceptId: 'c-gone', scheduledFor: new Date(NOW.getTime() - 2 * HOUR) });
    const ahead = slotRow({ id: 'slot-ahead', status: 'PLANNED', scheduledFor: new Date(NOW.getTime() + 48 * HOUR) });
    const { svc, prisma, scheduledJobs } = harness({ programme: paused(), campaign: campaignRow({ status: 'PAUSED' }), slots: [gone, ahead] });

    await svc.resume(WS, 'prog-1', NOW);

    expect(prisma.contentConcept.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['c-gone'] }, workspaceId: WS, status: 'PROPOSED' },
      data: { status: 'DISCARDED', reviewedAt: NOW, reviewedById: 'programme:prog-1', reviewNote: 'programme: slot skipped' },
    });
    expect(prisma.contentSlot.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['slot-gone'] }, workspaceId: WS, status: { in: ['PLANNED', 'IDEATED'] } },
      data: { status: 'SKIPPED', error: 'missed while paused' },
    });
    const armed = scheduledJobs.schedule.mock.calls.map((c: any[]) => c[0].dedupKey);
    expect(armed).toEqual([slotPlanDedup('slot-ahead'), slotProduceDedup('slot-ahead')]);
    expect(eventOf(prisma, 'RESUMED')).toMatchObject({
      message: expect.stringContaining('1 missed while paused'),
      data: { rearmedSlots: 1, missedSlots: 1, missedSlotIds: ['slot-gone'] },
    });
  });

  it('resume refuses a KILLED programme, and an ACTIVE one whose lane already runs', async () => {
    const a = harness({ campaign: campaignRow({ status: 'ACTIVE' }) });
    await expect(a.svc.resume(WS, 'prog-1')).rejects.toThrow(BadRequestException);
    expect(a.socialCampaigns.resume).not.toHaveBeenCalled();
    const k = harness({ programme: programmeRow({ status: 'KILLED' }), campaign: campaignRow({ status: 'PAUSED' }) });
    await expect(k.svc.resume(WS, 'prog-1')).rejects.toThrow(BadRequestException);
    expect(k.socialCampaigns.resume).not.toHaveBeenCalled();
  });

  /**
   * `pause` is the one campaign door the lane keeps, so the programme can be
   * ACTIVE with its campaign PAUSED by hand. The campaign's own resume door
   * refuses a lane and points here; this door has to open, or the only way
   * out is an undocumented pause-then-resume of the programme while every
   * produce job holds and skips its slot as missed.
   */
  it('an ACTIVE programme whose lane was paused by hand has the lane re-run AS the programme, logs LANE_RESUMED, and touches no slot', async () => {
    const { svc, prisma, socialCampaigns, scheduledJobs } = harness({ campaign: campaignRow({ status: 'PAUSED' }), slots: [slotRow({ status: 'PLANNED' })] });
    const out = await svc.resume(WS, 'prog-1', NOW);
    expect(socialCampaigns.resume).toHaveBeenCalledWith(WS, CAMPAIGN_ID, { byProgramme: true });
    expect(prisma.socialCampaign.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: CAMPAIGN_ID, workspaceId: WS } }));
    // The programme itself did not move, and no slot was consumed while it kept planning: nothing to re-arm or skip.
    expect(prisma.contentProgramme.update).not.toHaveBeenCalled();
    expect(prisma.contentSlot.findMany).not.toHaveBeenCalled();
    expect(prisma.contentSlot.updateMany).not.toHaveBeenCalled();
    expect(scheduledJobs.schedule).not.toHaveBeenCalled();
    expect(out.status).toBe('ACTIVE');
    expect(eventOf(prisma, 'LANE_RESUMED')).toMatchObject({ data: { socialCampaignId: CAMPAIGN_ID } });
    expect(eventOf(prisma, 'RESUMED')).toBeUndefined();
  });
});

describe('ContentProgrammeService.kill', () => {
  it('kill: KILLED + killSwitch, campaign paused, every open slot swept with its jobs cancelled, event written', async () => {
    const planned = slotRow({ id: 'slot-p', status: 'PLANNED' });
    const ideated = slotRow({ id: 'slot-i', status: 'IDEATED', conceptId: 'c-i' });
    const ready = slotRow({ id: 'slot-r', status: 'READY', conceptId: 'c-r', campaignItemId: 'item-r' });
    const { svc, prisma, socialCampaigns, scheduledJobs } = harness({ campaign: campaignRow({ status: 'ACTIVE' }), slots: [planned, ideated, ready] });

    const out = await svc.kill(WS, 'prog-1');

    expect(prisma.contentProgramme.update.mock.calls[0][0].data).toEqual({ status: 'KILLED', killSwitch: true });
    expect(socialCampaigns.pause).toHaveBeenCalledWith(WS, CAMPAIGN_ID);
    // PRODUCING is in the sweep too: its item may already be armed (see below).
    expect(prisma.contentSlot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: WS, programmeId: 'prog-1', status: { in: ['PLANNED', 'IDEATED', 'PRODUCING', 'READY'] } } }),
    );
    // The READY slot's armed item is rejected, so the publish gate drops it.
    expect(socialCampaigns.rejectItem).toHaveBeenCalledTimes(1);
    expect(socialCampaigns.rejectItem).toHaveBeenCalledWith(WS, 'item-r');
    // The IDEATED slot's proposed concept (and the READY one's) is discarded:
    // nothing stays approvable in the hub, no storyboard job keeps drawing.
    const discards = prisma.contentConcept.updateMany.mock.calls.map((c: any) => c[0]);
    expect(discards).toEqual([
      expect.objectContaining({ where: { id: { in: ['c-i'] }, workspaceId: WS, status: 'PROPOSED' }, data: expect.objectContaining({ status: 'DISCARDED', reviewedById: 'programme:prog-1', reviewNote: 'programme killed' }) }),
      expect.objectContaining({ where: { id: { in: ['c-r'] }, workspaceId: WS, status: 'PROPOSED' } }),
    ]);
    // Both jobs of every open slot are cancelled: a late job must not find work.
    const cancelled = scheduledJobs.cancel.mock.calls.map((c: any[]) => c[1]);
    expect(cancelled).toEqual(
      expect.arrayContaining(['slot-p', 'slot-i', 'slot-r'].flatMap((id) => [slotPlanDedup(id), slotProduceDedup(id)])),
    );
    expect(cancelled).toHaveLength(6);
    expect(prisma.contentSlot.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['slot-p', 'slot-i', 'slot-r'] }, workspaceId: WS, programmeId: 'prog-1', status: { in: ['PLANNED', 'IDEATED', 'PRODUCING', 'READY'] } },
      data: { status: 'SKIPPED', error: 'programme killed' },
    });
    expect(out.status).toBe('KILLED');
    expect(eventOf(prisma, 'KILLED')).toMatchObject({ data: { skippedSlots: 3, rejectedItems: 1, leftSlots: 0, leftSlotIds: [] } });
  });

  /**
   * The produce job arms the item SCHEDULED within minutes of the clips, but
   * the slot stays PRODUCING until the 6-hourly reconcile. A kill in that
   * window used to sweep nothing for the slot — its job was DONE, so the kill
   * flag was never read again — and the armed item looped hourly against the
   * paused lane with no door left to drop it.
   */
  it('a PRODUCING slot whose item is already armed has the item rejected and the slot swept; one still generating, or with no item yet, is left and counted', async () => {
    const armed = slotRow({ id: 'slot-armed', status: 'PRODUCING', conceptId: 'c-armed', campaignItemId: 'item-armed' });
    const generating = slotRow({ id: 'slot-gen', status: 'PRODUCING', conceptId: 'c-gen', campaignItemId: 'item-gen' });
    const noItem = slotRow({ id: 'slot-none', status: 'PRODUCING', conceptId: 'c-none', campaignItemId: null });
    const { svc, prisma, socialCampaigns, scheduledJobs } = harness({ campaign: campaignRow({ status: 'ACTIVE' }), slots: [armed, generating, noItem] });
    socialCampaigns.rejectItem.mockImplementation(async (_ws: string, itemId: string) => {
      if (itemId === 'item-gen') throw new BadRequestException('Cannot reject an item in status GENERATING');
      return { id: itemId, status: 'SKIPPED' };
    });

    await svc.kill(WS, 'prog-1');

    expect(socialCampaigns.rejectItem.mock.calls.map((c: any[]) => c[1])).toEqual(['item-armed', 'item-gen']);
    expect(prisma.contentSlot.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { in: ['slot-armed'] } }), data: { status: 'SKIPPED', error: 'programme killed' } }),
    );
    const cancelled = scheduledJobs.cancel.mock.calls.map((c: any[]) => c[1]);
    expect(cancelled).toEqual([slotPlanDedup('slot-armed'), slotProduceDedup('slot-armed')]);
    // The left slots keep their status: the produce job fails the generating
    // item on its next clip, and the reconcile/settle sweeps (which walk
    // KILLED programmes) follow each item to FAILED or PUBLISHED.
    expect(eventOf(prisma, 'KILLED')).toMatchObject({
      message: expect.stringContaining('2 slot(s) left to settle'),
      data: { skippedSlots: 1, rejectedItems: 1, leftSlots: 2, leftSlotIds: ['slot-gen', 'slot-none'] },
    });
  });

  it('a READY slot whose item can no longer be rejected (published under our feet) is left as it is', async () => {
    const ready = slotRow({ id: 'slot-r', status: 'READY', conceptId: 'c-r', campaignItemId: 'item-r' });
    const planned = slotRow({ id: 'slot-p', status: 'PLANNED' });
    const { svc, prisma, socialCampaigns, scheduledJobs } = harness({ campaign: campaignRow({ status: 'ACTIVE' }), slots: [ready, planned] });
    socialCampaigns.rejectItem.mockRejectedValueOnce(new BadRequestException('Cannot reject an item in status PUBLISHED'));

    await svc.kill(WS, 'prog-1');

    expect(prisma.contentSlot.updateMany.mock.calls[0][0].where.id).toEqual({ in: ['slot-p'] });
    expect(scheduledJobs.cancel.mock.calls.map((c: any[]) => c[1])).not.toContain(slotPlanDedup('slot-r'));
    expect(prisma.contentConcept.updateMany).not.toHaveBeenCalled();
    expect(eventOf(prisma, 'KILLED')).toMatchObject({ data: { skippedSlots: 1, rejectedItems: 0, leftSlots: 1, leftSlotIds: ['slot-r'] } });
  });

  it('kill with no open slots writes no sweep and still records the kill', async () => {
    const { svc, prisma } = harness({ campaign: campaignRow({ status: 'ACTIVE' }), slots: [] });
    await svc.kill(WS, 'prog-1');
    expect(prisma.contentSlot.updateMany).not.toHaveBeenCalled();
    expect(eventOf(prisma, 'KILLED')).toMatchObject({ data: { skippedSlots: 0 } });
  });

  it('kill is idempotent — a KILLED programme is returned, nothing written twice', async () => {
    const { svc, prisma } = harness({ programme: programmeRow({ status: 'KILLED', killSwitch: true }) });
    const out = await svc.kill(WS, 'prog-1');
    expect(out.status).toBe('KILLED');
    expect(prisma.contentProgramme.update).not.toHaveBeenCalled();
  });
});

describe('ContentProgrammeService.assertLaneRunning', () => {
  it('answers ACTIVE only for an ACTIVE campaign; a hand-paused, draft or missing lane is PAUSED', async () => {
    for (const [campaign, expected] of [
      [campaignRow({ status: 'ACTIVE' }), 'ACTIVE'],
      [campaignRow({ status: 'PAUSED' }), 'PAUSED'],
      [campaignRow({ status: 'DRAFT' }), 'PAUSED'],
      [campaignRow({ status: 'CANCELLED' }), 'PAUSED'],
      [null, 'PAUSED'],
    ] as const) {
      const { svc, prisma } = harness({ campaign });
      await expect(svc.assertLaneRunning(WS, programmeRow())).resolves.toBe(expected);
      expect(prisma.socialCampaign.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: CAMPAIGN_ID, workspaceId: WS } }),
      );
    }
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
