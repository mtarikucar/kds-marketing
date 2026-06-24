import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../../prisma/prisma.service';
import { withAdvisoryLock } from '../../../common/scheduling/advisory-lock';
import { isMetaAdsConfigured } from './ads.types';
import { AdManagementService, AdEntityView } from './ad-management.service';

const METRICS = ['SPEND', 'CPL', 'CTR', 'LEADS', 'CLICKS', 'IMPRESSIONS'] as const;
const OPERATORS = ['GT', 'LT', 'GTE', 'LTE'] as const;
const ACTIONS = ['INCREASE_BUDGET', 'DECREASE_BUDGET', 'PAUSE', 'RESUME'] as const;
type Metric = (typeof METRICS)[number];
type Op = (typeof OPERATORS)[number];
type Action = (typeof ACTIONS)[number];

export interface RuleInput {
  adAccountId: string;
  name: string;
  metric: string;
  operator: string;
  threshold: number;
  action: string;
  windowDays?: number;
  actionValue?: number | null;
  maxBudget?: number | null;
  minBudget?: number | null;
  cooldownHours?: number;
  enabled?: boolean;
}

interface ActionOutcome {
  entityId: string;
  entityName?: string;
  action: string;
  detail: string;
  ok: boolean;
}

/**
 * Automated ad-scaling rules (Meta). CRUD + an hourly evaluator that, per rule,
 * computes the metric over the trailing window per campaign and applies the
 * action (budget %, pause/resume) when the condition holds — guarded by a
 * per-campaign cooldown so it can't thrash. Every firing is logged to AdRuleLog.
 */
@Injectable()
export class AdRulesService {
  private readonly logger = new Logger(AdRulesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly management: AdManagementService,
  ) {}

  // ──────────────────────────────────────────────────────────────── CRUD

  private validate(input: Partial<RuleInput>) {
    if (input.metric && !METRICS.includes(input.metric as Metric)) {
      throw new BadRequestException(`metric must be one of: ${METRICS.join(', ')}`);
    }
    if (input.operator && !OPERATORS.includes(input.operator as Op)) {
      throw new BadRequestException(`operator must be one of: ${OPERATORS.join(', ')}`);
    }
    if (input.action && !ACTIONS.includes(input.action as Action)) {
      throw new BadRequestException(`action must be one of: ${ACTIONS.join(', ')}`);
    }
    const isBudget = input.action === 'INCREASE_BUDGET' || input.action === 'DECREASE_BUDGET';
    if (isBudget && !(Number(input.actionValue) > 0)) {
      throw new BadRequestException('actionValue (percent > 0) is required for budget actions');
    }
    if (input.windowDays !== undefined && (input.windowDays < 1 || input.windowDays > 90)) {
      throw new BadRequestException('windowDays must be between 1 and 90');
    }
  }

  async create(workspaceId: string, input: RuleInput) {
    this.validate(input);
    const account = await this.prisma.adAccount.findFirst({
      where: { id: input.adAccountId, workspaceId },
      select: { id: true, provider: true },
    });
    if (!account) throw new NotFoundException('Ad account not found');
    if (account.provider !== 'META') {
      throw new BadRequestException('Ad rules are only supported for Meta accounts');
    }
    return this.prisma.adRule.create({
      data: {
        workspaceId,
        adAccountId: input.adAccountId,
        name: input.name,
        metric: input.metric,
        operator: input.operator,
        threshold: input.threshold,
        action: input.action,
        windowDays: input.windowDays ?? 3,
        actionValue: input.actionValue ?? null,
        maxBudget: input.maxBudget ?? null,
        minBudget: input.minBudget ?? null,
        cooldownHours: input.cooldownHours ?? 24,
        enabled: input.enabled ?? true,
      },
    });
  }

  list(workspaceId: string) {
    return this.prisma.adRule.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' } });
  }

  async update(workspaceId: string, id: string, patch: Partial<RuleInput>) {
    const existing = await this.prisma.adRule.findFirst({ where: { id, workspaceId }, select: { id: true } });
    if (!existing) throw new NotFoundException('Rule not found');
    this.validate(patch);
    return this.prisma.adRule.update({
      where: { id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.metric !== undefined ? { metric: patch.metric } : {}),
        ...(patch.operator !== undefined ? { operator: patch.operator } : {}),
        ...(patch.threshold !== undefined ? { threshold: patch.threshold } : {}),
        ...(patch.action !== undefined ? { action: patch.action } : {}),
        ...(patch.windowDays !== undefined ? { windowDays: patch.windowDays } : {}),
        ...(patch.actionValue !== undefined ? { actionValue: patch.actionValue } : {}),
        ...(patch.maxBudget !== undefined ? { maxBudget: patch.maxBudget } : {}),
        ...(patch.minBudget !== undefined ? { minBudget: patch.minBudget } : {}),
        ...(patch.cooldownHours !== undefined ? { cooldownHours: patch.cooldownHours } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      },
    });
  }

  async remove(workspaceId: string, id: string) {
    const existing = await this.prisma.adRule.findFirst({ where: { id, workspaceId }, select: { id: true } });
    if (!existing) throw new NotFoundException('Rule not found');
    await this.prisma.adRule.delete({ where: { id } });
    return { deleted: true };
  }

  listLogs(workspaceId: string, ruleId: string) {
    return this.prisma.adRuleLog.findMany({
      where: { workspaceId, ruleId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  /** Manual "run now" for one rule (returns the actions it took). */
  async runNow(workspaceId: string, ruleId: string) {
    const rule = await this.prisma.adRule.findFirst({ where: { id: ruleId, workspaceId } });
    if (!rule) throw new NotFoundException('Rule not found');
    return { actions: await this.evaluateRule(rule) };
  }

  // ────────────────────────────────────────────────────────────── Evaluator

  @Cron(CronExpression.EVERY_HOUR, { name: 'ad-rules-eval' })
  async evaluateDueRules(): Promise<void> {
    if (!isMetaAdsConfigured()) return;
    await withAdvisoryLock(
      this.prisma,
      'ads:rules-eval',
      async () => {
        const rules = await this.prisma.adRule.findMany({
          where: { enabled: true, account: { provider: 'META', status: 'ACTIVE' } },
          take: 500,
        });
        let fired = 0;
        for (const rule of rules) {
          try {
            const actions = await this.evaluateRule(rule);
            fired += actions.filter((a) => a.ok).length;
          } catch (e) {
            this.logger.error(`rule ${rule.id} eval failed: ${(e as Error)?.message ?? e}`);
          }
        }
        if (fired > 0) this.logger.log(`ad-rules: applied ${fired} action(s) across ${rules.length} rule(s)`);
      },
      this.logger,
    );
  }

  /** Evaluate one rule across its account's campaigns; apply + log matching actions. */
  private async evaluateRule(rule: any): Promise<ActionOutcome[]> {
    const outcomes: ActionOutcome[] = [];
    // Live campaigns (current budget + status + names).
    let campaigns: AdEntityView[];
    try {
      campaigns = await this.management.campaigns(rule.workspaceId, rule.adAccountId);
    } catch (e) {
      await this.touch(rule.id, false);
      throw e;
    }
    const byId = new Map(campaigns.map((c) => [c.id, c]));

    // Trailing-window metrics per campaign from stored insights.
    const since = new Date(Date.now() - rule.windowDays * 86_400_000);
    since.setUTCHours(0, 0, 0, 0);
    const rows = await this.prisma.adMetric.findMany({
      where: { adAccountId: rule.adAccountId, date: { gte: since }, campaignId: { not: '' } },
      select: { campaignId: true, spend: true, impressions: true, clicks: true, leads: true },
    });
    const agg = new Map<string, { spend: number; impressions: number; clicks: number; leads: number }>();
    for (const r of rows) {
      const a = agg.get(r.campaignId) ?? { spend: 0, impressions: 0, clicks: 0, leads: 0 };
      a.spend += Number(r.spend);
      a.impressions += r.impressions;
      a.clicks += r.clicks;
      a.leads += r.leads;
      agg.set(r.campaignId, a);
    }

    const threshold = Number(rule.threshold);
    let triggered = false;
    for (const [campaignId, m] of agg) {
      const value = metricValue(rule.metric, m);
      if (value === null) continue;
      if (!compare(value, rule.operator, threshold)) continue;
      if (await this.inCooldown(rule.id, campaignId, rule.cooldownHours)) continue;
      const campaign = byId.get(campaignId);
      const outcome = await this.applyAction(rule, campaignId, campaign);
      await this.log(rule.workspaceId, rule.id, outcome);
      outcomes.push(outcome);
      if (outcome.ok) triggered = true;
    }
    await this.touch(rule.id, triggered);
    return outcomes;
  }

  private async applyAction(rule: any, campaignId: string, campaign?: AdEntityView): Promise<ActionOutcome> {
    const name = campaign?.name;
    const base = { entityId: campaignId, entityName: name, action: rule.action };
    try {
      if (rule.action === 'PAUSE') {
        if (campaign && campaign.status === 'PAUSED') return { ...base, detail: 'already paused', ok: false };
        await this.management.setStatus(rule.workspaceId, rule.adAccountId, campaignId, 'PAUSED');
        return { ...base, detail: 'paused', ok: true };
      }
      if (rule.action === 'RESUME') {
        if (campaign && campaign.status === 'ACTIVE') return { ...base, detail: 'already active', ok: false };
        await this.management.setStatus(rule.workspaceId, rule.adAccountId, campaignId, 'ACTIVE');
        return { ...base, detail: 'resumed', ok: true };
      }
      // budget actions
      const current = campaign?.dailyBudget;
      if (current === null || current === undefined) {
        return { ...base, detail: 'no campaign daily budget (ABO/lifetime) — skipped', ok: false };
      }
      const pct = Number(rule.actionValue) / 100;
      let next = rule.action === 'INCREASE_BUDGET' ? current * (1 + pct) : current * (1 - pct);
      next = Math.round(next * 100) / 100;
      if (rule.maxBudget != null) next = Math.min(next, Number(rule.maxBudget));
      if (rule.minBudget != null) next = Math.max(next, Number(rule.minBudget));
      if (next <= 0) return { ...base, detail: 'computed budget <= 0 — skipped', ok: false };
      if (next === current) return { ...base, detail: `at budget limit (${current})`, ok: false };
      await this.management.setDailyBudget(rule.workspaceId, rule.adAccountId, campaignId, next);
      return { ...base, detail: `daily_budget ${current} → ${next}`, ok: true };
    } catch (e) {
      return { ...base, detail: (e as Error)?.message?.slice(0, 300) ?? 'action failed', ok: false };
    }
  }

  /** A successful action for (rule, campaign) within cooldownHours blocks re-firing. */
  private async inCooldown(ruleId: string, entityId: string, cooldownHours: number): Promise<boolean> {
    const since = new Date(Date.now() - cooldownHours * 3_600_000);
    const recent = await this.prisma.adRuleLog.findFirst({
      where: { ruleId, entityId, ok: true, createdAt: { gte: since } },
      select: { id: true },
    });
    return !!recent;
  }

  private log(workspaceId: string, ruleId: string, o: ActionOutcome) {
    return this.prisma.adRuleLog
      .create({
        data: {
          workspaceId,
          ruleId,
          entityId: o.entityId,
          entityName: o.entityName ?? null,
          action: o.action,
          detail: o.detail,
          ok: o.ok,
        },
      })
      .catch(() => undefined);
  }

  private touch(ruleId: string, triggered: boolean) {
    return this.prisma.adRule
      .update({
        where: { id: ruleId },
        data: { lastRunAt: new Date(), ...(triggered ? { lastTriggeredAt: new Date() } : {}) },
      })
      .catch(() => undefined);
  }
}

/** Derive the rule metric from aggregated window totals (null = not evaluable). */
function metricValue(
  metric: string,
  m: { spend: number; impressions: number; clicks: number; leads: number },
): number | null {
  switch (metric) {
    case 'SPEND':
      return m.spend;
    case 'CLICKS':
      return m.clicks;
    case 'IMPRESSIONS':
      return m.impressions;
    case 'LEADS':
      return m.leads;
    case 'CTR':
      return m.impressions > 0 ? (m.clicks / m.impressions) * 100 : null;
    case 'CPL':
      // Spent with zero leads → infinite CPL (a "pause me" signal); no spend → skip.
      return m.leads > 0 ? m.spend / m.leads : m.spend > 0 ? Number.POSITIVE_INFINITY : null;
    default:
      return null;
  }
}

function compare(value: number, op: string, threshold: number): boolean {
  switch (op) {
    case 'GT':
      return value > threshold;
    case 'LT':
      return value < threshold;
    case 'GTE':
      return value >= threshold;
    case 'LTE':
      return value <= threshold;
    default:
      return false;
  }
}
