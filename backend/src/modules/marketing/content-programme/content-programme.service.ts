import { randomUUID } from 'crypto';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { ContentProgramme, ContentProgrammeEvent, ContentSlot, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { ScheduledJobService } from '../scheduling/scheduled-job.service';
import type { Cadence } from '../social-campaigns/cadence.util';
import { SocialCampaignsService } from '../social-campaigns/social-campaigns.service';
import { ContentTypesService } from './content-types.service';

/** What "working" means for a programme (design K2). */
export const PROGRAMME_GOALS = ['ENGAGEMENT', 'VIEWS', 'SAVES_SHARES', 'LEADS', 'COMPOSITE'] as const;
export type ProgrammeGoal = (typeof PROGRAMME_GOALS)[number];

/** Programme statuses. KILLED is terminal; `get` never returns one. */
export const PROGRAMME_STATUSES = ['ACTIVE', 'PAUSED', 'KILLED'] as const;

/** The statuses under which a programme still owns the workspace's calendar:
 *  a second one next to either would plan and spend beside it, unseen. */
const LIVE_PROGRAMME_STATUSES = ['ACTIVE', 'PAUSED'];

/** Slot statuses the kill switch sweeps: the money is not yet spent (PLANNED,
 *  IDEATED), the piece is being bought (PRODUCING) or is bought but not yet
 *  published (READY). A slot with an armed item has that item rejected so the
 *  gate drops it; one whose item cannot be rejected (still GENERATING, or
 *  already out) is left for the reconcile/settle sweeps, which walk KILLED
 *  programmes too. */
const OPEN_SLOT_STATUSES = ['PLANNED', 'IDEATED', 'PRODUCING', 'READY'];
/** Slots a pause leaves waiting and a resume has to re-arm. */
const WAITING_SLOT_STATUSES = ['PLANNED', 'IDEATED'];

export const PROGRAMME_TIMEZONE = 'Europe/Istanbul';
/** Turkey has kept +03:00 all year since 2016; the zone has no DST to model. */
const ISTANBUL_OFFSET_MINUTES = 3 * 60;
const MINUTES_PER_DAY = 24 * 60;
const DEFAULT_TIME_OF_DAY = '18:00';
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
/** One post per listed weekday: the cadence cannot carry more than seven a week. */
export const PER_WEEK_MAX = 7;
/** The most any door — panel, REST or agent — may set as the weekly credit cap. */
export const WEEKLY_CREDIT_CAP_MAX = 20000;
/** The lane releases at most one post a day; `perWeek` is spread over weekdays, never stacked. */
const DAILY_PUBLISH_CAP = 1;

/**
 * The bounds every setting is held to, stated once and read by create, update,
 * the REST DTO and the MCP schema. The two lead times and the look-ahead are
 * bounded ABOVE as well as below because they are spend levers in disguise:
 * the weekly cap is checked against the week the job runs in, and a lead long
 * enough to pull next month's slots into tonight would have every one of them
 * checked against this week's sum and booked into weeks no check reads.
 * Ninety-six hours of plan lead is four days — enough to storyboard over a long
 * weekend, never enough to reach past the coming week.
 */
export const BOUNDS = {
  perWeek: [1, PER_WEEK_MAX],
  weeklyCreditCap: [50, WEEKLY_CREDIT_CAP_MAX],
  explorationRate: [0.05, 0.5],
  maturityHours: [24, 168],
  halfLifeDays: [7, 90],
  editWindowHours: [1, 24],
  lookaheadDays: [7, 28],
  planLeadHours: [6, 96],
  produceLeadHours: [2, 48],
} as const;

/**
 * The cadence as the programme writes it onto its campaign. `daysOfWeek` and
 * `timeOfDay` are what `nextCadenceSlot` reads — and it reads them as UTC —
 * so they are the CONVERTED values; the two `local*` fields keep what the
 * owner typed, in Turkey time, for the panel and for the next edit.
 */
export interface ProgrammeCadence extends Cadence {
  timezone: string;
  localTimeOfDay: string;
  localDaysOfWeek: number[];
}

export interface CreateProgrammeInput {
  name: string;
  /** What the programme is about — product, audience, tone. Grounds every idea. */
  brief: string;
  accountIds: string[];
  perWeek?: number;
  goal?: string;
  weeklyCreditCap?: number;
  personaId?: string;
  /** 0 = Sunday … 6 = Saturday, in Turkey time. Spread evenly from `perWeek` when absent. */
  daysOfWeek?: number[];
  /** 'HH:MM' in Turkey time (Europe/Istanbul). */
  timeOfDay?: string;
  createdById: string;
}

/** The settings an owner may change after creation; everything else is the engine's. */
export interface UpdateProgrammeInput {
  name?: string;
  brief?: string;
  goal?: string;
  perWeek?: number;
  /** 0 = Sunday … 6 = Saturday, in Turkey time; must list exactly `perWeek` days. */
  daysOfWeek?: number[];
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
  'daysOfWeek',
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
 * bunched at its start: three a week is Mon/Wed/Fri, not Mon/Tue/Wed. Seven
 * is every day; there is no eighth slot because the cadence yields one post
 * per weekday (see `nextCadenceSlot`), which is why `perWeek` is capped at 7.
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

/**
 * Turkey wall-clock → the UTC cadence the campaign runs on. `nextCadenceSlot`
 * sets `timeOfDay` with `setUTCHours` and matches `daysOfWeek` against
 * `getUTCDay`, so an 18:00 the owner typed has to reach it as 15:00 — and a
 * time before 03:00 belongs to the PREVIOUS UTC day, so each weekday shifts
 * back one (Monday 01:30 Istanbul is Sunday 22:30 UTC). Pure; the offset is
 * fixed because the zone has had no DST since 2016.
 */
export function cadenceForIstanbul(localDaysOfWeek: number[], localTimeOfDay: string): ProgrammeCadence {
  const [h, m] = localTimeOfDay.split(':').map((n) => parseInt(n, 10));
  const localMinutes = h * 60 + m;
  let utcMinutes = localMinutes - ISTANBUL_OFFSET_MINUTES;
  let dayShift = 0;
  if (utcMinutes < 0) {
    utcMinutes += MINUTES_PER_DAY;
    dayShift = -1;
  }
  const localDays = [...new Set(localDaysOfWeek)].sort((a, b) => a - b);
  const utcDays = [...new Set(localDays.map((d) => (d + dayShift + 7) % 7))].sort((a, b) => a - b);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    daysOfWeek: utcDays,
    timeOfDay: `${pad(Math.floor(utcMinutes / 60))}:${pad(utcMinutes % 60)}`,
    timezone: PROGRAMME_TIMEZONE,
    localTimeOfDay,
    localDaysOfWeek: localDays,
  };
}

function inRange(name: keyof typeof BOUNDS, value: unknown): asserts value is number {
  const [lo, hi] = BOUNDS[name];
  const isInt = name !== 'explorationRate';
  if (typeof value !== 'number' || !Number.isFinite(value) || (isInt && !Number.isInteger(value)) || value < lo || value > hi) {
    throw new BadRequestException(`${name} must be ${isInt ? 'an integer' : 'a number'} between ${lo} and ${hi} (got ${String(value)})`);
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

function requireDaysOfWeek(daysOfWeek: unknown): number[] {
  if (!Array.isArray(daysOfWeek) || daysOfWeek.length === 0 || daysOfWeek.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    throw new BadRequestException('daysOfWeek must be a non-empty list of weekdays 0 (Sunday) to 6 (Saturday)');
  }
  return [...new Set(daysOfWeek as number[])].sort((a, b) => a - b);
}

/** One post per listed day, so the list IS the weekly count; a mismatch is a
 *  contradiction the owner has to settle, not one the service guesses at. */
function requireDaysMatchPerWeek(days: number[], perWeek: number): void {
  if (days.length !== perWeek) {
    throw new BadRequestException(
      `daysOfWeek lists ${days.length} weekday(s) but perWeek is ${perWeek}; the cadence carries one post per listed day, so the two must agree.`,
    );
  }
}

function requireTimeOfDay(timeOfDay: unknown): string {
  if (typeof timeOfDay !== 'string' || !TIME_RE.test(timeOfDay)) {
    throw new BadRequestException(`timeOfDay must be HH:MM in Turkey time (got ${String(timeOfDay)})`);
  }
  return timeOfDay;
}

/**
 * THE PROGRAMME — the owner's "make these types of content, publish, wait,
 * then lean into what worked" loop, as one row plus the FULL_AUTO campaign it
 * publishes through. This service is the lifecycle: create (which arms the
 * campaign), the settings an owner may change, pause/resume, the kill switch,
 * and the "why" log every job writes to. Planning, producing and learning live
 * in their own services and only read what this one wrote.
 *
 * ## One live programme per workspace
 *
 * `get(workspaceId)` returns the newest programme that is not KILLED, and
 * `create` refuses while an ACTIVE or PAUSED one exists. The panel, the MCP
 * tools and the jobs all treat "the programme" as singular; a second live row
 * would keep its own campaign, cap and slot jobs with no door that shows its
 * id, and spend beside the one the owner can see. Killed programmes stay for
 * their history and a new one is created next to them.
 *
 * ## The campaign is the lane, not the planner
 *
 * The programme's campaign is created with `programmeId` stamped on it BEFORE
 * it is activated. `activate` schedules the campaign's own plan tick, and that
 * tick returns immediately for a campaign that carries a `programmeId` — so
 * the order is not cosmetic: linking after activating would let the first
 * tick plan a stock topic into the calendar the programme is about to fill.
 * From then on the campaign's own resume/activate doors refuse the lane; only
 * this service moves it, through `setCampaignRunning`.
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
    private readonly scheduledJobs: ScheduledJobService,
  ) {}

  async create(workspaceId: string, input: CreateProgrammeInput): Promise<ContentProgramme> {
    // Everything is validated BEFORE the campaign exists: a refusal here costs
    // nothing and leaves nothing behind.
    const name = requireText('name', input.name);
    const brief = requireText('brief', input.brief);
    const days = input.daysOfWeek !== undefined ? requireDaysOfWeek(input.daysOfWeek) : undefined;
    const perWeek = input.perWeek ?? days?.length ?? 5;
    inRange('perWeek', perWeek);
    if (days) requireDaysMatchPerWeek(days, perWeek);
    const weeklyCreditCap = input.weeklyCreditCap ?? 600;
    inRange('weeklyCreditCap', weeklyCreditCap);
    const goal = requireGoal(input.goal ?? 'COMPOSITE');
    const cadence = cadenceForIstanbul(days ?? spreadDaysOfWeek(perWeek), requireTimeOfDay(input.timeOfDay ?? DEFAULT_TIME_OF_DAY));
    await this.requireAccounts(workspaceId, input.accountIds);
    if (input.personaId !== undefined && input.personaId !== null) await this.requirePersona(workspaceId, input.personaId);
    await this.requireNoLiveProgramme(workspaceId);

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
      dailyPublishCap: DAILY_PUBLISH_CAP,
      createdById: input.createdById,
    });

    // The programme's id is decided here so the campaign can carry it before
    // the programme row exists — see the class docblock for why the order
    // link -> activate -> row is the only safe one.
    const programmeId = randomUUID();
    try {
      await this.prisma.socialCampaign.update({ where: { id: campaign.id }, data: { programmeId } });
      await this.socialCampaigns.activate(workspaceId, campaign.id, { byProgramme: true });
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
    // The weekday list is not a programme column — it lives on the campaign's
    // cadence — but it is validated here with the rest, against the count it
    // has to agree with (the new one when both move, the stored one otherwise).
    const days = patch.daysOfWeek !== undefined ? requireDaysOfWeek(patch.daysOfWeek) : undefined;
    if (days) requireDaysMatchPerWeek(days, patch.perWeek ?? current.perWeek);
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
      // Both halves are held to BOUNDS, the stored one included: a row whose
      // stored lead sits outside them cannot keep it by editing only the other
      // half — the pair is settled together or not at all.
      inRange('planLeadHours', planLead);
      inRange('produceLeadHours', produceLead);
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
      // Proven to be this workspace's NOW, at the door: the first job to read a
      // foreign or deleted persona would otherwise fail a slot 36 hours from
      // now, and three of those pause the programme with the cause buried in a
      // slot's error text.
      if (patch.personaId !== null) await this.requirePersona(workspaceId, patch.personaId);
      data.personaId = patch.personaId;
    }

    const cadenceMoves = (patch.perWeek !== undefined && patch.perWeek !== current.perWeek) || days !== undefined;
    if (Object.keys(data).length === 0 && !cadenceMoves) return current;

    const updated = Object.keys(data).length ? await this.prisma.contentProgramme.update({ where: { id }, data }) : current;

    // The cadence lives on the campaign; a new weekly count or weekday list
    // has to reach it or the programme would plan slots the lane refuses to
    // release.
    let cadenceNote = '';
    if (cadenceMoves) {
      const perWeek = patch.perWeek ?? current.perWeek;
      const cadence = await this.syncCampaignCadence(workspaceId, current.socialCampaignId, perWeek, days);
      cadenceNote = ` Cadence now ${perWeek}/week per account on days [${cadence.localDaysOfWeek.join(', ')}] at ${cadence.localTimeOfDay} ${PROGRAMME_TIMEZONE}.`;
    }
    const changed = [...Object.keys(data), ...(days ? ['daysOfWeek'] : [])];
    await this.logEvent(workspaceId, id, 'UPDATED', `Settings changed: ${changed.join(', ')}.${cadenceNote}`, {
      ...(data as Record<string, unknown>),
      ...(days ? { daysOfWeek: days } : {}),
    });
    return updated;
  }

  /**
   * Pause: the programme stops, the lane is paused, and every slot stays as it
   * is. Nothing is rejected — a READY slot's armed item waits behind the paused
   * campaign's gate (which reschedules hourly rather than dropping), so the
   * piece already paid for publishes when the owner resumes.
   */
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

  /**
   * Resume: the programme and its lane run again, and the calendar is brought
   * back with them. While paused, a slot's plan/produce job that fired held
   * itself off, but a job can also have been consumed (a crash, an old row),
   * so every PLANNED/IDEATED slot still ahead of us is RE-ARMED here — belt
   * and braces, at the cost of two idempotent schedule calls per slot. A slot
   * whose publish time passed during the pause cannot be caught up: it is
   * SKIPPED with the reason on the row and its proposed concept discarded, so
   * the fill sweep plans the next times instead of leaving dead rows that
   * block them.
   *
   * ## The lane paused by hand
   *
   * `pause` is the one campaign door the lane keeps open, so a person or an
   * agent can leave the programme ACTIVE with its campaign PAUSED: produce
   * jobs then hold hourly and skip their slots as missed. The campaign's own
   * resume door refuses a lane ("resume the programme instead"), so THIS is
   * the door it points at — an ACTIVE programme whose lane is not running has
   * its lane re-run and nothing else touched: no slot was consumed while the
   * programme itself kept planning, so there is nothing to re-arm. An ACTIVE
   * programme whose lane is already running has nothing to resume and says so.
   */
  async resume(workspaceId: string, id: string, now = new Date()): Promise<ContentProgramme> {
    const current = await this.getOrThrow(workspaceId, id);
    if (current.status === 'ACTIVE') {
      if ((await this.assertLaneRunning(workspaceId, current)) === 'ACTIVE') {
        throw new BadRequestException('Cannot resume an ACTIVE programme whose lane is already running.');
      }
      await this.setCampaignRunning(workspaceId, current.socialCampaignId, true);
      await this.logEvent(workspaceId, id, 'LANE_RESUMED', 'The programme\'s campaign had been paused by hand; it runs again. Slots held meanwhile publish at their times.', {
        socialCampaignId: current.socialCampaignId,
      });
      return current;
    }
    if (current.status !== 'PAUSED') {
      throw new BadRequestException(`Cannot resume a ${current.status} programme.`);
    }
    const updated = await this.prisma.contentProgramme.update({ where: { id }, data: { status: 'ACTIVE' } });
    await this.setCampaignRunning(workspaceId, current.socialCampaignId, true);

    const waiting: Array<Pick<ContentSlot, 'id' | 'scheduledFor' | 'status' | 'conceptId'>> = await this.prisma.contentSlot.findMany({
      where: { workspaceId, programmeId: id, status: { in: WAITING_SLOT_STATUSES } },
      select: { id: true, scheduledFor: true, status: true, conceptId: true },
    });
    const missed = waiting.filter((s) => s.scheduledFor.getTime() <= now.getTime());
    const ahead = waiting.filter((s) => s.scheduledFor.getTime() > now.getTime());

    const { scheduleSlotJobs } = await this.slotJobs();
    for (const slot of ahead) await scheduleSlotJobs(this.scheduledJobs, workspaceId, updated, slot, now);

    if (missed.length) {
      const conceptIds = missed.map((s) => s.conceptId).filter((c): c is string => Boolean(c));
      if (conceptIds.length) await this.discardConcepts(workspaceId, conceptIds, id, 'programme: slot skipped', now);
      await this.prisma.contentSlot.updateMany({
        where: { id: { in: missed.map((s) => s.id) }, workspaceId, status: { in: WAITING_SLOT_STATUSES } },
        data: { status: 'SKIPPED', error: 'missed while paused' },
      });
    }

    await this.logEvent(
      workspaceId,
      id,
      'RESUMED',
      `Programme resumed by the owner: ${ahead.length} slot(s) re-armed, ${missed.length} missed while paused and skipped.`,
      { rearmedSlots: ahead.length, missedSlots: missed.length, missedSlotIds: missed.map((s) => s.id) },
    );
    return updated;
  }

  /**
   * THE KILL SWITCH. Terminal: the programme is KILLED, the flag every job
   * checks is set, the lane is paused, and every slot nothing has been
   * published for is closed:
   *
   *  - PLANNED / IDEATED: SKIPPED, their slot jobs cancelled and an IDEATED
   *    slot's proposed concept DISCARDED — otherwise it stays approvable in
   *    the concept hub and its storyboard job keeps drawing frames.
   *  - READY, and PRODUCING with an item: the armed item is REJECTED
   *    (SCHEDULED / NEEDS_APPROVAL → SKIPPED, which the publish gate drops)
   *    and the slot SKIPPED — otherwise the gate loops hourly forever against
   *    the paused lane, and anyone resuming the campaign by hand would publish
   *    a piece under a programme the owner ended. PRODUCING is in this sweep
   *    because the produce job arms the item SCHEDULED within minutes of the
   *    clips, while the slot stays PRODUCING until the 6-hourly reconcile: in
   *    that window the job is DONE, its kill check never runs again, and the
   *    item would sit armed behind the paused lane with nobody to drop it.
   *  - An item that cannot be rejected — still GENERATING (the produce job
   *    reads the kill flag before its next clip and fails it), or already
   *    out — leaves its slot as it is, counted in the event as left. The
   *    planner's reconcile and the learner's settle both walk KILLED
   *    programmes, so such a slot follows its item to FAILED or PUBLISHED
   *    rather than staying open forever.
   *  - PRODUCING with no item yet: left; the produce job is mid-flight before
   *    the item exists and reads the flag itself.
   *
   * Slots already published or measured keep their history.
   */
  async kill(workspaceId: string, id: string): Promise<ContentProgramme> {
    const current = await this.getOrThrow(workspaceId, id);
    if (current.status === 'KILLED') return current;
    const updated = await this.prisma.contentProgramme.update({
      where: { id },
      data: { status: 'KILLED', killSwitch: true },
    });
    await this.setCampaignRunning(workspaceId, current.socialCampaignId, false);

    const open: Array<Pick<ContentSlot, 'id' | 'status' | 'conceptId' | 'campaignItemId'>> = await this.prisma.contentSlot.findMany({
      where: { workspaceId, programmeId: id, status: { in: OPEN_SLOT_STATUSES } },
      select: { id: true, status: true, conceptId: true, campaignItemId: true },
    });
    const { cancelSlotJobs } = await this.slotJobs();
    const now = new Date();
    const swept: string[] = [];
    const left: string[] = [];
    let rejectedItems = 0;
    for (const slot of open) {
      if (slot.status === 'PRODUCING' && !slot.campaignItemId) {
        left.push(slot.id);
        continue;
      }
      if (slot.campaignItemId) {
        // `rejectItem` carries the one list of rejectable item states; an
        // item outside it (GENERATING, PUBLISHED, …) is the refusal itself,
        // not a second copy of that list here.
        try {
          await this.socialCampaigns.rejectItem(workspaceId, slot.campaignItemId);
          rejectedItems += 1;
        } catch (e) {
          this.logger.warn(`programme ${id}: slot ${slot.id} kept — its item could not be rejected: ${(e as Error)?.message ?? e}`);
          left.push(slot.id);
          continue;
        }
      }
      if (slot.conceptId) await this.discardConcepts(workspaceId, [slot.conceptId], id, 'programme killed', now);
      await cancelSlotJobs(this.scheduledJobs, slot.id);
      swept.push(slot.id);
    }
    const { count } = swept.length
      ? await this.prisma.contentSlot.updateMany({
          where: { id: { in: swept }, workspaceId, programmeId: id, status: { in: OPEN_SLOT_STATUSES } },
          data: { status: 'SKIPPED', error: 'programme killed' },
        })
      : { count: 0 };
    await this.logEvent(
      workspaceId,
      id,
      'KILLED',
      `Kill switch: programme stopped, campaign paused, ${count} open slot(s) skipped, ${rejectedItems} armed item(s) rejected, ${left.length} slot(s) left to settle.`,
      { skippedSlots: count, rejectedItems, leftSlots: left.length, leftSlotIds: left },
    );
    return updated;
  }

  /**
   * Whether the programme's lane can publish right now. The campaign is an
   * ordinary row in the campaigns list and a person or an agent may pause it
   * by hand (`pause` is the one campaign door the lane keeps); when they do,
   * the programme must hold its slots rather than buy clips into a gate that
   * releases nothing. Anything but ACTIVE — PAUSED, DRAFT, a cancelled or
   * missing campaign — is answered as PAUSED, because "cannot publish" is the
   * only thing the producer needs to know.
   */
  async assertLaneRunning(workspaceId: string, programme: Pick<ContentProgramme, 'socialCampaignId'>): Promise<'ACTIVE' | 'PAUSED'> {
    const campaign = await this.prisma.socialCampaign.findFirst({
      where: { id: programme.socialCampaignId, workspaceId },
      select: { status: true },
    });
    return campaign?.status === 'ACTIVE' ? 'ACTIVE' : 'PAUSED';
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

  /**
   * The per-slot job helpers live in the planner, and the planner INJECTS this
   * service. A top-level import of it here would load the planner while this
   * module is still half-built, and its constructor metadata would then name
   * `Object` where it should name this class — Nest fails to resolve it at
   * boot. Reading the helpers at call time keeps one copy of "which two jobs a
   * slot has" without the cycle.
   */
  private slotJobs() {
    return import('./programme-planner.service');
  }

  /** Only PROPOSED rows move: a concept a human already decided keeps that verdict. */
  private async discardConcepts(workspaceId: string, ids: string[], programmeId: string, note: string, now: Date): Promise<void> {
    await this.prisma.contentConcept.updateMany({
      where: { id: { in: ids }, workspaceId, status: 'PROPOSED' },
      data: { status: 'DISCARDED', reviewedAt: now, reviewedById: `programme:${programmeId}`, reviewNote: note },
    });
  }

  private async requireNoLiveProgramme(workspaceId: string): Promise<void> {
    const live = await this.prisma.contentProgramme.findFirst({
      where: { workspaceId, status: { in: LIVE_PROGRAMME_STATUSES } },
      select: { id: true, name: true },
    });
    if (live) {
      throw new BadRequestException(`This workspace already runs programme "${live.name}"; pause or kill it first.`);
    }
  }

  /** The persona must be this workspace's and usable; a foreign or archived one
   *  would fail every slot at plan time, days from now. */
  private async requirePersona(workspaceId: string, personaId: unknown): Promise<void> {
    if (typeof personaId !== 'string' || !personaId.trim()) {
      throw new BadRequestException('personaId must be a non-empty string');
    }
    const persona = await this.prisma.videoPersona.findFirst({
      where: { id: personaId, workspaceId },
      select: { id: true, name: true, status: true },
    });
    if (!persona) {
      throw new BadRequestException(`Persona ${personaId} does not exist in this workspace.`);
    }
    if (persona.status !== 'ACTIVE') {
      throw new BadRequestException(`Persona "${persona.name}" is ${persona.status} and cannot front a programme.`);
    }
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
   * The cadence follows `perWeek` and the weekday list. Written through Prisma
   * rather than `SocialCampaignsService.update`, which refuses cadence changes
   * on anything but a DRAFT campaign — a rule written for campaigns a human
   * schedules by hand, where a moving cadence under a running plan tick would
   * be a bug. The programme's lane has no plan tick of its own (see
   * `planTick`), so the rule it exists for does not apply.
   *
   * Which weekdays: the ones given; else the ones the owner already had when
   * they still fit the new count (raising 2 → 3 must not silently move Tue/Thu
   * to Mon/Wed/Fri — but it has to add a day somewhere, so a count the old list
   * cannot carry is spread afresh). The time is always what the owner typed,
   * re-converted; a cadence written before the conversion existed carries its
   * typed time in `timeOfDay`, and is repaired here on the first edit.
   */
  private async syncCampaignCadence(workspaceId: string, campaignId: string, perWeek: number, daysOfWeek: number[] | undefined): Promise<ProgrammeCadence> {
    const campaign = await this.prisma.socialCampaign.findFirst({
      where: { id: campaignId, workspaceId },
      select: { cadence: true },
    });
    const old = (campaign?.cadence ?? {}) as Partial<ProgrammeCadence>;
    const oldDays = old.localDaysOfWeek ?? old.daysOfWeek;
    const days = daysOfWeek ?? (Array.isArray(oldDays) && oldDays.length === perWeek ? oldDays : spreadDaysOfWeek(perWeek));
    const localTime = old.localTimeOfDay ?? old.timeOfDay ?? DEFAULT_TIME_OF_DAY;
    const cadence = cadenceForIstanbul(days, TIME_RE.test(localTime) ? localTime : DEFAULT_TIME_OF_DAY);
    await this.prisma.socialCampaign.updateMany({
      where: { id: campaignId, workspaceId },
      data: { cadence: cadence as unknown as Prisma.InputJsonValue, dailyPublishCap: DAILY_PUBLISH_CAP },
    });
    return cadence;
  }

  /**
   * Move the lane with the programme, through the campaign service's own
   * transitions (they cancel/schedule the plan job and validate the from
   * state), flagged as the programme's so the lane guard on resume/activate
   * lets them through. Only a transition that is legal from the campaign's
   * CURRENT status is attempted — a lane already paused by hand must not fail
   * the programme's pause.
   */
  private async setCampaignRunning(workspaceId: string, campaignId: string, running: boolean): Promise<void> {
    const campaign = await this.prisma.socialCampaign.findFirst({
      where: { id: campaignId, workspaceId },
      select: { status: true },
    });
    if (!campaign) return;
    if (running) {
      if (campaign.status === 'PAUSED') await this.socialCampaigns.resume(workspaceId, campaignId, { byProgramme: true });
      else if (campaign.status === 'DRAFT') await this.socialCampaigns.activate(workspaceId, campaignId, { byProgramme: true });
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
