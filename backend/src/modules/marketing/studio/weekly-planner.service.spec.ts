import { Prisma } from '@prisma/client';
import { NotFoundException } from '@nestjs/common';
import { WeeklyPlannerService, weekStartOf, buildPlanItems, analyzeBudget } from './weekly-planner.service';

describe('weekStartOf', () => {
  it('returns the Monday (UTC) of the week', () => {
    expect(weekStartOf(new Date('2026-07-10T15:00:00Z')).toISOString().slice(0, 10)).toBe('2026-07-06'); // Fri -> Mon
    expect(weekStartOf(new Date('2026-07-06T00:00:00Z')).toISOString().slice(0, 10)).toBe('2026-07-06'); // Mon -> Mon
    expect(weekStartOf(new Date('2026-07-05T23:00:00Z')).toISOString().slice(0, 10)).toBe('2026-06-29'); // Sun -> prev Mon
  });
});

describe('buildPlanItems', () => {
  it('produces a steady cadence and rotates channels', () => {
    const items = buildPlanItems({ channels: ['INSTAGRAM', 'FACEBOOK'], trends: [{ title: 'Hook', hookPattern: 'Think [x]?' }], brandName: 'Acme' });
    const social = items.filter((i) => i.type === 'SOCIAL_POST');
    expect(social).toHaveLength(5);
    expect(items.some((i) => i.type === 'TREND_REMIX')).toBe(true);
    expect(items.some((i) => i.type === 'CAMPAIGN')).toBe(true);
    expect(items.some((i) => i.type === 'CONTENT_IDEA')).toBe(true);
    // channels rotate across social posts
    expect(new Set(social.map((s) => s.channel))).toEqual(new Set(['INSTAGRAM', 'FACEBOOK']));
  });

  it('omits the trend remix when there are no trends and defaults channels', () => {
    const items = buildPlanItems({ channels: [], trends: [], brandName: 'Acme' });
    expect(items.some((i) => i.type === 'TREND_REMIX')).toBe(false);
    expect(items.filter((i) => i.type === 'SOCIAL_POST').every((i) => ['INSTAGRAM', 'FACEBOOK'].includes(i.channel!))).toBe(true);
  });
});

describe('analyzeBudget', () => {
  const items = buildPlanItems({ channels: ['INSTAGRAM'], trends: [{ title: 'T', hookPattern: null }], brandName: 'Acme' });

  it('splits ad-spend / content-gen / conversations and flags over-budget', () => {
    // content = 5 social*30 + 1 trend*30 = 180; conversations = 1 campaign*50 = 50
    const b = analyzeBudget(items, 1000);
    expect(b.contentGen).toBe(180);
    expect(b.conversations).toBe(50);
    expect(b.adSpend).toBe(600); // 60% of 1000
    expect(b.total).toBe(830);
    expect(b.overBudget).toBe(false);
  });

  it('flags over-budget when the plan exceeds a small weekly budget', () => {
    const b = analyzeBudget(items, 200); // adSpend 120 + 180 + 50 = 350 > 200
    expect(b.overBudget).toBe(true);
  });

  it('has no ad-spend and never over-budget when there is no budget', () => {
    const b = analyzeBudget(items, null);
    expect(b.adSpend).toBe(0);
    expect(b.weeklyBudget).toBeNull();
    expect(b.overBudget).toBe(false);
  });
});

describe('WeeklyPlannerService', () => {
  function makePrisma() {
    const upsert = jest.fn().mockResolvedValue({ id: 'plan-1' });
    const deleteMany = jest.fn().mockResolvedValue({ count: 0 });
    const createMany = jest.fn().mockResolvedValue({ count: 8 });
    const tx = { weeklyPlan: { upsert }, weeklyPlanItem: { deleteMany, createMany } };
    const prisma = {
      growthBudget: { findFirst: jest.fn().mockResolvedValue({ totalAmount: new Prisma.Decimal(4345) }) },
      socialAccount: { findMany: jest.fn().mockResolvedValue([{ network: 'INSTAGRAM' }, { network: 'FACEBOOK' }]) },
      trendTemplate: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn(async (cb: any) => cb(tx)),
      weeklyPlan: { findFirst: jest.fn().mockResolvedValue({ id: 'plan-1', items: [] }) },
    } as any;
    return { prisma, upsert, createMany };
  }

  it('generates a plan: persists the budget breakdown + items', async () => {
    const { prisma, upsert, createMany } = makePrisma();
    const svc = new WeeklyPlannerService(prisma);
    await svc.generate('ws1', '2026-07-10');
    const created = upsert.mock.calls[0][0].create;
    // weeklyBudget = 4345 / 4.345 = 1000; adSpend 600
    expect(created.budgetBreakdown.adSpend).toBe(600);
    expect(created.budgetBreakdown.weeklyBudget).toBeCloseTo(1000, 0);
    expect(createMany.mock.calls[0][0].data.length).toBeGreaterThanOrEqual(7);
    // items are dated within the week (Mon 2026-07-06 …)
    expect(createMany.mock.calls[0][0].data[0].day.toISOString().slice(0, 10) >= '2026-07-06').toBe(true);
  });

  it('decideItem 404s an item from another workspace', async () => {
    const { prisma } = makePrisma();
    prisma.weeklyPlanItem = { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() };
    const svc = new WeeklyPlannerService(prisma);
    await expect(svc.decideItem('ws1', 'x', 'APPROVED')).rejects.toBeInstanceOf(NotFoundException);
  });
});
