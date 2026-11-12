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
