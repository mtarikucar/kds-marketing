import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ListedTask, ResearchTask } from '@/api/types';
import { approvedVersion, sections } from '@/test/fixtures';
import { AGENT_CONNECTION_ID, LOADED, REP_ID, agentsList, leadsMe, leadsRep, row, task, taskId, team } from '@/test/leads';
import { delayed, mockFetch, renderAt, withStatus, type FetchCall } from '@/test/render';
import { TASK_COPY } from './research/copy';
import { knowledge } from '@/test/knowledge';

const SEEK_CARD = '0190a000-0000-7000-8000-0000000000c9';

// The research tasks page as the owner reads it: one row per task, counted chips, rows that open
// in place, a person's claim said for what it is, closing and a two-field composer.

const hour = 3_600_000;
const at = (ms: number) => new Date(Date.now() + ms).toISOString();
const CITIES = ['İstanbul', 'Ankara', 'İzmir', 'Bursa', 'Antalya', 'Konya', 'Adana', 'Gaziantep', 'Kocaeli', 'Mersin', 'Kayseri', 'Eskişehir', 'Samsun', 'Denizli', 'Trabzon', 'Malatya'];

const bayi = task(1, {
  kind: { type: 'standing', icp_key: 'bayi_adayi' },
  daily_cap: 5,
  brief: {
    segment_key: 'bayi',
    sectors: ['Fotoğraf stüdyosu', 'Dijital baskı ve kopyalama merkezi', 'Kişiye özel ürün ve hediye dükkânı', 'Kırtasiye ve hobi mağazası'],
    areas: CITIES.map((city) => ({ city, district: null })),
    signals: ['Kişiye özel baskılı ürün sergiliyor'],
    exclusions: ['Ulusal zincirlerin şubeleri'],
    size_hint: 'Tek ya da birkaç şubeli yerel işletme',
    language: 'tr',
    note: '',
  },
});
const okul = task(2, {
  kind: { type: 'standing', icp_key: 'okul_isbirligi' },
  daily_cap: 5,
  brief: { ...bayi.brief, segment_key: 'okul', sectors: ['Özel ilkokul'], areas: [{ city: 'İzmir', district: null }] },
});
const pastane = task(3, {
  kind: { type: 'ad_hoc', target_count: 20 },
  daily_cap: 5,
  created_by: { kind: 'human', user_id: leadsMe.user_id },
  brief: { segment_key: null, sectors: ['Pastane', 'Butik kafe'], areas: [{ city: 'İzmir', district: 'Alsancak' }, { city: 'Manisa', district: null }], signals: [], exclusions: [], size_hint: '', language: null, note: '' },
});

const listed = (t: ResearchTask, extra: Partial<ListedTask> = {}): ListedTask => ({
  task: t, remaining_today: 4, found: 0, qualified: 0, found_today: 0, last_found_at: null, ...extra,
});

const OPEN = [
  listed(bayi, { found: 121, qualified: 53, found_today: 1, last_found_at: at(-2 * hour) }),
  listed(okul, { found: 52, qualified: 24, found_today: 0, remaining_today: 5, last_found_at: at(-30 * hour) }),
  listed(pastane, { found: 3, qualified: 1, found_today: 1, last_found_at: at(-5 * hour) }),
];
const CLOSED = [
  listed(task(4, { ...pastane, id: taskId(4), status: 'done', closed_at: at(-30 * hour), close_note: 'target reached' }), { remaining_today: 0, found: 20, qualified: 9 }),
  listed(task(5, { ...pastane, id: taskId(5), status: 'canceled', closed_at: at(-80 * hour), close_note: 'Sezon bitti.' }), { remaining_today: 0, found: 4 }),
  listed(task(6, { ...bayi, id: taskId(6), status: 'superseded', closed_at: at(-300 * hour) }), { remaining_today: 0, found: 77, qualified: 30 }),
];

const strategy = {
  approved: { ...approvedVersion, sections: { ...sections, audience: [{ key: 'bayi', name: 'Bayi adayları', description: '' }, { key: 'okul', name: 'Okul işbirlikleri', description: '' }] } },
  draft: null,
  gaps: [],
};
const KEY_ID = agentsList[0].api_key_id;
const keys = [{ id: KEY_ID, name: 'Gece işleri', prefix: 'jt_', scopes: ['prospects.work'], status: 'active', issued_by: leadsMe.user_id, created_at: at(-900 * hour), last_used_at: null, revoked_at: null }];
const onTime = agentsList.map((a) => ({ ...a, last_seen_at: at(-0.1 * hour), overdue: false }));
const late = agentsList.map((a) => ({ ...a, last_seen_at: '2026-11-17T09:10:00Z', overdue: true }));

function answers(extra: Record<string, unknown> = {}, open: ListedTask[] = OPEN, closed: ListedTask[] = CLOSED) {
  return {
    'GET /api/auth/me': { ...leadsMe, memberships: [{ ...leadsMe.memberships[0], permissions: [...leadsMe.memberships[0].permissions, 'api_keys.manage'] }] },
    'GET /api/agents': onTime,
    'GET /api/api-keys': keys,
    'GET /api/team': team,
    'GET /api/strategy': strategy,
    'GET /api/knowledge': { ...knowledge, cards: [{ ...knowledge.cards[3], id: SEEK_CARD }] },
    'GET /api/research/tasks?status=open&limit=200': { items: open, next: null },
    'GET /api/research/tasks?limit=200': { items: [...open, ...closed], next: null },
    [`GET /api/research/tasks/${taskId(1)}`]: { task: bayi, remaining_today: 4, found: 121, prospects: [row(1), row(2, { status: 'new' })] },
    ...extra,
  };
}

const rows = () => screen.findAllByTestId('research-task', undefined, LOADED);
const rowNamed = async (name: string) => (await screen.findByRole('article', { name }, LOADED));
const posts = (calls: FetchCall[], path: string) => calls.filter((c) => c.method === 'POST' && c.path === path);

describe('ResearchTasksPage', () => {
  it('rows_read_at_a_glance', async () => {
    mockFetch(answers());
    renderAt('/prospects/tasks');
    const [first, second, third] = await rows();
    // The audience's name, never the ICP key or the segment key.
    expect(within(first).getByText('Bayi adayları')).toBeInTheDocument();
    expect(within(first).getByText('Fotoğraf stüdyosu, Dijital baskı ve kopyalama merkezi +2 · 16 şehir')).toBeInTheDocument();
    expect(first).toHaveTextContent('121 bulundu');
    expect(first).toHaveTextContent('53 nitelikli');
    expect(first).toHaveTextContent('bugün 1/5 · son aday 2 saat önce');
    expect(first).toHaveTextContent('Bir ajanın alması bekleniyor');
    expect(screen.queryByText(/bayi_adayi|okul_isbirligi/)).not.toBeInTheDocument();
    expect(within(second).getByText('Okul işbirlikleri')).toBeInTheDocument();
    expect(second).toHaveTextContent('bugün 0/5');
    // A one-off task is named by what it looks for, its target beside what it found.
    expect(within(third).getByText('Pastane, Butik kafe')).toBeInTheDocument();
    expect(within(third).getByText('İzmir / Alsancak, Manisa · Tek seferlik')).toBeInTheDocument();
    expect(third).toHaveTextContent('3/20 bulundu');
    // No raw status, no "claim" as the row's main button.
    expect(screen.queryByRole('button', { name: /Üstlen/ })).not.toBeInTheDocument();
    expect(screen.queryByText('open')).not.toBeInTheDocument();
  });

  it('a_row_says_who_holds_the_task_and_when_it_is_done_for_today', async () => {
    const byAgent = task(1, { ...bayi, claim: { by: { kind: 'agent', connection_id: AGENT_CONNECTION_ID, user_id: leadsMe.user_id }, until: at(hour) } });
    const byMe = task(2, { ...okul, claim: { by: { kind: 'human', user_id: leadsMe.user_id }, until: at(hour) } });
    const byRep = task(3, { ...pastane, claim: { by: { kind: 'human', user_id: REP_ID }, until: at(hour) } });
    const expired = task(7, { ...pastane, id: taskId(7), claim: { by: { kind: 'human', user_id: REP_ID }, until: at(-hour) } });
    const full = task(8, { ...okul, id: taskId(8) });
    mockFetch(answers({}, [
      listed(byAgent), listed(byMe), listed(byRep), listed(expired),
      listed(full, { remaining_today: 0, found_today: 5 }),
    ]));
    renderAt('/prospects/tasks');
    const [agent, me, rep, free, done] = await rows();
    await waitFor(() => expect(agent).toHaveTextContent('arastirma-ajani bu görevde · bitiş'));
    expect(me).toHaveTextContent('Sen bu görevdesin · bitiş');
    await waitFor(() => expect(rep).toHaveTextContent('Rana Temsilci bu görevde · bitiş'));
    expect(free).toHaveTextContent('Bir ajanın alması bekleniyor');
    expect(done).toHaveTextContent('Bugünlük tamam');
  });

  it('counted_chips_filter_open_and_closed', async () => {
    const user = userEvent.setup();
    mockFetch(answers());
    renderAt('/prospects/tasks');
    const chips = within(await screen.findByRole('group', { name: 'Görevler' }, LOADED));
    const open = await chips.findByRole('button', { name: 'Açık 3' }, LOADED);
    expect(open).toHaveAttribute('aria-pressed', 'true');
    await user.click(await chips.findByRole('button', { name: 'Kapanan 3' }, LOADED));
    const [done, canceled, superseded] = await rows();
    // Every closed status the server has stays reachable, each in words.
    expect(done).toHaveTextContent('Tamamlandı ·');
    expect(canceled).toHaveTextContent('İptal edildi ·');
    expect(superseded).toHaveTextContent('Bilgi bankası değişince kapandı ·');
    expect(done).not.toHaveTextContent('bugün');
  });

  it('a_filter_that_matches_nothing_says_so', async () => {
    const user = userEvent.setup();
    mockFetch(answers({}, OPEN, []));
    renderAt('/prospects/tasks');
    await user.click(await screen.findByRole('button', { name: 'Kapanan 0' }, LOADED));
    expect(await screen.findByText('Kapanan görev yok.')).toBeInTheDocument();
    expect(screen.queryByTestId('research-task')).not.toBeInTheDocument();
  });

  it('no_tasks_at_all_reads_as_an_empty_page_with_one_way_to_start', async () => {
    mockFetch(answers({}, [], []));
    renderAt('/prospects/tasks');
    expect(await screen.findByText('Henüz araştırma görevi yok', undefined, LOADED)).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Görevler' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Yeni görev' })).toHaveLength(1);
  });

  it('opening_a_row_shows_the_brief_the_newest_and_the_pool', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(answers());
    renderAt('/prospects/tasks');
    const row1 = await rowNamed('Bayi adayları');
    const toggle = within(row1).getAllByRole('button')[0];
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // Nothing is read for a row until it opens.
    expect(calls.some((c) => c.path === `/api/research/tasks/${taskId(1)}`)).toBe(false);
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const panel = within(document.getElementById(toggle.getAttribute('aria-controls')!)!);
    expect(panel.getByText('Fotoğraf stüdyosu, Dijital baskı ve kopyalama merkezi, Kişiye özel ürün ve hediye dükkânı, Kırtasiye ve hobi mağazası')).toBeInTheDocument();
    expect(panel.getByText('Türkçe')).toBeInTheDocument();
    expect(panel.getByText('Ulusal zincirlerin şubeleri')).toBeInTheDocument();
    expect(panel.getByText('Günde en çok 5 aday.')).toBeInTheDocument();
    // Long place lists open on demand.
    expect(panel.queryByText(/Malatya/)).not.toBeInTheDocument();
    await user.click(panel.getByRole('button', { name: 'Tümünü göster (16)' }));
    expect(panel.getByText(/Malatya/)).toBeInTheDocument();
    // It comes from the knowledge base's "Kimi arıyoruz" card, which is where it changes; there is no close for it.
    expect(await panel.findByRole('link', { name: 'Bilgi bankasında değiştir' }, LOADED)).toHaveAttribute('href', `/knowledge?card=${SEEK_CARD}`);
    expect(panel.queryByRole('button', { name: 'Görevi kapat' })).not.toBeInTheDocument();
    expect(await panel.findByRole('link', { name: 'Örnek Kafe 1' }, LOADED)).toHaveAttribute('href', expect.stringContaining('/prospects/'));
    expect(panel.getByRole('link', { name: 'Bu görevin 121 adayını havuzda gör' })).toHaveAttribute('href', `/prospects?task=${taskId(1)}`);
  });

  it('a_closed_task_says_why_it_closed', async () => {
    const user = userEvent.setup();
    mockFetch(answers());
    renderAt('/prospects/tasks');
    await user.click(await screen.findByRole('button', { name: 'Kapanan 3' }, LOADED));
    const [done, canceled] = await rows();
    await user.click(within(done).getAllByRole('button')[0]);
    expect(within(done).getByText('Hedefe ulaşınca kendiliğinden kapandı.')).toBeInTheDocument();
    expect(within(done).queryByText(/target reached/)).not.toBeInTheDocument();
    await user.click(within(canceled).getAllByRole('button')[0]);
    expect(within(canceled).getByText('Kapanış notu: Sezon bitti.')).toBeInTheDocument();
    expect(within(canceled).queryByRole('button', { name: /İki saatliğine/ })).not.toBeInTheDocument();
  });

  it('a_persons_claim_says_what_it_does', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(answers({
      [`POST /api/research/tasks/${taskId(1)}/claim`]: delayed(200, {
        task_id: taskId(1), claimed: true, held_by_other: false,
        claim: { by: { kind: 'human', user_id: leadsMe.user_id }, until: at(2 * hour) },
      }),
    }));
    renderAt('/prospects/tasks');
    const row1 = await rowNamed('Bayi adayları');
    await user.click(within(row1).getAllByRole('button')[0]);
    expect(within(row1).getByText(/ajanlara görevin sende olduğu söylenir, o sürede başka görevlere yönelirler\. Aday eklemeleri engellenmez\./)).toBeInTheDocument();
    const claim = within(row1).getByRole('button', { name: 'İki saatliğine ben bakıyorum' });
    await user.click(claim);
    await waitFor(() => expect(claim).toBeDisabled());
    await waitFor(() => expect(posts(calls, `/api/research/tasks/${taskId(1)}/claim`)).toHaveLength(1));
    expect(await screen.findByText('Görev iki saatliğine sende.')).toBeInTheDocument();
  });

  it('a_claim_held_by_someone_else_is_said_not_offered_and_mine_is_renewed', async () => {
    const user = userEvent.setup();
    const byAgent = task(1, { ...bayi, claim: { by: { kind: 'agent', connection_id: AGENT_CONNECTION_ID, user_id: leadsMe.user_id }, until: at(hour) } });
    const byMe = task(2, { ...okul, claim: { by: { kind: 'human', user_id: leadsMe.user_id }, until: at(hour) } });
    mockFetch(answers({}, [listed(byAgent, { found: 0 }), listed(byMe, { found: 0 })]));
    renderAt('/prospects/tasks');
    const [agent, me] = await rows();
    await user.click(within(agent).getAllByRole('button')[0]);
    await waitFor(() => expect(within(agent).getByText(/arastirma-ajani bu görevde \(bitiş .+\); süre dolmadan başkası üstlenemez\./)).toBeInTheDocument());
    expect(within(agent).queryByRole('button', { name: /İki saat/ })).not.toBeInTheDocument();
    await user.click(within(me).getAllByRole('button')[0]);
    expect(within(me).getByRole('button', { name: 'İki saat daha uzat' })).toBeInTheDocument();
  });

  it('a_claim_taken_meanwhile_is_told', async () => {
    const user = userEvent.setup();
    mockFetch(answers({
      [`POST /api/research/tasks/${taskId(1)}/claim`]: {
        task_id: taskId(1), claimed: false, held_by_other: true,
        claim: { by: { kind: 'agent', connection_id: AGENT_CONNECTION_ID, user_id: leadsMe.user_id }, until: at(hour) },
      },
    }));
    renderAt('/prospects/tasks');
    const row1 = await rowNamed('Bayi adayları');
    await user.click(within(row1).getAllByRole('button')[0]);
    await user.click(within(row1).getByRole('button', { name: 'İki saatliğine ben bakıyorum' }));
    expect(await screen.findByText('Görevi bu arada başkası üstlendi.')).toBeInTheDocument();
  });

  it('closing_a_one_off_task_in_place', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(answers({
      [`POST /api/research/tasks/${taskId(3)}/close`]: { task: { ...pastane, status: 'canceled' }, remaining_today: 0 },
    }));
    renderAt('/prospects/tasks');
    const row3 = await rowNamed('Pastane, Butik kafe');
    await user.click(within(row3).getAllByRole('button')[0]);
    await user.click(within(row3).getByRole('button', { name: 'Görevi kapat' }));
    const form = within(within(row3).getByRole('form', { name: 'Görevi kapat' }));
    await user.type(form.getByRole('textbox', { name: 'Kapanış notu (isteğe bağlı)' }), 'Yeterli');
    // Enter in the note does not pick an outcome for the person.
    await user.keyboard('{Enter}');
    expect(posts(calls, `/api/research/tasks/${taskId(3)}/close`)).toHaveLength(0);
    await user.click(form.getByRole('button', { name: 'İptal et' }));
    await waitFor(() => expect(posts(calls, `/api/research/tasks/${taskId(3)}/close`)).toHaveLength(1));
    expect(posts(calls, `/api/research/tasks/${taskId(3)}/close`)[0].body).toEqual({ outcome: 'canceled', note: 'Yeterli' });
    expect(await screen.findByText('Görev kapatıldı.')).toBeInTheDocument();
  });

  it('closing_is_refused_by_the_server_in_words', async () => {
    const user = userEvent.setup();
    mockFetch(answers({
      [`POST /api/research/tasks/${taskId(3)}/close`]: withStatus(409, { code: 'CONFLICT', message: 'closed', details: { reason: 'task_closed' } }),
    }));
    renderAt('/prospects/tasks');
    const row3 = await rowNamed('Pastane, Butik kafe');
    await user.click(within(row3).getAllByRole('button')[0]);
    await user.click(within(row3).getByRole('button', { name: 'Görevi kapat' }));
    await user.click(within(row3).getByRole('button', { name: 'Tamamlandı say' }));
    expect(await within(row3).findByText('Görev kapanmış.')).toBeInTheDocument();
  });

  it('composer_asks_only_what_and_where', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(answers({ 'POST /api/research/tasks': { task: { ...pastane, id: taskId(9) }, remaining_today: 5 } }));
    renderAt('/prospects/tasks');
    const open = await screen.findByRole('button', { name: 'Yeni görev' }, LOADED);
    await user.click(open);
    expect(open).toHaveAttribute('aria-expanded', 'true');
    const form = within(screen.getByRole('form', { name: 'Yeni araştırma görevi' }));
    // Up front: what and where, and the pace prefilled in a sentence; the rest folded away.
    expect(form.getByRole('spinbutton', { name: 'Bulunacak aday sayısı' })).toHaveValue(20);
    expect(form.getByRole('spinbutton', { name: 'Günlük üst sınır' })).toHaveValue(10);
    expect(form.queryByRole('textbox', { name: 'Aranan işaretler' })).not.toBeInTheDocument();
    expect(form.getByRole('button', { name: 'Daha fazla ayrıntı' })).toHaveAttribute('aria-expanded', 'false');
    const submit = form.getByRole('button', { name: 'Görevi aç' });
    expect(submit).toBeDisabled();
    await user.type(form.getByRole('textbox', { name: 'Ne aranacak?' }), 'kafe, pastane');
    expect(submit).toBeDisabled();
    await user.type(form.getByRole('textbox', { name: 'Nerede?' }), 'İzmir / Alsancak, Manisa');
    await user.click(submit);
    await waitFor(() => expect(posts(calls, '/api/research/tasks')).toHaveLength(1));
    expect(posts(calls, '/api/research/tasks')[0].body).toMatchObject({
      brief: {
        segment_key: null,
        sectors: ['kafe', 'pastane'],
        areas: [{ city: 'İzmir', district: 'Alsancak' }, { city: 'Manisa', district: null }],
        signals: [], exclusions: [], size_hint: '', language: null, note: '',
      },
      target_count: 20,
      daily_cap: 10,
    });
    expect(await screen.findByText('Görev açıldı.')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Yeni araştırma görevi' })).not.toBeInTheDocument();
  });

  it('composer_sets_every_value_the_server_takes', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(answers({ 'POST /api/research/tasks': { task: { ...pastane, id: taskId(9) }, remaining_today: 5 } }));
    renderAt('/prospects/tasks');
    await user.click(await screen.findByRole('button', { name: 'Yeni görev' }, LOADED));
    const form = within(screen.getByRole('form', { name: 'Yeni araştırma görevi' }));
    // Starting from a task's brief fills what it looks for, where and the details.
    await user.selectOptions(form.getByRole('combobox', { name: 'Bir görevin tarifinden başla' }), taskId(2));
    expect(form.getByRole('textbox', { name: 'Ne aranacak?' })).toHaveValue('Özel ilkokul');
    expect(form.getByRole('textbox', { name: 'Nerede?' })).toHaveValue('İzmir');
    expect(form.getByRole('button', { name: 'Daha fazla ayrıntı' })).toHaveAttribute('aria-expanded', 'true');
    expect(form.getByRole('combobox', { name: 'Kitle' })).toHaveValue('okul');
    await user.clear(form.getByRole('spinbutton', { name: 'Bulunacak aday sayısı' }));
    await user.type(form.getByRole('spinbutton', { name: 'Bulunacak aday sayısı' }), '40');
    await user.clear(form.getByRole('spinbutton', { name: 'Günlük üst sınır' }));
    await user.type(form.getByRole('spinbutton', { name: 'Günlük üst sınır' }), '3');
    await user.type(form.getByRole('textbox', { name: 'Aranan işaretler' }), '{Enter}Veli bülteni var');
    await user.clear(form.getByRole('textbox', { name: 'Hariç tutulanlar' }));
    await user.type(form.getByRole('textbox', { name: 'Hariç tutulanlar' }), 'Devlet okulu');
    await user.selectOptions(form.getByRole('combobox', { name: 'Kitle' }), 'bayi');
    await user.clear(form.getByRole('textbox', { name: 'Büyüklük' }));
    await user.type(form.getByRole('textbox', { name: 'Büyüklük' }), '100+ öğrenci');
    // A language by name, or any other tag the server takes.
    await user.selectOptions(form.getByRole('combobox', { name: 'Dil' }), 'other');
    await user.type(form.getByRole('textbox', { name: 'Dil kodu' }), 'fr');
    await user.type(form.getByRole('textbox', { name: 'Ajana not' }), 'Önce merkez');
    await user.click(form.getByRole('button', { name: 'Görevi aç' }));
    await waitFor(() => expect(posts(calls, '/api/research/tasks')).toHaveLength(1));
    expect(posts(calls, '/api/research/tasks')[0].body).toMatchObject({
      brief: {
        segment_key: 'bayi',
        sectors: ['Özel ilkokul'],
        areas: [{ city: 'İzmir', district: null }],
        signals: ['Kişiye özel baskılı ürün sergiliyor', 'Veli bülteni var'],
        exclusions: ['Devlet okulu'],
        size_hint: '100+ öğrenci',
        language: 'fr',
        note: 'Önce merkez',
      },
      target_count: 40,
      daily_cap: 3,
    });
  });

  it('composer_says_a_refused_value_at_its_field', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(answers({
      'POST /api/research/tasks': withStatus(422, { code: 'VALIDATION', message: 'areas: count', details: { field: 'areas', reason: 'count' } }),
    }));
    renderAt('/prospects/tasks');
    await user.click(await screen.findByRole('button', { name: 'Yeni görev' }, LOADED));
    const form = within(screen.getByRole('form', { name: 'Yeni araştırma görevi' }));
    await user.type(form.getByRole('textbox', { name: 'Ne aranacak?' }), 'kafe');
    await user.type(form.getByRole('textbox', { name: 'Nerede?' }), 'İzmir');
    // Numbers outside what the server takes keep the button off.
    await user.clear(form.getByRole('spinbutton', { name: 'Günlük üst sınır' }));
    await user.type(form.getByRole('spinbutton', { name: 'Günlük üst sınır' }), '0');
    expect(form.getByRole('button', { name: 'Görevi aç' })).toBeDisabled();
    await user.clear(form.getByRole('spinbutton', { name: 'Günlük üst sınır' }));
    await user.type(form.getByRole('spinbutton', { name: 'Günlük üst sınır' }), '5');
    await user.click(form.getByRole('button', { name: 'Görevi aç' }));
    expect(await form.findByText('Bir görevde 1 ile 20 arasında yer olabilir.')).toBeInTheDocument();
    expect(form.getByRole('textbox', { name: 'Nerede?' })).toHaveAttribute('aria-invalid', 'true');
    expect(posts(calls, '/api/research/tasks')).toHaveLength(1);
  });

  it('a_refused_detail_opens_the_fold', async () => {
    const user = userEvent.setup();
    mockFetch(answers({
      'POST /api/research/tasks': withStatus(422, { code: 'VALIDATION', message: 'language', details: { field: 'language', reason: 'invalid' } }),
    }));
    renderAt('/prospects/tasks');
    await user.click(await screen.findByRole('button', { name: 'Yeni görev' }, LOADED));
    const form = within(screen.getByRole('form', { name: 'Yeni araştırma görevi' }));
    await user.type(form.getByRole('textbox', { name: 'Ne aranacak?' }), 'kafe');
    await user.type(form.getByRole('textbox', { name: 'Nerede?' }), 'İzmir');
    await user.click(form.getByRole('button', { name: 'Görevi aç' }));
    expect(await form.findByText('Dil kodu harflerden oluşmalı (ör. tr, en).')).toBeInTheDocument();
    expect(form.getByRole('button', { name: 'Daha fazla ayrıntı' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('composer_enter_cannot_double_submit_and_a_retry_keeps_its_key', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(answers({ 'POST /api/research/tasks': delayed(300, withStatus(500, { code: 'INTERNAL', message: 'lost', details: {} })) }));
    renderAt('/prospects/tasks');
    await user.click(await screen.findByRole('button', { name: 'Yeni görev' }, LOADED));
    const formEl = screen.getByRole('form', { name: 'Yeni araştırma görevi' }) as HTMLFormElement;
    const form = within(formEl);
    await user.type(form.getByRole('textbox', { name: 'Ne aranacak?' }), 'kafe');
    await user.type(form.getByRole('textbox', { name: 'Nerede?' }), 'İzmir');
    formEl.requestSubmit();
    formEl.requestSubmit();
    await waitFor(() => expect(posts(calls, '/api/research/tasks')).toHaveLength(1));
    await waitFor(() => expect(form.getByRole('button', { name: 'Görevi aç' })).toBeEnabled());
    await user.click(form.getByRole('button', { name: 'Görevi aç' }));
    await waitFor(() => expect(posts(calls, '/api/research/tasks')).toHaveLength(2));
    const [a, b] = posts(calls, '/api/research/tasks').map((c) => (c.body as { request_key: string }).request_key);
    expect(a).toBe(b);
  });

  it('says_once_when_no_agent_comes', async () => {
    mockFetch(answers({ 'GET /api/agents': late }));
    renderAt('/prospects/tasks');
    await rows();
    const line = await screen.findByRole('status', {}, LOADED);
    expect(line).toHaveTextContent(/^3 görev bugün aday bekliyor; ajan en son .+ yoklama yaptı\.$/);
    expect(within(line).getByRole('link')).toHaveAttribute('href', '/agents');
    expect(screen.getAllByText(/görev bugün aday bekliyor/)).toHaveLength(1);
  });

  it('says_nothing_when_an_agent_is_on_time_or_nothing_waits', async () => {
    mockFetch(answers({}, OPEN.map((x) => ({ ...x, remaining_today: 0 }))));
    const quiet = renderAt('/prospects/tasks');
    await rows();
    expect(screen.queryByText(/görev bugün aday bekliyor/)).not.toBeInTheDocument();
    quiet.unmount();
    mockFetch(answers());
    renderAt('/prospects/tasks');
    await rows();
    await waitFor(() => expect(screen.getAllByTestId('research-task')).toHaveLength(3));
    expect(screen.queryByText(/görev bugün aday bekliyor/)).not.toBeInTheDocument();
  });

  it('says_when_no_agent_can_research_at_all', async () => {
    mockFetch(answers({ 'GET /api/agents': [] }));
    renderAt('/prospects/tasks');
    expect(await screen.findByText('3 görev bugün aday bekliyor; bu işe bakabilecek bağlı bir ajan yok.', undefined, LOADED)).toBeInTheDocument();
  });

  it('says_once_what_the_agent_will_do_and_rows_say_only_what_differs', async () => {
    const byAgent = task(1, { ...bayi, claim: { by: { kind: 'agent', connection_id: AGENT_CONNECTION_ID, user_id: leadsMe.user_id }, until: at(hour) } });
    const none = { state: 'no_agent' } as const;
    mockFetch(answers({
      'GET /api/agents': late,
      'GET /api/agents/wakes': {
        agents: [],
        needs: { content: none, materials: none, social: none, ads: none, inbox: none, research: { state: 'calling', api_key_id: KEY_ID, due_at: at(40_000), waiting_for: 'settle' } },
      },
    }, [listed(byAgent), OPEN[1], OPEN[2]]));
    renderAt('/prospects/tasks');
    const [held, free, other] = await rows();
    expect(await screen.findByText(/^Ajan (39|40) sn içinde çağrılacak$/, undefined, LOADED)).toBeInTheDocument();
    expect(screen.getAllByTestId('agent-wake-line')).toHaveLength(1);
    // The wake's sentence replaces the check-in's; the rows waiting for an agent say nothing more.
    expect(screen.queryByText(/görev bugün aday bekliyor/)).not.toBeInTheDocument();
    expect(screen.queryByText('Bir ajanın alması bekleniyor')).not.toBeInTheDocument();
    expect(free).not.toHaveTextContent('Bir ajanın alması bekleniyor');
    expect(other).not.toHaveTextContent('Bir ajanın alması bekleniyor');
    await waitFor(() => expect(held).toHaveTextContent('arastirma-ajani bu görevde · bitiş'));
  });

  it('works_for_a_member_with_prospects_work_but_not_manage', async () => {
    const user = userEvent.setup();
    const calls = mockFetch({ ...answers({ 'GET /api/agents': late }), 'GET /api/auth/me': leadsRep });
    renderAt('/prospects/tasks');
    const row1 = await rowNamed('Bayi adayları');
    await user.click(within(row1).getAllByRole('button')[0]);
    expect(within(row1).getByRole('button', { name: 'İki saatliğine ben bakıyorum' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Yeni görev' })).toBeEnabled();
    // Keys cannot be read without `api_keys.manage`: every agent counts, none is asked for.
    expect(calls.some((c) => c.path === '/api/api-keys')).toBe(false);
    expect(await screen.findByText(/3 görev bugün aday bekliyor/)).toBeInTheDocument();
  });

  it('the_pool_and_its_tasks_share_one_header', async () => {
    mockFetch(answers());
    renderAt('/prospects/tasks');
    const nav = within(await screen.findByRole('navigation', { name: 'Aday havuzu bölümleri' }, LOADED));
    expect(nav.getByRole('link', { name: 'Araştırma görevleri' })).toHaveAttribute('aria-current', 'page');
    expect(nav.getByRole('link', { name: 'Adaylar' })).toHaveAttribute('href', '/prospects');
    expect(screen.getByRole('heading', { level: 1, name: 'Aday havuzu' })).toBeInTheDocument();
  });
});

describe('research task copy', () => {
  it('has_the_same_keys_in_both_languages_and_no_empty_text', () => {
    expect(Object.keys(TASK_COPY.en).sort()).toEqual(Object.keys(TASK_COPY.tr).sort());
    for (const table of [TASK_COPY.tr, TASK_COPY.en]) for (const value of Object.values(table)) expect(value.trim()).not.toBe('');
  });
});
