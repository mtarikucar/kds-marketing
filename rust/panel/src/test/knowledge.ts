import type { CardOut, KnowledgeOut, NoteOut, ProposalOut } from '@/api/knowledge';
import { USER_ID } from '@/test/fixtures';

// The knowledge base of an invented business (a ceramics workshop), shaped like `GET
// /api/knowledge` (design 2026-11-19 §4.11.1). No real people or customers.

const HOUR = 3600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();

export const CARD_WHO = '0190a000-0000-7000-8000-0000000000c1';
export const CARD_PRODUCTS = '0190a000-0000-7000-8000-0000000000c2';
export const CARD_VOICE = '0190a000-0000-7000-8000-0000000000c3';
export const CARD_SEEK = '0190a000-0000-7000-8000-0000000000c4';
export const CARD_OWN = '0190a000-0000-7000-8000-0000000000c5';
export const NOTE_OPEN = '0190a000-0000-7000-8000-0000000000d1';
export const NOTE_FILED = '0190a000-0000-7000-8000-0000000000d2';
export const NOTE_DISMISSED = '0190a000-0000-7000-8000-0000000000d3';
export const NOTE_WITHDRAWN = '0190a000-0000-7000-8000-0000000000d4';
export const PROPOSAL_NEW = '0190a000-0000-7000-8000-0000000000e1';
export const PROPOSAL_EDIT = '0190a000-0000-7000-8000-0000000000e2';
export const PROPOSAL_RULE = '0190a000-0000-7000-8000-0000000000e3';
export const PROPOSAL_GOAL = '0190a000-0000-7000-8000-0000000000e4';
export const AREA_ID = '0190a000-0000-7000-8000-0000000000f1';
export const INSTAGRAM_ID = '0190a000-0000-7000-8000-0000000000a7';
export const WHATSAPP_ID = '0190a000-0000-7000-8000-0000000000a8';

export const PRODUCTS_BODY = 'El yapımı kupa ₺450, kargo dahil. Atölye dersi kişi başı ₺900.';

function card(over: Partial<CardOut> & Pick<CardOut, 'id' | 'title'>): CardOut {
  return { key: null, body: '', attachments: [], revision: 1, updated_at: ago(48 * HOUR), filed: null, ...over };
}

export const cards: CardOut[] = [
  card({ id: CARD_WHO, key: 'who_we_are', title: 'Biz kimiz', body: 'Alfa Atölye: elde şekillendirilmiş seramik kupalar ve haftalık atölye dersleri.', revision: 2 }),
  card({
    id: CARD_PRODUCTS,
    key: 'products_prices',
    title: 'Ürünler ve fiyat',
    body: PRODUCTS_BODY,
    attachments: [{ kind: 'link', url: 'https://alfa.example/fiyatlar', title: 'Fiyat listesi' }],
    revision: 3,
    filed: { at: ago(2 * HOUR), summary: 'Ders fiyatı eklendi' },
  }),
  card({ id: CARD_VOICE, key: 'voice', title: 'Ses tonu' }),
  card({ id: CARD_SEEK, key: 'who_we_seek', title: 'Kimi arıyoruz', body: 'Kahve dükkânları ve hediyelik eşya satıcıları; İzmir ve Manisa.' }),
  card({ id: CARD_OWN, title: 'Kargo', body: 'Siparişler iki iş gününde kargoya verilir.' }),
];

function note(over: Partial<NoteOut> & Pick<NoteOut, 'id' | 'text' | 'status'>): NoteOut {
  return { links: [], files: [], revision: 1, created_at: ago(HOUR), created_by: USER_ID, claimed_until: null, closed_at: null, outcome: null, ...over };
}

/** An open note, one filed with every outcome, a dismissed one and a withdrawn one. */
export const notes: NoteOut[] = [
  note({ id: NOTE_OPEN, text: 'Yılbaşı siparişleri 15 Aralık’ta kapanıyor', status: 'open', created_at: ago(HOUR) }),
  note({
    id: NOTE_FILED,
    text: 'Ders fiyatını 900 yaptık, indirim sözü verme, ayda bir ders hedefle, yılbaşı için bir paylaşım yap',
    status: 'filed',
    created_at: ago(5 * HOUR),
    closed_at: ago(4 * HOUR),
    outcome: {
      cards: [{ card_id: CARD_PRODUCTS, revision: 3 }],
      rules: ['İndirim sözü verilmez.'],
      goals: ['Ayda bir atölye dersi'],
      post_request: { area_id: AREA_ID },
      proposals: [PROPOSAL_NEW],
      summary: 'Ders fiyatı eklendi',
    },
  }),
  note({
    id: NOTE_DISMISSED,
    text: 'Reklama ayda 10.000 harca',
    status: 'dismissed',
    created_at: ago(30 * HOUR),
    closed_at: ago(29 * HOUR),
    outcome: { dismissed: "Reklam bütçesini Kurallar'dan sen değiştirirsin." },
  }),
  note({ id: NOTE_WITHDRAWN, text: 'Pazartesi kapalıyız', status: 'withdrawn', created_at: ago(50 * HOUR), closed_at: ago(49 * HOUR) }),
];

function proposal(over: Partial<ProposalOut> & Pick<ProposalOut, 'id' | 'kind' | 'body' | 'reason'>): ProposalOut {
  return {
    card_id: null,
    title: null,
    proposed_at: ago(3 * HOUR),
    expires_at: ahead(14 * 24 * HOUR),
    proposed_by: { kind: 'agent', connection_id: '0190a000-0000-7000-8000-0000000000b1' },
    ...over,
  };
}

export const proposals: ProposalOut[] = [
  proposal({ id: PROPOSAL_NEW, kind: 'card_new', title: 'Sık sorulanlar', body: 'Kupalar bulaşık makinesine girer mi? Evet.', reason: 'Müşteriler bunu sık soruyor.' }),
  proposal({
    id: PROPOSAL_EDIT,
    kind: 'card_edit',
    card_id: CARD_PRODUCTS,
    base_revision: 3,
    body: `${PRODUCTS_BODY} Hediye kutusu ₺50.`,
    reason: 'Hediye kutusu soruluyor.',
  }),
  proposal({ id: PROPOSAL_RULE, kind: 'rule_add', body: 'Teslim tarihi sözü verilmez.', reason: 'Bir müşteri tarih istedi.' }),
  proposal({ id: PROPOSAL_GOAL, kind: 'goal_add', body: 'Ayda 5 kurumsal sipariş', reason: 'Kurumsal sorular arttı.' }),
];

/** A knowledge base with text, rules, goals, every kind of note and of proposal. */
export const knowledge: KnowledgeOut = {
  revision: 9,
  empty: false,
  cards,
  rules: {
    revision: 4,
    prohibitions: ['Sitede yazmayan fiyat sözü verilmez.', 'Müşteri fotoğrafı yalnızca izinle paylaşılır.', 'Başka atölyelerin adı anılmaz.'],
    ad_cap: { amount_minor: 500000, period: 'monthly', currency: 'TRY' },
    message_cap: { amount_minor: 0, period: 'monthly', currency: 'TRY' },
    post_approval: false,
    post_approval_accounts: [{ capability_id: INSTAGRAM_ID, name: 'Alfa Instagram', kind: 'instagram' }],
    tiktok_connected: true,
    metered: false,
    auto_reply: { available: true, off_reason: null, capability_ids: [], price: null, accounts: [{ capability_id: WHATSAPP_ID, name: 'Alfa WhatsApp', kind: 'whatsapp_cloud' }], notify: { available: true, on: true, from: 'iletisim@alfa.test' }, order: { available: false, host: null, off_reason: 'no_shop' } },
  },
  goals: { revision: 2, items: ['Ayda 20 kupa siparişi', 'Ayda 2 atölye dersi', 'Haftada 3 paylaşım', '3 ayda 2 kahve dükkânı ortaklığı'] },
  notes,
  notes_agent: { state: 'ok', next_at: null },
  proposals,
  frame: { number: 2, derive_due: [] },
};

/** A brand-new workspace: blank seed cards, nothing else. */
export const emptyKnowledge: KnowledgeOut = {
  revision: 1,
  empty: true,
  cards: [
    card({ id: CARD_WHO, key: 'who_we_are', title: 'Biz kimiz' }),
    card({ id: CARD_PRODUCTS, key: 'products_prices', title: 'Ürünler ve fiyat' }),
    card({ id: CARD_VOICE, key: 'voice', title: 'Ses tonu' }),
  ],
  rules: { revision: 1, prohibitions: [], ad_cap: null, message_cap: null, post_approval: false, post_approval_accounts: [], tiktok_connected: false, metered: false, auto_reply: { available: false, off_reason: 'no_key', capability_ids: [], price: null, accounts: [], notify: { available: false, on: true, from: null }, order: { available: false, host: null, off_reason: 'no_shop' } } },
  goals: { revision: 1, items: [] },
  notes: [],
  notes_agent: { state: 'none', next_at: null },
  proposals: [],
  frame: null,
};
