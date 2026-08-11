/**
 * Inbox — the omnichannel conversations hub at /inbox.
 *
 * The 2026-07 IA merge dissolved the Conversations hub: Channels, Canned
 * Responses, AI Agents and Knowledge stopped being sibling pages and became
 * `?tab=` surfaces of THIS page (App.tsx no longer routes /settings/channels
 * et al). The onboarding checklist and the inbox's own empty state deep-link
 * straight into those params, so a `?tab=` value that stops resolving is a
 * dead end for a brand-new workspace with no way back — and nothing else in
 * the suite covers it.
 *
 * These tests pin, for a fresh (therefore empty) workspace:
 *   - the default inbox surface renders its empty state rather than a blank
 *     pane, and an unknown ?tab= falls back to it instead of rendering nothing;
 *   - the empty state's "Kanal bağla" CTA actually lands on the channels tab
 *     (it is the only route a new workspace is offered to connect a channel);
 *   - each config tab mounts its OWN lazy surface — a mis-wired TabsContent
 *     would silently render the wrong one, or none.
 *
 * All copy asserted here is verified present in
 * src/i18n/locales/tr/marketing.json (locale is pinned tr-TR); no production
 * component was modified to make these testable.
 */
import { test, expect } from './support/fixtures';

// The config tabs are lazy chunks — first mount pays a Vite on-demand
// transform, which can outrun the 10 s default expect timeout on a cold run.
const LAZY = { timeout: 20_000 };

test('a fresh workspace gets the inbox empty state, and a bogus ?tab= still lands there', async ({
  app,
}) => {
  await app.goto('/inbox');

  await expect(app.getByRole('heading', { level: 1, name: 'Gelen Kutusu' })).toBeVisible();

  // Left pane: no conversations yet — it must SAY so (inbox.empty/emptyHint),
  // not render an empty list body that reads as a broken page.
  await expect(app.getByText('Henüz konuşma yok.')).toBeVisible();
  await expect(app.getByText(/Bir kanal bağlanıp/)).toBeVisible();

  // Centre pane with nothing selected (inbox.selectPrompt).
  await expect(app.getByText('Konuşmayı görmek için birini seçin.')).toBeVisible();

  // `tab` is read straight off the query string; an unrecognised value must
  // fall back to the inbox, not select a tab that has no TabsContent and
  // leave the page blank.
  await app.goto('/inbox?tab=not-a-real-tab');
  await expect(app.getByText('Henüz konuşma yok.')).toBeVisible();
  await expect(app.getByText('Konuşmayı görmek için birini seçin.')).toBeVisible();
});

test('the empty state\'s connect-channel CTA opens the Channels tab', async ({ app }) => {
  await app.goto('/inbox');

  // inbox.connectChannel — the ONLY affordance a new workspace is given here.
  await app.getByRole('link', { name: 'Kanal bağla' }).click();

  await expect(app).toHaveURL(/\/inbox\?tab=channels/);

  // channels.empty + its Account Center CTA: connecting moved to /accounts, so
  // the channels tab that no longer offers that link is a dead end.
  await expect(app.getByText(/Henüz kanal yok/)).toBeVisible(LAZY);
  const connect = app.getByRole('link', { name: /Hesap Merkezi.nden kanal bağla/ });
  await expect(connect).toBeVisible();
  await expect(connect).toHaveAttribute('href', '/accounts');

  // The tab really SWAPPED the surface — the conversation list is gone, so
  // this cannot pass on a page that merely appended the channels panel.
  await expect(app.getByText('Henüz konuşma yok.')).toBeHidden();
});

test('?tab=agents mounts the Agent Studio, and its create form opens', async ({ app }) => {
  await app.goto('/inbox?tab=agents');

  // agents.empty — specific to the AI-agent surface.
  await expect(app.getByText(/Henüz ajan yok/)).toBeVisible(LAZY);
  await expect(app.getByText('Konuşmayı görmek için birini seçin.')).toBeHidden();

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
  // Not the agent studio, not the inbox — the tabs must not collide.
  await expect(app.getByText(/Henüz ajan yok/)).toBeHidden();

  await app.goto('/inbox?tab=snippets');

  // snippets.empty.title + snippets.new. A load failure renders
  // snippets.error instead, so this also proves GET /snippets answered.
  await expect(app.getByText('Henüz snippet yok')).toBeVisible(LAZY);
  await expect(app.getByRole('button', { name: 'Yeni snippet' })).toBeVisible();
  await expect(app.getByText(/Henüz belge yok/)).toBeHidden();
});
