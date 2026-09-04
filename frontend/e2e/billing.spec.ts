/**
 * Billing — the single-package catalogue, asserted through the UI.
 *
 * This is the cheapest end-to-end proof that the collapse actually landed:
 * it exercises the seed, `listPackages`' isPublic+ACTIVE filter, and the
 * pricing card together. If a retired tier were ever un-retired by accident,
 * this fails.
 */
import { test, expect } from './support/fixtures';

test('the pricing page offers exactly one plan', async ({ app }) => {
  await app.goto('/billing');

  // /billing is 'Plan ve erişim' since 2026-09-04 — the plan, and the switch
  // that turns features off, which belong together at the end of the list.
  await expect(app.getByRole('heading', { name: /plan ve eri.im/i }).first()).toBeVisible();
  await expect(app.getByRole('tab', { name: 'Plan', selected: true })).toBeVisible();

  // Exactly one buyable card. The retired STARTER/GROWTH/SCALE rows still
  // exist in the database on purpose — subscriptions point at them by a
  // FK-less id — so their ABSENCE here is the real assertion.
  const chooseButtons = app.getByRole('button', { name: /^Seç$/ });
  await expect(chooseButtons).toHaveCount(1);

  await expect(app.getByRole('heading', { name: 'Jeeta', exact: true })).toBeVisible();
  for (const retired of ['Starter', 'Growth', 'Scale']) {
    await expect(app.getByRole('heading', { name: retired, exact: true })).toHaveCount(0);
  }
});

test('the plan renders its Turkish price and Turkish feature names', async ({ app }) => {
  await app.goto('/billing');

  // Turkish thousands separator — the workspace is created with currency TRY.
  await expect(app.getByText('₺6.900').first()).toBeVisible();

  // Feature labels lived only in a hardcoded English map, so a fully Turkish
  // page listed English capabilities. They resolve through billing.feature.*
  // now; assert a couple that previously printed in English.
  await expect(app.getByText('Tek tıkla arama').first()).toBeVisible();
  await expect(app.getByText('Üyelikler ve kurslar').first()).toBeVisible();
});

test('a new workspace starts on the trial, which grants every feature', async ({ app }) => {
  await app.goto('/billing');

  await expect(app.getByText(/TRIALING|Trial/i).first()).toBeVisible();

  // The trial used to withhold most of the product: on the old TRIAL package
  // `socialCampaigns` was false, so the studio's campaign tools rendered the
  // upgrade wall instead. The trial now mirrors the paid plan's capabilities
  // on smaller meters, so the wall must be gone.
  //
  // (/social is an unconditional legacy redirect into the studio tools — see
  // App.tsx — so assert where it LANDS, not the path we asked for.)
  await app.goto('/social');
  await expect(app).toHaveURL(/\/studio\?view=tools/);
  await expect(app.getByText(/aktif abonelik gerekiyor|growth plan/i)).toHaveCount(0);
});

test('credit packs are sold as a one-off, not as a monthly charge', async ({ app }) => {
  await app.goto('/billing');

  const pack = app.getByText('1.000 AI kredisi').first();
  await expect(pack).toBeVisible();

  // The price line used to read "₺1.290/ay" for every add-on. Credits are a
  // balance bought once that never expires — promising a recurring charge next
  // to a Buy button is the wrong thing to get wrong on a payment control.
  const priceLine = app.getByText(/₺1\.290/).first();
  await expect(priceLine).toContainText(/tek seferlik/i);
  await expect(priceLine).not.toContainText(/\/ay/);
});
