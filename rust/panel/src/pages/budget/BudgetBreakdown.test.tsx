import { expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockFetch, renderAt } from '@/test/render';
import { adsAnswers, breakdown, campaign, stop } from '@/test/ads';

it('shows campaign spend under its item and sends a revisioned stop', async () => {
  const calls = mockFetch({
    ...adsAnswers,
    'POST /api/budget/stop': {
      ...stop,
      revision: 9,
      all: true,
      modules: ['ads'],
      paused: [{ module: 'ads', title: campaign.title, state: 'pausing' }],
    },
  });
  renderAt('/budget');
  expect(await screen.findByRole('link', { name: campaign.title })).toHaveAttribute(
    'href',
    '/ads?campaign=campaign-1',
  );
  await userEvent.click(await screen.findByRole('button', { name: 'Tüm harcamayı durdur' }));
  await waitFor(() =>
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      scope: 'all',
      stopped: true,
      expected_revision: 8,
    }),
  );
  const section = screen.getByRole('region', { name: 'Durdurma' });
  expect(await within(section).findAllByText('Duraklatma bekliyor')).not.toHaveLength(0);
  expect(within(section).getByText('Reklam yönetimi').parentElement).toHaveTextContent('Duraklatma bekliyor');
  expect(within(section).getByText('Reklam yönetimi').parentElement).not.toHaveTextContent('Durduruldu');
});

it('shows confirmed pauses separately from pending provider confirmations', async () => {
  mockFetch({
    ...adsAnswers,
    'GET /api/budget/breakdown': {
      ...breakdown,
      stop: {
        ...stop,
        modules: ['ads'],
        paused: [
          { module: 'ads', title: campaign.title, state: 'paused' },
          { module: 'ads', title: 'İkinci reklam', state: 'pausing' },
        ],
      },
    },
  });
  renderAt('/budget');
  const section = await screen.findByRole('region', { name: 'Durdurma' });
  expect(await within(section).findByText('Durduruldu')).toBeVisible();
  // The stopped module and the campaign that is not confirmed yet; all spending is not stopped.
  expect(within(section).getAllByText('Duraklatma bekliyor')).toHaveLength(2);
  expect(within(section).getByText('Tüm harcama').parentElement).toHaveTextContent('Harcama açık');
});

import { fireEvent } from '@testing-library/react';
import { generalBudget } from '@/test/ads';
import { budgetItems } from '@/test/fixtures';
import tr from '@/i18n/tr.json';
import { formatMoney } from '@/lib/format';

it('requests the chosen period and rejects an inverted range', async () => {
  const calls = mockFetch(adsAnswers);
  renderAt('/budget');
  await screen.findByRole('link', { name: campaign.title });
  fireEvent.change(screen.getByLabelText('Başlangıç günü'), { target: { value: '2026-09-01' } });
  fireEvent.change(screen.getByLabelText('Bitiş günü'), { target: { value: '2026-10-01' } });
  await waitFor(() =>
    expect(calls.filter((c) => c.path === '/api/budget/breakdown').at(-1)?.search).toBe(
      `?from=${encodeURIComponent(new Date('2026-09-01T00:00:00').toISOString())}&until=${encodeURIComponent(new Date('2026-10-01T00:00:00').toISOString())}`,
    ),
  );
  fireEvent.change(screen.getByLabelText('Bitiş günü'), { target: { value: '2026-08-01' } });
  expect(screen.getByText('Bitiş günü başlangıç gününden sonra olmalı.')).toBeVisible();
  expect(screen.queryByRole('link', { name: campaign.title })).not.toBeInTheDocument();
});

it('resumes a module with the latest stop revision', async () => {
  const stopped = {
    ...stop,
    revision: 12,
    modules: ['ads'],
    paused: [{ module: 'ads', title: campaign.title, state: 'paused' }],
  };
  const calls = mockFetch({
    ...adsAnswers,
    'GET /api/budget/breakdown': { ...breakdown, stop: stopped },
    'POST /api/budget/stop': { ...stop, revision: 13 },
  });
  renderAt('/budget');
  await userEvent.click(await screen.findByRole('button', { name: 'Reklam yönetimi: Sürdür' }));
  await waitFor(() =>
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      scope: { module: 'ads' },
      stopped: false,
      expected_revision: 12,
    }),
  );
  expect(await screen.findByRole('button', { name: 'Reklam yönetimi: harcamayı durdur' })).toBeVisible();
});

it('keeps module switches disabled under the global stop', async () => {
  mockFetch({
    ...adsAnswers,
    'GET /api/budget/breakdown': { ...breakdown, stop: { ...stop, all: true, modules: ['ads'] } },
  });
  renderAt('/budget');
  expect(await screen.findByRole('button', { name: 'Tüm harcama: Sürdür' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Reklam yönetimi: Sürdür' })).toBeDisabled();
});

it('offers the general checkbox only for a recurring currency ad budget and submits it', async () => {
  const calls = mockFetch({ ...adsAnswers, 'POST /api/budget/items': generalBudget });
  renderAt('/budget');
  await userEvent.click(await screen.findByRole('button', { name: tr.budget.create }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).queryByRole('checkbox', { name: 'Genel reklam bütçesi' })).not.toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole('combobox', { name: tr.fields.kind }));
  await userEvent.click(await screen.findByRole('option', { name: tr.budget.kinds.ad_budget }));
  await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Genel reklam bütçesi' }));
  await userEvent.click(within(dialog).getByRole('combobox', { name: tr.fields.period }));
  await userEvent.click(await screen.findByRole('option', { name: tr.budget.periods.total }));
  expect(within(dialog).queryByRole('checkbox', { name: 'Genel reklam bütçesi' })).not.toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole('combobox', { name: tr.fields.period }));
  await userEvent.click(await screen.findByRole('option', { name: tr.budget.periods.monthly }));
  await userEvent.type(within(dialog).getByLabelText(tr.fields.name, { exact: false }), 'Genel reklam');
  await userEvent.type(within(dialog).getByLabelText(tr.budget.dialog.cap, { exact: false }), '5.000');
  await userEvent.click(within(dialog).getByRole('button', { name: tr.budget.dialog.submit }));
  await waitFor(() =>
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      name: 'Genel reklam',
      kind: 'ad_budget',
      unit: { kind: 'currency', value: 'TRY' },
      cap: 500000,
      period: 'monthly',
      general: true,
    }),
  );
});

it('clears the general designation when changing its period to total', async () => {
  const calls = mockFetch({
    ...adsAnswers,
    [`PATCH /api/budget/items/${generalBudget.item.id}`]: generalBudget,
  });
  renderAt('/budget');
  await userEvent.click(await screen.findByRole('button', { name: tr.budget.actions.edit }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByRole('checkbox', { name: 'Genel reklam bütçesi' })).toBeChecked();
  await userEvent.click(within(dialog).getByRole('combobox', { name: tr.fields.period }));
  await userEvent.click(await screen.findByRole('option', { name: tr.budget.periods.total }));
  await userEvent.click(within(dialog).getByRole('button', { name: tr.common.save }));
  await waitFor(() =>
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ period: 'total', general: false }),
  );
});

it('does not offer the general flag on a cash item', async () => {
  mockFetch({ ...adsAnswers, 'GET /api/budget/items': [budgetItems[1]] });
  renderAt('/budget');
  await userEvent.click(await screen.findByRole('button', { name: tr.budget.actions.edit }));
  expect(
    within(screen.getByRole('dialog')).queryByRole('checkbox', { name: 'Genel reklam bütçesi' }),
  ).not.toBeInTheDocument();
});

it('says what open ad campaigns hold of the general ad budget', async () => {
  mockFetch({
    ...adsAnswers,
    'GET /api/budget/breakdown': {
      ...breakdown,
      items: [{ ...breakdown.items[0], held_minor: 175000 }],
    },
  });
  renderAt('/budget');
  const label = await screen.findByText('Açık reklam kampanyalarına ayrılan (başka kampanya alamaz)');
  expect(label.parentElement).toHaveTextContent(formatMoney(175000, 'TRY', 'tr'));
});
