import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import StudioCalendarTab from './StudioCalendarTab';
import * as plan from '../../../features/marketing/api/weeklyPlan.service';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, o?: string) => (typeof o === 'string' ? o : k) }) }));
vi.mock('../../../features/marketing/api/weeklyPlan.service', () => ({ generateWeeklyPlan: vi.fn(), decidePlanItem: vi.fn() }));
vi.mock('../../../features/marketing/api/contentCalendar.service', () => ({ listContentCalendar: vi.fn().mockResolvedValue([]) }));

const PLAN = {
  id: 'wp1', weekStart: '2026-07-06', status: 'DRAFT', budgetTotal: '1000',
  budgetBreakdown: { weeklyBudget: 1000, adSpend: 600, contentGen: 180, conversations: 50, total: 830, overBudget: false },
  items: [{ id: 'i1', day: '2026-07-06', type: 'SOCIAL_POST', channel: 'INSTAGRAM', title: 'Tip post', draft: 'A tip', estCost: '30', status: 'DRAFT' }],
};

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><StudioCalendarTab /></MemoryRouter></QueryClientProvider>);
}

describe('StudioCalendarTab', () => {
  beforeEach(() => vi.clearAllMocks());
  it('generates a weekly plan and shows the budget analysis + draft items', async () => {
    (plan.generateWeeklyPlan as any).mockResolvedValue(PLAN);
    renderTab();
    fireEvent.click(await screen.findByText('Generate weekly plan'));
    expect(await screen.findByText('Budget analysis (this week)')).toBeInTheDocument();
    expect(screen.getByText('Tip post')).toBeInTheDocument();
    expect(plan.generateWeeklyPlan).toHaveBeenCalled();
  });
});
