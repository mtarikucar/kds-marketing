import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import tr from '@/i18n/tr.json';
import { delayed, mockFetch, renderAt } from '@/test/render';
import { LOADED, agentsList, leadsMe, leadsRep, prospectId, prospectOut, team } from '@/test/leads';

const ID = prospectId(1);

function answers(extra: Record<string, unknown> = {}) {
  return {
    'GET /api/auth/me': leadsMe,
    'GET /api/agents': agentsList,
    'GET /api/team': team,
    [`GET /api/prospects/${ID}`]: prospectOut(1),
    [`GET /api/prospects/${prospectId(2)}`]: prospectOut(2, { status: 'new' }),
    'GET /api/prospects': { items: [], next: null },
    'GET /api/research/tasks': { items: [], next: null },
    ...extra,
  };
}

async function open(extra: Record<string, unknown> = {}) {
  const calls = mockFetch(answers(extra));
  const view = renderAt(`/prospects/${ID}`);
  await screen.findByRole('list', { name: tr.leads.prospect.fields }, LOADED);
  return { calls, ...view };
}

describe('ProspectDetail', () => {
  it('evidence_links_open_safely', async () => {
    await open();
    const phone = within(screen.getByRole('list', { name: 'Telefon kaynakları' }));
    const link = phone.getByRole('link', { name: 'https://ornek-kafe.example.invalid/iletisim' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    // A source that is no web page is text, never a link.
    const email = within(screen.getByRole('list', { name: 'E-posta kaynakları' }));
    expect(email.queryByRole('link')).not.toBeInTheDocument();
    expect(email.getByText('javascript:alert(1)')).toBeInTheDocument();
    // Who recorded it: the agent connection by name, and the member.
    await waitFor(() => expect(screen.getAllByText(/arastirma-ajani \(ajan, Ada Sahip adına\)/).length).toBeGreaterThan(0));
    expect(screen.getAllByText(/· Ada Sahip$/).length).toBeGreaterThan(0);
    const signals = within(screen.getByRole('list', { name: tr.leads.prospect.signals }));
    expect(signals.getByRole('link', { name: 'https://haber.example.invalid/ornek-kafe' })).toHaveAttribute(
      'rel',
      'noopener noreferrer',
    );
  });

  it('score_history_shows_reasons', async () => {
    await open();
    const history = within(screen.getByRole('list', { name: tr.leads.prospect.scores }));
    const [score] = history.getAllByTestId('score');
    expect(within(score).getByText('72')).toBeInTheDocument();
    expect(within(score).getByText('sube_sayisi')).toBeInTheDocument();
    expect(within(score).getByText('30')).toBeInTheDocument();
    expect(within(score).getByText('İki şubesi var')).toBeInTheDocument();
    expect(within(score).getByText('aktif_sosyal')).toBeInTheDocument();
    expect(within(score).getByRole('link', { name: 'https://sosyal.example.invalid/ornekkafe' })).toBeInTheDocument();
    expect(within(score).getByText('Ölçüt sürümü abc123def456')).toBeInTheDocument();
  });

  it('reject_requires_reason', async () => {
    const user = userEvent.setup();
    const { calls } = await open({ [`POST /api/prospects/${ID}/decision`]: { prospect: prospectOut(1).prospect, flags: [] } });
    await user.click(screen.getByRole('button', { name: tr.leads.actions.reject }));
    const dialog = await screen.findByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: tr.leads.reject.submit });
    expect(submit).toBeDisabled();
    // "Other" needs a note as well.
    await user.selectOptions(within(dialog).getByRole('combobox', { name: tr.leads.reject.reason }), 'other');
    expect(submit).toBeDisabled();
    await user.type(within(dialog).getByRole('textbox'), 'Yalnızca toptan satış yapıyor');
    expect(submit).toBeEnabled();
    await user.click(submit);
    await waitFor(() =>
      expect(calls.find((c) => c.path === `/api/prospects/${ID}/decision`)?.body).toEqual({
        decision: 'reject',
        reason: 'other',
        note: 'Yalnızca toptan satış yapıyor',
        expected_revision: 3,
      }),
    );
  });

  it('reject_enter_cannot_double_submit', async () => {
    const user = userEvent.setup();
    const { calls } = await open({
      [`POST /api/prospects/${ID}/decision`]: delayed(300, { prospect: prospectOut(1).prospect, flags: [] }),
    });
    await user.click(screen.getByRole('button', { name: tr.leads.actions.reject }));
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: tr.leads.reject.reason }), 'competitor');
    const form = within(dialog).getByRole('form');
    (form as HTMLFormElement).requestSubmit();
    (form as HTMLFormElement).requestSubmit();
    await waitFor(() => expect(calls.filter((c) => c.path.endsWith('/decision'))).toHaveLength(1));
  });

  it('the_reject_draft_resets_when_the_prospect_changes', async () => {
    const user = userEvent.setup();
    await open();
    await user.click(screen.getByRole('button', { name: tr.leads.actions.reject }));
    let dialog = await screen.findByRole('dialog');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: tr.leads.reject.reason }), 'other');
    await user.type(within(dialog).getByRole('textbox'), 'Taslak');
    await user.click(within(dialog).getByRole('button', { name: tr.common.cancel }));
    // Another prospect, through its duplicate link: nothing typed for the first carries over.
    await user.click(screen.getByRole('link', { name: 'Örnek Kafe 2' }));
    await screen.findByRole('heading', { name: 'Örnek Kafe 2', level: 1 }, LOADED);
    await user.click(await screen.findByRole('button', { name: tr.leads.actions.reject }));
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('combobox', { name: tr.leads.reject.reason })).toHaveValue('');
    expect(within(dialog).getByRole('textbox')).toHaveValue('');
  });

  it('dnc_requires_typed_confirmation', async () => {
    const user = userEvent.setup();
    const { calls } = await open({
      'POST /api/prospects/do-not-contact': { prospect_id: ID, prospects: [ID], people: [], kinds: ['phone', 'email'] },
    });
    await user.click(screen.getByRole('button', { name: tr.leads.actions.dnc }));
    const dialog = await screen.findByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: tr.leads.dnc.submit });
    await user.selectOptions(within(dialog).getByRole('combobox', { name: tr.leads.dnc.reason }), 'objected');
    expect(submit).toBeDisabled();
    const confirm = within(dialog).getByRole('textbox', { name: 'Onaylamak için ENGELLE yazın' });
    await user.type(confirm, 'engelle');
    expect(submit).toBeDisabled();
    await user.clear(confirm);
    await user.type(confirm, 'ENGELLE');
    await user.click(submit);
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/api/prospects/do-not-contact')?.body).toEqual({
        confirm: true,
        prospect_id: ID,
        reason: 'objected',
      }),
    );
  });

  it('erase_requires_SIL', async () => {
    const user = userEvent.setup();
    const { calls, router } = await open({
      [`POST /api/prospects/${ID}/erase`]: { prospect_id: ID, erased: true, kinds: ['phone', 'email'] },
    });
    await user.click(screen.getByRole('button', { name: tr.leads.actions.erase }));
    const dialog = await screen.findByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: tr.leads.erase.submit });
    expect(submit).toBeDisabled();
    await user.type(within(dialog).getByRole('textbox', { name: 'Onaylamak için SİL yazın' }), 'SIL');
    expect(submit).toBeDisabled();
    await user.type(within(dialog).getByRole('textbox', { name: 'Onaylamak için SİL yazın' }), '{Backspace}{Backspace}İL');
    await user.click(submit);
    await waitFor(() => expect(calls.find((c) => c.path === `/api/prospects/${ID}/erase`)?.body).toEqual({ confirm: true }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/prospects'));
  });

  it('erase_and_reopen_need_prospects_manage', async () => {
    mockFetch(answers({ 'GET /api/auth/me': leadsRep, [`GET /api/prospects/${ID}`]: prospectOut(1, { status: 'rejected' }) }));
    renderAt(`/prospects/${ID}`);
    await screen.findByRole('list', { name: tr.leads.prospect.fields }, LOADED);
    expect(screen.queryByRole('button', { name: tr.leads.actions.erase })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: tr.leads.actions.reopen })).not.toBeInTheDocument();
  });
});
