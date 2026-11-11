import { expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from '@/i18n/config';
import tr from '@/i18n/tr.json';
import type { WorkItem } from '@/api/types';
import { me as baseMe, workspace, pendingOverdue } from '@/test/fixtures';
import { mockFetch, renderAt } from '@/test/render';
const me = { ...baseMe, memberships: [{ ...baseMe.memberships[0], workspace_status: 'active' as const }] };
it('links all four inbox work kinds to actionable destinations', async () => {
  mockFetch({
    'GET /api/auth/me': me,
    'GET /api/workspace': workspace,
    'GET /api/work/pending': { ...pendingOverdue, items: [
      { kind: 'reply_due', conversation_id: 'conv-1', priority: 2, hint: 'private hint' },
      { kind: 'reopen_question', conversation_id: 'conv-2', priority: 2, hint: 'private hint' },
      { kind: 'merge_suggested', merge_id: 'merge-1', priority: 3, hint: 'private hint' },
      { kind: 'task_due', task_id: 'task-1', priority: 3, hint: 'private hint' },
    ] },
  });
  renderAt('/');
  for (const [copy, href] of [
    [tr.home.pending.reply_due, '/inbox/conv-1'],
    [tr.home.pending.reopen_question, '/inbox/conv-2'],
    [tr.home.pending.merge_suggested, '/inbox/merges?merge=merge-1'],
    [tr.home.pending.task_due, '/inbox?task=task-1'],
  ]) {
    const text = await screen.findByText(copy);
    expect(within(text.closest('li')!).getByRole('link')).toHaveAttribute('href', href);
  }
  expect(screen.queryByText('private hint')).not.toBeInTheDocument();
});


it('opens the relevant research, prospect, distribution and outreach work instead of capabilities', async () => {
  const campaignId = 'campaign/with a space';
  const cases: { item: WorkItem; href: string }[] = [
    { item: { kind: 'research_due', task_id: 'research-1', remaining_today: 3, priority: 2, hint: '' }, href: '/prospects/tasks' },
    { item: { kind: 'prospects_to_score', count: 2, priority: 2, hint: '' }, href: '/prospects' },
    { item: { kind: 'prospects_to_promote', count: 2, priority: 2, hint: '' }, href: '/prospects' },
    { item: { kind: 'ownerless_journeys', count: 2, oldest_journey_id: 'journey-1', priority: 2, hint: '' }, href: '/team/distribution' },
    { item: { kind: 'assignment_stalled', count: 2, priority: 2, hint: '' }, href: '/team/distribution' },
    { item: { kind: 'promoted_not_contacted', count: 2, priority: 2, hint: '' }, href: '/inbox' },
    { item: { kind: 'campaign_approval', campaign_id: campaignId, revision: 1, priority: 1, hint: '' }, href: '/outreach/campaign%2Fwith%20a%20space' },
    { item: { kind: 'campaign_blocked', campaign_id: campaignId, reason: 'daily_cap', priority: 1, hint: '' }, href: '/outreach/campaign%2Fwith%20a%20space' },
    { item: { kind: 'personalization_due', campaign_id: campaignId, count: 2, priority: 2, hint: '' }, href: '/outreach/campaign%2Fwith%20a%20space' },
    // Capability work continues to use the existing default destination.
    { item: { kind: 'declare_first_capability', priority: 2, hint: '' }, href: '/capabilities' },
  ];
  mockFetch({
    'GET /api/auth/me': me,
    'GET /api/workspace': workspace,
    'GET /api/work/pending': { ...pendingOverdue, items: cases.map(({ item }) => item) },
  });
  renderAt('/');
  for (const { item, href } of cases) {
    const text = await screen.findByText(i18n.t(`home.pending.${item.kind}`));
    expect(within(text.closest('li')!).getByRole('link', { name: 'Aç' })).toHaveAttribute('href', href);
  }
});

it('shows every pending item on All and keeps the log tab without links to removed pages', async () => {
  mockFetch({
    'GET /api/auth/me': me,
    'GET /api/work/pending': { ...pendingOverdue, items: Array.from({ length: 7 }, (_, i) => ({ kind: 'content_area', redo_note: null, project_id: `p${i}`, priority: i, expected_revision: 1, hint: 'private' })) },
    'GET /api/ledger': [{ id: 'log1', entry: { at: new Date().toISOString(), actor: { kind: 'system' }, action: 'studio.adset_bind', result: {} } }],
  });
  renderAt('/');
  const list = await screen.findByRole('list', { name: 'Bekleyen' });
  expect(within(list).getAllByRole('listitem')).toHaveLength(7);
  expect(within(list).getAllByRole('link').map(a => a.getAttribute('href'))).toEqual(Array.from({ length: 7 }, (_, i) => `/content?area=p${i}`));
  await userEvent.click(screen.getByRole('button', { name: 'Günlük' }));
  // The record is said in words, under its module, not as its code.
  expect(await screen.findByRole('list', { name: 'Günlük' })).toHaveTextContent('bir reklam setini bağladı');
  expect(screen.getByRole('list', { name: 'Günlük' })).not.toHaveTextContent('studio.adset_bind');
  expect(screen.queryByRole('list', { name: 'Bekleyen' })).not.toBeInTheDocument();
  expect(screen.getAllByRole('link').some(a => ['/activity', '/ledger'].includes(a.getAttribute('href') ?? ''))).toBe(false);
});

import { workItemLink } from '@/lib/workItems';
import { ledgerModule } from './home/agenda';

it('routes social, materials, project and budget work to their modules', () => {
  const cases: [WorkItem, string][] = [
    [{ kind: 'studio_slot', slot_id: 's/1', overdue: false, priority: 1, hint: '' }, '/social?slot=s%2F1'],
    [{ kind: 'studio_approval', target: { slot: 's1' }, priority: 1, hint: '' }, '/social?slot=s1'],
    [{ kind: 'studio_approval', target: { budget_move: 'b1' }, priority: 1, hint: '' }, '/ads?tab=external'],
    [{ kind: 'studio_budget_move', budget_move_id: 'b1', priority: 1, hint: '' }, '/ads?tab=external'],
    [{ kind: 'studio_shoot_request', shoot_request_id: 'r1', priority: 1, hint: '' }, '/materials?view=shoots'],
    [{ kind: 'studio_post_request', post_request_id: 'p1', priority: 1, hint: '' }, '/social?tab=posts'],
    [{ kind: 'content_area', redo_note: null, project_id: 'p1', expected_revision: 1, priority: 1, hint: '' }, '/content?area=p1'],
  ];
  for (const [item, href] of cases) expect(workItemLink(item)).toBe(href);
});

it.each([
  ['studio.slot_materials', 'materials'], ['studio.material_add', 'materials'], ['studio.material_production_request', 'content'],
  ['studio.project_create', 'content'], ['studio.project_schedule', 'social'],
  ['studio.slot_cancel', 'social'], ['studio.adset_bind', 'ads'], ['studio.budget_move', 'ads'],
  ['studio.judgment_record', null],
  // The three modules' own records, and the budget's (workspace-wide).
  ['content.area.opened', 'content'], ['content.package.delivered', 'content'],
  ['social.version.scheduled', 'social'], ['social.account.paused', 'social'],
  ['ads.campaign.opened', 'ads'], ['ads.campaign.plan_refused', 'ads'],
  ['budget.stop', null],
  // The `studio.*` records as the server writes them.
  ['studio.material.added', 'materials'], ['studio.shoot.requested', 'materials'], ['studio.file_upload', 'materials'],
  ['studio.project.created', 'content'], ['studio.project.materials_changed', 'content'],
  ['studio.project.scheduled', 'social'], ['studio.publish.failure', 'social'], ['studio.slot.planned', 'social'],
  ['studio.package.requested', 'social'], ['studio.piece_submit', 'social'], ['studio.posting_policy.set', 'social'],
  ['studio.paid.refused', 'ads'], ['studio.budget_rollover', 'ads'], ['studio.binding_status', 'ads'], ['studio.external_drift', 'ads'],
  ['studio.brake', null], ['studio.measurement.recorded', null],
])('attributes %s to its module', (action, module) => expect(ledgerModule(action)).toBe(module));

it('shows the three content work kinds and links each to its production area', async () => {
  const items: WorkItem[] = [
    { kind: 'content_area', project_id: 'a/1', expected_revision: 3, redo_note: 'Daha kısa', priority: 1, hint: 'private' },
    { kind: 'content_material_request', project_id: 'a2', request_id: 'r1', priority: 1, hint: 'private' },
    { kind: 'content_area_held', project_id: 'a3', priority: 1, hint: 'private' },
  ];
  mockFetch({ 'GET /api/auth/me': me, 'GET /api/work/pending': { ...pendingOverdue, items } });
  renderAt('/');
  const list = await screen.findByRole('list', { name: 'Bekleyen' });
  expect(within(list).getByText('Yeniden yapılıyor: “Daha kısa”')).toBeVisible();
  expect(within(list).getByText(tr.home.pending.content_material_request)).toBeVisible();
  expect(within(list).getByText(tr.home.pending.content_area_held)).toBeVisible();
  expect(within(list).getAllByRole('link').map(a => a.getAttribute('href'))).toEqual(['/content?area=a%2F1', '/content?area=a2', '/content?area=a3']);
});

it('shows ad campaign proposals and held campaigns with encoded campaign links', async () => {
  const items: WorkItem[] = [
    { kind: 'ads_campaign_proposal', campaign_id: 'ad/one', priority: 1, hint: 'private' },
    { kind: 'ads_campaign_held', campaign_id: 'ad-two', priority: 2, hint: 'private' },
  ];
  mockFetch({ 'GET /api/auth/me': me, 'GET /api/work/pending': { ...pendingOverdue, items } });
  renderAt('/');
  const list = await screen.findByRole('list', { name: 'Bekleyen' });
  expect(within(list).getByText(tr.home.pending.ads_campaign_proposal)).toBeVisible();
  expect(within(list).getByText(tr.home.pending.ads_campaign_held)).toBeVisible();
  expect(within(list).getAllByRole('link').map(a => a.getAttribute('href'))).toEqual(['/ads?campaign=ad%2Fone', '/ads?campaign=ad-two']);
});

it('says the three modules’ records and the budget’s in words, under their module', async () => {
  const entry = (id: string, action: string) => ({ id, entry: { at: new Date().toISOString(), actor: { kind: 'system' }, action, result: {} } });
  mockFetch({
    'GET /api/auth/me': me,
    'GET /api/work/pending': { ...pendingOverdue, items: [] },
    'GET /api/ledger': [
      entry('l1', 'ads.campaign.opened'),
      entry('l2', 'ads.campaign.plan_refused'),
      entry('l3', 'content.package.delivered'),
      entry('l4', 'social.version.scheduled'),
      entry('l5', 'budget.stop'),
    ],
  });
  renderAt('/');
  await userEvent.click(await screen.findByRole('button', { name: 'Günlük' }));
  const rows = within(await screen.findByRole('list', { name: 'Günlük' })).getAllByRole('listitem');
  expect(rows[0]).toHaveTextContent('bir reklam kampanyası açtı');
  expect(rows[0]).toHaveTextContent('Reklam yönetimi');
  expect(rows[1]).toHaveTextContent('kurallara uymayan bir reklam planı teslim etti');
  expect(rows[2]).toHaveTextContent('bir içerik paketi teslim etti');
  expect(rows[2]).toHaveTextContent('İçerik oluşturma');
  expect(rows[3]).toHaveTextContent('bir paylaşıma zaman verdi');
  expect(rows[3]).toHaveTextContent('Sosyal medya yönetimi');
  expect(rows[4]).toHaveTextContent('harcama durdurma ayarını değiştirdi');
  for (const row of rows) expect(row.querySelector('code')).toBeNull();
});
