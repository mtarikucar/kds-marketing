/**
 * Sales pipeline — the kanban board at /opportunities and its configuration
 * page at /settings/pipelines.
 *
 * The board is the only page in the product whose scaffolding is SEEDED, not
 * created by the user: `PipelinesService.ensureDefaultPipeline` lazily writes a
 * "Sales Pipeline" with six stages (New → Contacted → Qualified → Proposal Sent
 * → Won → Lost) the first time a workspace reads /pipelines or the board. That
 * seed is invisible to unit tests — they mock the API and hand the page a
 * pipeline — so nothing else proves a brand-new workspace actually gets a
 * usable board instead of an empty one with "Pipeline seç" and no columns.
 *
 * What these pin, for a fresh (therefore deal-less) workspace:
 *   - the seed lands and renders as ordered columns, left to right;
 *   - the empty state is HONEST: no cards, and the open total is a bare "0"
 *     with no currency symbol (the mixed-currency guard's zero case — a symbol
 *     there would assert a currency the workspace has never chosen);
 *   - creating a deal through the dialog puts a card in the FIRST column and
 *     only then does the total gain a symbol;
 *   - the terminal Won/Lost columns never offer "+ Ekle". This is a deliberate
 *     guard (see the comment in OpportunitiesPage.tsx): the backend resolves a
 *     deal born on a terminal stage to WON/LOST, so it would vanish from this
 *     OPEN-only board while silently entering won/lost reporting;
 *   - /settings/pipelines shows that same seed as editable stages, in order.
 *
 * Notes on the assertions:
 *   - Stage names are English on purpose — they are seeded DATA
 *     (pipelines.service.ts DEFAULT_STAGES), not i18n copy. Every piece of UI
 *     copy asserted here is verified present in
 *     src/i18n/locales/tr/marketing.json (locale is pinned tr-TR). Several keys
 *     this page uses (`forecast`, `expectedClose`, `archive`, …) are MISSING
 *     from the Turkish bundle and fall back to English defaults — deliberately
 *     not asserted, so fixing that gap does not break this suite.
 *   - Columns and cards carry no data-testid and none was added. Cards are
 *     located by `[draggable="true"]` (only the deal cards are draggable) and
 *     column order by left-to-right layout position, which is what "kanban
 *     order" actually means to a user.
 *
 * If these fail: a new workspace opens the pipeline to nothing to work with,
 * or a deal is created into a stage that silently closes it.
 */
import { test, expect } from './support/fixtures';
// Type-only — `test`/`expect` still come from the fixtures module above, which
// is what keeps every test on the shared session and its own workspace.
import type { Page } from '@playwright/test';

/** pipelines.service.ts → PipelinesService.DEFAULT_STAGES, in seeded order. */
const SEEDED_STAGES = ['New', 'Contacted', 'Qualified', 'Proposal Sent', 'Won', 'Lost'];

/** Left edge of a stage's column header, for order assertions. */
async function stageX(page: Page, name: string): Promise<number> {
  const label = page.locator('main').getByText(name, { exact: true });
  await expect(label, `stage column "${name}" must render exactly once`).toHaveCount(1);
  const box = await label.boundingBox();
  expect(box, `stage column "${name}" has no layout box`).not.toBeNull();
  return box!.x;
}

test('a fresh workspace is seeded a full board, and its empty state claims no currency', async ({
  app,
}) => {
  await app.goto('/opportunities');

  await expect(app.getByRole('heading', { level: 1, name: 'Fırsatlar' })).toBeVisible();

  // All six seeded stages, laid out in seeded order. A reversed `position`
  // sort or a dropped terminal stage both survive a "the board rendered" check
  // and both are caught here.
  const xs: number[] = [];
  for (const name of SEEDED_STAGES) xs.push(await stageX(app, name));
  for (let i = 1; i < xs.length; i += 1) {
    expect(xs[i], `"${SEEDED_STAGES[i]}" must sit right of "${SEEDED_STAGES[i - 1]}"`).toBeGreaterThan(
      xs[i - 1],
    );
  }

  // Nothing in it yet — the deal cards are the page's only draggable elements.
  await expect(app.locator('main [draggable="true"]')).toHaveCount(0);

  // …and the header says so WITHOUT a currency symbol. `fmtBoard` only prints
  // one when every open deal shares a currency; with no deals at all there is
  // no currency to claim, and "₺0" on a workspace that never picked TRY is a
  // lie the board would tell on day one.
  await expect(app.locator('main p', { hasText: /Açık toplam/ })).toHaveText('Açık toplam: 0');
});

test('a deal created from the header dialog lands in the first stage and gives the total its currency', async ({
  app,
}) => {
  await app.goto('/opportunities');
  // Board is up before we touch the dialog (the create posts to the ACTIVE
  // pipeline, which is only known once /pipelines resolves).
  await expect(app.locator('main').getByText('New', { exact: true })).toBeVisible();

  await app.getByRole('button', { name: 'Yeni fırsat' }).click();
  const dialog = app.getByRole('dialog');
  await expect(dialog).toBeVisible();

  // The name field has no htmlFor-linked label, so it is addressed by its
  // placeholder (opportunities.namePlaceholder); the value field is the only
  // number input in the dialog.
  await dialog.getByPlaceholder(/Acme/).fill('E2E yıllık anlaşma');
  await dialog.locator('input[type="number"]').fill('5000');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();

  await expect(dialog).toBeHidden();

  const cards = app.locator('main [draggable="true"]');
  await expect(cards).toHaveCount(1);
  await expect(cards).toContainText('E2E yıllık anlaşma');
  // TRY is the dialog's default currency. Separator is locale-dependent, the
  // symbol is not — the symbol is the part under test.
  await expect(cards).toContainText(/₺5[.,]000/);

  // Created without a stageId, so the backend must file it under the FIRST
  // stage — i.e. left of the second column, not dumped in whichever stage the
  // map happened to yield.
  const cardBox = await cards.first().boundingBox();
  expect(cardBox).not.toBeNull();
  expect(cardBox!.x, 'a new deal belongs in the leftmost stage').toBeLessThan(
    await stageX(app, 'Contacted'),
  );

  // Now that the board has exactly one currency, the total may finally show it.
  await expect(app.locator('main p', { hasText: /Açık toplam/ })).toHaveText(
    /^Açık toplam: ₺5[.,]000$/,
  );
});

test('the terminal Won/Lost columns offer no way to create a deal into them', async ({ app }) => {
  await app.goto('/opportunities');
  await expect(app.locator('main').getByText('Lost', { exact: true })).toBeVisible();

  // Four of six columns get "+ Ekle" (opportunities.add). A deal created
  // directly on Won/Lost is resolved on write, so it would leave this
  // OPEN-only board immediately while counting as closed revenue.
  const add = app.locator('main').getByRole('button', { name: 'Ekle', exact: true });
  await expect(add).toHaveCount(4);

  // Count alone would still pass if the buttons were on the wrong columns:
  // the last one must sit left of the Won column.
  const lastAdd = await add.last().boundingBox();
  expect(lastAdd).not.toBeNull();
  expect(lastAdd!.x, 'no add button may belong to a terminal column').toBeLessThan(
    await stageX(app, 'Won'),
  );
});

test('the board links to pipeline settings, which shows the seed as editable stages', async ({
  app,
}) => {
  await app.goto('/opportunities');

  // opportunities.managePipelines — manager-only, and the only route from the
  // board to its own configuration.
  const toSettings = app.locator('main').getByRole('link', { name: "Pipeline'lar" });
  await expect(toSettings).toHaveAttribute('href', '/settings/pipelines');
  await toSettings.click();

  await expect(app).toHaveURL(/\/settings\/pipelines$/);
  await expect(app.getByRole('heading', { level: 1, name: "Pipeline'lar" })).toBeVisible();

  // The seeded pipeline, flagged as the default new deals land in.
  await expect(app.getByRole('heading', { name: 'Sales Pipeline' })).toBeVisible();
  await expect(app.locator('main').getByText('Varsayılan', { exact: true })).toHaveCount(1);

  // Each stage renders as a name input; the empty ones are the "new pipeline"
  // and "new stage" fields. Reading the values in DOM order proves this page
  // shows the same ordered seed the board draws — a mismatch here is how a
  // reorder silently applies to one surface and not the other.
  const stageNames = await app
    .locator('main input:not([type])')
    .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value).filter(Boolean));
  expect(stageNames).toEqual(SEEDED_STAGES);
});
