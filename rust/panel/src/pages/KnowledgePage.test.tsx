import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from '@/i18n/config';
import tr from '@/i18n/tr.json';
import type { KnowledgeOut } from '@/api/knowledge';
import type { MeOut, NeedWake, WakesOut } from '@/api/types';
import { me, repMe } from '@/test/fixtures';
import {
  AREA_ID,
  CARD_OWN,
  CARD_PRODUCTS,
  CARD_WHO,
  NOTE_OPEN,
  PRODUCTS_BODY,
  PROPOSAL_EDIT,
  PROPOSAL_NEW,
  PROPOSAL_RULE,
  WHATSAPP_ID,
  emptyKnowledge,
  knowledge,
} from '@/test/knowledge';
import { delayed, mockFetch, renderAt, withStatus, type FetchCall, type FetchRoutes } from '@/test/render';
import { wakeTime } from '@/lib/wake';
import { approvalLine } from './knowledge/words';
import { markAdded } from './knowledge/Proposals';
import { cardMatches } from './knowledge/Cards';
import { KNOWLEDGE_BUSY_MS, KNOWLEDGE_IDLE_MS, knowledgeRefresh } from './knowledge/queries';
import { measuredPosts } from './knowledge/Learned';

const k = tr.knowledge;
const routes = (over: FetchRoutes = {}, data: KnowledgeOut = knowledge): FetchRoutes => ({
  'GET /api/auth/me': me,
  'GET /api/knowledge': data,
  ...over,
});
const writes = (calls: FetchCall[], method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
const reads = (calls: FetchCall[]) => calls.filter((c) => c.method === 'GET' && c.path === '/api/knowledge').length;

/** The owner without one permission. */
function without(permission: string): MeOut {
  return { ...me, memberships: [{ ...me.memberships[0], permissions: me.memberships[0].permissions.filter((p) => p !== permission) }] };
}

const none: NeedWake = { state: 'no_agent' };
function wakes(knowledgeWake: NeedWake): WakesOut {
  return { agents: [], needs: { content: none, materials: none, social: none, ads: none, research: none, inbox: none, knowledge: knowledgeWake } };
}

/** One revision of "Ürünler ve fiyat" as `GET …/history` lists it. */
const revision = (n: number, body: string, cause: string, by: object) => ({
  id: `rev-${n}`, subject: 'card', card_id: CARD_PRODUCTS, revision: n, kb_revision: n + 4,
  content: { key: 'products_prices', title: 'Ürünler ve fiyat', body, attachments: [] }, cause, source_id: null,
  at: '2026-11-18T09:00:00Z', by,
});

/** The card button of the grid: its name is the card's title, its description the card's text. */
const cardButton = (title: string) => screen.getByRole('button', { name: title });

/** The page with its read answered: Kurallar is drawn once the knowledge base is read. */
async function page() {
  await screen.findByRole('heading', { level: 1, name: k.title });
  await screen.findByRole('region', { name: k.rules.title });
}

describe('KnowledgePage', () => {
  it('shows the cards, Kurallar with the ad, message and approval lines, and Hedefler', async () => {
    const user = userEvent.setup();
    mockFetch(routes());
    renderAt('/knowledge');
    await page();
    expect(screen.getByText(k.description)).toBeInTheDocument();

    const rules = screen.getByRole('region', { name: k.rules.title });
    expect(within(rules).getByText(k.rules.aside)).toBeInTheDocument();
    expect(within(rules).getByText('Sitede yazmayan fiyat sözü verilmez.')).toBeInTheDocument();
    expect(within(rules).queryByText('Başka atölyelerin adı anılmaz.')).not.toBeInTheDocument();
    expect(within(rules).getByText('Reklama ayda en çok ₺5.000.')).toBeInTheDocument();
    expect(within(rules).getByText('Ücretli mesajlara ayda en çok ₺0.')).toBeInTheDocument();
    expect(within(rules).getByText("Paylaşımlar onay beklemeden çıkar; Alfa Instagram hariç. TikTok'u sen tamamlarsın.")).toBeInTheDocument();
    await user.click(within(rules).getByRole('button', { name: i18n.t('knowledge.rules.more', { n: 1 }) }));
    expect(within(rules).getByText('Başka atölyelerin adı anılmaz.')).toBeInTheDocument();

    const goals = screen.getByRole('region', { name: k.goals.title });
    expect(within(goals).getByText('Ayda 20 kupa siparişi')).toBeInTheDocument();
    expect(within(goals).queryByText('3 ayda 2 kahve dükkânı ortaklığı')).not.toBeInTheDocument();
    expect(within(goals).getByRole('button', { name: i18n.t('knowledge.goals.more', { n: 1 }) })).toBeInTheDocument();

    const grid = screen.getByRole('region', { name: k.cards.title });
    expect(within(grid).getByText('Biz kimiz')).toBeInTheDocument();
    expect(within(grid).getByText(PRODUCTS_BODY)).toBeInTheDocument();
    // A blank seed card shows its own question; an agent's filing reads "Yeni" with what it added.
    expect(within(grid).getByText(k.cards.placeholders.voice)).toBeInTheDocument();
    expect(within(grid).getByText(k.cards.newBadge)).toBeInTheDocument();
    expect(within(grid).getByRole('tooltip', { hidden: true })).toHaveTextContent(i18n.t('knowledge.cards.filed', { summary: 'Ders fiyatı eklendi' }));
    expect(within(grid).getByRole('link', { name: 'Fiyat listesi' })).toHaveAttribute('href', 'https://alfa.example/fiyatlar');
    // Each card's title is a heading holding the button that opens it; its text describes the button.
    const heading = within(grid).getByRole('heading', { level: 3, name: 'Ürünler ve fiyat' });
    expect(within(heading).getByRole('button', { name: 'Ürünler ve fiyat' })).toHaveAccessibleDescription(PRODUCTS_BODY);
    // No internal word on the owner's page (the whole check is `i18n/ownerWords.test.tsx`).
    expect(screen.getByRole('main').textContent ?? '').not.toMatch(/strateji|hipotez|sürüm/i);
  });

  it('builds the approval line from the switch, the account list and TikTok', () => {
    const t = i18n.t.bind(i18n);
    expect(approvalLine(t, { post_approval: true, post_approval_accounts: [], tiktok_connected: false })).toBe(k.rules.approvalAll);
    expect(approvalLine(t, { post_approval: false, post_approval_accounts: [], tiktok_connected: false })).toBe(k.rules.approvalNone);
    expect(approvalLine(t, { post_approval: false, post_approval_accounts: [], tiktok_connected: true })).toBe(`${k.rules.approvalNone} ${k.rules.tiktok}`);
    // An account the workspace no longer has is named with an empty name by the read: nothing
    // posts there, so the line names only the ones still connected.
    const gone = { capability_id: 'cap-gone', name: '', kind: '' };
    const kept = { capability_id: 'cap-ig', name: 'Alfa Instagram', kind: 'instagram' };
    expect(approvalLine(t, { post_approval: false, post_approval_accounts: [gone], tiktok_connected: false })).toBe(k.rules.approvalNone);
    expect(approvalLine(t, { post_approval: false, post_approval_accounts: [gone, kept], tiktok_connected: false })).toBe(
      i18n.t('knowledge.rules.approvalExcept', { accounts: 'Alfa Instagram' }),
    );
  });

  it('lets only an owner or a manager turn post approval off', async () => {
    const user = userEvent.setup();
    const editor: MeOut = { ...me, memberships: [{ ...me.memberships[0], role_key: 'editor' }] };
    mockFetch(routes({ 'GET /api/auth/me': editor }, { ...knowledge, rules: { ...knowledge.rules, post_approval: true } }));
    renderAt('/knowledge');
    await page();
    await user.click(within(screen.getByRole('region', { name: k.rules.title })).getByRole('button', { name: k.rules.editLabel }));
    const dialog = await screen.findByRole('dialog', { name: k.rules.title });
    expect(within(dialog).getByRole('switch', { name: k.rules.dialog.approval })).toBeDisabled();
    expect(within(dialog).getByText(k.rules.dialog.approvalOwnerOnly)).toBeInTheDocument();
  });

  it('leaves the message line out while no limit is set, and says when nothing is forbidden yet', async () => {
    mockFetch(routes({}, { ...knowledge, rules: { ...knowledge.rules, prohibitions: [], message_cap: null, ad_cap: null, post_approval: true } }));
    renderAt('/knowledge');
    await page();
    const rules = screen.getByRole('region', { name: k.rules.title });
    expect(within(rules).getByText(k.rules.none)).toBeInTheDocument();
    expect(within(rules).getByText(k.rules.adNone)).toBeInTheDocument();
    expect(within(rules).queryByText(/Ücretli mesajlara/)).not.toBeInTheDocument();
    expect(within(rules).getByText(`${k.rules.approvalAll} ${k.rules.tiktok}`)).toBeInTheDocument();
  });

  it('saves Kurallar whole: a new prohibition, a lowered ad budget, and the accounts taken off the list', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(routes({
      'PUT /api/knowledge/rules': { ...knowledge.rules, post_approval_accounts: [], stopped_campaigns: 2 },
    }));
    renderAt('/knowledge');
    await page();
    await user.click(screen.getByRole('button', { name: k.rules.editLabel }));
    const dialog = await screen.findByRole('dialog', { name: k.rules.title });
    expect(within(dialog).getByText(k.rules.dialog.help)).toBeInTheDocument();
    // The message field shows while a limit is set.
    expect(within(dialog).getByLabelText(k.rules.dialog.message)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: k.rules.dialog.add }));
    await user.type(within(dialog).getByRole('textbox', { name: i18n.t('knowledge.rules.dialog.item', { n: 4 }) }), 'Teslim tarihi sözü verilmez.');
    await user.click(within(dialog).getByRole('button', { name: i18n.t('knowledge.rules.dialog.remove', { n: 3 }) }));
    const ad = within(dialog).getByLabelText(k.rules.dialog.ad);
    await user.clear(ad);
    await user.type(ad, '3000');
    // The switch is off and an account still waits: said, with the way to clear it.
    expect(within(dialog).getByText(i18n.t('knowledge.rules.dialog.stillWaits', { accounts: 'Alfa Instagram' }))).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: k.rules.dialog.clearAccounts }));
    await user.click(within(dialog).getByRole('button', { name: k.save }));

    await waitFor(() => expect(writes(calls, 'PUT', '/api/knowledge/rules')).toHaveLength(1));
    expect(writes(calls, 'PUT', '/api/knowledge/rules')[0].body).toEqual({
      expected_revision: 4,
      prohibitions: ['Sitede yazmayan fiyat sözü verilmez.', 'Müşteri fotoğrafı yalnızca izinle paylaşılır.', 'Teslim tarihi sözü verilmez.'],
      ad_budget: { amount_minor: 300000, period: 'monthly' },
      message_budget: { amount_minor: 0, period: 'monthly' },
      post_approval: false,
      post_approval_accounts: [],
    });
    expect(await screen.findByText(i18n.t('knowledge.rules.stopped', { n: 2 }))).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('names the paid-message limit by its own period in the dialog, and keeps it', async () => {
    const user = userEvent.setup();
    const weekly = { ...knowledge.rules, message_cap: { amount_minor: 20000, period: 'weekly' as const, currency: 'TRY' } };
    const calls = mockFetch(routes({ 'PUT /api/knowledge/rules': weekly }, { ...knowledge, rules: weekly }));
    renderAt('/knowledge');
    await page();
    expect(within(screen.getByRole('region', { name: k.rules.title })).getByText('Ücretli mesajlara haftada en çok ₺200.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: k.rules.editLabel }));
    const dialog = await screen.findByRole('dialog', { name: k.rules.title });
    const field = within(dialog).getByRole('group', { name: k.rules.dialog.message });
    expect(within(field).getByText(k.rules.dialog.weekly)).toBeInTheDocument();
    expect(within(field).queryByText(k.rules.dialog.monthly)).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: k.save }));
    await waitFor(() => expect(writes(calls, 'PUT', '/api/knowledge/rules')).toHaveLength(1));
    expect(writes(calls, 'PUT', '/api/knowledge/rules')[0].body).toMatchObject({ message_budget: { amount_minor: 20000, period: 'weekly' } });
  });

  it('turns the ad budget off with "Reklam yok" and shows the message field only for a metered workspace', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(routes({ 'PUT /api/knowledge/rules': knowledge.rules }, { ...knowledge, rules: { ...knowledge.rules, message_cap: null, metered: false } }));
    renderAt('/knowledge');
    await page();
    await user.click(screen.getByRole('button', { name: k.rules.editLabel }));
    const dialog = await screen.findByRole('dialog', { name: k.rules.title });
    expect(within(dialog).queryByLabelText(k.rules.dialog.message)).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('switch', { name: k.rules.dialog.noAds }));
    expect(within(dialog).getByLabelText(k.rules.dialog.ad)).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: k.save }));
    await waitFor(() => expect(writes(calls, 'PUT', '/api/knowledge/rules')).toHaveLength(1));
    expect(writes(calls, 'PUT', '/api/knowledge/rules')[0].body).toMatchObject({ ad_budget: null, message_budget: null });
  });

  it('keeps the money fields read-only without budget.manage and sends the ceilings as they are', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(routes({ 'GET /api/auth/me': without('budget.manage'), 'PUT /api/knowledge/rules': knowledge.rules }));
    renderAt('/knowledge');
    await page();
    await user.click(screen.getByRole('button', { name: k.rules.editLabel }));
    const dialog = await screen.findByRole('dialog', { name: k.rules.title });
    expect(within(dialog).getByText(k.rules.dialog.noBudget)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(k.rules.dialog.ad)).toBeDisabled();
    expect(within(dialog).getByLabelText(k.rules.dialog.message)).toBeDisabled();
    await user.click(within(dialog).getByRole('switch', { name: k.rules.dialog.approval }));
    await user.click(within(dialog).getByRole('button', { name: k.save }));
    await waitFor(() => expect(writes(calls, 'PUT', '/api/knowledge/rules')).toHaveLength(1));
    expect(writes(calls, 'PUT', '/api/knowledge/rules')[0].body).toEqual({
      expected_revision: 4,
      prohibitions: knowledge.rules.prohibitions,
      ad_budget: { amount_minor: 500000, period: 'monthly' },
      message_budget: { amount_minor: 0, period: 'monthly' },
      post_approval: true,
    });
  });

  it('says a stale Kurallar save changed meanwhile and reads again', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(routes({
      'PUT /api/knowledge/rules': withStatus(409, { code: 'CONFLICT', message: 'the rules changed', details: { reason: 'rules_changed' } }),
    }));
    renderAt('/knowledge');
    await page();
    const before = reads(calls);
    await user.click(screen.getByRole('button', { name: k.rules.editLabel }));
    const dialog = await screen.findByRole('dialog', { name: k.rules.title });
    await user.click(within(dialog).getByRole('button', { name: k.save }));
    expect(await within(dialog).findByText(k.conflict)).toBeInTheDocument();
    await waitFor(() => expect(reads(calls)).toBeGreaterThan(before));
  });

  it('saves Hedefler as a list', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(routes({ 'PUT /api/knowledge/goals': { revision: 3, items: [] } }));
    renderAt('/knowledge');
    await page();
    await user.click(screen.getByRole('button', { name: k.goals.editLabel }));
    const dialog = await screen.findByRole('dialog', { name: k.goals.title });
    await user.click(within(dialog).getByRole('button', { name: i18n.t('knowledge.goals.dialog.remove', { n: 1 }) }));
    await user.click(within(dialog).getByRole('button', { name: k.goals.dialog.add }));
    await user.type(within(dialog).getByRole('textbox', { name: i18n.t('knowledge.goals.dialog.item', { n: 4 }) }), 'Ayda 5 kurumsal sipariş');
    await user.click(within(dialog).getByRole('button', { name: k.save }));
    await waitFor(() => expect(writes(calls, 'PUT', '/api/knowledge/goals')).toHaveLength(1));
    expect(writes(calls, 'PUT', '/api/knowledge/goals')[0].body).toEqual({
      expected_revision: 2,
      items: ['Ayda 2 atölye dersi', 'Haftada 3 paylaşım', '3 ayda 2 kahve dükkânı ortaklığı', 'Ayda 5 kurumsal sipariş'],
    });
  });

  it('says when nothing is a goal yet', async () => {
    mockFetch(routes({}, { ...knowledge, goals: { revision: 1, items: [] } }));
    renderAt('/knowledge');
    await page();
    expect(within(screen.getByRole('region', { name: k.goals.title })).getByText(k.goals.none)).toBeInTheDocument();
  });

  it('creates a card of the owner’s own', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(routes({ 'POST /api/knowledge/cards': { ...knowledge.cards[4], id: 'new-card', title: 'Sık sorulanlar' } }));
    const { router } = renderAt('/knowledge');
    await page();
    await user.click(screen.getByRole('button', { name: k.cards.new }));
    expect(router.state.location.search).toBe('?card=new');
    const form = screen.getByRole('form', { name: k.cards.newCard });
    await user.click(within(form).getByRole('button', { name: k.save }));
    expect(within(form).getByText(k.cards.titleRequired)).toBeInTheDocument();
    await user.type(within(form).getByLabelText(k.cards.titleField), 'Sık sorulanlar');
    await user.type(within(form).getByLabelText(k.cards.bodyField), 'Kupalar bulaşık makinesine girer.');
    await user.click(within(form).getByRole('button', { name: k.save }));
    await waitFor(() => expect(writes(calls, 'POST', '/api/knowledge/cards')).toHaveLength(1));
    expect(writes(calls, 'POST', '/api/knowledge/cards')[0].body).toEqual({ title: 'Sık sorulanlar', body: 'Kupalar bulaşık makinesine girer.', attachments: [] });
    expect(await screen.findByText(k.saved)).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.search).toBe(''));
  });

  it('edits a card in place, sending only what changed at the revision read', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(routes({ [`PATCH /api/knowledge/cards/${CARD_WHO}`]: knowledge.cards[0] }));
    const { router } = renderAt('/knowledge');
    await page();
    await user.click(cardButton('Biz kimiz'));
    expect(router.state.location.search).toBe(`?card=${CARD_WHO}`);
    const form = screen.getByRole('form', { name: i18n.t('knowledge.cards.editLabel', { title: 'Biz kimiz' }) });
    const body = within(form).getByLabelText(k.cards.bodyField);
    await user.clear(body);
    await user.type(body, 'Alfa Atölye: seramik kupalar.');
    await user.click(within(form).getByRole('button', { name: k.save }));
    await waitFor(() => expect(writes(calls, 'PATCH', `/api/knowledge/cards/${CARD_WHO}`)).toHaveLength(1));
    expect(writes(calls, 'PATCH', `/api/knowledge/cards/${CARD_WHO}`)[0].body).toEqual({ expected_revision: 2, body: 'Alfa Atölye: seramik kupalar.' });
  });

  it('shows a card as it now is when it changed while being edited', async () => {
    const user = userEvent.setup();
    const answers = routes({
      [`PATCH /api/knowledge/cards/${CARD_WHO}`]: withStatus(409, { code: 'CONFLICT', message: 'stale', details: { reason: 'card_changed', revision: 3 } }),
    });
    mockFetch(answers);
    renderAt(`/knowledge?card=${CARD_WHO}`);
    const form = await screen.findByRole('form', { name: i18n.t('knowledge.cards.editLabel', { title: 'Biz kimiz' }) });
    const body = within(form).getByLabelText(k.cards.bodyField);
    await user.clear(body);
    await user.type(body, 'Benim metnim');
    answers['GET /api/knowledge'] = {
      ...knowledge,
      cards: knowledge.cards.map((c) => (c.id === CARD_WHO ? { ...c, body: 'Ortağın yazdığı metin', revision: 3 } : c)),
    };
    await user.click(within(form).getByRole('button', { name: k.save }));
    expect(await within(form).findByText(k.conflict)).toBeInTheDocument();
    await waitFor(() => expect(within(form).getByLabelText(k.cards.bodyField)).toHaveValue('Ortağın yazdığı metin'));
  });

  it('removes a card after asking, and puts it back with "Geri al"', async () => {
    const user = userEvent.setup();
    const own = knowledge.cards[4];
    const calls = mockFetch(routes({ [`POST /api/knowledge/cards/${CARD_OWN}/archive`]: { ...own, revision: 2 } }));
    renderAt(`/knowledge?card=${CARD_OWN}`);
    const form = await screen.findByRole('form', { name: i18n.t('knowledge.cards.editLabel', { title: 'Kargo' }) });
    await user.click(within(form).getByRole('button', { name: k.cards.remove }));
    const confirm = await screen.findByRole('dialog', { name: k.cards.removeTitle });
    await user.click(within(confirm).getByRole('button', { name: k.cards.remove }));
    await waitFor(() => expect(writes(calls, 'POST', `/api/knowledge/cards/${CARD_OWN}/archive`)).toHaveLength(1));
    expect(writes(calls, 'POST', `/api/knowledge/cards/${CARD_OWN}/archive`)[0].body).toEqual({ expected_revision: 1, archived: true });
    const removed = await screen.findByText(i18n.t('knowledge.cards.removed', { title: 'Kargo' }));
    await user.click(within(removed).getByRole('button', { name: k.cards.undo }));
    await waitFor(() => expect(writes(calls, 'POST', `/api/knowledge/cards/${CARD_OWN}/archive`)).toHaveLength(2));
    expect(writes(calls, 'POST', `/api/knowledge/cards/${CARD_OWN}/archive`)[1].body).toEqual({ expected_revision: 2, archived: false });
  });

  it('says in the editor why a removal was refused, shows the card as it now is, and removes that one', async () => {
    const user = userEvent.setup();
    const own = knowledge.cards[4];
    const archive = `POST /api/knowledge/cards/${CARD_OWN}/archive`;
    const answers = routes({ [archive]: withStatus(409, { code: 'CONFLICT', message: 'stale', details: { reason: 'card_changed', revision: 2 } }) });
    const calls = mockFetch(answers);
    renderAt(`/knowledge?card=${CARD_OWN}`);
    const form = await screen.findByRole('form', { name: i18n.t('knowledge.cards.editLabel', { title: 'Kargo' }) });
    answers['GET /api/knowledge'] = { ...knowledge, cards: knowledge.cards.map((c) => (c.id === CARD_OWN ? { ...c, body: 'Siparişler ertesi gün kargoda.', revision: 2 } : c)) };
    await user.click(within(form).getByRole('button', { name: k.cards.remove }));
    await user.click(within(await screen.findByRole('dialog', { name: k.cards.removeTitle })).getByRole('button', { name: k.cards.remove }));
    // The question closes: the refusal and the card as it now is show where the owner is.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: k.cards.removeTitle })).not.toBeInTheDocument());
    expect(await within(form).findByText(k.conflict)).toBeInTheDocument();
    await waitFor(() => expect(within(form).getByLabelText(k.cards.bodyField)).toHaveValue('Siparişler ertesi gün kargoda.'));

    answers[archive] = { ...own, revision: 3 };
    await user.click(within(form).getByRole('button', { name: k.cards.remove }));
    await user.click(within(await screen.findByRole('dialog', { name: k.cards.removeTitle })).getByRole('button', { name: k.cards.remove }));
    await waitFor(() => expect(writes(calls, 'POST', `/api/knowledge/cards/${CARD_OWN}/archive`)).toHaveLength(2));
    expect(writes(calls, 'POST', `/api/knowledge/cards/${CARD_OWN}/archive`).map((c) => c.body)).toEqual([
      { expected_revision: 1, archived: true },
      { expected_revision: 2, archived: true },
    ]);
    expect(await screen.findByText(i18n.t('knowledge.cards.removed', { title: 'Kargo' }))).toBeInTheDocument();
  });

  it('closes the editor of a card removed meanwhile and says so', async () => {
    const user = userEvent.setup();
    const answers = routes({ [`PATCH /api/knowledge/cards/${CARD_OWN}`]: withStatus(409, { code: 'CONFLICT', message: 'removed', details: { reason: 'card_archived' } }) });
    const calls = mockFetch(answers);
    const { router } = renderAt(`/knowledge?card=${CARD_OWN}`);
    const name = i18n.t('knowledge.cards.editLabel', { title: 'Kargo' });
    const form = await screen.findByRole('form', { name });
    await user.type(within(form).getByLabelText(k.cards.bodyField), ' Pazar hariç.');
    const before = reads(calls);
    answers['GET /api/knowledge'] = { ...knowledge, cards: knowledge.cards.filter((c) => c.id !== CARD_OWN) };
    await user.click(within(form).getByRole('button', { name: k.save }));
    await waitFor(() => expect(reads(calls)).toBeGreaterThan(before));
    await waitFor(() => expect(screen.queryByRole('form', { name })).not.toBeInTheDocument());
    expect(await screen.findByText(k.cards.archived)).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.search).toBe(''));
  });

  it('lists a card’s history in the owner’s words and puts an older text back', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(routes({
      [`GET /api/knowledge/cards/${CARD_PRODUCTS}/history`]: {
        revisions: [
          revision(3, PRODUCTS_BODY, 'note', { kind: 'agent', connection_id: 'c1', api_key_id: 'k1' }),
          revision(2, 'El yapımı kupa ₺400.', 'owner', { kind: 'human', user_id: me.user_id }),
          revision(1, 'Kupa', 'backfill', { kind: 'system', component: 'knowledge_backfill' }),
        ],
        next_before: null,
      },
      [`PATCH /api/knowledge/cards/${CARD_PRODUCTS}`]: knowledge.cards[1],
    }));
    renderAt(`/knowledge?card=${CARD_PRODUCTS}&history=${CARD_PRODUCTS}`);
    const sheet = await screen.findByRole('dialog', { name: k.history.title });
    expect(await within(sheet).findByText(/Ajan \(not\)/)).toBeInTheDocument();
    expect(within(sheet).getByText(/· Sen$/)).toBeInTheDocument();
    expect(within(sheet).getByText(/İlk kurulum/)).toBeInTheDocument();
    // The text in force has nothing to go back to; an older one does.
    expect(within(sheet).getAllByRole('button', { name: k.history.restore })).toHaveLength(2);
    await user.click(within(sheet).getAllByRole('button', { name: k.history.restore })[0]);
    await waitFor(() => expect(writes(calls, 'PATCH', `/api/knowledge/cards/${CARD_PRODUCTS}`)).toHaveLength(1));
    expect(writes(calls, 'PATCH', `/api/knowledge/cards/${CARD_PRODUCTS}`)[0].body).toEqual({
      expected_revision: 3, title: 'Ürünler ve fiyat', body: 'El yapımı kupa ₺400.', attachments: [],
    });
  });

  it('names a teammate in a card’s history from the team list', async () => {
    mockFetch(routes({
      'GET /api/team': [
        { membership_id: 'm2', user_id: 'u-2', email: 'ayse@alfa.example', display_name: 'Ayşe', role_key: 'manager', role_name: 'Yönetici', status: 'active', created_at: '2026-11-01T09:00:00Z' },
      ],
      [`GET /api/knowledge/cards/${CARD_PRODUCTS}/history`]: {
        revisions: [
          revision(3, PRODUCTS_BODY, 'owner', { kind: 'human', user_id: 'u-2' }),
          revision(2, 'El yapımı kupa ₺400.', 'proposal', { kind: 'human', user_id: 'u-3' }),
        ],
        next_before: null,
      },
    }));
    renderAt(`/knowledge?history=${CARD_PRODUCTS}`);
    const sheet = await screen.findByRole('dialog', { name: k.history.title });
    expect(await within(sheet).findByText(/· Ayşe$/)).toBeInTheDocument();
    // Someone the team list does not name (gone since) reads as a teammate.
    expect(within(sheet).getByText(new RegExp(`· ${k.history.member} · ${k.history.proposal}$`))).toBeInTheDocument();
  });

  it('keeps a card’s history to its editors', async () => {
    const calls = mockFetch(routes({ 'GET /api/auth/me': repMe }));
    renderAt(`/knowledge?history=${CARD_PRODUCTS}`);
    await page();
    // `strategy.card_history` is the editors' (`team.manage`): a member's address opens nothing.
    expect(screen.queryByRole('dialog', { name: k.history.title })).not.toBeInTheDocument();
    expect(calls.some((c) => c.path === `/api/knowledge/cards/${CARD_PRODUCTS}/history`)).toBe(false);
  });

  it('finds cards by their title or text', async () => {
    const user = userEvent.setup();
    mockFetch(routes());
    renderAt('/knowledge');
    await page();
    const grid = screen.getByRole('region', { name: k.cards.title });
    await user.type(within(grid).getByRole('searchbox', { name: k.cards.searchLabel }), 'kargo');
    expect(within(grid).getByText('Siparişler iki iş gününde kargoya verilir.')).toBeInTheDocument();
    expect(within(grid).queryByText('Biz kimiz')).not.toBeInTheDocument();
    await user.type(within(grid).getByRole('searchbox', { name: k.cards.searchLabel }), 'zzz');
    expect(within(grid).getByText(k.cards.noMatch)).toBeInTheDocument();
    expect(cardMatches({ title: 'İzmir', body: '' }, 'izmir')).toBe(true);
  });

  it('adds a note, and lists the notes with what became of each', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(routes({ 'POST /api/knowledge/notes': { ...knowledge.notes[0], id: 'n-new' } }));
    renderAt('/knowledge');
    await page();
    const list = screen.getByRole('list', { name: k.notes.title });
    expect(within(list).getByText(k.notes.waiting)).toBeInTheDocument();
    expect(within(list).getByText(i18n.t('knowledge.notes.card', { card: 'Ürünler ve fiyat', summary: 'Ders fiyatı eklendi' }))).toBeInTheDocument();
    expect(within(list).getByText(i18n.t('knowledge.notes.rule', { line: 'İndirim sözü verilmez.' }), { exact: false })).toBeInTheDocument();
    expect(within(list).getByText(i18n.t('knowledge.notes.goal', { line: 'Ayda bir atölye dersi' }), { exact: false })).toBeInTheDocument();
    expect(within(list).getByText(k.notes.post, { exact: false })).toBeInTheDocument();
    expect(within(list).getByRole('link', { name: k.notes.postLink })).toHaveAttribute('href', `/posts?content=${AREA_ID}`);
    expect(within(list).getByRole('link', { name: k.rules.title })).toHaveAttribute('href', '#kurallar');
    expect(within(list).getByRole('link', { name: k.goals.title })).toHaveAttribute('href', '#hedefler');
    expect(within(list).getByText(k.notes.proposals, { exact: false })).toBeInTheDocument();
    expect(within(list).getByText(i18n.t('knowledge.notes.dismissed', { reason: "Reklam bütçesini Kurallar'dan sen değiştirirsin." }))).toBeInTheDocument();
    expect(within(list).getByText(k.notes.withdrawn)).toBeInTheDocument();

    const input = screen.getByRole('textbox', { name: k.composer.label });
    expect(input).toHaveAttribute('placeholder', k.composer.placeholder);
    await user.type(input, 'Pazar günleri kapalıyız{Enter}');
    await waitFor(() => expect(writes(calls, 'POST', '/api/knowledge/notes')).toHaveLength(1));
    const sent = writes(calls, 'POST', '/api/knowledge/notes')[0].body as { request_key: string; text: string };
    expect(sent.text).toBe('Pazar günleri kapalıyız');
    expect(sent.request_key).toMatch(/\S/);
    expect(Object.keys(sent).sort()).toEqual(['request_key', 'text']);
    expect(await screen.findByText(k.composer.sent)).toBeInTheDocument();
    await waitFor(() => expect(input).toHaveValue(''));
  });

  it('adds a link to a note and refuses one that is not https', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(routes({ 'POST /api/knowledge/notes': knowledge.notes[0] }));
    renderAt('/knowledge');
    await page();
    await user.click(screen.getByRole('button', { name: k.composer.attach }));
    await user.click(await screen.findByRole('menuitem', { name: k.composer.addLink }));
    const link = screen.getByRole('textbox', { name: k.composer.linkLabel });
    await user.type(link, 'http://alfa.example{Enter}');
    expect(screen.getByText(k.composer.linkInvalid)).toBeInTheDocument();
    await user.clear(link);
    await user.type(link, 'https://alfa.example/katalog{Enter}');
    expect(within(screen.getByRole('list', { name: k.composer.attached })).getByText('https://alfa.example/katalog')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: k.composer.label }), 'Yeni katalog');
    await user.click(within(screen.getByRole('region', { name: k.composer.label })).getByRole('button', { name: k.composer.send }));
    await waitFor(() => expect(writes(calls, 'POST', '/api/knowledge/notes')).toHaveLength(1));
    expect(writes(calls, 'POST', '/api/knowledge/notes')[0].body).toMatchObject({ text: 'Yeni katalog', links: ['https://alfa.example/katalog'] });
  });

  it('hides the file choice without the library and says why', async () => {
    const user = userEvent.setup();
    mockFetch(routes({ 'GET /api/workspace/modules': { modules: [] } }));
    renderAt('/knowledge');
    await page();
    await user.click(screen.getByRole('button', { name: k.composer.attach }));
    expect(await screen.findByRole('menuitem', { name: k.composer.addLink })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: k.composer.addFile })).not.toBeInTheDocument();
    expect(screen.getByText(k.composer.noFiles)).toBeInTheDocument();
  });

  it('takes an open note back', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(routes({ [`POST /api/knowledge/notes/${NOTE_OPEN}/withdraw`]: { ...knowledge.notes[0], status: 'withdrawn' } }));
    renderAt('/knowledge');
    await page();
    const list = screen.getByRole('list', { name: k.notes.title });
    await user.click(within(list).getByRole('button', { name: k.notes.withdraw }));
    await waitFor(() => expect(writes(calls, 'POST', `/api/knowledge/notes/${NOTE_OPEN}/withdraw`)).toHaveLength(1));
    expect(writes(calls, 'POST', `/api/knowledge/notes/${NOTE_OPEN}/withdraw`)[0].body).toEqual({ expected_revision: 1 });
  });

  it.each([
    ['none', null, () => k.composer.stops.none],
    ['asleep', '2026-11-21T09:00:00Z', (at: string) => i18n.t('knowledge.composer.stops.asleep', { time: wakeTime(at, 'tr') })],
    ['late', '2026-11-19T09:00:00Z', (at: string) => i18n.t('knowledge.composer.stops.late', { time: wakeTime(at, 'tr') })],
  ] as const)('says before sending what stands before a note is filed (%s), and still sends', async (state, nextAt, text) => {
    const user = userEvent.setup();
    const calls = mockFetch(routes({ 'POST /api/knowledge/notes': knowledge.notes[0] }, { ...knowledge, notes_agent: { state, next_at: nextAt } }));
    renderAt('/knowledge');
    await page();
    expect(screen.getByText(text(nextAt ?? ''), { exact: false })).toBeInTheDocument();
    if (state === 'none') expect(screen.getByRole('link', { name: k.composer.stops.connect })).toHaveAttribute('href', '/agents');
    await user.type(screen.getByRole('textbox', { name: k.composer.label }), 'Bir not{Enter}');
    await waitFor(() => expect(writes(calls, 'POST', '/api/knowledge/notes')).toHaveLength(1));
    expect(await screen.findByText(k.composer.sentNoAgent)).toBeInTheDocument();
  });

  it('shows the agent line only while a note is open or a derivation is due', async () => {
    const schedule: NeedWake = { state: 'schedule', next_expected_at: new Date(Date.now() + 3600_000).toISOString(), interval_minutes: 60, has_address: false, failed_at: null, run_now: null };
    mockFetch(routes({ 'GET /api/agents/wakes': wakes(schedule) }));
    renderAt('/knowledge');
    await page();
    expect(await screen.findByTestId('agent-wake-line')).toBeInTheDocument();
  });

  it('reads again often while a note waits or a derivation is due, else now and then', () => {
    expect(knowledgeRefresh(undefined)).toBe(KNOWLEDGE_IDLE_MS);
    expect(knowledgeRefresh(knowledge)).toBe(KNOWLEDGE_BUSY_MS);
    const quiet = { ...knowledge, notes: knowledge.notes.filter((n) => n.status !== 'open'), frame: { number: 2, derive_due: [] } };
    expect(knowledgeRefresh(quiet)).toBe(KNOWLEDGE_IDLE_MS);
    expect(knowledgeRefresh({ ...quiet, frame: { number: 2, derive_due: ['posting'] } })).toBe(KNOWLEDGE_BUSY_MS);
  });

  it('reads again on its own, so a note the agent filed shows what became of it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const answers = routes();
      const calls = mockFetch(answers);
      renderAt('/knowledge');
      await page();
      expect(within(screen.getByRole('list', { name: k.notes.title })).getByText(k.notes.waiting)).toBeInTheDocument();
      const filed: KnowledgeOut = {
        ...knowledge,
        cards: knowledge.cards.map((c) => (c.id === CARD_OWN ? { ...c, revision: 2, filed: { at: new Date().toISOString(), summary: 'Yılbaşı tarihi eklendi' } } : c)),
        notes: knowledge.notes.map((n) =>
          n.id === NOTE_OPEN ? { ...n, status: 'filed', closed_at: new Date().toISOString(), outcome: { cards: [{ card_id: CARD_OWN, revision: 2 }], summary: 'Yılbaşı tarihi eklendi' } } : n,
        ),
      };
      answers['GET /api/knowledge'] = filed;
      const before = reads(calls);
      await vi.advanceTimersByTimeAsync(KNOWLEDGE_BUSY_MS);
      await waitFor(() => expect(reads(calls)).toBeGreaterThan(before));
      const list = screen.getByRole('list', { name: k.notes.title });
      await waitFor(() => expect(within(list).queryByText(k.notes.waiting)).not.toBeInTheDocument());
      expect(within(list).getByText(i18n.t('knowledge.notes.card', { card: 'Kargo', summary: 'Yılbaşı tarihi eklendi' }))).toBeInTheDocument();
      // Nothing waits any more: the next read comes a minute later, not in 15 seconds.
      const settled = reads(calls);
      await vi.advanceTimersByTimeAsync(KNOWLEDGE_BUSY_MS + 1_000);
      expect(reads(calls)).toBe(settled);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps what the owner is typing when a newer card is read, and saves over the one opened', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const answers = routes({
        [`PATCH /api/knowledge/cards/${CARD_WHO}`]: withStatus(409, { code: 'CONFLICT', message: 'stale', details: { reason: 'card_changed', revision: 3 } }),
      });
      const calls = mockFetch(answers);
      renderAt(`/knowledge?card=${CARD_WHO}`);
      const form = await screen.findByRole('form', { name: i18n.t('knowledge.cards.editLabel', { title: 'Biz kimiz' }) });
      const body = within(form).getByLabelText(k.cards.bodyField);
      await user.clear(body);
      await user.type(body, 'Benim metnim');
      answers['GET /api/knowledge'] = { ...knowledge, cards: knowledge.cards.map((c) => (c.id === CARD_WHO ? { ...c, body: 'Ortağın yazdığı metin', revision: 3 } : c)) };
      const before = reads(calls);
      await vi.advanceTimersByTimeAsync(KNOWLEDGE_BUSY_MS);
      await waitFor(() => expect(reads(calls)).toBeGreaterThan(before));
      expect(body).toHaveValue('Benim metnim');
      await user.click(within(form).getByRole('button', { name: k.save }));
      await waitFor(() => expect(writes(calls, 'PATCH', `/api/knowledge/cards/${CARD_WHO}`)).toHaveLength(1));
      expect(writes(calls, 'PATCH', `/api/knowledge/cards/${CARD_WHO}`)[0].body).toEqual({ expected_revision: 2, body: 'Benim metnim' });
      expect(await within(form).findByText(k.conflict)).toBeInTheDocument();
      await waitFor(() => expect(body).toHaveValue('Ortağın yazdığı metin'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('takes a newer card into an editor nothing was changed in', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const answers = routes();
      const calls = mockFetch(answers);
      renderAt(`/knowledge?card=${CARD_WHO}`);
      const form = await screen.findByRole('form', { name: i18n.t('knowledge.cards.editLabel', { title: 'Biz kimiz' }) });
      answers['GET /api/knowledge'] = { ...knowledge, cards: knowledge.cards.map((c) => (c.id === CARD_WHO ? { ...c, body: 'Ortağın yazdığı metin', revision: 3 } : c)) };
      const before = reads(calls);
      await vi.advanceTimersByTimeAsync(KNOWLEDGE_BUSY_MS);
      await waitFor(() => expect(reads(calls)).toBeGreaterThan(before));
      await waitFor(() => expect(within(form).getByLabelText(k.cards.bodyField)).toHaveValue('Ortağın yazdığı metin'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('saves Kurallar over the rules the dialog opened with, though the page read newer ones', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const answers = routes({ 'PUT /api/knowledge/rules': withStatus(409, { code: 'CONFLICT', message: 'stale', details: { reason: 'rules_changed' } }) });
      const calls = mockFetch(answers);
      renderAt('/knowledge');
      await page();
      await user.click(screen.getByRole('button', { name: k.rules.editLabel }));
      const dialog = await screen.findByRole('dialog', { name: k.rules.title });
      await user.click(within(dialog).getByRole('button', { name: i18n.t('knowledge.rules.dialog.remove', { n: 1 }) }));
      const newer = { ...knowledge.rules, revision: 5, prohibitions: ['Ortağın yasağı.'] };
      answers['GET /api/knowledge'] = { ...knowledge, rules: newer };
      const before = reads(calls);
      await vi.advanceTimersByTimeAsync(KNOWLEDGE_BUSY_MS);
      await waitFor(() => expect(reads(calls)).toBeGreaterThan(before));
      // The owner's edit stays; the save is made over revision 4, so the server can refuse it.
      expect(within(dialog).queryByDisplayValue('Sitede yazmayan fiyat sözü verilmez.')).not.toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: k.save }));
      await waitFor(() => expect(writes(calls, 'PUT', '/api/knowledge/rules')).toHaveLength(1));
      expect(writes(calls, 'PUT', '/api/knowledge/rules')[0].body).toMatchObject({ expected_revision: 4 });
      expect(await within(dialog).findByText(k.conflict)).toBeInTheDocument();
      expect(await within(dialog).findByDisplayValue('Ortağın yasağı.')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('has no agent line when nothing waits for an agent', async () => {
    const schedule: NeedWake = { state: 'schedule', next_expected_at: new Date(Date.now() + 3600_000).toISOString(), interval_minutes: 60, has_address: false, failed_at: null, run_now: null };
    const calls = mockFetch(routes({ 'GET /api/agents/wakes': wakes(schedule) }, { ...knowledge, notes: knowledge.notes.filter((n) => n.status !== 'open'), frame: { number: 2, derive_due: [] } }));
    renderAt('/knowledge');
    await page();
    await waitFor(() => expect(calls.some((c) => c.path === '/api/agents/wakes')).toBe(true));
    expect(screen.queryByTestId('agent-wake-line')).not.toBeInTheDocument();
  });

  it('shows each proposal by its kind, with what a card edit adds, and adds or skips it', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(routes({
      [`POST /api/knowledge/proposals/${PROPOSAL_NEW}/accept`]: { ...knowledge.proposals[0] },
      [`POST /api/knowledge/proposals/${PROPOSAL_RULE}/skip`]: { ...knowledge.proposals[2] },
    }));
    renderAt('/knowledge');
    await page();
    const box = screen.getByRole('region', { name: k.proposals.title });
    const block = (heading: string) => within(box).getByRole('heading', { name: heading }).closest('li') as HTMLElement;
    expect(within(block(i18n.t('knowledge.proposals.cardNew', { title: 'Sık sorulanlar' }))).getByText(i18n.t('knowledge.proposals.reason', { reason: 'Müşteriler bunu sık soruyor.' }))).toBeInTheDocument();
    const edit = block(i18n.t('knowledge.proposals.cardEdit', { card: 'Ürünler ve fiyat' }));
    expect(edit.querySelector('mark')).toHaveTextContent('Hediye kutusu ₺50.');
    expect(block(k.proposals.ruleAdd)).toBeInTheDocument();
    expect(block(k.proposals.goalAdd)).toBeInTheDocument();

    await user.click(within(block(i18n.t('knowledge.proposals.cardNew', { title: 'Sık sorulanlar' }))).getByRole('button', { name: k.proposals.accept }));
    await waitFor(() => expect(writes(calls, 'POST', `/api/knowledge/proposals/${PROPOSAL_NEW}/accept`)).toHaveLength(1));
    expect(await screen.findByText(k.proposals.accepted)).toBeInTheDocument();
    await user.click(within(block(k.proposals.ruleAdd)).getByRole('button', { name: k.proposals.skip }));
    await waitFor(() => expect(writes(calls, 'POST', `/api/knowledge/proposals/${PROPOSAL_RULE}/skip`)).toHaveLength(1));
  });

  it('says a proposal no longer holds when its card changed meanwhile, also once the read drops it', async () => {
    const user = userEvent.setup();
    const answers = routes({
      [`POST /api/knowledge/proposals/${PROPOSAL_EDIT}/accept`]: withStatus(409, { code: 'CONFLICT', message: 'superseded', details: { reason: 'proposal_superseded' } }),
    });
    const calls = mockFetch(answers);
    renderAt('/knowledge');
    await page();
    const before = reads(calls);
    const box = screen.getByRole('region', { name: k.proposals.title });
    const heading = i18n.t('knowledge.proposals.cardEdit', { card: 'Ürünler ve fiyat' });
    const edit = within(box).getByRole('heading', { name: heading }).closest('li') as HTMLElement;
    // The read again lists pending proposals only: the superseded one is gone from it.
    answers['GET /api/knowledge'] = { ...knowledge, proposals: knowledge.proposals.filter((p) => p.id !== PROPOSAL_EDIT) };
    await user.click(within(edit).getByRole('button', { name: k.proposals.accept }));
    await waitFor(() => expect(reads(calls)).toBeGreaterThan(before));
    await waitFor(() => expect(within(box).queryByRole('heading', { name: heading })).not.toBeInTheDocument());
    expect(within(box).getByRole('alert')).toHaveTextContent(k.proposals.superseded);
    expect(screen.queryByText(k.proposals.accepted)).not.toBeInTheDocument();
  });

  it('says a refusal under the proposal while it is still listed', async () => {
    const user = userEvent.setup();
    mockFetch(routes({
      [`POST /api/knowledge/proposals/${PROPOSAL_RULE}/skip`]: withStatus(500, { code: 'INTERNAL', message: 'down', details: {} }),
    }));
    renderAt('/knowledge');
    await page();
    const box = screen.getByRole('region', { name: k.proposals.title });
    const rule = within(box).getByRole('heading', { name: k.proposals.ruleAdd }).closest('li') as HTMLElement;
    await user.click(within(rule).getByRole('button', { name: k.proposals.skip }));
    expect(await within(rule).findByRole('alert')).toBeInTheDocument();
    expect(within(box).getAllByRole('alert')).toHaveLength(1);
  });

  it('marks the words a card edit adds', () => {
    expect(markAdded('Kupa ₺450.', 'Kupa ₺450. Hediye kutusu ₺50.')).toEqual([
      { text: 'Kupa ₺450. ', added: false },
      { text: 'Hediye kutusu ₺50.', added: true },
    ]);
    expect(markAdded('', 'Yeni')).toEqual([{ text: 'Yeni', added: true }]);
  });

  it('says there is no proposal in the mockup’s words', async () => {
    mockFetch(routes({}, { ...knowledge, proposals: [] }));
    renderAt('/knowledge');
    await page();
    expect(within(screen.getByRole('region', { name: k.proposals.title })).getByText(k.proposals.none)).toBeInTheDocument();
  });

  it('shows what works, by topic, only with evidence and to a viewer who works on posts', async () => {
    const overview = (evidence: { id: string; status: string; publication_id?: string; window?: string; raw_metrics: Record<string, number | null> }[]) => ({
      hypotheses: [
        { id: 'h1', title: 'Atölyeden kısa videolar', segment_key: 'genel', derived_confidence: 0.7 },
        { id: 'h2', title: 'Sahibin isteği', segment_key: 'owner_request', derived_confidence: 0.9 },
      ],
      learned: {
        arms: [
          { arm: { id: 'a1', key: { hypothesis_id: 'h1', lane: 'organic', channel: 'instagram', content_type: 'reel' } }, evidence },
          { arm: { id: 'a2', key: { hypothesis_id: 'h2', lane: 'organic', channel: 'instagram', content_type: 'reel' } }, evidence: [{ id: 'm9', status: 'complete', publication_id: 'p9', raw_metrics: {} }] },
        ],
        hypotheses: [{ hypothesis_id: 'h1', derived_confidence: 0.7 }],
      },
    });
    // Two posts: one read at 24 h and 72 h, one at 24 h; a third whose reading is missing, a fourth failed.
    mockFetch(routes({
      'GET /api/studio/overview': overview([
        { id: 'm1', status: 'complete', publication_id: 'p1', window: 'hours24', raw_metrics: {} },
        { id: 'm2', status: 'complete', publication_id: 'p1', window: 'hours72', raw_metrics: {} },
        { id: 'm3', status: 'complete', publication_id: 'p2', window: 'hours24', raw_metrics: {} },
        { id: 'm4', status: 'missing', publication_id: 'p3', window: 'hours24', raw_metrics: {} },
        { id: 'm5', status: 'failed', publication_id: 'p4', window: 'hours24', raw_metrics: {} },
      ]),
    }));
    renderAt('/knowledge');
    await page();
    const learned = await screen.findByRole('region', { name: k.learned.title });
    expect(within(learned).getByText('Atölyeden kısa videolar')).toBeInTheDocument();
    expect(learned).toHaveTextContent(`${i18n.t('knowledge.learned.interest', { level: k.learned.high })} · ${i18n.t('knowledge.learned.measured', { n: 2 })}`);
    // The owner's own requests are not a topic of the page.
    expect(within(learned).queryByText('Sahibin isteği')).not.toBeInTheDocument();
  });

  it('counts each measured post once, by its complete readings', () => {
    expect(measuredPosts([
      { id: 'm1', status: 'complete', publication_id: 'p1', raw_metrics: {} },
      { id: 'm2', status: 'complete', publication_id: 'p1', raw_metrics: {} },
      { id: 'm3', status: 'complete', publication_id: null, binding_id: 'b1', raw_metrics: {} },
      { id: 'm4', status: 'complete', publication_id: null, binding_id: 'b1', raw_metrics: {} },
      { id: 'm5', status: 'failed', publication_id: 'p2', raw_metrics: {} },
    ])).toBe(2);
  });

  it('hides "Neler işe yarıyor" without evidence, and without a complete reading', async () => {
    const calls = mockFetch(routes({
      'GET /api/studio/overview': {
        hypotheses: [{ id: 'h1', title: 'Atölyeden kısa videolar', segment_key: 'genel' }],
        learned: { arms: [{ arm: { id: 'a1', key: { hypothesis_id: 'h1', lane: 'organic', channel: 'instagram', content_type: 'reel' } }, evidence: [{ id: 'm1', status: 'failed', publication_id: 'p1', raw_metrics: {} }] }], hypotheses: [] },
      },
    }));
    renderAt('/knowledge');
    await page();
    await waitFor(() => expect(calls.some((c) => c.path === '/api/studio/overview')).toBe(true));
    expect(screen.queryByRole('region', { name: k.learned.title })).not.toBeInTheDocument();
  });

  it('lets a member read but not change: no composer, no edit, proposals without buttons, and says so', async () => {
    const calls = mockFetch(routes({ 'GET /api/auth/me': repMe }));
    renderAt('/knowledge');
    await page();
    expect(screen.getByText(k.readOnly)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: k.composer.label })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: k.rules.editLabel })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: k.goals.editLabel })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: k.cards.new })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Biz kimiz' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Biz kimiz' })).toBeInTheDocument();
    const box = screen.getByRole('region', { name: k.proposals.title });
    expect(within(box).queryByRole('button', { name: k.proposals.accept })).not.toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: k.notes.title })).queryByRole('button', { name: k.notes.withdraw })).not.toBeInTheDocument();
    // Nobody without a work permission reads the learned results.
    expect(calls.some((c) => c.path === '/api/studio/overview')).toBe(false);
  });

  it('opens "Biz kimiz" for an empty knowledge base, under the callout that says to start there', async () => {
    mockFetch(routes({}, emptyKnowledge));
    renderAt('/knowledge');
    await page();
    expect(screen.getByText(k.empty.callout)).toBeInTheDocument();
    const form = screen.getByRole('form', { name: i18n.t('knowledge.cards.editLabel', { title: 'Biz kimiz' }) });
    expect(within(form).getByLabelText(k.cards.bodyField)).toHaveAttribute('placeholder', k.cards.placeholders.who_we_are);
    expect(within(form).getByLabelText(k.cards.bodyField)).toHaveFocus();
    expect(screen.getByText(k.rules.adNone)).toBeInTheDocument();
    expect(screen.getByText(k.composer.stops.none)).toBeInTheDocument();
  });

  it('points an empty knowledge base to the texts waiting as proposals instead', async () => {
    mockFetch(routes({}, {
      ...emptyKnowledge,
      proposals: [{ ...knowledge.proposals[1], card_id: CARD_WHO, proposed_by: { kind: 'system', component: 'knowledge_backfill' }, reason: 'Daha önce yazılmıştı ama uygulanmamıştı.' }],
    }));
    renderAt('/knowledge');
    await page();
    expect(screen.getByText(k.empty.proposals, { exact: false })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: k.empty.toProposals })).toHaveAttribute('href', '#oneriler');
    expect(screen.queryByRole('form', { name: i18n.t('knowledge.cards.editLabel', { title: 'Biz kimiz' }) })).not.toBeInTheDocument();
  });

  it('shows the boxes’ and cards’ skeletons while loading', async () => {
    mockFetch(routes({ 'GET /api/knowledge': delayed(10_000, knowledge) }));
    renderAt('/knowledge');
    await screen.findByRole('heading', { level: 1, name: k.title });
    expect(screen.getByRole('status', { name: tr.common.loading })).toBeInTheDocument();
  });

  it('says the knowledge base could not be read, and reads again on "Yeniden dene"', async () => {
    const user = userEvent.setup();
    const answers = routes({ 'GET /api/knowledge': withStatus(500, { code: 'INTERNAL', message: 'down', details: {} }) });
    mockFetch(answers);
    renderAt('/knowledge');
    expect(await screen.findByText(k.loadError)).toBeInTheDocument();
    answers['GET /api/knowledge'] = knowledge;
    await user.click(screen.getByRole('button', { name: tr.common.retry }));
    expect(await screen.findByRole('region', { name: k.rules.title })).toBeInTheDocument();
  });

  it('opens a card as a full-screen sheet on a phone', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
      matches: query.includes('max-width: 639px'), media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }) as unknown as MediaQueryList);
    mockFetch(routes());
    renderAt('/knowledge');
    await page();
    await user.click(cardButton('Biz kimiz'));
    const sheet = await screen.findByRole('dialog', { name: 'Biz kimiz' });
    expect(within(sheet).getByRole('form', { name: i18n.t('knowledge.cards.editLabel', { title: 'Biz kimiz' }) })).toBeInTheDocument();
  });
});

describe('KnowledgePage automatic replies', () => {
  const onRules = {
    ...knowledge.rules,
    auto_reply: { ...knowledge.rules.auto_reply, capability_ids: [WHATSAPP_ID], price: { min_minor: 100000, max_minor: 500000, currency: 'TRY' } },
  };

  it('shows one line in Kurallar while they are on, and what they wait for', async () => {
    mockFetch(routes({}, { ...knowledge, rules: onRules }));
    renderAt('/knowledge');
    await page();
    const rules = screen.getByRole('region', { name: k.rules.title });
    expect(within(rules).getByText('Mesajlara otomatik yanıt: WhatsApp · ₺1.000–₺5.000.')).toBeInTheDocument();
  });

  it('says what keeps them waiting, and shows no line while they are off', async () => {
    const waiting = { ...onRules, auto_reply: { ...onRules.auto_reply, off_reason: 'standard_missing' as const } };
    mockFetch(routes({}, { ...knowledge, rules: waiting }));
    renderAt('/knowledge');
    await page();
    expect(within(screen.getByRole('region', { name: k.rules.title })).getByText(k.rules.autoReplyWaiting)).toBeInTheDocument();
  });

  it('turns them on for a WhatsApp number with the range, in the Kurallar dialog', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(routes({ 'PUT /api/knowledge/rules': knowledge.rules }));
    renderAt('/knowledge');
    await page();
    expect(within(screen.getByRole('region', { name: k.rules.title })).queryByText(/otomatik yanıt/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: k.rules.editLabel }));
    const dialog = await screen.findByRole('dialog', { name: k.rules.title });
    const section = within(dialog).getByRole('region', { name: k.rules.dialog.autoReply });
    await user.click(within(section).getByRole('switch', { name: 'Alfa WhatsApp' }));
    // Both amounts are needed.
    await user.click(within(dialog).getByRole('button', { name: k.save }));
    expect(await within(dialog).findByText(k.rules.dialog.autoReplyInvalid)).toBeInTheDocument();
    expect(writes(calls, 'PUT', '/api/knowledge/rules')).toHaveLength(0);
    await user.type(within(section).getByLabelText(k.rules.dialog.autoReplyMin), '1000');
    await user.type(within(section).getByLabelText(k.rules.dialog.autoReplyMax), '5000');
    await user.click(within(dialog).getByRole('button', { name: k.save }));
    await waitFor(() => expect(writes(calls, 'PUT', '/api/knowledge/rules')).toHaveLength(1));
    expect(writes(calls, 'PUT', '/api/knowledge/rules')[0].body).toMatchObject({
      auto_reply: { capability_ids: [WHATSAPP_ID], min_minor: 100000, max_minor: 500000 },
    });
  });

  it('names the mailbox email notices go out from, and turns them off in the dialog', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(routes({ 'PUT /api/knowledge/rules': onRules }, { ...knowledge, rules: onRules }));
    renderAt('/knowledge');
    await page();
    const rules = screen.getByRole('region', { name: k.rules.title });
    expect(within(rules).getByText('E-posta bildirimi: iletisim@alfa.test')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: k.rules.editLabel }));
    const dialog = await screen.findByRole('dialog', { name: k.rules.title });
    const section = within(dialog).getByRole('region', { name: k.rules.dialog.autoReply });
    const box = within(section).getByRole('checkbox', { name: k.rules.dialog.notify });
    expect(box).toBeChecked();
    await user.click(box);
    await user.click(within(dialog).getByRole('button', { name: k.save }));
    await waitFor(() => expect(writes(calls, 'PUT', '/api/knowledge/rules')).toHaveLength(1));
    expect(writes(calls, 'PUT', '/api/knowledge/rules')[0].body).toMatchObject({
      auto_reply: { capability_ids: [WHATSAPP_ID], notify_email: false },
    });
  });

  it('shows no email line and no checkbox without a verified mailbox', async () => {
    const user = userEvent.setup();
    const noMailbox = { ...onRules, auto_reply: { ...onRules.auto_reply, notify: { available: false, on: true, from: null } } };
    mockFetch(routes({}, { ...knowledge, rules: noMailbox }));
    renderAt('/knowledge');
    await page();
    expect(within(screen.getByRole('region', { name: k.rules.title })).queryByText(/E-posta bildirimi/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: k.rules.editLabel }));
    const dialog = await screen.findByRole('dialog', { name: k.rules.title });
    expect(within(dialog).queryByRole('checkbox', { name: k.rules.dialog.notify })).not.toBeInTheDocument();
  });

  it('keeps the switches off and says why when the server has no key', async () => {
    const user = userEvent.setup();
    const noKey = { ...knowledge.rules, auto_reply: { ...knowledge.rules.auto_reply, available: false, off_reason: 'no_key' as const } };
    mockFetch(routes({}, { ...knowledge, rules: noKey }));
    renderAt('/knowledge');
    await page();
    await user.click(screen.getByRole('button', { name: k.rules.editLabel }));
    const dialog = await screen.findByRole('dialog', { name: k.rules.title });
    const section = within(dialog).getByRole('region', { name: k.rules.dialog.autoReply });
    expect(within(section).getByText(k.rules.dialog.autoReplyNoKey)).toBeInTheDocument();
    expect(within(section).getByRole('switch', { name: 'Alfa WhatsApp' })).toBeDisabled();
  });
});
