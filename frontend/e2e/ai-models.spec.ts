/**
 * The AI model settings card, in a real browser — the price witness.
 *
 * ## Why a browser test, and why THIS assertion
 *
 * jsdom does not apply Tailwind. A view shipped earlier in this session rendered
 * nothing on screen while 126 jsdom tests stayed green, because every class that
 * decides whether an element is visible simply does not exist in that
 * environment. `AiModelsPage.test.tsx` therefore proves the component's LOGIC —
 * which option is checked, what the PATCH sends — and cannot prove that a
 * manager can see any of it.
 *
 * What only a browser can answer here:
 *
 *   1. the lazy chunk registered in App.tsx actually loads and mounts at
 *      `/settings/ai-models` (a wrong import path or a bad default export
 *      compiles, passes vitest against the mock, and fails only here);
 *   2. the catalogue is served by the REAL endpoint — the whole point of the
 *      screen is that the price comes from the backend rather than a fourth
 *      hardcoded copy of the model list, and only the real request path proves
 *      the route exists, is reachable at the MANAGER floor, and returns prices;
 *   3. **the price is visible INSIDE the control being chosen with.** Not
 *      "somewhere on the page" — inside the radiogroup, on the option. Video is
 *      the most expensive action in this product and choosing a model is the
 *      spending decision; a picker that renders its prices into a collapsed or
 *      clipped container is exactly the failure jsdom cannot see.
 *
 * Locale is pinned tr-TR by playwright.config.ts, so every string asserted here
 * is the Turkish one and lives in src/i18n/locales/tr/marketing.json:
 * `nav.aiModels`, `aiModels.title`, `aiModels.video.title`,
 * `aiModels.platformDefaultIs`, `aiModels.priceVideo`, `settingsGroup.automation`.
 *
 * If this fails: either the chunk does not load, the endpoint is not reachable
 * from the panel, or the prices are no longer on the options — and the third is
 * the one that would make the card actively misleading rather than merely
 * broken.
 */
import { test, expect } from './support/fixtures';

/** The lazy settings chunk pays a Vite on-demand transform on first mount. */
const LAZY = { timeout: 20_000 };

test('the model picker shows each model’s price on the option itself', async ({ app }) => {
  await app.goto('/settings/ai-models');

  await expect(app.getByRole('heading', { name: 'Yapay zeka üretim modelleri' })).toBeVisible(LAZY);

  // The video card, located by the accessible name its own RadioGroup carries.
  const video = app.getByRole('radiogroup', { name: 'Video modeli' });
  await expect(video).toBeVisible(LAZY);

  /*
   * The assertion that matters. The price is part of each radio's accessible
   * name (aria-labelledby spans the label AND the price element), so a radio
   * that is visible with this name is a radio whose price a person can read —
   * it cannot pass with the number rendered outside the control, or with the
   * control rendered and the price container collapsed.
   *
   * Two options, two different prices, so this also fails if every row is given
   * the same number.
   */
  const priced = video.getByRole('radio', { name: /saniyede \d+ kredi \(\$[\d.]+\/sn\)/ });
  await expect(priced).toHaveCount(await video.getByRole('radio').count());
  // Anchored, because the platform row legitimately quotes the SAME number as
  // the model it currently points at — two rows, one price, on purpose.
  await expect(video.getByRole('radio', { name: /^Video \+ audio saniyede 25 kredi/ })).toBeVisible();
  await expect(video.getByRole('radio', { name: /^Short video saniyede 3 kredi/ })).toBeVisible();

  // A workspace that has chosen nothing sits on a NAMED platform default, not
  // an empty picker — the state that keeps it following the platform constant.
  await expect(
    video.getByRole('radio', { name: /^Platform varsayılanı \(/ }),
  ).toHaveAttribute('aria-checked', 'true');

  // Images bill in a different unit, and the card says so rather than reusing
  // the per-second wording.
  const image = app.getByRole('radiogroup', { name: 'Görsel modeli' });
  await expect(image.getByRole('radio', { name: /^Draft image görsel başına \d+ kredi/ })).toBeVisible();

  // Nothing has changed yet, so the save affordance is inert.
  await expect(app.getByRole('button', { name: 'Kaydet' })).toBeDisabled();
});

test('the card has a door in the Settings menu, under a real group', async ({ app }) => {
  // Desktop width: SettingsLayout's sidebar is `hidden … md:flex`, so below md
  // the entry that is on screen is the mobile strip's, not this one.
  await app.setViewportSize({ width: 1440, height: 900 });
  await app.goto('/branding');

  const nav = app.getByRole('navigation', { name: 'Ayarlar' });
  const link = nav.getByRole('link', { name: 'Yapay zeka modelleri' });
  await expect(link).toBeVisible(LAZY);

  await link.click();
  await expect(app).toHaveURL(/\/settings\/ai-models$/);
  await expect(app.getByRole('heading', { name: 'Yapay zeka üretim modelleri' })).toBeVisible(LAZY);
});
