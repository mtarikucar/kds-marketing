import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ContentProgramme, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { ScheduledJobService } from '../scheduling/scheduled-job.service';
import { ScheduledJobRunnerService } from '../scheduling/scheduled-job-runner.service';
import { accountBaseline, Baseline, Goal, MetricSnapshot, rewardFor } from './engine/reward.util';
import {
  decayPosterior, nextPhase, Phase, Posterior, posteriorMean, updatePosterior, weightsFrom,
} from './engine/posterior.util';
import { TypeArm } from './engine/type-selector.util';

export const CONTENT_PROGRAMME_LEARN_KIND = 'content.programme.learn';
export const LEARN_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** The programme reweights at most once a week: a posterior fed every tick
 *  would chase day-to-day noise and the weights chart would be unreadable. */
export const REWEIGHT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
/** How long past maturity a published slot may wait for its first metric
 *  row before it is closed unmeasured — a network whose insights permission
 *  was never granted must not pin the programme's slots PUBLISHED forever. */
export const METRIC_GRACE_HOURS = 7 * 24;
/** Baseline window: the account's posts of the last 30 days. */
const BASELINE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const ALL = 'ALL';

type Slot = Prisma.ContentSlotGetPayload<{}>;
type TypeRow = { id: string; key: string; minShare: number; maxShare: number; active: boolean };
type StatRow = { contentTypeKey: string; contentTypeId?: string; network: string; alpha: number; beta: number; samples: number; computedAt: Date };

export interface ReweightResult {
  phase: Phase;
  previousPhase: Phase;
  folded: number;
  weights: Record<string, number>;
  arms: Array<{ key: string; alpha: number; beta: number; mean: number; samples: number }>;
}

const hours = (h: number) => h * 60 * 60 * 1000;
const round = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d;

/**
 * The learning half of the content programme's loop — the half that runs
 * AFTER a slot has published. Three steps, each idempotent and each
 * runnable on its own:
 *
 *   settle    READY slot whose post went out → PUBLISHED (with the date)
 *   measure   PUBLISHED slot past maturity → MEASURED, reward per network
 *             against the account's own 30-day baseline
 *   reweight  weekly: fold every new reward into the per-(type, network)
 *             Beta posteriors, decay the old evidence, write ContentTypeStat
 *             rows, recompute the calendar weights, advance the phase
 *
 * The planner reads `currentArms` (the latest ALL posterior per active type)
 * and the selector samples from it. Everything here is workspace-scoped
 * even though the 6-hourly job walks every workspace's programme — each
 * programme row carries its workspaceId and every read/write repeats it.
 */
@Injectable()
export class ProgrammeLearningService implements OnModuleInit {
  private readonly logger = new Logger(ProgrammeLearningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduledJobs: ScheduledJobService,
    private readonly runner: ScheduledJobRunnerService,
  ) {}

  onModuleInit(): void {
    this.runner.registerHandler(CONTENT_PROGRAMME_LEARN_KIND, async () => {
      await this.runAll();
      return { reschedule: { runAt: new Date(Date.now() + LEARN_INTERVAL_MS) } };
    });
    void this.scheduledJobs.schedule({
      workspaceId: 'system',
      kind: CONTENT_PROGRAMME_LEARN_KIND,
      runAt: new Date(Date.now() + LEARN_INTERVAL_MS),
      payload: {},
      dedupKey: 'content-programme-learn',
    }).catch(() => undefined);
  }

  /** One tick: every live programme, in turn; one programme's failure is its
   *  own event, never the others' lost tick. */
  async runAll(now = new Date()): Promise<void> {
    const programmes = await this.prisma.contentProgramme.findMany({ where: { status: 'ACTIVE', killSwitch: false } });
    for (const p of programmes) {
      try {
        await this.settle(p.workspaceId, p);
        await this.measureDue(p.workspaceId, p, now);
        await this.reweight(p.workspaceId, p, now);
      } catch (e: any) {
        const msg = String(e?.message ?? e).slice(0, 500);
        this.logger.warn(`learn tick failed for programme ${p.id}: ${msg}`);
        await this.logEvent(p.workspaceId, p.id, 'LEARN_ERROR', `Learning tick failed: ${msg}`, { error: msg });
      }
    }
  }

  /**
   * READY → PUBLISHED for every slot whose post has gone out. A post counts
   * as published as soon as ONE target is out (a partial fan-out still put
   * content in front of people, and the failed target simply yields no
   * metrics); a post that failed outright fails the slot with the reason.
   * Returns how many slots were marked PUBLISHED.
   */
  async settle(workspaceId: string, programme: ContentProgramme): Promise<number> {
    const slots = await this.prisma.contentSlot.findMany({
      where: { workspaceId, programmeId: programme.id, status: 'READY' },
    });
    let published = 0;
    for (const slot of slots) {
      const postId = slot.socialPostId ?? (await this.postIdOfItem(workspaceId, slot.campaignItemId));
      if (!postId) continue;
      const post = await this.prisma.socialPost.findFirst({
        where: { id: postId, workspaceId },
        select: { id: true, status: true, publishedAt: true, updatedAt: true, targets: { select: { status: true, error: true } } },
      });
      if (!post) continue;
      const anyOut = post.status === 'PUBLISHED' || post.targets.some((t) => t.status === 'PUBLISHED');
      if (anyOut) {
        await this.prisma.contentSlot.updateMany({
          where: { id: slot.id, workspaceId, status: 'READY' },
          data: { status: 'PUBLISHED', publishedAt: post.publishedAt ?? post.updatedAt ?? new Date(), socialPostId: post.id },
        });
        published++;
      } else if (post.status === 'FAILED') {
        const reasons = post.targets.map((t) => t.error).filter(Boolean).join('; ') || 'unknown';
        const error = `publish failed: ${reasons}`.slice(0, 500);
        await this.prisma.contentSlot.updateMany({
          where: { id: slot.id, workspaceId, status: 'READY' },
          data: { status: 'FAILED', error },
        });
        await this.logEvent(workspaceId, programme.id, 'SLOT_FAILED', `Slot ${slot.contentTypeKey} failed to publish: ${reasons}`, {
          slotId: slot.id, postId: post.id, contentTypeKey: slot.contentTypeKey, error,
        });
      }
    }
    return published;
  }

  /**
   * PUBLISHED → MEASURED for every slot older than `maturityHours`. Each
   * published target gets the latest metric row it has, scored by the
   * programme's goal against the account's baseline on that network; the
   * slot's reward is the mean over its networks. A slot with no metric row
   * yet is left for a later tick, up to METRIC_GRACE_HOURS, then closed with
   * no reward so it stops blocking the programme. Returns how many slots
   * received a reward.
   */
  async measureDue(workspaceId: string, programme: ContentProgramme, now = new Date()): Promise<number> {
    const slots = await this.prisma.contentSlot.findMany({
      where: {
        workspaceId, programmeId: programme.id, status: 'PUBLISHED',
        publishedAt: { lte: new Date(now.getTime() - hours(programme.maturityHours)) },
      },
      orderBy: { publishedAt: 'asc' },
    });
    const baselines = new Map<string, Baseline>();
    let measured = 0;
    let touched = 0;
    for (const slot of slots) {
      if (!slot.socialPostId) continue;
      const targets = await this.prisma.socialPostTarget.findMany({
        where: { workspaceId, postId: slot.socialPostId, status: 'PUBLISHED' },
        select: {
          id: true, socialAccountId: true, network: true,
          metrics: { orderBy: { date: 'desc' }, take: 1 },
        },
      });
      const withMetrics = targets.filter((t) => t.metrics.length > 0);
      if (withMetrics.length === 0) {
        const graceEnds = new Date(slot.publishedAt.getTime() + hours(programme.maturityHours + METRIC_GRACE_HOURS));
        if (graceEnds > now) continue;
        await this.prisma.contentSlot.updateMany({
          where: { id: slot.id, workspaceId, status: 'PUBLISHED' },
          data: { status: 'MEASURED', measuredAt: now, reward: null, error: 'no metrics arrived within the grace period' },
        });
        await this.logEvent(workspaceId, programme.id, 'NO_METRICS', `Slot ${slot.contentTypeKey} closed unmeasured: no metrics within ${METRIC_GRACE_HOURS}h of maturity`, {
          slotId: slot.id, contentTypeKey: slot.contentTypeKey, postId: slot.socialPostId,
        });
        touched++;
        continue;
      }

      const perNetwork: Record<string, Record<string, unknown>> = {};
      for (const t of withMetrics) {
        const key = `${t.socialAccountId}:${t.network}`;
        let baseline = baselines.get(key);
        if (!baseline) {
          baseline = await this.baselineFor(workspaceId, t.socialAccountId, t.network, slot.socialPostId, now);
          baselines.set(key, baseline);
        }
        const m = toSnapshot(t.metrics[0]);
        const { reward, breakdown } = rewardFor(programme.goal as Goal, t.network, m, baseline);
        const entry = { ...breakdown, accountId: t.socialAccountId, targetId: t.id, baselineSource: baseline.source, metricDate: t.metrics[0].date };
        const prev = perNetwork[t.network];
        // Two accounts on one network (rare): average, and keep each account's line.
        perNetwork[t.network] = prev
          ? { ...prev, reward: ((prev.reward as number) + reward) / 2, perAccount: [...((prev.perAccount as unknown[]) ?? [prev]), entry] }
          : entry;
      }
      const rewards = Object.values(perNetwork).map((n) => n.reward as number);
      const reward = rewards.reduce((s, r) => s + r, 0) / rewards.length;
      await this.prisma.contentSlot.updateMany({
        where: { id: slot.id, workspaceId, status: 'PUBLISHED' },
        data: { status: 'MEASURED', measuredAt: now, reward, rewardBreakdown: perNetwork as Prisma.InputJsonValue },
      });
      const summary = Object.entries(perNetwork).map(([n, v]) => `${n} ${round(v.reward as number, 2)}`).join(', ');
      await this.logEvent(workspaceId, programme.id, 'MEASURE', `Slot ${slot.contentTypeKey} measured: reward ${round(reward, 2)} (${summary})`, {
        slotId: slot.id, contentTypeKey: slot.contentTypeKey, reward,
        networks: Object.fromEntries(Object.entries(perNetwork).map(([n, v]) => [n, { reward: v.reward, baselineSource: v.baselineSource }])),
      });
      measured++;
      touched++;
    }
    if (touched > 0) {
      await this.prisma.contentProgramme.updateMany({ where: { id: programme.id, workspaceId }, data: { lastMeasuredAt: now } });
    }
    return measured;
  }

  /**
   * The weekly posterior update. Due on the first measured slot, then every
   * REWEIGHT_INTERVAL_MS (even with nothing new: decay alone moves the
   * weights). For every active type × (each network seen, and ALL): the
   * previous stat decayed by its age, plus every slot measured since the
   * last reweight, written as a fresh ContentTypeStat row so the history
   * chart keeps every point. Returns null when not due.
   */
  async reweight(workspaceId: string, programme: ContentProgramme, now = new Date()): Promise<ReweightResult | null> {
    const last = programme.lastReweightedAt;
    if (last) {
      if (now.getTime() - last.getTime() < REWEIGHT_INTERVAL_MS) return null;
    } else {
      const measured = await this.prisma.contentSlot.count({
        where: { workspaceId, programmeId: programme.id, status: 'MEASURED', reward: { not: null } },
      });
      if (measured < 1) return null;
    }

    const types = await this.activeTypes(workspaceId);
    const slots: Slot[] = await this.prisma.contentSlot.findMany({
      where: {
        workspaceId, programmeId: programme.id, status: 'MEASURED', reward: { not: null },
        ...(last ? { measuredAt: { gt: last } } : {}),
      },
    });
    const prevStats: StatRow[] = await this.prisma.contentTypeStat.findMany({
      where: { workspaceId, programmeId: programme.id },
      orderBy: [{ contentTypeKey: 'asc' }, { network: 'asc' }, { computedAt: 'desc' }],
      distinct: ['contentTypeKey', 'network'],
    });
    const prevByKey = new Map(prevStats.map((s) => [`${s.contentTypeKey}|${s.network}`, s]));

    const networks = new Set<string>([ALL]);
    for (const s of prevStats) networks.add(s.network);
    for (const s of slots) for (const n of Object.keys(breakdownOf(s))) networks.add(n);

    type Cell = Posterior & { samples: number };
    const cells = new Map<string, Cell>();
    for (const t of types) {
      for (const network of networks) {
        const prev = prevByKey.get(`${t.key}|${network}`);
        let p: Posterior = prev ? { alpha: prev.alpha, beta: prev.beta } : { alpha: 1, beta: 1 };
        if (prev) p = decayPosterior(p, (now.getTime() - prev.computedAt.getTime()) / DAY_MS, programme.halfLifeDays);
        let samples = prev?.samples ?? 0;
        for (const s of slots) {
          if (s.contentTypeKey !== t.key) continue;
          const r = network === ALL ? s.reward : breakdownOf(s)[network]?.reward;
          if (typeof r !== 'number' || !Number.isFinite(r)) continue;
          p = updatePosterior(p, r);
          samples++;
        }
        cells.set(`${t.key}|${network}`, { ...p, samples });
      }
    }

    const rows: Prisma.ContentTypeStatCreateManyInput[] = [];
    let allWeights: Record<string, number> = {};
    for (const network of networks) {
      const arms = types.map((t) => ({ key: t.key, ...cells.get(`${t.key}|${network}`), minShare: t.minShare, maxShare: t.maxShare, active: true }));
      const weights = weightsFrom(arms);
      if (network === ALL) allWeights = weights;
      for (const t of types) {
        const c = cells.get(`${t.key}|${network}`);
        rows.push({
          workspaceId, programmeId: programme.id, contentTypeId: t.id, contentTypeKey: t.key, network,
          samples: c.samples, alpha: c.alpha, beta: c.beta, meanReward: posteriorMean(c), weight: weights[t.key] ?? 0, computedAt: now,
        });
      }
    }
    if (rows.length > 0) await this.prisma.contentTypeStat.createMany({ data: rows });

    const allArms = types.map((t) => {
      const c = cells.get(`${t.key}|${ALL}`);
      return { key: t.key, alpha: c.alpha, beta: c.beta, mean: posteriorMean(c), samples: c.samples, active: true };
    });
    const measuredPerType = Object.fromEntries(allArms.map((a) => [a.key, a.samples]));
    const seedWeeksElapsed = now.getTime() - programme.createdAt.getTime() >= programme.seedWeeks * 7 * DAY_MS;
    const previousPhase = programme.phase as Phase;
    const phase = nextPhase(previousPhase, { seedWeeksElapsed, measuredPerType, arms: allArms });

    await this.prisma.contentProgramme.updateMany({
      where: { id: programme.id, workspaceId },
      data: { phase, lastReweightedAt: now },
    });

    const result: ReweightResult = {
      phase, previousPhase, folded: slots.length, weights: allWeights,
      arms: allArms.map(({ key, alpha, beta, mean, samples }) => ({ key, alpha: round(alpha), beta: round(beta), mean: round(mean), samples })),
    };
    const weightLine = types.map((t) => `${t.key} ${round(allWeights[t.key] ?? 0, 2)}`).join(', ');
    await this.logEvent(workspaceId, programme.id, 'REWEIGHT',
      `Reweighted after folding ${slots.length} measurement(s): ${weightLine}; phase ${phase}`,
      { folded: slots.length, phase, previousPhase, weights: allWeights, arms: result.arms, networks: [...networks] });
    if (phase !== previousPhase) {
      await this.logEvent(workspaceId, programme.id, 'PHASE', `Phase ${previousPhase} → ${phase}`, {
        from: previousPhase, to: phase, seedWeeksElapsed, measuredPerType,
      });
    }
    return result;
  }

  /** The selector's arms: one per active type, from its latest ALL stat;
   *  a type that never reweighted starts at the Beta(1, 1) prior. */
  async currentArms(workspaceId: string, programmeId: string): Promise<TypeArm[]> {
    const types = await this.activeTypes(workspaceId);
    const stats: StatRow[] = await this.prisma.contentTypeStat.findMany({
      where: { workspaceId, programmeId, network: ALL },
      orderBy: [{ contentTypeKey: 'asc' }, { computedAt: 'desc' }],
      distinct: ['contentTypeKey'],
    });
    // Newest first per key: keep the first row seen, and only the ALL blend.
    const byKey = new Map<string, StatRow>();
    for (const s of stats) if (s.network === ALL && !byKey.has(s.contentTypeKey)) byKey.set(s.contentTypeKey, s);
    return types.map((t) => {
      const s = byKey.get(t.key);
      return {
        typeId: t.id, key: t.key, minShare: t.minShare, maxShare: t.maxShare,
        alpha: s?.alpha ?? 1, beta: s?.beta ?? 1, samples: s?.samples ?? 0, active: t.active,
      };
    });
  }

  /** The programme's live types in calendar order. The `active` re-check
   *  mirrors the query so a stale caller (or a loose mock) cannot hand an
   *  inactive type a posterior row or a share of the calendar. */
  private async activeTypes(workspaceId: string): Promise<TypeRow[]> {
    const types: TypeRow[] = await this.prisma.contentType.findMany({
      where: { workspaceId, active: true },
      orderBy: { ordinal: 'asc' },
    });
    return types.filter((t) => t.active);
  }

  private async postIdOfItem(workspaceId: string, campaignItemId: string | null): Promise<string | null> {
    if (!campaignItemId) return null;
    const item = await this.prisma.socialCampaignItem.findFirst({
      where: { id: campaignItemId, workspaceId },
      select: { socialPostId: true },
    });
    return item?.socialPostId ?? null;
  }

  /** The account's last 30 days on this network: the latest row of every
   *  OTHER post's target, so the slot is never measured against itself. */
  private async baselineFor(workspaceId: string, socialAccountId: string, network: string, excludePostId: string, now: Date): Promise<Baseline> {
    const rows = await this.prisma.socialPostMetric.findMany({
      where: {
        workspaceId,
        date: { gte: new Date(now.getTime() - BASELINE_DAYS * DAY_MS) },
        target: { socialAccountId, postId: { not: excludePostId } },
      },
      orderBy: [{ targetId: 'asc' }, { date: 'desc' }],
      distinct: ['targetId'],
    });
    return accountBaseline(rows.map(toSnapshot), network);
  }

  /** Best-effort "why" line: the log must never take the learning down with it. */
  private async logEvent(workspaceId: string, programmeId: string, kind: string, message: string, data?: Record<string, unknown>): Promise<void> {
    try {
      await this.prisma.contentProgrammeEvent.create({
        data: { workspaceId, programmeId, kind, message: message.slice(0, 1000), data: (data ?? undefined) as Prisma.InputJsonValue },
      });
    } catch (e: any) {
      this.logger.warn(`could not log programme event ${kind}: ${String(e?.message ?? e)}`);
    }
  }
}

function toSnapshot(m: Record<string, unknown>): MetricSnapshot {
  const n = (k: string) => Math.max(0, Number(m[k]) || 0);
  return {
    impressions: n('impressions'), reach: n('reach'), engagements: n('engagements'), likes: n('likes'), comments: n('comments'),
    shares: n('shares'), saves: n('saves'), videoViews: n('videoViews'), leads: n('leads'),
  };
}

function breakdownOf(slot: Slot): Record<string, { reward?: unknown }> {
  const b = slot.rewardBreakdown;
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, { reward?: unknown }>) : {};
}
