import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import tr from '@/i18n/tr.json';
import { delayed, mockFetch, renderAt, withStatus } from '@/test/render';
import { LOADED, agentsList, leadsMe, row, task, taskId, team } from '@/test/leads';

const adHoc = task(2, {
  kind: { type: 'ad_hoc', target_count: 20 },
  brief: { ...task(2).brief, sectors: ['pastane'], areas: [{ city: 'Manisa', district: null }] },
  created_by: { kind: 'human', user_id: leadsMe.user_id },
});

function answers(extra: Record<string, unknown> = {}) {
  return {
    'GET /api/auth/me': leadsMe,
    'GET /api/agents': agentsList,
    'GET /api/team': team,
    'GET /api/research/tasks': {
      items: [
        { task: task(1), remaining_today: 8 },
        { task: adHoc, remaining_today: 5 },
      ],
      next: null,
    },
    [`GET /api/research/tasks/${taskId(2)}`]: { task: adHoc, remaining_today: 5, found: 5, prospects: [row(1)] },
    ...extra,
  };
}

describe('ResearchTasksPage', () => {
  it('task_progress_and_create_form', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(
      answers({
        'POST /api/research/tasks': withStatus(500, { code: 'INTERNAL', message: 'lost', details: {} }),
      }),
    );
    renderAt('/prospects/tasks');
    const [standing, oneOff] = await screen.findAllByTestId('research-task', undefined, LOADED);
    expect(within(standing).getByText('Strateji görevi · kafeler_izmir')).toBeInTheDocument();
    expect(within(standing).getByText('Bugün kalan: 8 (günlük üst sınır 20)')).toBeInTheDocument();
    expect(within(oneOff).getByText('Tek seferlik · pastane')).toBeInTheDocument();
    // The progress is read when it is opened: found of the target, and the newest prospects.
    await user.click(within(oneOff).getByRole('button', { name: new RegExp(tr.leads.tasks.progress) }));
    expect(await within(oneOff).findByText('Bulunan: 5 / 20', undefined, LOADED)).toBeInTheDocument();
    expect(within(oneOff).getByRole('link', { name: 'Örnek Kafe 1' })).toBeInTheDocument();
    expect(within(oneOff).getByRole('link', { name: tr.leads.tasks.prospectsLink })).toHaveAttribute(
      'href',
      `/prospects?task=${taskId(2)}`,
    );

    // The form mirrors the brief.
    const form = within(screen.getByRole('form', { name: tr.leads.tasks.create.title }));
    const submit = form.getByRole('button', { name: tr.leads.tasks.create.submit });
    expect(submit).toBeDisabled();
    await user.type(form.getByRole('textbox', { name: tr.leads.tasks.create.sectors }), 'kafe{Enter}pastane');
    await user.type(form.getByRole('textbox', { name: tr.leads.tasks.create.areas }), 'İzmir / Alsancak{Enter}Manisa');
    await user.type(form.getByRole('textbox', { name: tr.leads.tasks.create.exclusions }), 'zincir');
    await user.clear(form.getByRole('spinbutton', { name: tr.leads.tasks.create.dailyCap }));
    await user.type(form.getByRole('spinbutton', { name: tr.leads.tasks.create.dailyCap }), '5');
    await user.click(submit);
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST' && c.path === '/api/research/tasks')).toHaveLength(1));
    const first = calls.find((c) => c.method === 'POST' && c.path === '/api/research/tasks')!.body as Record<string, unknown>;
    expect(first).toMatchObject({
      brief: {
        segment_key: null,
        sectors: ['kafe', 'pastane'],
        areas: [
          { city: 'İzmir', district: 'Alsancak' },
          { city: 'Manisa', district: null },
        ],
        signals: [],
        exclusions: ['zincir'],
        size_hint: '',
        language: null,
        note: '',
      },
      target_count: 20,
      daily_cap: 5,
    });
    // The answer was lost: the same draft again carries the same key; a changed one a new key.
    await screen.findByText(tr.errors.INTERNAL);
    await user.click(submit);
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST' && c.path === '/api/research/tasks')).toHaveLength(2));
    await user.type(form.getByRole('textbox', { name: tr.leads.tasks.create.signals }), 'yeni şube');
    await user.click(submit);
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST' && c.path === '/api/research/tasks')).toHaveLength(3));
    const keys = calls
      .filter((c) => c.method === 'POST' && c.path === '/api/research/tasks')
      .map((c) => (c.body as { request_key: string }).request_key);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  it('create_enter_cannot_double_submit', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(
      answers({ 'POST /api/research/tasks': delayed(300, { task: task(3), remaining_today: 10 }) }),
    );
    renderAt('/prospects/tasks');
    const formEl = await screen.findByRole('form', { name: tr.leads.tasks.create.title }, LOADED);
    const form = within(formEl);
    await user.type(form.getByRole('textbox', { name: tr.leads.tasks.create.sectors }), 'kafe');
    await user.type(form.getByRole('textbox', { name: tr.leads.tasks.create.areas }), 'İzmir');
    (formEl as HTMLFormElement).requestSubmit();
    (formEl as HTMLFormElement).requestSubmit();
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST' && c.path === '/api/research/tasks')).toHaveLength(1));
  });

  it('each_claim_has_its_own_pending_state', async () => {
    const user = userEvent.setup();
    mockFetch(
      answers({
        [`POST /api/research/tasks/${taskId(1)}/claim`]: delayed(500, {
          task_id: taskId(1),
          claimed: true,
          claim: { by: { kind: 'human', user_id: leadsMe.user_id }, until: '2026-11-04T12:00:00Z' },
          held_by_other: false,
        }),
      }),
    );
    renderAt('/prospects/tasks');
    const [standing, oneOff] = await screen.findAllByTestId('research-task', undefined, LOADED);
    const claimFirst = within(standing).getByRole('button', { name: tr.leads.tasks.claim });
    const claimSecond = within(oneOff).getByRole('button', { name: tr.leads.tasks.claim });
    await user.click(claimFirst);
    await waitFor(() => expect(claimFirst).toBeDisabled());
    expect(claimSecond).toBeEnabled();
  });
});
