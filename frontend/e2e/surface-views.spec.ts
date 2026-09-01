/**
 * The person surface's LEFT COLUMN, and its four arrangements of the same
 * people: Liste · Hat · Takvim · Görevler (2026-09-01 design, stage 2).
 *
 * ## Why this spec exists
 *
 * Stage 1's reviewer noted that nothing in the browser suite touched the record
 * card or the surface's columns at all — the whole three-column layout was
 * covered only by jsdom, where every embedded page is a `vi.mock` and the CSS
 * that decides which column is on screen does not exist. Stage 2 adds three
 * LAZY chunks to that column, and a lazy chunk is precisely the thing unit
 * tests cannot vouch for: a wrong import path, a bad default export or a
 * circular import compiles, passes vitest against the mock, and fails only in a
 * browser.
 *
 * So this is deliberately thin on assertions about what each view CONTAINS —
 * opportunities.spec.ts already owns the board, and each page owns its own unit
 * tests — and thick on the two things only a browser can answer:
 *
 *   1. each arrangement really MOUNTS from the surface, at 1440px, in the left
 *      column, with the other two columns still standing;
 *   2. **the selected person survives a view switch**, which is the design's
 *      own sentence for what the switcher is FOR ("hattan birine tıklayıp aynı
 *      ekranda yazışmasını okursun; seçili kişi görünüm değişince korunur").
 *
 * ## Notes on the assertions
 *
 * The tab strip is a real `role="tablist"`, so the tabs are located by role and
 * accessible name rather than by test id. Every Turkish string asserted here is
 * in src/i18n/locales/tr/marketing.json (locale is pinned tr-TR):
 * `surface.view.list|board|calendar|tasks`, `surface.title`,
 * `surface.card.idle`, `surface.card.owner`, `surface.people.empty.title`.
 *
 * The three frozen routes these views borrow are asserted to still resolve on
 * their own, because the whole bargain of stage 2 is that the menu collapses
 * and the URLs do not.
 *
 * If this fails: either a view's chunk does not load in a browser, or the
 * switcher has become a navigation — which is the one thing this surface exists
 * to have stopped doing.
 */
import { test, expect } from './support/fixtures';
import { apiUrl } from './support/config';

/** The lazy view chunks pay a Vite on-demand transform on first mount. */
const LAZY = { timeout: 20_000 };

const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1000)}`;

test('the left column switches between four arrangements without disturbing the other two', async ({
  app,
}) => {
  await app.goto('/inbox');
  await expect(app.getByRole('heading', { level: 1, name: 'Kişiler' })).toBeVisible();

  const tabs = app.getByRole('tablist', { name: 'Görünüm' });
  await expect(tabs).toBeVisible();
  await expect(tabs.getByRole('tab')).toHaveCount(4);
  // Liste is where a session starts — the daily arrangement.
  await expect(tabs.getByRole('tab', { name: 'Liste' })).toHaveAttribute('aria-selected', 'true');

  // Hat — the kanban, seeded by PipelinesService for a fresh workspace. Located
  // by the "Hatta değil" column's test id rather than its heading: the record
  // card's SATIŞ section says "Bu kişi hatta değil.", and Playwright's text
  // matching is a case-insensitive SUBSTRING, so the heading alone would be
  // ambiguous the moment somebody is selected.
  await tabs.getByRole('tab', { name: 'Hat' }).click();
  await expect(app).toHaveURL(/left=board/);
  await expect(app.getByTestId('column-not-in-pipeline')).toBeVisible(LAZY);
  // The middle column never went anywhere: with nobody selected it still says
  // so, rather than being replaced by the board.
  await expect(app.getByText('Soldan bir kişi seç.').first()).toBeVisible();

  // Takvim — the month of tasks. "Bugün" is the month navigation's own control.
  await tabs.getByRole('tab', { name: 'Takvim' }).click();
  await expect(app).toHaveURL(/left=calendar/);
  await expect(app.getByRole('button', { name: 'Bugün' })).toBeVisible(LAZY);
  await expect(app.getByTestId('column-not-in-pipeline')).toHaveCount(0);

  // Görevler — the task list, empty on a fresh workspace and SAYING so.
  await tabs.getByRole('tab', { name: 'Görevler' }).click();
  await expect(app).toHaveURL(/left=tasks/);
  await expect(app.getByText('Burada görev yok.')).toBeVisible(LAZY);

  // …and back to the list, which drops the parameter rather than spelling the
  // default out.
  await tabs.getByRole('tab', { name: 'Liste' }).click();
  await expect(app).not.toHaveURL(/left=/);
  await expect(app.getByText('Bu kuyrukta kimse yok')).toBeVisible();
});

test('the person selected in the list is still open after the column changes shape', async ({
  app,
  api,
  workspace,
}) => {
  const suffix = stamp();
  const businessName = `Kahve Durağı ${suffix}`;
  const contactPerson = `Ayşe Yılmaz ${suffix}`;

  // Seeded out of band: the creation flow is leads.spec.ts's job, and what is
  // under test here is what happens to a SELECTION.
  const created = await api.post(apiUrl('/marketing/leads'), {
    headers: { Authorization: `Bearer ${workspace.session.accessToken}` },
    data: {
      businessName,
      contactPerson,
      businessType: 'OTHER',
      source: 'WEBSITE',
      city: 'İzmir',
    },
  });
  expect(created.status(), await created.text()).toBe(201);

  await app.goto('/inbox');

  // Nobody is open yet — the record card says so by name.
  await expect(app.getByText('Soldan bir kişi seç.').first()).toBeVisible();

  await app.getByRole('button', { name: new RegExp(contactPerson) }).click();

  // Selected: the record card is now this person's, and it is NOT a navigation.
  await expect(app.getByText('Sahibi')).toBeVisible();
  await expect(app.getByRole('link', { name: /Kaydı aç/ })).toBeVisible();
  await expect(app).toHaveURL(/\/inbox(\?|$)/);

  const tabs = app.getByRole('tablist', { name: 'Görünüm' });

  // The switch the whole stage is for. The left column becomes a kanban and the
  // person stays open beside it.
  await tabs.getByRole('tab', { name: 'Hat' }).click();
  await expect(app.getByTestId('column-not-in-pipeline')).toBeVisible(LAZY);
  await expect(app.getByRole('link', { name: /Kaydı aç/ })).toBeVisible();
  await expect(app.getByText('Soldan bir kişi seç.')).toHaveCount(0);

  // …and through two more arrangements, then back to the list, still open.
  await tabs.getByRole('tab', { name: 'Görevler' }).click();
  await expect(app.getByText('Burada görev yok.')).toBeVisible(LAZY);
  await expect(app.getByRole('link', { name: /Kaydı aç/ })).toBeVisible();

  await tabs.getByRole('tab', { name: 'Liste' }).click();
  await expect(app.getByRole('link', { name: /Kaydı aç/ })).toBeVisible();
  // The row itself still reports the selection, which is what keeps the three
  // columns agreeing about who is open.
  await expect(app.getByRole('button', { name: new RegExp(contactPerson) })).toHaveAttribute(
    'aria-current',
    'true',
  );
});

test('every page the left column borrows still resolves at its own URL', async ({ app }) => {
  // The bargain of the one-screen work: the menu collapses, the routes do not.
  // navigation.test.ts freezes the path SET; only a browser proves each one
  // still mounts a page rather than a blank shell.
  await app.goto('/opportunities');
  await expect(app.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(app.getByTestId('column-not-in-pipeline')).toBeVisible(LAZY);

  await app.goto('/calendar');
  await expect(app.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(app.getByRole('button', { name: 'Bugün' })).toBeVisible(LAZY);

  await app.goto('/tasks');
  await expect(app.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(app.getByText('Burada görev yok.')).toBeVisible(LAZY);
});
