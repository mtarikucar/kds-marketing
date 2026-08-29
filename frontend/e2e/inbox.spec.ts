/**
 * The person-primary surface at /inbox (and, identically, at /leads).
 *
 * The 2026-07 IA merge dissolved the Conversations hub: Channels, Canned
 * Responses, AI Agents and Knowledge stopped being sibling pages and became
 * `?tab=` surfaces of THIS page (App.tsx no longer routes /settings/channels et
 * al). The onboarding checklist deep-links straight into those params, so a
 * `?tab=` value that stops resolving is a dead end for a brand-new workspace —
 * and nothing else in the suite covers it.
 *
 * The 2026-08-29 correction then replaced this page's two tabs with three
 * columns over ONE list of people, and the copy asserted below moved with it:
 * the conversation list's empty state became the people list's, and "select a
 * conversation" became "pick someone". The conversation-list empty state's
 * "Kanal bağla" link went with the list it lived on; the gear menu and the
 * onboarding checklist are the two routes that remain, and the first of them is
 * pinned here.
 *
 * These tests pin, for a fresh (therefore empty) workspace:
 *   - the surface renders its NAMED empty states rather than blank columns, and
 *     an unknown ?tab= falls back to it instead of rendering nothing;
 *   - the gear menu still reaches the Channels surface;
 *   - each config tab mounts its OWN lazy surface — a mis-wired branch would
 *     silently render the wrong one, or none.
 *
 * All copy asserted here is verified present in
 * src/i18n/locales/tr/marketing.json (locale is pinned tr-TR); no production
 * component was modified to make these testable.
 */
import { test, expect } from './support/fixtures';

// The config tabs are lazy chunks — first mount pays a Vite on-demand
// transform, which can outrun the 10 s default expect timeout on a cold run.
const LAZY = { timeout: 20_000 };

test('a fresh workspace gets the surface empty states, and a bogus ?tab= still lands there', async ({
  app,
}) => {
  await app.goto('/inbox');

  await expect(app.getByRole('heading', { level: 1, name: 'Kişiler' })).toBeVisible();

  // Left column: nobody yet — it must SAY so (surface.people.empty), not render
  // an empty list body that reads as a broken page.
  await expect(app.getByText('Bu kuyrukta kimse yok')).toBeVisible();

  // Middle column with nobody selected (surface.pane.pickSomeone).
  await expect(app.getByText('Soldan bir kişi seç.').first()).toBeVisible();

  // `tab` is read straight off the query string; an unrecognised value must
  // fall back to the surface rather than leaving the page blank.
  await app.goto('/inbox?tab=not-a-real-tab');
  await expect(app.getByText('Bu kuyrukta kimse yok')).toBeVisible();
  await expect(app.getByText('Soldan bir kişi seç.').first()).toBeVisible();
});

test('the gear menu opens the Channels surface', async ({ app }) => {
  await app.goto('/inbox');

  await app.getByRole('button', { name: /Inbox settings|Gelen kutusu ayarları/i }).click();
  await app.getByRole('menuitem', { name: /Kanallar|Channels/i }).click();

  await expect(app).toHaveURL(/\/inbox\?tab=channels/);

  // channels.empty + its Account Center CTA: connecting moved to /accounts, so
  // a channels tab that no longer offers that link is a dead end.
  await expect(app.getByText(/Henüz kanal yok/)).toBeVisible(LAZY);
  const connect = app.getByRole('link', { name: /Hesap Merkezi.nden kanal bağla/ });
  await expect(connect).toBeVisible();
  await expect(connect).toHaveAttribute('href', '/accounts');

  // The surface really SWAPPED — the people list is gone, so this cannot pass
  // on a page that merely appended the channels panel.
  await expect(app.getByText('Bu kuyrukta kimse yok')).toBeHidden();
});

test('?tab=agents mounts the Agent Studio, and its create form opens', async ({ app }) => {
  await app.goto('/inbox?tab=agents');

  // agents.empty — specific to the AI-agent surface.
  await expect(app.getByText(/Henüz ajan yok/)).toBeVisible(LAZY);
  await expect(app.getByText('Soldan bir kişi seç.')).toBeHidden();

  // The lazy chunk is not just painted, it is wired: the create dialog opens
  // and carries the persona field (agents.persona) that defines the agent.
  await app.getByRole('button', { name: 'Yeni ajan' }).click();
  const dialog = app.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Kişilik (bu ajan kim?)')).toBeVisible();
});

test('?tab=knowledge and ?tab=snippets each mount their own surface', async ({ app }) => {
  await app.goto('/inbox?tab=knowledge');

  // knowledge.empty + knowledge.new
  await expect(app.getByText(/Henüz belge yok/)).toBeVisible(LAZY);
  await expect(app.getByRole('button', { name: 'Yeni belge' })).toBeVisible();
  // Not the agent studio, not the surface — the tabs must not collide.
  await expect(app.getByText(/Henüz ajan yok/)).toBeHidden();

  await app.goto('/inbox?tab=snippets');

  // snippets.empty.title + snippets.new. A load failure renders
  // snippets.error instead, so this also proves GET /snippets answered.
  await expect(app.getByText('Henüz snippet yok')).toBeVisible(LAZY);
  await expect(app.getByRole('button', { name: 'Yeni snippet' })).toBeVisible();
  await expect(app.getByText(/Henüz belge yok/)).toBeHidden();
});
