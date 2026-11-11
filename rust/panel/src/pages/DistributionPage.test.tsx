import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import tr from '@/i18n/tr.json';
import { delayed, mockFetch, renderAt } from '@/test/render';
import { LOADED, REP_ID, distribution, leadsMe, leadsRep } from '@/test/leads';

const log = {
  items: [
    {
      id: '0190a000-0000-7000-8000-000000000601',
      journey_id: '0190a000-0000-7000-8000-000000000501',
      user_id: REP_ID,
      cause: 'rule',
      rule_id: distribution.rules[0].id,
      assigned_at: '2026-11-03T09:00:00Z',
      sla_due_at: '2026-11-03T10:00:00Z',
      acted_at: null,
      superseded_at: null,
      by: { kind: 'system', component: 'lead_distribution' },
    },
    {
      id: '0190a000-0000-7000-8000-000000000602',
      journey_id: '0190a000-0000-7000-8000-000000000502',
      user_id: null,
      cause: 'no_eligible',
      rule_id: null,
      assigned_at: '2026-11-03T08:00:00Z',
      sla_due_at: null,
      acted_at: null,
      superseded_at: null,
      by: { kind: 'system', component: 'lead_distribution' },
    },
  ],
  next: { assigned_at: '2026-11-03T08:00:00Z', id: '0190a000-0000-7000-8000-000000000602' },
};

function answers(extra: Record<string, unknown> = {}) {
  return {
    'GET /api/auth/me': leadsMe,
    'GET /api/distribution': distribution,
    'GET /api/distribution/assignments': log,
    ...extra,
  };
}

const ruleNames = () =>
  screen.getAllByTestId('rule').map((r) => (within(r).getByRole('textbox', { name: tr.leads.distribution.rules.name }) as HTMLInputElement).value);

describe('DistributionPage', () => {
  it('rules_reorder_and_save', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(answers({ 'PUT /api/distribution/rules': distribution }));
    renderAt('/team/distribution');
    await screen.findByRole('list', { name: tr.leads.distribution.rules.list }, LOADED);
    expect(ruleNames()).toEqual(['İzmir kafeleri', 'Reklam formları']);
    await user.click(screen.getByRole('button', { name: 'Reklam formları kuralını yukarı taşı' }));
    expect(ruleNames()).toEqual(['Reklam formları', 'İzmir kafeleri']);
    await user.selectOptions(screen.getByRole('combobox', { name: tr.leads.distribution.mode }), 'manual');
    await user.click(screen.getByRole('button', { name: tr.leads.distribution.rules.save }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT' && c.path === '/api/distribution/rules')?.body).toEqual({
        rules: [
          {
            id: distribution.rules[1].id,
            name: 'Reklam formları',
            enabled: true,
            when: distribution.rules[1].when,
            to: { kind: 'all_eligible' },
            method: 'least_loaded',
            sla_minutes: null,
          },
          {
            id: distribution.rules[0].id,
            name: 'İzmir kafeleri',
            enabled: true,
            when: distribution.rules[0].when,
            to: { kind: 'members', user_ids: [REP_ID] },
            method: 'round_robin',
            sla_minutes: 60,
          },
        ],
        mode: 'manual',
        max_reassignments: 2,
      }),
    );
  });

  it('rules_save_enter_cannot_double_submit', async () => {
    const calls = mockFetch(answers({ 'PUT /api/distribution/rules': delayed(300, distribution) }));
    renderAt('/team/distribution');
    const form = await screen.findByRole('form', { name: tr.leads.distribution.rules.title }, LOADED);
    (form as HTMLFormElement).requestSubmit();
    (form as HTMLFormElement).requestSubmit();
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1));
  });

  it('rep_can_edit_only_own_row', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(
      answers({
        'GET /api/auth/me': leadsRep,
        [`PUT /api/distribution/reps/${REP_ID}`]: distribution.reps[1],
      }),
    );
    renderAt('/team/distribution');
    await user.click(await screen.findByRole('tab', { name: tr.leads.distribution.reps.title }, LOADED));
    const [owner, rep] = await screen.findAllByTestId('rep', undefined, LOADED);
    expect(within(owner).queryByRole('button')).not.toBeInTheDocument();
    // Without inbox.manage: the rules are shown, not edited, and there is no backfill.
    expect(screen.queryByRole('form', { name: tr.leads.distribution.rules.title })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: tr.leads.distribution.backfill })).not.toBeInTheDocument();
    await user.click(within(rep).getByRole('button', { name: 'Rana Temsilci için düzenle' }));
    const form = within(screen.getByRole('form', { name: 'Rana Temsilci: müsaitlik' }));
    const maxOpen = form.getByRole('spinbutton', { name: tr.leads.distribution.reps.maxOpen });
    await user.clear(maxOpen);
    await user.type(maxOpen, '25');
    await user.click(form.getByRole('button', { name: tr.common.save }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT' && c.path === `/api/distribution/reps/${REP_ID}`)?.body).toEqual({
        accepting: true,
        max_open: 25,
        languages: ['tr'],
        cities: ['İzmir'],
        sectors: [],
        hours: null,
        away_until: null,
      }),
    );
  });

  it('rep_editor_resets_when_another_member_is_chosen', async () => {
    const user = userEvent.setup();
    mockFetch(answers());
    renderAt('/team/distribution');
    await user.click(await screen.findByRole('tab', { name: tr.leads.distribution.reps.title }, LOADED));
    const [owner, rep] = await screen.findAllByTestId('rep', undefined, LOADED);
    await user.click(within(rep).getByRole('button', { name: 'Rana Temsilci için düzenle' }));
    const languages = within(screen.getByRole('form', { name: 'Rana Temsilci: müsaitlik' })).getByRole('textbox', {
      name: tr.leads.distribution.reps.languages,
    });
    await user.clear(languages);
    await user.type(languages, 'en');
    await user.click(within(owner).getByRole('button', { name: 'Ada Sahip için düzenle' }));
    const ada = within(screen.getByRole('form', { name: 'Ada Sahip: müsaitlik' }));
    expect(ada.getByRole('textbox', { name: tr.leads.distribution.reps.languages })).toHaveValue('');
    expect(screen.queryByRole('form', { name: 'Rana Temsilci: müsaitlik' })).not.toBeInTheDocument();
  });

  it('ownerless_count_and_backfill', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(
      answers({ 'POST /api/distribution/backfill': { assigned: 2, no_eligible: 1, imported: 0, reassigned: 0, kept: 0 } }),
    );
    renderAt('/team/distribution');
    const ownerless = await screen.findByText(tr.leads.distribution.ownerless, undefined, LOADED);
    expect(ownerless.parentElement).toHaveTextContent('3');
    expect(screen.getByText(tr.leads.distribution.stalled).parentElement).toHaveTextContent('1');
    await user.click(screen.getByRole('button', { name: tr.leads.distribution.backfill }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/distribution/backfill')?.body).toEqual({}));
    expect(await screen.findByText('2 yolculuğa sahip atandı; 1 için uygun kimse yok.')).toBeInTheDocument();
  });

  it('assignment_log', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(answers());
    renderAt('/team/distribution');
    await user.click(await screen.findByRole('tab', { name: tr.leads.distribution.log.title }, LOADED));
    const [first, second] = await screen.findAllByTestId('assignment', undefined, LOADED);
    expect(first).toHaveTextContent('Rana Temsilci');
    expect(first).toHaveTextContent(tr.leads.causes.rule);
    expect(first).toHaveTextContent('İzmir kafeleri');
    expect(second).toHaveTextContent(tr.leads.causes.no_eligible);
    const q = () =>
      calls
        .filter((c) => c.path === '/api/distribution/assignments')
        .map((c) => new URLSearchParams(c.search))
        .at(-1)!;
    await user.selectOptions(screen.getByRole('combobox', { name: tr.leads.distribution.log.member }), REP_ID);
    await waitFor(() => expect(q().get('user_id')).toBe(REP_ID));
    expect(q().get('before_id')).toBeNull();
    await user.click(screen.getByRole('button', { name: tr.leads.prospects.next }));
    await waitFor(() => {
      expect(q().get('before_id')).toBe(log.next.id);
      expect(q().get('before_at')).toBe(log.next.assigned_at);
      expect(q().get('user_id')).toBe(REP_ID);
    });
  });
});


it('keeps an unsaved rule draft while switching distribution sections', async () => {
  mockFetch(answers());
  renderAt('/team/distribution');
  const user = userEvent.setup();
  const name = within((await screen.findAllByTestId('rule', undefined, LOADED))[0]).getByRole('textbox', { name: tr.leads.distribution.rules.name });
  await user.clear(name);
  await user.type(name, 'Yeni taslak');
  await user.click(screen.getByRole('tab', { name: tr.leads.distribution.reps.title }));
  expect(screen.getByRole('tabpanel', { name: tr.leads.distribution.reps.title })).toBeVisible();
  await user.click(screen.getByRole('tab', { name: tr.leads.distribution.rules.title }));
  expect(name).toHaveValue('Yeni taslak');
});

it('keeps existing rule details compact and opens a newly added rule for editing', async () => {
  mockFetch(answers());
  renderAt('/team/distribution');
  const user = userEvent.setup();
  const existing = await screen.findAllByTestId('rule', undefined, LOADED);
  const summary = within(existing[0]).getByText('Eşleşme ve yönlendirme');
  expect(summary.closest('details')).not.toHaveAttribute('open');
  await user.click(summary);
  expect(summary.closest('details')).toHaveAttribute('open');
  await user.click(screen.getByRole('button', { name: tr.leads.distribution.rules.add }));
  const rows = screen.getAllByTestId('rule');
  expect(within(rows[2]).getByText('Eşleşme ve yönlendirme').closest('details')).toHaveAttribute('open');
  expect(within(rows[2]).getByRole('textbox', { name: tr.leads.distribution.rules.name })).toBeVisible();
});

it('explains invalid rule numbers even after their details are closed', async () => {
  const calls = mockFetch(answers({ 'PUT /api/distribution/rules': distribution }));
  renderAt('/team/distribution');
  const user = userEvent.setup();
  const row = (await screen.findAllByTestId('rule', undefined, LOADED))[0];
  const summary = within(row).getByText('Eşleşme ve yönlendirme');
  await user.click(summary);
  const score = within(row).getByRole('spinbutton', { name: tr.leads.distribution.rules.minScore });
  await user.type(score, '101');
  const sla = within(row).getByRole('spinbutton', { name: tr.leads.distribution.rules.sla });
  await user.clear(sla);
  await user.type(sla, '2');
  await user.click(summary);
  expect(summary.closest('details')).not.toHaveAttribute('open');
  expect(screen.getByRole('alert')).toHaveTextContent('İzmir kafeleri: En düşük puan 0 ile 100');
  expect(screen.getByRole('alert')).toHaveTextContent('İzmir kafeleri: İlk temas süresi 5 ile 10080');
  expect(screen.getByRole('button', { name: tr.leads.distribution.rules.save })).toBeDisabled();
  expect(calls.some((call) => call.method === 'PUT')).toBe(false);
  await user.click(summary);
  await user.clear(score);
  await user.type(score, '50');
  await user.clear(sla);
  await user.type(sla, '60');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: tr.leads.distribution.rules.save })).toBeEnabled();
});

it('explains an empty member pool and an invalid reassignment limit', async () => {
  mockFetch(answers());
  renderAt('/team/distribution');
  const user = userEvent.setup();
  const row = (await screen.findAllByTestId('rule', undefined, LOADED))[0];
  const summary = within(row).getByText('Eşleşme ve yönlendirme');
  await user.click(summary);
  await user.click(within(row).getByRole('checkbox', { name: 'Rana Temsilci' }));
  await user.click(summary);
  const limit = screen.getByRole('spinbutton', { name: tr.leads.distribution.maxReassignments });
  await user.clear(limit);
  await user.type(limit, '11');
  expect(screen.getByRole('alert')).toHaveTextContent('İzmir kafeleri: En az bir üye seçin');
  expect(screen.getByRole('alert')).toHaveTextContent('Yeniden atama sınırı 0 ile 10');
  expect(screen.getByRole('button', { name: tr.leads.distribution.rules.save })).toBeDisabled();
});

it('allows an optional missing SLA without treating it as invalid', async () => {
  const noSla = { ...distribution, rules: distribution.rules.map((r) => ({ ...r, sla_minutes: undefined })) };
  mockFetch(answers({ 'GET /api/distribution': noSla }));
  renderAt('/team/distribution');
  expect(await screen.findByRole('button', { name: tr.leads.distribution.rules.save }, LOADED)).toBeEnabled();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
