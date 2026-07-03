/** weeklyPlan.service.ts — one-click weekly planner (Faz C, Growth Studio). */
import marketingApi from './marketingApi';

export type PlanItemType = 'SOCIAL_POST' | 'CONTENT_IDEA' | 'CAMPAIGN' | 'TREND_REMIX';
export type PlanItemStatus = 'DRAFT' | 'APPROVED' | 'DISCARDED' | 'SCHEDULED';

export interface WeeklyPlanItem {
  id: string;
  day: string;
  type: PlanItemType;
  channel: string | null;
  title: string;
  draft: string | null;
  estCost: string;
  status: PlanItemStatus;
}

export interface BudgetBreakdown {
  weeklyBudget: number | null;
  adSpend: number;
  contentGen: number;
  conversations: number;
  total: number;
  overBudget: boolean;
}

export interface WeeklyPlan {
  id: string;
  weekStart: string;
  status: string;
  budgetTotal: string | null;
  budgetBreakdown: BudgetBreakdown | null;
  items: WeeklyPlanItem[];
}

export const generateWeeklyPlan = (weekStart?: string) =>
  marketingApi.post<WeeklyPlan>('/weekly-plan/generate', weekStart ? { weekStart } : {}).then((r) => r.data);

export const getWeeklyPlan = (id: string) =>
  marketingApi.get<WeeklyPlan>(`/weekly-plan/${id}`).then((r) => r.data);

export const decidePlanItem = (id: string, decision: 'approve' | 'discard') =>
  marketingApi.post(`/weekly-plan/items/${id}/${decision}`).then((r) => r.data);
