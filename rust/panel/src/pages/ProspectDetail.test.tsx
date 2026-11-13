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
    await userEvent.setup().click(screen.getByText(tr.leads.prospect.scores));
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
    await screen.findByRole('heading', { name: 'Örnek Kafe 2', level: 2 }, LOADED);
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
    await user.click(screen.getByRole('button', { name: 'Diğer işlemler' }));
    await user.click(await screen.findByRole('menuitem', { name: tr.leads.actions.dnc }));
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
    await user.click(screen.getByRole('button', { name: 'Diğer işlemler' }));
    await user.click(await screen.findByRole('menuitem', { name: tr.leads.actions.erase }));
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
    // A rep's menu holds only what a rep may do.
    await userEvent.setup().click(screen.getByRole('button', { name: 'Diğer işlemler' }));
    expect(await screen.findByRole('menuitem', { name: tr.leads.actions.dnc })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: tr.leads.actions.erase })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: tr.leads.actions.reopen })).not.toBeInTheDocument();
  });

  it('shows where the prospect stands and its progress newest first, in plain words', async () => {
    const out = prospectOut(1);
    const entry = (id: number, at: string, action: string, payload: unknown, actor: unknown = { kind: 'human', user_id: leadsMe.user_id }) => ({
      id,
      entry: { workspace_id: leadsMe.current_workspace, at, actor, action, subject: null, payload, strategy_version_id: null },
    });
    await open({
      [`GET /api/prospects/${ID}`]: {
        ...out,
        ledger: [
          entry(43, '2026-11-01T09:10:00Z', 'prospects.qualified', { auto: true, score: 72 }, { kind: 'system', component: 'prospects.auto_qualify' }),
          entry(42, '2026-11-01T09:10:00Z', 'prospects.scored', { score: 72, digest: 'abc123def456' }, { kind: 'agent', connection_id: agentsList[0].id, user_id: leadsMe.user_id }),
          entry(41, '2026-11-01T09:00:00Z', 'prospects.created', { fields: ['sector', 'city', 'phone', 'email'], via: 'research_task' }, { kind: 'agent', connection_id: agentsList[0].id, user_id: leadsMe.user_id }),
        ],
      },
    });
    const steps = within(screen.getByRole('list', { name: 'Aşama' })).getAllByRole('listitem');
    expect(steps.map((s) => s.getAttribute('data-state'))).toEqual(['done', 'done', 'now', 'todo', 'todo', 'todo', 'todo']);
    expect(steps[2]).toHaveAttribute('aria-current', 'step');
    expect(steps[2]).toHaveTextContent('Nitelikli');
    const timeline = within(screen.getByRole('list', { name: 'Akış' })).getAllByRole('listitem');
    expect(timeline).toHaveLength(3);
    expect(timeline[0]).toHaveTextContent('Nitelikli sayıldı');
    expect(timeline[0]).toHaveTextContent('otomatik · puan 72');
    expect(timeline[1]).toHaveTextContent('Puanlandı: 72');
    expect(timeline[1]).toHaveTextContent('sube_sayisi 30 · aktif_sosyal 42');
    await waitFor(() => expect(timeline[2]).toHaveTextContent('arastirma-ajani kaydetti'));
    // A new record is summed up by its contact fields and where it came from.
    expect(timeline[2]).toHaveTextContent('Telefon, E-posta · Araştırma görevi');
  });

  it('a prospect in contact shows its journey: the message sent, the reply, and the way to the conversation', async () => {
    const promoted = { person_id: 'person-1', journey_id: 'journey-1', at: '2026-11-02T10:00:00Z', score: 72, bucket: '50-74' as const };
    const event = (id: string, at: string, kind: unknown, source: unknown = 'agent') => ({
      id, workspace_id: leadsMe.current_workspace, journey_id: 'journey-1', source, kind, idempotency_key: id, reason_label: null, at,
    });
    await open({
      [`GET /api/prospects/${ID}`]: prospectOut(1, { status: 'promoted', promoted }),
      'GET /api/inbox/journeys/journey-1': {
        appointments: [], status_labels: {}, status_label_overrides: {}, tasks: [],
        journey: { id: 'journey-1', workspace_id: leadsMe.current_workspace, person_id: 'person-1', status: 'contacted', owner: null, opened_at: promoted.at, closed_at: null, updated_at: promoted.at, lost_reason: null, unreachable_attempts: 0, source: 'import' },
        events: [
          event('e2', '2026-11-03T08:00:00Z', 'message_received', 'system'),
          event('e1', '2026-11-02T10:05:00Z', 'replied', { human: leadsMe.user_id }),
        ],
        notes: [{ id: 'n1', workspace_id: leadsMe.current_workspace, journey_id: 'journey-1', author: { human: leadsMe.user_id }, text: 'Sahibiyle konuşuldu.', at: '2026-11-02T10:06:00Z' }],
      },
      'GET /api/inbox/people/person-1': {
        person: {}, identities: [], open_journey: null,
        conversations: [{ id: 'conv-9', updated_at: '2026-11-03T08:00:00Z' }],
      },
    });
    const steps = within(screen.getByRole('list', { name: 'Aşama' })).getAllByRole('listitem');
    await waitFor(() => expect(steps[4]).toHaveAttribute('aria-current', 'step'));
    expect(steps[4]).toHaveTextContent('Yanıt');
    const timeline = within(screen.getByRole('list', { name: 'Akış' }));
    const [reply, note, sent] = timeline.getAllByRole('listitem');
    expect(reply).toHaveTextContent('Mesaj geldi');
    expect(note).toHaveTextContent('Ada Sahip not ekledi');
    expect(note).toHaveTextContent('Sahibiyle konuşuldu.');
    expect(sent).toHaveTextContent('Mesaj gönderildi');
    // Message entries and the header lead to the conversation itself.
    expect(within(reply).getByRole('link', { name: 'Mesaj geldi' })).toHaveAttribute('href', '/inbox/conv-9');
    expect(screen.getByRole('link', { name: 'Konuşmayı aç' })).toHaveAttribute('href', '/inbox/conv-9');
    // In contact, the pool no longer edits or rejects it.
    expect(screen.queryByRole('button', { name: tr.leads.actions.reject })).not.toBeInTheDocument();
  });

  it('a message handed off to WhatsApp counts as contact: the step moves and the timeline says who wrote', async () => {
    const promoted = { person_id: 'person-1', journey_id: 'journey-1', at: '2026-11-02T10:00:00Z', score: 72, bucket: '50-74' as const };
    await open({
      [`GET /api/prospects/${ID}`]: prospectOut(1, { status: 'promoted', promoted }),
      'GET /api/inbox/journeys/journey-1': {
        appointments: [], status_labels: {}, status_label_overrides: {}, tasks: [], events: [],
        journey: { id: 'journey-1', workspace_id: leadsMe.current_workspace, person_id: 'person-1', status: 'new', owner: null, opened_at: promoted.at, closed_at: null, updated_at: promoted.at, lost_reason: null, unreachable_attempts: 0, source: 'import' },
        notes: [{ id: 'n1', workspace_id: leadsMe.current_workspace, journey_id: 'journey-1', author: { human: leadsMe.user_id }, text: '↗ WhatsApp: Merhaba, tanışmak isteriz.', at: '2026-11-02T10:06:00Z' }],
      },
      'GET /api/inbox/people/person-1': { person: {}, identities: [], open_journey: null, conversations: [] },
    });
    const steps = within(screen.getByRole('list', { name: 'Aşama' })).getAllByRole('listitem');
    await waitFor(() => expect(steps[3]).toHaveAttribute('aria-current', 'step'));
    expect(steps[3]).toHaveTextContent('Mesaj atıldı');
    const [entry] = within(screen.getByRole('list', { name: 'Akış' })).getAllByRole('listitem');
    expect(entry).toHaveTextContent('Ada Sahip WhatsApp üzerinden yazdı');
    expect(entry).toHaveTextContent('Merhaba, tanışmak isteriz.');
    expect(entry).not.toHaveTextContent('↗');
    // No conversation exists yet (Jeeta sent nothing): the way in is the person in the inbox.
    expect(screen.getByRole('link', { name: 'Konuşmayı aç' })).toHaveAttribute('href', '/inbox?person=person-1');
  });

  it('edits the note in place and saves it against the revision shown', async () => {
    const user = userEvent.setup();
    const { calls } = await open({ [`PATCH /api/prospects/${ID}`]: { prospect: prospectOut(1).prospect, flags: [] } });
    await user.click(screen.getByRole('button', { name: 'Not ekle' }));
    const box = screen.getByRole('textbox', { name: 'Not metni' });
    const save = screen.getByRole('button', { name: 'Kaydet' });
    expect(save).toBeDisabled();
    await user.type(box, 'Sahibi hafta içi 10–12 arası müsait.');
    await user.click(save);
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH' && c.path === `/api/prospects/${ID}`)?.body).toEqual({
        expected_revision: 3,
        set: { notes: 'Sahibi hafta içi 10–12 arası müsait.' },
      }),
    );
  });

  it('shows an existing note prominently and clears it when emptied', async () => {
    const user = userEvent.setup();
    const { calls } = await open({
      [`GET /api/prospects/${ID}`]: prospectOut(1, { notes: 'Tek şubeli, sadakat kartı yok.' }),
      [`PATCH /api/prospects/${ID}`]: { prospect: prospectOut(1).prospect, flags: [] },
    });
    expect(screen.getByTestId('prospect-notes')).toHaveTextContent('Tek şubeli, sadakat kartı yok.');
    await user.click(screen.getByRole('button', { name: 'Düzenle' }));
    const box = screen.getByRole('textbox', { name: 'Not metni' });
    expect(box).toHaveValue('Tek şubeli, sadakat kartı yok.');
    await user.clear(box);
    await user.click(screen.getByRole('button', { name: 'Kaydet' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ expected_revision: 3, clear: ['notes'] }),
    );
  });

  it('edits the details in a form and sends only what changed', async () => {
    const user = userEvent.setup();
    const { calls } = await open({ [`PATCH /api/prospects/${ID}`]: { prospect: prospectOut(1).prospect, flags: [] } });
    await user.click(screen.getByRole('button', { name: 'Bilgileri düzenle' }));
    const form = within(screen.getByRole('form', { name: 'Bilgileri düzenle' }));
    // The name and kind are fixed once recorded; with nothing changed there is nothing to save.
    expect(form.queryByRole('textbox', { name: /İşletme adı/ })).not.toBeInTheDocument();
    const save = form.getByRole('button', { name: 'Kaydet' });
    expect(save).toBeDisabled();
    expect(form.getByRole('textbox', { name: tr.leads.fields.phone })).toHaveValue('+905000000000');

    const city = form.getByRole('textbox', { name: 'Şehir' });
    await user.clear(city);
    await user.type(city, 'Ankara');
    await user.clear(form.getByRole('textbox', { name: tr.leads.fields.email }));
    await user.type(form.getByRole('textbox', { name: tr.leads.fields.instagram }), 'ornekkafe');
    const source = form.getByRole('textbox', { name: /nereden biliyorsun/ });
    await user.clear(source);
    await user.type(source, 'Telefonda sordum');
    await user.click(save);
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    const body = calls.find((c) => c.method === 'PATCH' && c.path === `/api/prospects/${ID}`)!.body as {
      set: Record<string, unknown>;
    };
    expect(body).toMatchObject({
      expected_revision: 3,
      set: { city: 'Ankara', instagram: { value: 'ornekkafe', sources: [{ kind: 'manual', note: 'Telefonda sordum' }] } },
      clear: ['email'],
    });
    // The phone was not touched: it is not sent, so it keeps the agent's evidence.
    expect(body.set).not.toHaveProperty('phone');
  });

  it('a blocked prospect is not edited in the pool', async () => {
    await open({
      [`GET /api/prospects/${ID}`]: prospectOut(1, { status: 'do_not_contact' }),
    });
    expect(screen.queryByRole('button', { name: 'Bilgileri düzenle' })).not.toBeInTheDocument();
  });
});
