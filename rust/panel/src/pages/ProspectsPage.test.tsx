import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import tr from '@/i18n/tr.json';
import { delayed, mockFetch, renderAt, withStatus } from '@/test/render';
import { LOADED, leadsMe, prospectId, row, task } from '@/test/leads';

const NEXT = { before_at: '2026-11-01T09:02:00Z', before_id: prospectId(2) };

function answers(extra: Record<string, unknown> = {}) {
  return {
    'GET /api/auth/me': leadsMe,
    'GET /api/research/tasks': { items: [{ task: task(1), remaining_today: 8 }], next: null },
    'GET /api/prospects': { items: [row(1), row(2), row(3, { status: 'new', latest_score: null, bucket: null })], next: NEXT },
    ...extra,
  };
}

const listCalls = (calls: { path: string; method: string; search: string }[]) =>
  calls.filter((c) => c.method === 'GET' && c.path === '/api/prospects').map((c) => new URLSearchParams(c.search));

describe('ProspectsPage', () => {
  it('filters_and_paging', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(answers());
    renderAt('/prospects');
    expect(await screen.findByRole('link', { name: 'Örnek Kafe 1' }, LOADED)).toHaveAttribute('href', `/prospects/${prospectId(1)}`);

    await user.selectOptions(screen.getByRole('combobox', { name: tr.leads.prospects.filters.status }), 'qualified');
    await user.selectOptions(screen.getByRole('combobox', { name: tr.leads.prospects.filters.bucket }), '75-100');
    expect(screen.queryByRole('textbox', { name: tr.leads.prospects.filters.city })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /More filters|Diğer filtreler/ }));
    await screen.findByRole('option', { name: 'Strateji görevi · kafeler_izmir' }, LOADED);
    await user.selectOptions(screen.getByRole('combobox', { name: tr.leads.prospects.filters.task }), task(1).id);
    await user.click(screen.getByRole('textbox', { name: tr.leads.prospects.filters.city }));
    await user.paste('İzmir');
    await user.click(screen.getByRole('textbox', { name: tr.leads.prospects.filters.segment }));
    await user.paste('kafeler');
    await waitFor(() => {
      const q = listCalls(calls).at(-1)!;
      expect(q.get('status')).toBe('qualified');
      expect(q.get('bucket')).toBe('75-100');
      expect(q.get('research_task_id')).toBe(task(1).id);
      expect(q.get('city')).toBe('İzmir');
      expect(q.get('segment_key')).toBe('kafeler');
      expect(q.get('limit')).toBe('50');
      expect(q.get('before_id')).toBeNull();
    });

    // The next page continues from the previous page's cursor, keeping the filters.
    expect(screen.getByRole('button', { name: tr.leads.prospects.previous })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: tr.leads.prospects.next }));
    await waitFor(() => {
      const q = listCalls(calls).at(-1)!;
      expect(q.get('before_id')).toBe(NEXT.before_id);
      expect(q.get('before_at')).toBe(NEXT.before_at);
      expect(q.get('status')).toBe('qualified');
    });
    // Back to the first page, and a changed filter starts from the first page again.
    await user.click(screen.getByRole('button', { name: tr.leads.prospects.previous }));
    await waitFor(() => expect(listCalls(calls).at(-1)!.get('before_id')).toBeNull());
    await user.click(screen.getByRole('button', { name: tr.leads.prospects.next }));
    await waitFor(() => expect(listCalls(calls).at(-1)!.get('before_id')).toBe(NEXT.before_id));
    await user.selectOptions(screen.getByRole('combobox', { name: tr.leads.prospects.filters.status }), 'new');
    await waitFor(() => {
      const q = listCalls(calls).at(-1)!;
      expect(q.get('status')).toBe('new');
      expect(q.get('before_id')).toBeNull();
    });
    // Many steps, each a render of the table: more time than one interaction needs.
  }, 15_000);

  it('keeps a task filter visible when opened from a research task', async () => {
    const calls = mockFetch(answers());
    renderAt(`/prospects?task=${task(1).id}`);
    const taskFilter = await screen.findByRole('combobox', { name: tr.leads.prospects.filters.task }, LOADED);
    expect(taskFilter).toHaveValue(task(1).id);
    await waitFor(() => expect(listCalls(calls).at(-1)!.get('research_task_id')).toBe(task(1).id));
  });

  it('clears filters when no prospects match', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(answers({ 'GET /api/prospects': { items: [], next: null } }));
    renderAt('/prospects');
    await screen.findByText(tr.leads.prospects.empty, {}, LOADED);
    const status = screen.getByRole('combobox', { name: tr.leads.prospects.filters.status });
    await user.click(screen.getByRole('button', { name: /More filters|Diğer filtreler/ }));
    const city = screen.getByRole('textbox', { name: tr.leads.prospects.filters.city });
    await user.selectOptions(status, 'qualified');
    await user.type(city, 'Izmir');
    const title = await screen.findByText(tr.leads.filteredEmpty.title);
    const empty = title.parentElement!.parentElement!;
    expect(within(empty).queryByRole('link', { name: tr.leads.prospects.tasksLink })).not.toBeInTheDocument();
    await waitFor(() => expect(listCalls(calls).at(-1)!.get('city')).toBe('Izmir'));
    await user.click(within(empty).getByRole('button', { name: tr.leads.filteredEmpty.clear }));
    expect(status).toHaveValue('');
    expect(city).toHaveValue('');
    await waitFor(() => {
      expect(listCalls(calls).at(-1)!.get('status')).toBeNull();
      expect(listCalls(calls).at(-1)!.get('city')).toBeNull();
    });
    expect(await screen.findByText(tr.leads.prospects.empty)).toBeInTheDocument();
  });

  it('bulk_promote_shows_per_item_outcomes', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(
      answers({
        'POST /api/prospects/promote': {
          items: [
            {
              outcome: 'promoted',
              prospect_id: prospectId(1),
              person_id: 'person-1',
              journey_id: 'journey-1',
              created_person: true,
              owner_id: null,
            },
            { outcome: 'refused', prospect_id: prospectId(2), reason: 'daily_cap', details: {} },
          ],
        },
      }),
    );
    renderAt('/prospects');
    await user.click(await screen.findByRole('checkbox', { name: 'Örnek Kafe 1 seç' }, LOADED));
    await user.click(screen.getByRole('checkbox', { name: 'Örnek Kafe 2 seç' }));
    const bar = screen.getByRole('toolbar', { name: tr.leads.bulk.label });
    await user.click(within(bar).getByRole('button', { name: tr.leads.bulk.promote }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/api/prospects/promote')?.body).toMatchObject({
        prospect_ids: [prospectId(1), prospectId(2)],
      }),
    );
    expect(typeof (calls.find((c) => c.path === '/api/prospects/promote')?.body as { request_key: unknown }).request_key).toBe(
      'string',
    );
    const results = await screen.findByRole('list', { name: tr.leads.bulk.results });
    const items = within(results).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Örnek Kafe 1');
    expect(items[0]).toHaveTextContent(tr.leads.outcome.promoted);
    expect(items[0]).toHaveAttribute('data-ok', 'true');
    expect(items[1]).toHaveTextContent('Örnek Kafe 2');
    expect(items[1]).toHaveTextContent(tr.leads.promoteRefused.daily_cap);
    expect(items[1]).toHaveAttribute('data-ok', 'false');
  });

  it('each_row_promote_has_its_own_pending_state', async () => {
    const user = userEvent.setup();
    mockFetch(
      answers({
        'POST /api/prospects/promote': delayed(500, {
          items: [{ outcome: 'already_promoted', prospect_id: prospectId(1), person_id: 'p', journey_id: 'j' }],
        }),
      }),
    );
    renderAt('/prospects');
    await screen.findByRole('link', { name: 'Örnek Kafe 1' }, LOADED);
    const [first, second] = screen.getAllByRole('button', { name: tr.leads.actions.promote });
    await user.click(first);
    await waitFor(() => expect(first).toBeDisabled());
    expect(second).toBeEnabled();
  });

  it('a_retried_promotion_reuses_its_request_key', async () => {
    const user = userEvent.setup();
    // The answer is lost (a server error): the retry carries the same key, so it replays.
    const failing = mockFetch(
      answers({ 'POST /api/prospects/promote': withStatus(500, { code: 'INTERNAL', message: 'boom', details: {} }) }),
    );
    renderAt('/prospects');
    await screen.findByRole('link', { name: 'Örnek Kafe 1' }, LOADED);
    const [first] = screen.getAllByRole('button', { name: tr.leads.actions.promote });
    await user.click(first);
    await waitFor(() => expect(failing.filter((c) => c.path === '/api/prospects/promote')).toHaveLength(1));
    await waitFor(() => expect(first).toBeEnabled());
    await user.click(first);
    await waitFor(() => expect(failing.filter((c) => c.path === '/api/prospects/promote')).toHaveLength(2));
    const [a, b] = failing.filter((c) => c.path === '/api/prospects/promote').map((c) => (c.body as { request_key: string }).request_key);
    expect(a).toBe(b);
  });

  it('reject_from_a_row_needs_a_reason', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(answers({ [`POST /api/prospects/${prospectId(1)}/decision`]: { prospect: {}, flags: [] } }));
    renderAt('/prospects');
    await screen.findByRole('link', { name: 'Örnek Kafe 1' }, LOADED);
    await user.click(screen.getAllByRole('button', { name: tr.leads.actions.reject })[0]);
    const dialog = await screen.findByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: tr.leads.reject.submit });
    expect(submit).toBeDisabled();
    await user.selectOptions(within(dialog).getByRole('combobox', { name: tr.leads.reject.reason }), 'not_icp');
    await user.click(submit);
    await waitFor(() =>
      expect(calls.find((c) => c.path === `/api/prospects/${prospectId(1)}/decision`)?.body).toEqual({
        decision: 'reject',
        reason: 'not_icp',
        expected_revision: 3,
      }),
    );
  });
});
