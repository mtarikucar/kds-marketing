import { describe, expect, it } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockFetch, renderAt, withStatus } from '@/test/render';
import { inboxAnswers, inboxMe } from '@/test/inbox';
import tr from '@/i18n/tr.json';
import en from '@/i18n/en.json';

const h = {
  id: 'h1',
  title: 'Kısa hikâyeler',
  metric: 'engagement',
  prior_confidence: 0.4,
  derived_confidence: 0.7,
  channel: 'x',
  cadence: {},
  state: 'kept',
};
const chain = { workspace_id: 'w', born_version_id: 'v1', hypothesis_id: 'h1', arm_id: 'a1' };
const slot = {
  id: 's1',
  chain,
  capability_id: 'c1',
  scheduled_at: new Date().toISOString(),
  state: 'ready',
  revision: 1,
};
const overview = {
  strategy: { id: 'v1', number: 3 },
  goals: { objective: 'Daha çok yanıt', kpis: [{ name: 'engagement', target: '10' }] },
  hypotheses: [h],
  control: { revision: 2, brake_engaged: false, lanes: {} },
  lane_support: {
    organic: { visible: true, supported: true },
    paid: { visible: false, supported: false },
  },
  slots: [slot],
  today: {
    slots: [{ slot, overdue: true }],
    approvals: [{ slot: 's1' }],
    budget_moves: [],
    blockers: [
      { target: { slot: 's1' }, reason: 'human_approval_required' },
      {
        target: { slot: 's1' },
        reason: 'publish_unknown',
        next_action: 'review_publication_duplicate_risk',
      },
    ],
    paid_alerts: [],
  },
  learned: {
    hypotheses: [],
    arms: [
      {
        arm: {
          id: 'a1',
          key: { hypothesis_id: 'h1', lane: 'organic', channel: 'x', content_type: 'text' },
          alpha: 2,
          beta: 3,
          weight: 0.4,
        },
        evidence: [],
      },
    ],
    lane_performance: [],
    spend_vs_cap: [],
    trends: [],
    judgments: [],
  },
  bindings: [],
};
const answers = {
  ...inboxAnswers,
  'GET /api/auth/me': {
    ...inboxMe,
    memberships: [
      {
        ...inboxMe.memberships[0],
        permissions: [
          ...inboxMe.memberships[0].permissions,
          'studio.work',
          'studio.manage',
          'team.manage',
        ],
      },
    ],
  },
  'GET /api/studio/overview': overview,
  'GET /api/studio/ledger': { entries: [], next_before: null },
  'GET /api/work/pending': {
    items: [],
    agent: { overdue: true, interval_minutes: 60, last_seen_at: null },
    strategy: { approved: { number: 3 } },
  },
  'GET /api/capabilities': [],
  'GET /api/studio/slots/s1': {
    slot,
    piece: { text: 'Örnek içerik', media: [], adaptations: {} },
    hypothesis: h,
    brand_rules: { identity: { voice: 'Sade' }, prohibitions: [] },
    learned: overview.learned.arms[0].arm,
    attempts: [],
    measurements: [],
  },
};
describe('Growth Studio', () => {
  it('hypothesis_filter_updates_all_five_regions', async () => {
    const calls = mockFetch(answers);
    renderAt('/studio');
    const user = userEvent.setup();
    await within(await screen.findByLabelText('Hipotez')).findByRole('option', {
      name: 'Kısa hikâyeler',
    });
    expect(within(screen.getByTestId('studio')).getAllByRole('region')).toHaveLength(5);
    await user.selectOptions(screen.getByLabelText('Hipotez'), 'h1');
    await waitFor(() =>
      expect(calls.filter((c) => c.path === '/api/studio/overview').at(-1)?.search).toContain(
        'hypothesis_id=h1',
      ),
    );
    await waitFor(() =>
      expect(calls.filter((c) => c.path === '/api/studio/ledger').at(-1)?.search).toContain(
        'hypothesis_id=h1',
      ),
    );
  });
  it('list_calendar_share_slot_ids', async () => {
    mockFetch(answers);
    renderAt('/studio');
    const user = userEvent.setup();
    const plan = await screen.findByRole('region', { name: 'Plan' });
    expect(await within(plan).findByTestId('slot-s1')).toBeInTheDocument();
    await user.click(within(plan).getByRole('button', { name: 'Takvim' }));
    expect(await within(plan).findByTestId('slot-s1')).toBeInTheDocument();
    await user.click(within(plan).getByRole('button', { name: 'Liste' }));
    expect(await within(plan).findByTestId('slot-s1')).toBeInTheDocument();
  });
  it('approval_and_unknown_outcome_show_actionable_reason', async () => {
    const calls = mockFetch({ ...answers, 'POST /api/studio/approvals': { revision: 1 } });
    renderAt('/studio');
    expect(await screen.findByText('Yayın sonucu belirsiz')).toBeInTheDocument();
    expect(screen.getByText('Onay bekliyor')).toBeInTheDocument();
    expect(screen.getAllByText('Ajan bekleniyor').length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: 'Onayla' }));
    expect(calls.find((c) => c.path === '/api/studio/approvals')?.body).toEqual({
      target: { slot: 's1' },
      expected_revision: 1,
    });
  });
  it('organic_visible_and_paid_four_case_visibility', async () => {
    mockFetch(answers);
    renderAt('/studio');
    expect(await screen.findByRole('button', { name: 'Organik' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ücretli' })).not.toBeInTheDocument();
    expect(screen.queryByText('Reklam seti bağla')).not.toBeInTheDocument();
  });
  it('studio_has_no_removed_routes_menus_or_targets', async () => {
    mockFetch(answers);
    renderAt('/studio');
    await screen.findByRole('heading', { name: 'Bugün' });
    const page = screen.getByTestId('studio');
    expect(page).not.toHaveTextContent(/Kurulum|Komisyon|COMMISSION_AMOUNT|Cüzdan|autopilot/i);
    expect(within(page).queryByRole('link', { name: /installations/i })).not.toBeInTheDocument();
  });
  it('inbox_commissions_remain_outside_studio', async () => {
    mockFetch({ ...answers, 'GET /api/inbox/commissions': [] });
    renderAt('/inbox/commissions');
    expect(await screen.findByRole('heading', { name: 'Komisyonlar' })).toBeInTheDocument();
    expect(screen.queryByTestId('studio')).not.toBeInTheDocument();
  });
  it('keyboard_and_mobile_keep_the_same_five_regions', async () => {
    window.innerWidth = 375;
    const calls = mockFetch({
      ...answers,
      'POST /api/studio/brake': { ...overview.control, brake_engaged: true, revision: 3 },
    });
    renderAt('/studio');
    const brake = await screen.findByRole('button', { name: 'Acil fren' });
    brake.focus();
    await userEvent.keyboard('{Enter}');
    expect(calls.find((c) => c.path === '/api/studio/brake')?.body).toEqual({
      engaged: true,
      lane: null,
      expected_revision: 2,
    });
    expect(within(screen.getByTestId('studio')).getAllByRole('region')).toHaveLength(5);
  });
  it('no_strategy_keeps_organic_and_ledger_with_actionable_copy', async () => {
    mockFetch({
      ...answers,
      'GET /api/studio/overview': withStatus(409, {
        code: 'STRATEGY_REQUIRED',
        message: 'required',
        details: {},
      }),
    });
    renderAt('/studio');
    expect(await screen.findByText('Önce bir strateji onaylayın.')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Günlük' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Organik' })).toBeInTheDocument();
  });
  it('TR_EN_key_parity', () => {
    expect(Object.keys(tr.studio).sort()).toEqual(Object.keys(en.studio).sort());
  });
});

it('panel_actions_match_every_studio_tool', async () => {
  const api = await import('@/api/studio');
  const q = { from: '2026-10-01T00:00:00Z', until: '2026-11-01T00:00:00Z' };
  const expected = [
    ['GET', '/api/studio/overview'],
    ['GET', '/api/studio/ledger'],
    ['POST', '/api/studio/ledger/export'],
    ['GET', '/api/studio/pending'],
    ['GET', '/api/studio/slots/s1'],
    ['POST', '/api/studio/slots/s1/cancel'],
    ['POST', '/api/studio/brake'],
    ['PUT', '/api/studio/policy'],
    ['POST', '/api/studio/approvals'],
    ['POST', '/api/studio/hypotheses/proposals'],
    ['POST', '/api/studio/trends'],
    ['POST', '/api/studio/judgments'],
    ['GET', '/api/studio/learned'],
    ['GET', '/api/studio/adsets'],
    ['POST', '/api/studio/adsets/bind'],
    ['POST', '/api/studio/budget-moves'],
    ['POST', '/api/studio/slots/s1/piece'],
    ['POST', '/api/studio/files'],
  ];
  const calls = mockFetch(Object.fromEntries(expected.map(([m, p]) => [`${m} ${p}`, {}])));
  await api.overview(q);
  await api.ledger(q);
  await api.ledgerExport(q);
  await api.pending();
  await api.slotGet('s1');
  await api.slotCancel('s1', 1, 'No longer needed');
  await api.brake(true, null, 2);
  await api.policySet('organic', true, 2);
  await api.approve({ slot: 's1' }, 1);
  await api.hypothesisPropose({
    title: 'Title',
    segment_key: 'audience',
    angle: 'angle',
    channel: 'x',
    metric: 'clicks',
    prior_confidence: 0.5,
  });
  await api.trendRecord({
    hypothesis_id: 'h1',
    channel: 'x',
    summary: 'A trend',
    observed_at: q.from,
    request_key: 'trend',
  });
  await api.judgmentRecord({
    hypothesis_id: 'h1',
    evidence_ids: ['e1'],
    text: 'Result',
    request_key: 'judgment',
  });
  await api.learned(q);
  await api.adsetsList('c1');
  await api.adsetBind({
    hypothesis_id: 'h1',
    arm_id: 'a1',
    capability_id: 'c1',
    adset_id: 'set1',
    request_key: 'binding',
  });
  await api.budgetMove({
    binding_id: 'b1',
    daily_budget_minor: 100,
    currency: 'TRY',
    request_key: 'move',
  });
  await api.pieceSubmit('s1', {
    expected_revision: 1,
    request_key: 'piece',
    text: 'Hello',
    media: [],
    adaptations: {},
  });
  await api.fileUpload({
    filename: 'photo.png',
    mime: 'image/png',
    content: { kind: 'bytes_base64', data: 'eA==' },
    request_key: 'file',
  });
  expect(calls.map((c) => [c.method, c.path])).toEqual(expected);
  expect(calls[2].body).toEqual({ filter: q });
  expect(
    calls
      .filter((c) => c.method !== 'GET')
      .every((c) => c.headers.get('X-Requested-With') === 'jeeta-panel'),
  ).toBe(true);
});

it('slot_detail_submits_and_cancels_the_current_revision', async () => {
  const calls = mockFetch({
    ...answers,
    'POST /api/studio/slots/s1/piece': {},
    'POST /api/studio/slots/s1/cancel': {},
  });
  renderAt('/studio');
  const user = userEvent.setup();
  const plan = await screen.findByRole('region', { name: 'Plan' });
  await user.click(
    await within(plan)
      .findByTestId('slot-s1')
      .then((e) => within(e).getByRole('button')),
  );
  const editor = await screen.findByTestId('slot-detail');
  const text = await within(editor).findByLabelText('İçerik metni');
  await user.clear(text);
  await user.type(text, 'Yeni içerik');
  await user.click(within(editor).getByRole('button', { name: 'İçeriği teslim et' }));
  await waitFor(() =>
    expect(calls.find((c) => c.path.endsWith('/piece'))?.body).toMatchObject({
      expected_revision: 1,
      text: 'Yeni içerik',
      media: [],
      adaptations: {},
    }),
  );
  await user.type(within(editor).getByLabelText('İptal nedeni'), 'Plan değişti');
  await user.click(within(editor).getByRole('button', { name: 'İçeriği iptal et' }));
  await waitFor(() =>
    expect(calls.find((c) => c.path.endsWith('/cancel'))?.body).toEqual({
      expected_revision: 1,
      reason: 'Plan değişti',
    }),
  );
});

it.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])('paid_actions_follow_server_account_%s_strategy_%s', async (account, strategy) => {
  const visible = account && strategy;
  mockFetch({
    ...answers,
    'GET /api/studio/overview': {
      ...overview,
      lane_support: { ...overview.lane_support, paid: { visible, supported: visible } },
    },
  });
  renderAt('/studio');
  await screen.findByRole('button', { name: 'Acil fren' });
  expect(screen.getByRole('button', { name: 'Organik' })).toBeInTheDocument();
  expect(Boolean(screen.queryByRole('button', { name: 'Ücretli' }))).toBe(visible);
  expect(Boolean(screen.queryByText('Reklam seti bağla', { selector: 'summary' }))).toBe(visible);
});

it('strategy_hypothesis_click_filters_regions_and_plan_names_channel_and_type', async () => {
  const calls = mockFetch(answers);
  renderAt('/studio');
  const strategy = await screen.findByRole('region', { name: 'Strateji' });
  await userEvent.click(await within(strategy).findByRole('button', { name: 'Kısa hikâyeler' }));
  await waitFor(() =>
    expect(calls.filter((c) => c.path === '/api/studio/overview').at(-1)?.search).toContain(
      'hypothesis_id=h1',
    ),
  );
  const row = await within(screen.getByRole('region', { name: 'Plan' })).findByTestId('slot-s1');
  expect(row).toHaveTextContent('text / x');
});
