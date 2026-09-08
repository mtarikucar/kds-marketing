import { randomUUID } from 'crypto';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { ContentProgramme, ContentProgrammeEvent, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import type { Cadence } from '../social-campaigns/cadence.util';
import { SocialCampaignsService } from '../social-campaigns/social-campaigns.service';
import { ContentTypesService } from './content-types.service';

/** What "working" means for a programme (design K2). */
export const PROGRAMME_GOALS = ['ENGAGEMENT', 'VIEWS', 'SAVES_SHARES', 'LEADS', 'COMPOSITE'] as const;
export type ProgrammeGoal = (typeof PROGRAMME_GOALS)[number];

/** Programme statuses. KILLED is terminal; `get` never returns one. */
export const PROGRAMME_STATUSES = ['ACTIVE', 'PAUSED', 'KILLED'] as const;

/** Slot statuses the kill switch sweeps: nothing has been spent on them yet. */
const OPEN_SLOT_STATUSES = ['PLANNED', 'IDEATED'];

const PROGRAMME_TIMEZONE = 'Europe/Istanbul';
const DEFAULT_TIME_OF_DAY = '18:00';
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The bounds every setting is held to, stated once and read by both create and update. */
const BOUNDS = {
  perWeek: [1, 14],
  weeklyCreditCap: [50, Number.POSITIVE_INFINITY],
  explorationRate: [0.05, 0.5],
  maturityHours: [24, 168],
  halfLifeDays: [7, 90],
  editWindowHours: [1, 24],
  lookaheadDays: [7, 28],
} as const;

export interface CreateProgrammeInput {
  name: string;
  /** What the programme is about — product, audience, tone. Grounds every idea. */
  brief: string;
  accountIds: string[];
  perWeek?: number;
  goal?: string;
  weeklyCreditCap?: number;
  personaId?: string;
  /** 0 = Sunday … 6 = Saturday. Spread evenly from `perWeek` when absent. */
  daysOfWeek?: number[];
  /** 'HH:MM'. */
  timeOfDay?: string;
  createdById: string;
}

/** The settings an owner may change after creation; everything else is the engine's. */
export interface UpdateProgrammeInput {
  name?: string;
  brief?: string;
  goal?: string;
  perWeek?: number;
  weeklyCreditCap?: number;
  explorationRate?: number;
  maturityHours?: number;
  halfLifeDays?: number;
  editWindowHours?: number;
  lookaheadDays?: number;
  planLeadHours?: number;
  produceLeadHours?: number;
  personaId?: string | null;
}

const UPDATABLE: ReadonlySet<keyof UpdateProgrammeInput> = new Set<keyof UpdateProgrammeInput>([
  'name',
  'brief',
  'goal',
  'perWeek',
  'weeklyCreditCap',
  'explorationRate',
  'maturityHours',
  'halfLifeDays',
  'editWindowHours',
  'lookaheadDays',
  'planLeadHours',
  'produceLeadHours',
  'personaId',
]);

/**
 * Which weekdays carry `perWeek` posts, spread across the week rather than
 * bunched at its start: three a week is Mon/Wed/Fri, not Mon/Tue/Wed. Above
 * seven every day carries at least one and the campaign's daily cap takes the
 * remainder.
 */
export function spreadDaysOfWeek(perWeek: number): number[] {
  const table: Record<number, number[]> = {
    1: [3],
    2: [2, 5],
    3: [1, 3, 5],
    4: [1, 2, 4, 5],
    5: [1, 2, 3, 4, 5],
    6: [1, 2, 3, 4, 5, 6],
  };
  return table[perWeek] ?? [0, 1, 2, 3, 4, 5, 6];
}

/** Posts per day the publishing lane may release: at least one, and enough for `perWeek`. */
function dailyCapFor(perWeek: number): number {
  return Math.max(1, Math.ceil(perWeek / 7));
}

function inRange(name: keyof typeof BOUNDS, value: unknown): asserts value is number {
  const [lo, hi] = BOUNDS[name];
  const isInt = name !== 'explorationRate';
  if (typeof value !== 'number' || !Number.isFinite(value) || (isInt && !Number.isInteger(value)) || value < lo || value > hi) {
    const range = hi === Number.POSITIVE_INFINITY ? `at least ${lo}` : `between ${lo} and ${hi}`;
    throw new BadRequestException(`${name} must be ${isInt ? 'an integer' : 'a number'} ${range} (got ${String(value)})`);
  }
}

function requireGoal(goal: unknown): ProgrammeGoal {
  if (!(PROGRAMME_GOALS as readonly string[]).includes(String(goal))) {
    throw new BadRequestException(`goal must be one of ${PROGRAMME_GOALS.join(', ')} (got ${String(goal)})`);
  }
  return goal as ProgrammeGoal;
}

function requireText(name: string, value: unknown): string {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) throw new BadRequestException(`${name} must not be empty`);
  return s;
}

/**
 * THE PROGRAMME — the owner's "make these types of content, publish, wait,
 * then lean into what worked" loop, as one row plus the FULL_AUTO campaign it
 * publishes through. This service is the lifecycle: create (which arms the
 * campaign), the settings an owner may change, pause/resume, the kill switch,
 * and the "why" log every job writes to. Planning, producing and learning live
 * in their own services and only read what this one wrote.
 *
 * ## One programme per workspace (v1)
 *
 * `get(workspaceId)` returns the newest programme that is not KILLED. Nothing
 * prevents a second row from existing — a killed programme stays for its
 * history, and a new one is created next to it — but the panel and the jobs
 * treat "the programme" as singular, and that is what `get` answers.
 *
 * ## The campaign is the lane, not the planner
 *
 * The programme's campaign is created with `programmeId` stamped on it BEFORE
 * it is activated. `activate` schedules the campaign's own plan tick, and that
 * tick returns immediately for a campaign that carries a `programmeId` — so
 * the order is not cosmetic: linking after activating would let the first
 * tick plan a stock topic into the calendar the programme is about to fill.
 *
 * ## No half-armed campaign
 *
 * Every step after the campaign exists runs under one catch: if the link, the
 * activation, the type seed or the programme row fails, the campaign is
 * paused before the error is rethrown. A campaign left ACTIVE with no
 * programme behind it would sit in the owner's list as a live FULL_AUTO
 * campaign that publishes nothing and explains nothing.
 */
@Injectable()
export class ContentProgrammeService {
  private readonly logger = new Logger(ContentProgrammeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly socialCampaigns: SocialCampaignsService,
    private readonly contentTypes: ContentTypesService,
  ) {}

  async create(workspaceId: string, input: CreateProgrammeInput): Promise<ContentProgramme> {
    // Everything is validated BEFORE the campaign exists: a refusal here costs
    // nothing and leaves nothing behind.
    const name = requireText('name', input.name);
    const brief = requireText('brief', input.brief);
    const perWeek = input.perWeek ?? 5;
    inRange('perWeek', perWeek);
    const weeklyCreditCap = input.weeklyCreditCap ?? 600;
    inRange('weeklyCreditCap', weeklyCreditCap);
    const goal = requireGoal(input.goal ?? 'COMPOSITE');
    const cadence = this.cadenceFor(perWeek, input.daysOfWeek, input.timeOfDay);
    await this.requireAccounts(workspaceId, input.accountIds);

    const campaign = await this.socialCampaigns.create(workspaceId, {
      name,
      goal: 'AWARENESS',
      theme: brief,
      brief: { theme: brief, programme: true },
      automationMode: 'FULL_AUTO',
      planningMode: 'AI_FULL',
      cadence,
      startDate: new Date(),
      targetAccountIds: [...input.accountIds],
      mediaKinds: ['VIDEO'],
      dailyPublishCap: dailyCapFor(perWeek),
      createdById: input.createdById,
    });

    // The programme's id is decided here so the campaign can carry it before
    // the programme row exists — see the class docblock for why the order
    // link -> activate -> row is the only safe one.
    const programmeId = randomUUID();
    try {
      await this.prisma.socialCampaign.update({ where: { id: campaign.id }, data: { programmeId } });
      await this.socialCampaigns.activate(workspaceId, campaign.id);
      await this.contentTypes.ensureDefaults(workspaceId);
      const programme = await this.prisma.contentProgramme.create({
        data: {
          id: programmeId,
          workspaceId,
          name,
          status: 'ACTIVE',
          socialCampaignId: campaign.id,
          goal,
          brief,
          personaId: input.personaId ?? null,
          perWeek,
          weeklyCreditCap,
          createdById: input.createdById,
        },
      });
      await this.logEvent(workspaceId, programme.id, 'CREATED', `Programme "${name}" created: ${perWeek}/week per account, goal ${goal}, cap ${weeklyCreditCap} credits/week.`, {
        socialCampaignId: campaign.id,
        accountIds: input.accountIds,
        cadence,
      });
      return programme;
    } catch (e) {
      await this.disarmCampaign(workspaceId, campaign.id);
      throw e;
    }
  }

  /** The workspace's programme: the newest one that has not been killed. */
  get(workspaceId: string): Promise<ContentProgramme | null> {
    return this.prisma.contentProgramme.findFirst({
      where: { workspaceId, status: { not: 'KILLED' } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getOrThrow(workspaceId: string, id: string): Promise<ContentProgramme> {
    const row = await this.prisma.contentProgramme.findFirst({ where: { id, workspaceId } });
    if (!row) throw new NotFoundException('Programme not found');
    return row;
  }

  /**
   * The owner's settings, and only those. Status, phase, the kill switch and
   * the job timestamps are the engine's to write; a patch naming one of them is
   * refused by name rather than ignored, so a caller learns which door is the
   * right one (`pause`/`resume`/`kill`) instead of watching a field not move.
   */
  async update(workspaceId: string, id: string, patch: UpdateProgrammeInput): Promise<ContentProgramme> {
    const unknown = Object.keys(patch).filter((k) => !UPDATABLE.has(k as keyof UpdateProgrammeInput));
    if (unknown.length) {
      throw new BadRequestException(
        `Cannot update ${unknown.join(', ')}. Editable: ${[...UPDATABLE].join(', ')}; use pause/resume/kill for the status.`,
      );
    }
    const current = await this.getOrThrow(workspaceId, id);
    if (current.status === 'KILLED') {
      throw new BadRequestException('This programme was killed; start a new one instead of editing it.');
    }

    const data: Prisma.ContentProgrammeUpdateInput = {};
    if (patch.name !== undefined) data.name = requireText('name', patch.name);
    if (patch.brief !== undefined) data.brief = requireText('brief', patch.brief);
    if (patch.goal !== undefined) data.goal = requireGoal(patch.goal);
    if (patch.perWeek !== undefined) {
      inRange('perWeek', patch.perWeek);
      data.perWeek = patch.perWeek;
    }
    if (patch.weeklyCreditCap !== undefined) {
      inRange('weeklyCreditCap', patch.weeklyCreditCap);
      data.weeklyCreditCap = patch.weeklyCreditCap;
    }
    for (const key of ['explorationRate', 'maturityHours', 'halfLifeDays', 'editWindowHours', 'lookaheadDays'] as const) {
      const v = patch[key];
      if (v === undefined) continue;
      inRange(key, v);
      data[key] = v;
    }
    // The two lead times are one constraint: the storyboard must be planned
    // before the clips are bought, so produce < plan holds against whichever
    // half the patch does not carry.
    const planLead = patch.planLeadHours ?? current.planLeadHours;
    const produceLead = patch.produceLeadHours ?? current.produceLeadHours;
    if (patch.planLeadHours !== undefined || patch.produceLeadHours !== undefined) {
      for (const [k, v] of [['planLeadHours', planLead], ['produceLeadHours', produceLead]] as const) {
        if (!Number.isInteger(v) || v < 1) throw new BadRequestException(`${k} must be a positive integer (got ${String(v)})`);
      }
      if (produceLead >= planLead) {
        throw new BadRequestException(
          `produceLeadHours (${produceLead}) must be smaller than planLeadHours (${planLead}): the storyboard is planned before the clips are bought.`,
        );
      }
      if (patch.planLeadHours !== undefined) data.planLeadHours = patch.planLeadHours;
      if (patch.produceLeadHours !== undefined) data.produceLeadHours = patch.produceLeadHours;
    }
    if (patch.personaId !== undefined) {
      if (patch.personaId !== null && typeof patch.personaId !== 'string') {
        throw new BadRequestException('personaId must be a string or null');
      }
      data.personaId = patch.personaId;
    }

    if (Object.keys(data).length === 0) return current;

    const updated = await this.prisma.contentProgramme.update({ where: { id }, data });

    // The cadence lives on the campaign; a new weekly count has to reach it or
    // the programme would plan slots the lane refuses to release.
    if (patch.perWeek !== undefined && patch.perWeek !== current.perWeek) {
      await this.syncCampaignCadence(workspaceId, current.socialCampaignId, patch.perWeek);
    }
    await this.logEvent(workspaceId, id, 'UPDATED', `Settings changed: ${Object.keys(data).join(', ')}.`, data as Record<string, unknown>);
    return updated;
  }

  async pause(workspaceId: string, id: string): Promise<ContentProgramme> {
    const current = await this.getOrThrow(workspaceId, id);
    if (current.status !== 'ACTIVE') {
      throw new BadRequestException(`Cannot pause a ${current.status} programme.`);
    }
    const updated = await this.prisma.contentProgramme.update({ where: { id }, data: { status: 'PAUSED' } });
    await this.setCampaignRunning(workspaceId, current.socialCampaignId, false);
    await this.logEvent(workspaceId, id, 'PAUSED', 'Programme paused by the owner; nothing is planned, produced or published until resumed.');
    return updated;
  }

  async resume(workspaceId: string, id: string): Promise<ContentProgramme> {
    const current = await this.getOrThrow(workspaceId, id);
    if (current.status !== 'PAUSED') {
      throw new BadRequestException(`Cannot resume a ${current.status} programme.`);
    }
    const updated = await this.prisma.contentProgramme.update({ where: { id }, data: { status: 'ACTIVE' } });
    await this.setCampaignRunning(workspaceId, current.socialCampaignId, true);
    await this.logEvent(workspaceId, id, 'RESUMED', 'Programme resumed by the owner.');
    return updated;
  }

  /**
   * THE KILL SWITCH. Terminal: the programme is KILLED, the flag every job
   * checks is set, the lane is paused, and every slot nothing has been spent
   * on is SKIPPED with the reason on the row. Slots already producing or
   * published are left as they are — their money is spent and their history
   * is the programme's record.
   */
  async kill(workspaceId: string, id: string): Promise<ContentProgramme> {
    const current = await this.getOrThrow(workspaceId, id);
    if (current.status === 'KILLED') return current;
    const updated = await this.prisma.contentProgramme.update({
      where: { id },
      data: { status: 'KILLED', killSwitch: true },
    });
    await this.setCampaignRunning(workspaceId, current.socialCampaignId, false);
    const { count } = await this.prisma.contentSlot.updateMany({
      where: { workspaceId, programmeId: id, status: { in: OPEN_SLOT_STATUSES } },
      data: { status: 'SKIPPED', error: 'programme killed' },
    });
    await this.logEvent(workspaceId, id, 'KILLED', `Kill switch: programme stopped, campaign paused, ${count} open slot(s) skipped.`, { skippedSlots: count });
    return updated;
  }

  /**
   * The "why" log. Never throws: a log write must not fail the plan, the
   * reweight or the kill it describes. A failure is logged to the process log
   * instead, which is the one place it cannot take anything down with it.
   */
  async logEvent(
    workspaceId: string,
    programmeId: string,
    kind: string,
    message: string,
    data?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.prisma.contentProgrammeEvent.create({
        data: {
          workspaceId,
          programmeId,
          kind,
          message,
          ...(data !== undefined ? { data: data as Prisma.InputJsonValue } : {}),
        },
      });
    } catch (e) {
      this.logger.warn(`programme ${programmeId}: event ${kind} was not written: ${(e as Error)?.message ?? e}`);
    }
  }

  events(workspaceId: string, programmeId: string, limit = 50): Promise<ContentProgrammeEvent[]> {
    return this.prisma.contentProgrammeEvent.findMany({
      where: { workspaceId, programmeId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  // ───────────────────────────────────────────────────────── internals

  private cadenceFor(perWeek: number, daysOfWeek: number[] | undefined, timeOfDay: string | undefined): Cadence {
    if (daysOfWeek !== undefined) {
      if (!Array.isArray(daysOfWeek) || daysOfWeek.length === 0 || daysOfWeek.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
        throw new BadRequestException('daysOfWeek must be a non-empty list of weekdays 0 (Sunday) to 6 (Saturday)');
      }
    }
    if (timeOfDay !== undefined && !TIME_RE.test(timeOfDay)) {
      throw new BadRequestException(`timeOfDay must be HH:MM (got ${timeOfDay})`);
    }
    return {
      daysOfWeek: daysOfWeek ? [...new Set(daysOfWeek)].sort((a, b) => a - b) : spreadDaysOfWeek(perWeek),
      timeOfDay: timeOfDay ?? DEFAULT_TIME_OF_DAY,
      timezone: PROGRAMME_TIMEZONE,
    };
  }

  /** Every account must be the workspace's own AND connected: a slot planned
   *  for a disconnected account is a slot that can never publish. */
  private async requireAccounts(workspaceId: string, accountIds: unknown): Promise<void> {
    if (!Array.isArray(accountIds) || accountIds.length === 0) {
      throw new BadRequestException('At least one social account is required.');
    }
    const wanted = [...new Set(accountIds.map(String))];
    const found = await this.prisma.socialAccount.findMany({
      where: { id: { in: wanted }, workspaceId, enabled: true },
      select: { id: true },
    });
    const ok = new Set(found.map((a) => a.id));
    const missing = wanted.filter((id) => !ok.has(id));
    if (missing.length) {
      throw new BadRequestException(
        `Social account(s) ${missing.join(', ')} are not connected in this workspace. Connect them in the Social Planner first, or leave them out.`,
      );
    }
  }

  /**
   * Cadence and daily cap follow `perWeek`. Written through Prisma rather than
   * `SocialCampaignsService.update`, which refuses cadence changes on anything
   * but a DRAFT campaign — a rule written for campaigns a human schedules by
   * hand, where a moving cadence under a running plan tick would be a bug. The
   * programme's lane has no plan tick of its own (see `planTick`), so the rule
   * it exists for does not apply.
   */
  private async syncCampaignCadence(workspaceId: string, campaignId: string, perWeek: number): Promise<void> {
    const campaign = await this.prisma.socialCampaign.findFirst({
      where: { id: campaignId, workspaceId },
      select: { cadence: true },
    });
    const old = (campaign?.cadence ?? {}) as Partial<Cadence>;
    const cadence: Cadence = {
      daysOfWeek: spreadDaysOfWeek(perWeek),
      timeOfDay: old.timeOfDay ?? DEFAULT_TIME_OF_DAY,
      timezone: old.timezone ?? PROGRAMME_TIMEZONE,
    };
    await this.prisma.socialCampaign.updateMany({
      where: { id: campaignId, workspaceId },
      data: { cadence: cadence as unknown as Prisma.InputJsonValue, dailyPublishCap: dailyCapFor(perWeek) },
    });
  }

  /**
   * Move the lane with the programme, through the campaign service's own
   * transitions (they cancel/schedule the plan job and validate the from
   * state). Only a transition that is legal from the campaign's CURRENT
   * status is attempted — a lane already paused by hand must not fail the
   * programme's pause.
   */
  private async setCampaignRunning(workspaceId: string, campaignId: string, running: boolean): Promise<void> {
    const campaign = await this.prisma.socialCampaign.findFirst({
      where: { id: campaignId, workspaceId },
      select: { status: true },
    });
    if (!campaign) return;
    if (running) {
      if (campaign.status === 'PAUSED') await this.socialCampaigns.resume(workspaceId, campaignId);
      else if (campaign.status === 'DRAFT') await this.socialCampaigns.activate(workspaceId, campaignId);
    } else if (campaign.status === 'ACTIVE') {
      await this.socialCampaigns.pause(workspaceId, campaignId);
    }
  }

  /**
   * The rollback for a create that failed after the campaign existed. `pause`
   * is the right door when the campaign was activated (it cancels the plan
   * job too); when it was not, `pause` refuses the DRAFT and the status is
   * written directly. Best-effort: the original error is what the caller
   * needs to see.
   */
  private async disarmCampaign(workspaceId: string, campaignId: string): Promise<void> {
    try {
      await this.socialCampaigns.pause(workspaceId, campaignId);
    } catch {
      await this.prisma.socialCampaign
        .updateMany({ where: { id: campaignId, workspaceId }, data: { status: 'PAUSED' } })
        .catch((e) => this.logger.warn(`campaign ${campaignId} could not be disarmed: ${(e as Error)?.message ?? e}`));
    }
  }
}
