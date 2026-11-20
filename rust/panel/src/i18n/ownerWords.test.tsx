import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import tr from '@/i18n/tr.json';
import type { KnowledgeOut } from '@/api/knowledge';
import type { NeedWake } from '@/api/types';
import { me } from '@/test/fixtures';
import { CARD_PRODUCTS, emptyKnowledge, knowledge } from '@/test/knowledge';
import { mockFetch, renderAt, type FetchRoutes } from '@/test/render';

// The owner reads no internal word (design 2026-11-19 §1.2 G6, §8.5): the pages are mounted over
// fixtures that hold every kind of thing they can show, and their visible text (Turkish) is
// checked, so reused keys and the server's codes are covered too, not only one namespace.
// Paylaşımlar joins this test with its own page (§7.4, PR 5).

/** Internal words, at the start of a word ("kolay" is not "olay"). */
const INTERNAL = /(?<!\p{L})(olay|paket|sürüm|durak|hipotez|strateji|icp|kadans|materyal|taslak)/u;
/** TikTok's own word for its drafts is the one "taslak" the owner reads. */
const TIKTOK_DRAFTS = /tiktok'ta taslak|tiktok'taki taslaklarına/gu;
/** The pages speak to the owner as "sen": no "siz" form. */
const SIZ = /onayınız|(?<!\p{L})(seçin|ekleyin)(?!\p{L})/u;

/** Everything the owner can read now: the page, open dialogs and menus, placeholders and labels. */
function visibleText(): string {
  // A modal dialog hides the page from the accessibility tree, not from the owner's eyes.
  const main = document.getElementById('main-content');
  if (!main) throw new Error('the page is not drawn');
  const roots = [main, ...screen.queryAllByRole('dialog'), ...screen.queryAllByRole('menu')];
  const texts = roots.flatMap((root) => [
    root.textContent ?? '',
    ...Array.from(root.querySelectorAll('[placeholder], [aria-label], [title]')).flatMap((el) =>
      ['placeholder', 'aria-label', 'title'].map((a) => el.getAttribute(a) ?? ''),
    ),
  ]);
  return texts.join('\n').toLocaleLowerCase('tr');
}

/**
 * The internal words and "siz" forms in `text` (lowercased as Turkish reads it), each with a little
 * of what surrounds it. An ASCII capital I lowercases to a dotless ı in Turkish ("ICP" → "ıcp",
 * "STRATEJI" → "stratejı"), so the internal words are also looked for with every ı read as i (no
 * Turkish word turns into one of them that way; the same length keeps the positions).
 */
function offences(text: string): string[] {
  const cleaned = text.replace(TIKTOK_DRAFTS, '');
  const dotted = cleaned.replace(/ı/gu, 'i');
  const found: string[] = [];
  for (const [pattern, within] of [[INTERNAL, dotted], [SIZ, cleaned]] as const) {
    const global = new RegExp(pattern.source, 'gu');
    for (const m of within.matchAll(global)) found.push(within.slice(Math.max(0, m.index - 30), m.index + 30));
  }
  return found;
}

const none: NeedWake = { state: 'no_agent' };
const late: NeedWake = {
  state: 'schedule',
  next_expected_at: new Date(Date.now() - 3600_000).toISOString(),
  interval_minutes: 60,
  has_address: false,
  failed_at: null,
  run_now: null,
};

function answers(data: KnowledgeOut): FetchRoutes {
  return {
    'GET /api/auth/me': me,
    'GET /api/knowledge': data,
    'GET /api/agents/wakes': { agents: [], needs: { content: none, materials: none, social: none, ads: none, research: none, inbox: none, knowledge: late } },
    'GET /api/studio/overview': {
      hypotheses: [{ id: 'h1', title: 'Atölyeden kısa videolar', segment_key: 'genel' }],
      learned: { arms: [{ arm: { id: 'a1', key: { hypothesis_id: 'h1', lane: 'organic', channel: 'instagram', content_type: 'reel' } }, evidence: [{ id: 'm1', status: 'complete', publication_id: 'p1', raw_metrics: {} }] }], hypotheses: [{ hypothesis_id: 'h1', derived_confidence: 0.3 }] },
    },
    [`GET /api/knowledge/cards/${CARD_PRODUCTS}/history`]: {
      revisions: (['note', 'proposal', 'owner', 'backfill', 'resync', 'system'] as const).map((cause, i) => ({
        id: `rev-${i}`, subject: 'card', card_id: CARD_PRODUCTS, revision: 6 - i, kb_revision: 9 - i,
        content: { title: 'Ürünler ve fiyat', body: `Metin ${i}`, attachments: [], archived: i === 5 }, cause, source_id: null,
        at: '2026-11-18T09:00:00Z', by: cause === 'owner' || cause === 'proposal' ? { kind: 'human', user_id: me.user_id } : { kind: 'system', component: 'knowledge' },
      })),
      next_before: null,
    },
  };
}

describe('the owner’s words on Bilgi bankası', () => {
  it('holds no internal word or "siz" form, with every note outcome, proposal kind, rule line, dialog and agent stop', async () => {
    const user = userEvent.setup();
    const stops: KnowledgeOut['notes_agent'][] = [
      { state: 'none', next_at: null },
      { state: 'asleep', next_at: '2026-11-21T09:00:00Z' },
      { state: 'late', next_at: '2026-11-19T09:00:00Z' },
    ];
    const seen: string[] = [];
    for (const notes_agent of stops) {
      mockFetch(answers({ ...knowledge, notes_agent, frame: { number: 2, derive_due: ['posting'] } }));
      const { unmount } = renderAt(`/knowledge?card=${CARD_PRODUCTS}`);
      await screen.findByRole('heading', { level: 1, name: tr.knowledge.title });
      await screen.findByRole('region', { name: tr.knowledge.learned.title });
      seen.push(visibleText());
      unmount();
    }

    mockFetch(answers(knowledge));
    renderAt(`/knowledge?card=${CARD_PRODUCTS}&history=${CARD_PRODUCTS}`);
    const history = await screen.findByRole('dialog', { name: tr.knowledge.history.title });
    await within(history).findAllByRole('button', { name: tr.knowledge.history.restore });
    seen.push(visibleText());
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: tr.knowledge.rules.editLabel }));
    await screen.findByRole('dialog', { name: tr.knowledge.rules.title });
    seen.push(visibleText());
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: tr.knowledge.goals.editLabel }));
    await screen.findByRole('dialog', { name: tr.knowledge.goals.title });
    seen.push(visibleText());
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(within(screen.getByRole('region', { name: tr.knowledge.composer.label })).getByRole('button', { name: tr.knowledge.composer.attach }));
    await screen.findByRole('menu');
    seen.push(visibleText());

    expect(seen.flatMap(offences)).toEqual([]);
    // Four mounts and three dialogs: more than the default five seconds on a busy runner.
  }, 15_000);

  it('holds none on an empty knowledge base either, with or without the texts waiting as proposals', async () => {
    const seen: string[] = [];
    for (const data of [
      emptyKnowledge,
      { ...emptyKnowledge, proposals: [{ ...knowledge.proposals[0], proposed_by: { kind: 'system' as const, component: 'knowledge_backfill' }, reason: 'Daha önce yazılmıştı ama uygulanmamıştı.' }] },
    ]) {
      mockFetch(answers(data));
      const { unmount } = renderAt('/knowledge');
      await screen.findByRole('region', { name: tr.knowledge.rules.title });
      seen.push(visibleText());
      unmount();
    }
    expect(seen.flatMap(offences)).toEqual([]);
  });

  it('catches an internal word, a "siz" form, and lets TikTok’s drafts and "kolay" through', () => {
    expect(offences("bu olay için · onayınızı bekliyor")).toHaveLength(2);
    // Written in capitals with an ASCII I, as the page lowercases them.
    expect(offences('Hedef ICP · STRATEJI · HİPOTEZ'.toLocaleLowerCase('tr'))).toHaveLength(3);
    expect(offences("tiktok'ta taslak · kolay · tiktok'taki taslaklarına gönderildi")).toEqual([]);
  });
});
