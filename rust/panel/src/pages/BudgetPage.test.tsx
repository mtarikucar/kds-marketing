import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import tr from '@/i18n/tr.json';
import { BUDGET_ITEM_ID, budgetItems, me, spend } from '@/test/fixtures';
import { mockFetch, renderAt } from '@/test/render';

describe('BudgetPage', () => {
  it('lists the items and flags one over its cap', async () => {
    mockFetch({ 'GET /api/auth/me': me, 'GET /api/budget/items': budgetItems });
    renderAt('/budget');
    expect(await screen.findByRole('heading', { level: 1, name: tr.budget.title })).toBeInTheDocument();
    expect(await screen.findByText('Ekim kampanyası')).toBeInTheDocument();
    expect(screen.getByText(tr.budget.overCap)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: tr.budget.create })).toBeInTheDocument();
  });

  it('shows the spend history and records spend in minor units', async () => {
    const user = userEvent.setup();
    const calls = mockFetch({
      'GET /api/auth/me': me,
      'GET /api/budget/items': budgetItems,
      [`GET /api/budget/items/${BUDGET_ITEM_ID}/spend`]: spend,
      [`POST /api/budget/items/${BUDGET_ITEM_ID}/spend`]: { spend: spend[0], remaining: -26250 },
    });
    renderAt('/budget');
    const row = (await screen.findByText('Ekim kampanyası')).closest('tr') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: tr.budget.spend }));
    const sheet = await screen.findByRole('dialog');
    expect(await within(sheet).findByText('FTR-2026-001')).toBeInTheDocument();
    await user.type(within(sheet).getByLabelText(tr.fields.amount, { exact: false }), '12.50');
    await user.type(within(sheet).getByLabelText(tr.fields.reference, { exact: false }), 'FTR-2');
    await user.click(within(sheet).getByRole('button', { name: tr.budget.spendSheet.record }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ amount: 1250, reference: 'FTR-2' }),
    );
  });
});
