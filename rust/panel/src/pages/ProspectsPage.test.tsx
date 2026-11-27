import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import tr from '@/i18n/tr.json';
import { mockFetch, renderAt, withStatus } from '@/test/render';
import { LOADED, agentsList, leadsMe, playbook, prospect, prospectId, prospectOut, row, task, taskId, team } from '@/test/leads';
import { approvedVersion, sections } from '@/test/fixtures';
import { segmentOptions } from './ProspectsPage';

const NEXT = { before_at: '2026-11-01T09:02:00Z', before_id: prospectId(2) };

function answers(extra: Record<string, unknown> = {}) {
  return {
    'GET /api/auth/me': leadsMe,
    'GET /api/agents': agentsList,
    'GET /api/team': team,
    'GET /api/research/tasks': { items: [{ task: task(1), remaining_today: 8, found: 0, qualified: 0, found_today: 0, last_found_at: null }], next: null },
    'GET /api/strategy': { approved: { ...approvedVersion, sections: { ...sections, audience: [{ key: 'kafeler', name: 'Kafeler', description: '' }] } }, draft: null, gaps: [] },
    'GET /api/prospects': { items: [row(1), row(2), row(3, { status: 'new', latest_score: null, bucket: null })], next: NEXT },
    ...extra,
  };
}

/** The list's page reads (not the counts' reads, which ask `counts=true`). */
const listCalls = (calls: { path: string; method: string; search: string }[]) =>
  calls
    .filter((c) => c.method === 'GET' && c.path === '/api/prospects')
    .map((c) => new URLSearchParams(c.search))
    .filter((q) => q.get('counts') !== 'true');

/** The counts' reads: the filters chosen, one row each, `counts=true`. */
const countCalls = (calls: { path: string; method: string; search: string }[]) =>
  calls
    .filter((c) => c.method === 'GET' && c.path === '/api/prospects')
    .map((c) => new URLSearchParams(c.search))
    .filter((q) => q.get('counts') === 'true');

/** How full each class is, as `prospects.list` answers it with `counts`. */
const COUNTS = {
  total: 3,
  status: [
    { key: 'qualified', count: 2 },
    { key: 'new', count: 1 },
  ],
  segment_key: [{ key: 'kafeler', count: 3 }],
  icp_key: [
    { key: 'kafeler_izmir', count: 2 },
    { key: null, count: 1 },
  ],
  bucket: [
    { key: '50-74', count: 2 },
    { key: null, count: 1 },
  ],
  city: [
    { key: 'İzmir', count: 2 },
    { key: 'Manisa', count: 1 },
  ],
  research_task_id: [
    { key: taskId(1), count: 2 },
    { key: taskId(2), count: 1 },
  ],
};

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

    // The status is a tab; every other filter is a compact choice beside the tabs.
    await user.click(tabs().getByRole('button', { name: 'Nitelikli' }));
    expect(tabs().getByRole('button', { name: 'Nitelikli' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: /More filters|Diğer filtreler/ })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: tr.leads.prospects.filters.bucket }), '75-100');
    // A task is named as the tasks page names it (its audience, never its key), with its day.
    const taskFilter = screen.getByRole('combobox', { name: tr.leads.prospects.filters.task });
    await within(taskFilter).findByRole('option', { name: /^Kafeler · / }, LOADED);
    await user.selectOptions(taskFilter, task(1).id);
    // The audience is chosen from the workspace's own segments, the purpose from its ICP entries.
    await user.selectOptions(screen.getByRole('combobox', { name: tr.leads.prospects.filters.segment }), 'kafeler');
    const purpose = screen.getByRole('combobox', { name: tr.leads.prospects.filters.purpose });
    expect(within(purpose).getByRole('option', { name: 'Kafeler izmir' })).toBeInTheDocument();
    await user.selectOptions(purpose, 'kafeler_izmir');
    await waitFor(() => {
      const q = listCalls(calls).at(-1)!;
      expect(q.get('status')).toBe('qualified');
      expect(q.get('bucket')).toBe('75-100');
      expect(q.get('research_task_id')).toBe(task(1).id);
      expect(q.get('segment_key')).toBe('kafeler');
      expect(q.get('icp_key')).toBe('kafeler_izmir');
      expect(q.get('limit')).toBe('50');
      expect(q.get('before_id')).toBeNull();
    });
    // The counts are read under the same filters, one row at a time.
    await waitFor(() => {
      const q = countCalls(calls).at(-1)!;
      expect(q.get('icp_key')).toBe('kafeler_izmir');
      expect(q.get('status')).toBe('qualified');
      expect(q.get('limit')).toBe('1');
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

  it('switches_to_the_research_tasks_from_its_own_header', async () => {
    mockFetch(answers());
    renderAt('/prospects');
    const nav = within(await screen.findByRole('navigation', { name: 'Aday havuzu bölümleri' }, LOADED));
    expect(nav.getByRole('link', { name: 'Adaylar' })).toHaveAttribute('aria-current', 'page');
    expect(nav.getByRole('link', { name: 'Araştırma görevleri' })).toHaveAttribute('href', '/prospects/tasks');
    expect(nav.getByRole('link', { name: 'Araştırma görevleri' })).not.toHaveAttribute('aria-current');
  });

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
    const bucket = screen.getByRole('combobox', { name: tr.leads.prospects.filters.bucket });
    await user.click(tabs().getByRole('button', { name: 'Nitelikli' }));
    await user.selectOptions(bucket, '75-100');
    const title = await screen.findByText(tr.leads.filteredEmpty.title);
    const empty = title.parentElement!.parentElement!;
    expect(within(empty).queryByRole('link', { name: tr.leads.prospects.tasksLink })).not.toBeInTheDocument();
    await waitFor(() => expect(listCalls(calls).at(-1)!.get('bucket')).toBe('75-100'));
    await user.click(within(empty).getByRole('button', { name: tr.leads.filteredEmpty.clear }));
    expect(tabs().getByRole('button', { name: 'Tümü' })).toHaveAttribute('aria-pressed', 'true');
    expect(bucket).toHaveValue('');
    await waitFor(() => {
      expect(listCalls(calls).at(-1)!.get('status')).toBeNull();
      expect(listCalls(calls).at(-1)!.get('bucket')).toBeNull();
    });
    expect(await screen.findByText(tr.leads.prospects.empty)).toBeInTheDocument();
  });

  it('counts every class under the other filters, and a choice keeps the others', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(
      answers({
        'GET /api/prospects': { items: [row(1), row(2), row(3, { status: 'new', icp_key: null, latest_score: null, bucket: null })], next: null, counts: COUNTS },
        'GET /api/research/tasks': {
          items: [
            { task: task(1), remaining_today: 8, found: 2, qualified: 2, found_today: 0, last_found_at: null },
            {
              task: task(2, { kind: { type: 'ad_hoc', target_count: 10 }, status: 'done', closed_at: '2026-11-02T08:00:00Z', created_at: '2026-11-02T08:00:00Z' }),
              remaining_today: 0,
              found: 1,
              qualified: 0,
              found_today: 0,
              last_found_at: null,
            },
          ],
          next: null,
        },
      }),
    );
    renderAt('/prospects');
    await screen.findByRole('link', { name: 'Örnek Kafe 1' }, LOADED);
    // Each tab says how many it holds; "all" is every status together.
    expect(await tabs().findByRole('button', { name: /^Nitelikli\s*2$/ })).toBeInTheDocument();
    expect(tabs().getByRole('button', { name: /^Tümü\s*3$/ })).toBeInTheDocument();
    expect(tabs().getByRole('button', { name: /^Yeni\s*1$/ })).toBeInTheDocument();
    expect(tabs().getByRole('button', { name: /^Reddedilen\s*0$/ })).toBeInTheDocument();
    // Each choice with its count; a closed task with prospects is still a choice.
    const purpose = screen.getByRole('combobox', { name: tr.leads.prospects.filters.purpose });
    expect(within(purpose).getByRole('option', { name: 'Kafeler izmir (2)' })).toBeInTheDocument();
    const city = screen.getByRole('combobox', { name: tr.leads.prospects.filters.city });
    expect(within(city).getAllByRole('option').map((o) => o.textContent)).toEqual(['Şehir', 'İzmir (2)', 'Manisa (1)']);
    const taskFilter = screen.getByRole('combobox', { name: tr.leads.prospects.filters.task });
    await within(taskFilter).findByRole('option', { name: /^kafe · .*\(1\)$/ });
    // A row says what it is for: its purpose, else its segment.
    const rows = within(screen.getByRole('list', { name: 'Adaylar' })).getAllByTestId('prospect-row');
    expect(rows[0]).toHaveTextContent('Kafeler izmir · kafe');
    expect(rows[2]).toHaveTextContent('Kafeler · kafe');
    // A city chosen narrows the list and the other counts, and "Temizle" lets every class go but the status.
    await user.click(tabs().getByRole('button', { name: /^Nitelikli/ }));
    await user.selectOptions(city, 'Manisa');
    await waitFor(() => {
      expect(listCalls(calls).at(-1)!.get('city')).toBe('Manisa');
      expect(countCalls(calls).at(-1)!.get('city')).toBe('Manisa');
    });
    await user.click(screen.getByRole('button', { name: 'Temizle' }));
    await waitFor(() => {
      const q = listCalls(calls).at(-1)!;
      expect(q.get('city')).toBeNull();
      expect(q.get('status')).toBe('qualified');
    });
    expect(screen.queryByRole('button', { name: 'Temizle' })).not.toBeInTheDocument();
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
        'GET /api/prospects/playbook': { ...playbook, workspace: { ...playbook.workspace, icp: [{ key: 'atolye_mekan', segment_key: 'atolye' }] } },
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
    // The audiences and the purposes offered are the workspace's own.
    await user.selectOptions(form.getByRole('combobox', { name: 'Kitle' }), 'atolye');
    await user.selectOptions(form.getByRole('combobox', { name: 'Amaç' }), 'atolye_mekan');
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
      icp_key: 'atolye_mekan',
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
