import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import tr from '@/i18n/tr.json';
import type { BudgetItemOut } from '@/api/types';
import { formatDateTime } from '@/lib/format';
import { BUDGET_ITEM_ID, CASH_ITEM_ID, budgetItems, me, spend } from '@/test/fixtures';
import { mockFetch, renderAt } from '@/test/render';

const RETIRED_ID = '0190a000-0000-7000-8000-000000000063';
const RETIRED_AT = '2026-10-01T08:00:00Z';

/** The fixtures and one item retired on 1 October. */
const withRetired: BudgetItemOut[] = [
  ...budgetItems,
  {
    item: { ...budgetItems[1].item, id: RETIRED_ID, name: 'Eylül kasası', retired_at: RETIRED_AT },
    spent_in_period: 0,
    remaining: 50000,
  },
];

/** The table row showing `name`. */
async function rowOf(name: string): Promise<HTMLElement> {
  return (await screen.findByText(name)).closest('tr') as HTMLElement;
}

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

  it('edits an item, sending only what changed, the cap in minor units', async () => {
    const user = userEvent.setup();
    const cash = budgetItems[1];
    const calls = mockFetch({
      'GET /api/auth/me': me,
      'GET /api/budget/items': budgetItems,
      [`PATCH /api/budget/items/${CASH_ITEM_ID}`]: {
        ...cash,
        item: { ...cash.item, name: 'Saha', cap: 75050, period: 'weekly' },
      },
    });
    renderAt('/budget');
    await user.click(within(await rowOf('Saha giderleri')).getByRole('button', { name: tr.budget.actions.edit }));
    const dialog = await screen.findByRole('dialog');
    const name = within(dialog).getByLabelText(tr.fields.name, { exact: false });
    expect(name).toHaveValue('Saha giderleri');
    const save = within(dialog).getByRole('button', { name: tr.common.save });
    expect(save).toBeDisabled();
    await user.clear(name);
    await user.type(name, 'Saha');
    const cap = within(dialog).getByLabelText(tr.budget.dialog.cap, { exact: false });
    await user.clear(cap);
    await user.type(cap, '750,50');
    await user.click(within(dialog).getByRole('combobox', { name: tr.fields.period }));
    await user.click(await screen.findByRole('option', { name: tr.budget.periods.weekly }));
    await user.click(save);
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({
        name: 'Saha',
        cap: 75050,
        period: 'weekly',
      }),
    );
    expect(await screen.findByText(tr.budget.editDialog.saved)).toBeInTheDocument();
  });

  it('retires an item once confirmed, and shows retired items greyed with their date', async () => {
    const user = userEvent.setup();
    const calls = mockFetch({
      'GET /api/auth/me': me,
      'GET /api/budget/items': withRetired,
      [`POST /api/budget/items/${CASH_ITEM_ID}/retire`]: {
        ...budgetItems[1],
        item: { ...budgetItems[1].item, retired_at: '2026-10-22T09:00:00Z' },
      },
    });
    renderAt('/budget');

    // A retired item: greyed, its date shown, nothing to edit or retire.
    const retired = await rowOf('Eylül kasası');
    expect(retired).toHaveAttribute('data-retired', 'true');
    expect(
      within(retired).getByText(tr.budget.retiredOn.replace('{{date}}', formatDateTime(RETIRED_AT, 'tr'))),
    ).toBeInTheDocument();
    expect(within(retired).queryByRole('button', { name: tr.budget.actions.edit })).not.toBeInTheDocument();
    expect(within(retired).queryByRole('button', { name: tr.budget.actions.retire })).not.toBeInTheDocument();
    expect(await rowOf('Saha giderleri')).not.toHaveAttribute('data-retired');

    // Retiring asks first, saying what stops; cancelling sends nothing.
    await user.click(within(await rowOf('Saha giderleri')).getByRole('button', { name: tr.budget.actions.retire }));
    let dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(tr.budget.retireDialog.body.replace('{{name}}', 'Saha giderleri')),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: tr.common.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    await user.click(within(await rowOf('Saha giderleri')).getByRole('button', { name: tr.budget.actions.retire }));
    dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: tr.budget.actions.retire }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')).toMatchObject({
        path: `/api/budget/items/${CASH_ITEM_ID}/retire`,
        body: { confirm: true },
      }),
    );
    expect(await screen.findByText(tr.budget.retireDialog.retired)).toBeInTheDocument();
  });

  it('shows a retired item’s spend but takes no more', async () => {
    const user = userEvent.setup();
    mockFetch({
      'GET /api/auth/me': me,
      'GET /api/budget/items': withRetired,
      [`GET /api/budget/items/${RETIRED_ID}/spend`]: [],
    });
    renderAt('/budget');
    await user.click(within(await rowOf('Eylül kasası')).getByRole('button', { name: tr.budget.spend }));
    const sheet = await screen.findByRole('dialog');
    expect(await within(sheet).findByText(tr.budget.spendSheet.retired)).toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: tr.budget.spendSheet.record })).not.toBeInTheDocument();
  });
});
