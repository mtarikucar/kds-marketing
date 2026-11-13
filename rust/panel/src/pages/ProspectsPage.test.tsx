import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import tr from '@/i18n/tr.json';
import { mockFetch, renderAt, withStatus } from '@/test/render';
import { LOADED, agentsList, leadsMe, playbook, prospect, prospectId, prospectOut, row, task, team } from '@/test/leads';
import { segmentOptions } from './ProspectsPage';

const NEXT = { before_at: '2026-11-01T09:02:00Z', before_id: prospectId(2) };

function answers(extra: Record<string, unknown> = {}) {
  return {
    'GET /api/auth/me': leadsMe,
    'GET /api/agents': agentsList,
    'GET /api/team': team,
    'GET /api/research/tasks': { items: [{ task: task(1), remaining_today: 8 }], next: null },
    'GET /api/prospects': { items: [row(1), row(2), row(3, { status: 'new', latest_score: null, bucket: null })], next: NEXT },
    ...extra,
  };
}

const listCalls = (calls: { path: string; method: string; search: string }[]) =>
  calls.filter((c) => c.method === 'GET' && c.path === '/api/prospects').map((c) => new URLSearchParams(c.search));

const tabs = () => within(screen.getByRole('group', { name: 'Durum' }));

describe('segmentOptions', () => {
  it('lists_the_workspaces_own_segments_by_name', () => {
    const icp = [{ segment_key: 'toplu' }, { segment_key: 'atolye' }, { segment_key: 'toplu' }];
    const audience = [
      { key: 'atolye', name: 'Atölye ortakları' },
      { key: 'toplu', name: 'Toplu sipariş' },
      { key: 'kisiye_ozel', name: 'Kişiye özel' },
    ];
    // ICP order, each segment once; a segment without an ICP entry is not offered.
    expect(segmentOptions(icp, audience)).toEqual([
      { key: 'toplu', name: 'Toplu sipariş' },
      { key: 'atolye', name: 'Atölye ortakları' },
    ]);
    // A segment a listed prospect carries, and the filter's own value, stay selectable; without
    // the strategy the key stands in for the name.
    expect(segmentOptions([], [], ['bayi', null, 'bayi'], 'eski')).toEqual([
      { key: 'bayi', name: 'bayi' },
      { key: 'eski', name: 'eski' },
    ]);
  });
});

describe('ProspectsPage', () => {
  it('filters_and_paging', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(answers());
    renderAt('/prospects');
    expect(await screen.findByRole('link', { name: 'Örnek Kafe 1' }, LOADED)).toHaveAttribute('href', `/prospects/${prospectId(1)}`);

    // The status is a tab; the other filters open on demand.
    await user.click(tabs().getByRole('button', { name: 'Nitelikli' }));
    expect(tabs().getByRole('button', { name: 'Nitelikli' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('textbox', { name: tr.leads.prospects.filters.city })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /More filters|Diğer filtreler/ }));
    await user.selectOptions(screen.getByRole('combobox', { name: tr.leads.prospects.filters.bucket }), '75-100');
    await screen.findByRole('option', { name: 'Strateji görevi · kafeler_izmir' }, LOADED);
    await user.selectOptions(screen.getByRole('combobox', { name: tr.leads.prospects.filters.task }), task(1).id);
    await user.click(screen.getByRole('textbox', { name: tr.leads.prospects.filters.city }));
    await user.paste('İzmir');
    // The audience is chosen from the workspace's own segments, beside the status tabs.
    await user.selectOptions(screen.getByRole('combobox', { name: tr.leads.prospects.filters.segment }), 'kafeler');
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
    await user.click(tabs().getByRole('button', { name: 'Yeni' }));
    await waitFor(() => {
      const q = listCalls(calls).at(-1)!;
      expect(q.get('status')).toBe('new');
      expect(q.get('before_id')).toBeNull();
    });
    // Many steps, each a render of the list: more time than one interaction needs.
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
    await user.click(screen.getByRole('button', { name: /More filters|Diğer filtreler/ }));
    const city = screen.getByRole('textbox', { name: tr.leads.prospects.filters.city });
    await user.click(tabs().getByRole('button', { name: 'Nitelikli' }));
    await user.type(city, 'Izmir');
    const title = await screen.findByText(tr.leads.filteredEmpty.title);
    const empty = title.parentElement!.parentElement!;
    expect(within(empty).queryByRole('link', { name: tr.leads.prospects.tasksLink })).not.toBeInTheDocument();
    await waitFor(() => expect(listCalls(calls).at(-1)!.get('city')).toBe('Izmir'));
    await user.click(within(empty).getByRole('button', { name: tr.leads.filteredEmpty.clear }));
    expect(tabs().getByRole('button', { name: 'Tümü' })).toHaveAttribute('aria-pressed', 'true');
    expect(city).toHaveValue('');
    await waitFor(() => {
      expect(listCalls(calls).at(-1)!.get('status')).toBeNull();
      expect(listCalls(calls).at(-1)!.get('city')).toBeNull();
    });
    expect(await screen.findByText(tr.leads.prospects.empty)).toBeInTheDocument();
  });

  it('sums this month’s funnel from the pool’s report', async () => {
    const group = { scored: 0, contacted: 0, meetings: 0, quoted: 0 };
    mockFetch(
      answers({
        'GET /api/prospects/report': {
          from: '2026-11-01T00:00:00Z',
          to: '2026-12-01T00:00:00Z',
          truncated: false,
          groups: [
            { ...group, key: 'manual', created: 1, qualified: 0, promoted: 0, replied: 0, won: 0 },
            { ...group, key: 'research_task', created: 10, qualified: 6, promoted: 2, replied: 1, won: 0 },
          ],
        },
      }),
    );
    renderAt('/prospects');
    const funnel = await screen.findByLabelText('Bu ayın hunisi', {}, LOADED);
    expect(funnel).toHaveTextContent('11 bulundu');
    expect(funnel).toHaveTextContent('6 nitelikli');
    expect(funnel).toHaveTextContent('2 iletişimde');
    expect(funnel).toHaveTextContent('1 yanıt verdi');
    expect(funnel).toHaveTextContent('0 satış');
  });

  it('opens a prospect beside the list and keeps the list and its filter', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(answers({ [`GET /api/prospects/${prospectId(1)}`]: prospectOut(1) }));
    const { router } = renderAt('/prospects');
    await user.click(await screen.findByRole('button', { name: 'Nitelikli' }, LOADED));
    await user.click(await screen.findByRole('link', { name: 'Örnek Kafe 1' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/prospects/${prospectId(1)}`));
    expect(await screen.findByRole('heading', { name: 'Örnek Kafe 1', level: 2 }, LOADED)).toBeInTheDocument();
    // The list is still there, the chosen row marked, and the filter was not reset by opening it.
    const rows = within(screen.getByRole('list', { name: 'Adaylar' }));
    expect(rows.getByRole('link', { name: 'Örnek Kafe 1' })).toHaveAttribute('aria-current', 'page');
    expect(rows.getByRole('link', { name: 'Örnek Kafe 2' })).not.toHaveAttribute('aria-current');
    expect(tabs().getByRole('button', { name: 'Nitelikli' })).toHaveAttribute('aria-pressed', 'true');
    expect(listCalls(calls).at(-1)!.get('status')).toBe('qualified');
  });

  it('there is no "promote to inbox" action in the pool any more', async () => {
    mockFetch(answers());
    renderAt('/prospects');
    await screen.findByRole('link', { name: 'Örnek Kafe 1' }, LOADED);
    await userEvent.setup().click(screen.getByRole('checkbox', { name: 'Örnek Kafe 1 seç' }));
    const bar = within(screen.getByRole('toolbar', { name: tr.leads.bulk.label }));
    expect(bar.getByRole('button', { name: tr.leads.bulk.reject })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /aktar/i })).not.toBeInTheDocument();
  });

  it('bulk_reject_shows_per_item_outcomes', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(
      answers({
        [`POST /api/prospects/${prospectId(1)}/decision`]: { prospect: {}, flags: [] },
        [`POST /api/prospects/${prospectId(2)}/decision`]: withStatus(409, {
          code: 'CONFLICT',
          message: 'stale',
          details: { reason: 'stale_revision' },
        }),
      }),
    );
    renderAt('/prospects');
    await user.click(await screen.findByRole('checkbox', { name: 'Örnek Kafe 1 seç' }, LOADED));
    await user.click(screen.getByRole('checkbox', { name: 'Örnek Kafe 2 seç' }));
    const bar = screen.getByRole('toolbar', { name: tr.leads.bulk.label });
    await user.click(within(bar).getByRole('button', { name: tr.leads.bulk.reject }));
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
    // One refusal never stops the rest: each prospect gets its own line.
    const results = await screen.findByRole('list', { name: tr.leads.bulk.results });
    const items = within(results).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Örnek Kafe 1');
    expect(items[0]).toHaveAttribute('data-ok', 'true');
    expect(items[1]).toHaveTextContent('Örnek Kafe 2');
    expect(items[1]).toHaveAttribute('data-ok', 'false');
  });

  it('a person adds a prospect by hand, under their own source note', async () => {
    const user = userEvent.setup();
    const added = { business_name: 'Örnek Atölye', status: 'new' as const };
    const calls = mockFetch(
      answers({
        'GET /api/prospects/playbook': { ...playbook, workspace: { ...playbook.workspace, icp: [{ segment_key: 'atolye' }] } },
        'POST /api/prospects': { prospect: prospect(9, added), flags: [] },
        [`GET /api/prospects/${prospectId(9)}`]: prospectOut(9, added),
      }),
    );
    const { router } = renderAt('/prospects');
    await user.click(await screen.findByRole('button', { name: 'Aday ekle' }, LOADED));
    const form = within(screen.getByRole('form', { name: 'Yeni aday' }));
    // Nothing is sent while the name is missing.
    await user.click(form.getByRole('button', { name: 'Aday ekle' }));
    expect(form.getByText('Bu alan zorunlu.')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    await user.type(form.getByRole('textbox', { name: /İşletme adı/ }), 'Örnek Atölye');
    // The purposes offered are the workspace's own.
    await user.selectOptions(form.getByRole('combobox', { name: 'Amaç (kitle)' }), 'atolye');
    await user.type(form.getByRole('textbox', { name: tr.leads.fields.phone }), '0532 000 00 00');
    await user.click(form.getByRole('button', { name: 'Aday ekle' }));
    // The new prospect opens beside the list.
    await waitFor(() => expect(router.state.location.pathname).toBe(`/prospects/${prospectId(9)}`));
    const body = calls.find((c) => c.method === 'POST' && c.path === '/api/prospects')!.body as Record<string, unknown>;
    const manual = { kind: 'manual', note: 'Elle girildi' };
    expect(body).toMatchObject({
      business_name: 'Örnek Atölye',
      entity_kind: 'unknown_business',
      segment_key: 'atolye',
      discovered_at: [manual],
      phone: { value: '0532 000 00 00', sources: [manual] },
    });
    expect(body).not.toHaveProperty('email');
    expect(typeof body.request_key).toBe('string');
  });

  it('a duplicate is refused with the way to the record that holds the contact', async () => {
    const user = userEvent.setup();
    mockFetch(
      answers({
        'POST /api/prospects': withStatus(409, {
          code: 'CONFLICT',
          message: 'another prospect holds this contact',
          details: { reason: 'duplicate', prospect_id: prospectId(2) },
        }),
      }),
    );
    renderAt('/prospects');
    await user.click(await screen.findByRole('button', { name: 'Aday ekle' }, LOADED));
    const form = within(screen.getByRole('form', { name: 'Yeni aday' }));
    await user.type(form.getByRole('textbox', { name: /İşletme adı/ }), 'Örnek Kafe 2');
    await user.click(form.getByRole('button', { name: 'Aday ekle' }));
    expect(await form.findByText(tr.leads.errors.duplicate)).toBeInTheDocument();
    expect(form.getByRole('link', { name: 'Var olan kaydı aç' })).toHaveAttribute('href', `/prospects/${prospectId(2)}`);
  });
});
