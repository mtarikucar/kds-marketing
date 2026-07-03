import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

export type PlanItemType = 'SOCIAL_POST' | 'CONTENT_IDEA' | 'CAMPAIGN' | 'TREND_REMIX';

export interface DraftItem {
  dayOffset: number; // 0=Mon … 6=Sun
  type: PlanItemType;
  channel?: string;
  title: string;
  draft?: string;
  estCost: number;
}

export interface PlanContext {
  channels: string[];
  trends: { title: string | null; hookPattern: string | null }[];
  brandName: string;
}

export interface BudgetBreakdown {
  weeklyBudget: number | null;
  adSpend: number;
  contentGen: number;
  conversations: number;
  total: number;
  overBudget: boolean;
}

// Deterministic per-item cost estimates (TRY). LLM enrichment can refine the
// drafts later; the STRUCTURE + budget math are deterministic and testable.
const COST = { SOCIAL_POST: 30, TREND_REMIX: 30, CAMPAIGN: 50, CONTENT_IDEA: 0 } as const;
const AD_SPEND_SHARE = 0.6; // recommend ~60% of the weekly budget to paid boost

/** Monday (UTC midnight) of the week containing `d`. */
export function weekStartOf(d: Date): Date {
  const day = d.getUTCDay(); // 0=Sun
  const diff = (day + 6) % 7; // days since Monday
  const mon = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diff));
  return mon;
}

/**
 * Pure: build a week of draft items from the brand context. A steady cadence
 * (5 social posts + 1 campaign + 1 content idea + a trend remix when trends
 * exist), rotating through the connected channels.
 */
export function buildPlanItems(ctx: PlanContext): DraftItem[] {
  const channels = ctx.channels.length ? ctx.channels : ['INSTAGRAM', 'FACEBOOK'];
  const ch = (i: number) => channels[i % channels.length];
  const items: DraftItem[] = [];

  // Social posts Mon/Tue/Thu/Fri/Sat.
  const socialDays = [0, 1, 3, 4, 5];
  socialDays.forEach((dayOffset, i) => {
    items.push({
      dayOffset,
      type: 'SOCIAL_POST',
      channel: ch(i),
      title: `${ctx.brandName} — ${['tip', 'behind-the-scenes', 'social proof', 'offer', 'FAQ'][i % 5]} post`,
      draft: `A ${ch(i)} post for ${ctx.brandName}: ${['share a quick tip', 'show behind the scenes', 'highlight a happy customer', 'run a limited offer', 'answer a common question'][i % 5]}.`,
      estCost: COST.SOCIAL_POST,
    });
  });

  // A trend remix (Wed) when a trend is available.
  if (ctx.trends.length) {
    const tr = ctx.trends[0];
    items.push({
      dayOffset: 2,
      type: 'TREND_REMIX',
      channel: ch(1),
      title: `Trend remix: ${tr.title ?? 'trending format'}`,
      draft: `Adapt the format "${tr.hookPattern ?? tr.title ?? 'trending hook'}" onto ${ctx.brandName} — abstract structure only, never a copy.`,
      estCost: COST.TREND_REMIX,
    });
  }

  // One campaign (Wed email) + one content idea (Sun).
  items.push({ dayOffset: 2, type: 'CAMPAIGN', channel: 'EMAIL', title: `${ctx.brandName} weekly email`, draft: `A short value email to your list.`, estCost: COST.CAMPAIGN });
  items.push({ dayOffset: 6, type: 'CONTENT_IDEA', title: `Content idea: plan next week's theme`, estCost: COST.CONTENT_IDEA });

  return items;
}

/** Pure: analyze the week's item costs against the weekly budget slice. */
export function analyzeBudget(items: DraftItem[], weeklyBudget: number | null): BudgetBreakdown {
  const sum = (types: PlanItemType[]) => Math.round(items.filter((i) => types.includes(i.type)).reduce((s, i) => s + i.estCost, 0) * 100) / 100;
  const contentGen = sum(['SOCIAL_POST', 'TREND_REMIX']);
  const conversations = sum(['CAMPAIGN']);
  const adSpend = weeklyBudget != null ? Math.round(weeklyBudget * AD_SPEND_SHARE * 100) / 100 : 0;
  const total = Math.round((adSpend + contentGen + conversations) * 100) / 100;
  const overBudget = weeklyBudget != null && total > weeklyBudget;
  return { weeklyBudget, adSpend, contentGen, conversations, total, overBudget };
}

@Injectable()
export class WeeklyPlannerService {
  private readonly logger = new Logger(WeeklyPlannerService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Generate (or regenerate) the plan for the week containing `weekStart`. */
  async generate(workspaceId: string, weekStartInput?: string) {
    const base = weekStartInput ? new Date(weekStartInput) : new Date();
    if (Number.isNaN(base.getTime())) throw new BadRequestException('invalid weekStart');
    const weekStart = weekStartOf(base);

    const [budget, accounts, trends] = await Promise.all([
      this.prisma.growthBudget.findFirst({ where: { workspaceId, status: 'ACTIVE' }, orderBy: { periodKey: 'desc' }, select: { totalAmount: true } }),
      this.prisma.socialAccount.findMany({ where: { workspaceId }, select: { network: true } }),
      this.prisma.trendTemplate.findMany({ where: { workspaceId, status: 'ACTIVE' }, orderBy: { createdAt: 'desc' }, take: 3, select: { title: true, hookPattern: true } }),
    ]);

    const channels = [...new Set(accounts.map((a) => a.network))];
    const weeklyBudget = budget ? budget.totalAmount.toNumber() / 4.345 : null;
    const items = buildPlanItems({ channels, trends, brandName: 'your brand' });
    const breakdown = analyzeBudget(items, weeklyBudget);

    const plan = await this.prisma.$transaction(async (tx) => {
      const p = await tx.weeklyPlan.upsert({
        where: { workspaceId_weekStart: { workspaceId, weekStart } },
        create: { workspaceId, weekStart, budgetTotal: weeklyBudget != null ? new Prisma.Decimal(round2(weeklyBudget)) : null, budgetBreakdown: breakdown as unknown as Prisma.InputJsonValue },
        update: { budgetTotal: weeklyBudget != null ? new Prisma.Decimal(round2(weeklyBudget)) : null, budgetBreakdown: breakdown as unknown as Prisma.InputJsonValue, status: 'DRAFT' },
        select: { id: true },
      });
      await tx.weeklyPlanItem.deleteMany({ where: { planId: p.id } });
      await tx.weeklyPlanItem.createMany({
        data: items.map((it) => ({
          workspaceId,
          planId: p.id,
          day: addDays(weekStart, it.dayOffset),
          type: it.type,
          channel: it.channel ?? null,
          title: it.title,
          draft: it.draft ?? null,
          estCost: new Prisma.Decimal(it.estCost),
        })),
      });
      return p;
    });

    this.logger.log(`weekly-plan generated for ${workspaceId} week ${weekStart.toISOString().slice(0, 10)} (${items.length} items)`);
    return this.get(workspaceId, plan.id);
  }

  async get(workspaceId: string, id: string) {
    const plan = await this.prisma.weeklyPlan.findFirst({
      where: { id, workspaceId },
      include: { items: { orderBy: [{ day: 'asc' }, { createdAt: 'asc' }] } },
    });
    if (!plan) throw new NotFoundException('Weekly plan not found');
    return plan;
  }

  async decideItem(workspaceId: string, itemId: string, status: 'APPROVED' | 'DISCARDED') {
    const item = await this.prisma.weeklyPlanItem.findFirst({ where: { id: itemId, workspaceId }, select: { id: true } });
    if (!item) throw new NotFoundException('Plan item not found');
    return this.prisma.weeklyPlanItem.update({ where: { id: itemId }, data: { status } });
  }
}

function addDays(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n));
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
