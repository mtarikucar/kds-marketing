/**
 * Commerce chain — products → order forms → invoices.
 *
 * These three pages are one dependency chain: a product is the thing an order
 * form sells, and an order form's checkout is what produces an invoice. The
 * chain is only ever exercised end-to-end in a browser, so a break here is
 * invisible to the unit suites:
 *
 *   - /products, /order-forms and /invoices all live in App.tsx's MANAGER-gated
 *     block. If that gate, the lazy chunk or the list query regressed, a manager
 *     lands on /dashboard or an error state instead of the page — every empty
 *     state below would stop rendering.
 *   - A fresh workspace must look EMPTY. If workspace scoping on
 *     GET /marketing/products|/order-forms|/invoices leaked, these tests see
 *     another test's rows instead of the empty states.
 *   - /order-forms deliberately refuses to let you create anything until the
 *     catalog has a product (an order form with no product cannot check out).
 *   - Money must render in Turkish. ProductsPage formats with
 *     `Intl.NumberFormat(undefined, …)` — i.e. the BROWSER locale, not the app's
 *     i18n language — so a TRY price on a tr-TR browser must read ₺1.234,50 and
 *     never the en-US ₺1,234.50. Only a real browser can prove that.
 *
 * No production component was modified for these tests.
 */
import { test, expect } from './support/fixtures';
import { apiUrl } from './support/config';

/**
 * Turkish TRY formatting for 1234.5: '.' groups thousands, ',' is the decimal
 * separator. The symbol's SIDE is left free (ICU has moved it between versions
 * and either side is correct Turkish) — the separators are the actual claim,
 * and they are what flips if the locale ever falls back to en-US.
 */
const TRY_1234_50 = /^(₺\s?1\.234,50|1\.234,50\s?₺)$/;

test('a new workspace has an empty product catalog', async ({ app }) => {
  await app.goto('/products');

  await expect(app.getByRole('heading', { name: 'Ürünler', level: 1 })).toBeVisible();

  // The catalog renders EITHER this empty state or a grid of product cards, so
  // its presence is the "no rows leaked into this workspace" assertion.
  await expect(app.getByText('Henüz ürün yok')).toBeVisible();
  await expect(
    app.getByText('Faturalarda ve fırsatlarda kullanmak için ürün oluşturun.'),
  ).toBeVisible();

  // Tax rates and coupons were separate routes before the hub merge; they are
  // deep-linkable tabs of this page now.
  await expect(app.getByRole('tab', { name: 'Vergi Oranları' })).toBeVisible();
  await expect(app.getByRole('tab', { name: 'Kuponlar' })).toBeVisible();
});

test('a product created through the UI is listed with Turkish lira formatting', async ({ app }) => {
  await app.goto('/products');

  // Two buttons carry this name on the empty page (toolbar + empty-state CTA);
  // the first is the toolbar one.
  await app.getByRole('button', { name: 'Yeni ürün' }).first().click();

  const dialog = app.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Yeni ürün' })).toBeVisible();

  // The dialog's Labeled() wrapper renders a <label> with no htmlFor, so there
  // is no accessible name to match on. Name is the only placeholder'd field;
  // price is the FIRST number input (tax % is the second). Currency (TRY) and
  // billing type (one-time) are left at their defaults on purpose — that is the
  // path a user takes, and it is what makes the ₺ assertion below meaningful.
  await dialog.getByPlaceholder('Pro plan').fill('E2E Danışmanlık Paketi');
  await dialog.locator('input[type="number"]').first().fill('1234.5');

  const posted = app.waitForResponse(
    (r) => r.url().includes('/marketing/products') && r.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  const res = await posted;
  expect(res.status(), await res.text()).toBe(201);

  await expect(dialog).toBeHidden();

  // Listed from the server's refetch, not from optimistic state.
  await expect(app.getByText('Henüz ürün yok')).toHaveCount(0);
  await expect(app.getByText('E2E Danışmanlık Paketi')).toBeVisible();
  // One product in the workspace, so a page-level match is unambiguous.
  await expect(app.getByText(TRY_1234_50)).toBeVisible();
  // Billing type defaulted to one-time, and the badge says so in Turkish.
  await expect(app.getByText('Tek seferlik')).toBeVisible();
});

test('order forms stay locked until the catalog has a product', async ({ app, api, workspace }) => {
  await app.goto('/order-forms');

  // A TAB of Selling since 2026-09-04: a product is what you sell and an order
  // form is how somebody buys it. The old path redirects, and the page's own
  // <h1> gave way to the shell's.
  await expect(app).toHaveURL(/\/products\?tab=order-forms$/);
  await expect(app.getByRole('tab', { name: 'Sipariş formları', selected: true })).toBeVisible();

  // With no product there is nothing an order form could sell, so the page
  // explains that and disables creation instead of offering a dead-end dialog.
  await expect(app.getByText('Önce bir ürün oluşturun')).toBeVisible();
  await expect(app.getByRole('button', { name: 'Yeni sipariş formu' }).first()).toBeDisabled();
  await expect(app.getByText('Henüz sipariş formu yok')).toHaveCount(0);

  // Seed the product out-of-band — the gate is what's under test here, the
  // creation flow is covered by the test above.
  const created = await api.post(apiUrl('/marketing/products'), {
    headers: { Authorization: `Bearer ${workspace.session.accessToken}` },
    data: { name: 'E2E Aylık Abonelik', price: 750, currency: 'TRY' },
  });
  expect(created.status(), await created.text()).toBe(201);

  await app.reload();

  await expect(app.getByText('Önce bir ürün oluşturun')).toHaveCount(0);
  await expect(app.getByRole('button', { name: 'Yeni sipariş formu' }).first()).toBeEnabled();
  // Only now does the page show its OWN empty state.
  await expect(app.getByText('Henüz sipariş formu yok')).toBeVisible();
});

test('the invoices page starts empty and will not create a blank invoice', async ({ app }) => {
  await app.goto('/invoices');

  await expect(app.getByRole('heading', { name: 'Faturalar', level: 1 })).toBeVisible();
  await expect(app.getByText('Nasıl ödeme alırsınız')).toBeVisible();

  // The empty state is rendered only when the list query SUCCEEDED and came
  // back empty (`!isError && length === 0`), so this distinguishes "no invoices
  // yet" from "the page failed to load" — and no table means no leaked rows.
  await expect(app.getByText('Henüz fatura yok.')).toBeVisible();
  await expect(app.getByRole('table')).toHaveCount(0);

  await app.getByRole('button', { name: 'Yeni fatura' }).first().click();
  await expect(app.getByText('Henüz fatura yok.')).toHaveCount(0);
  await expect(app.getByRole('button', { name: 'Satır ekle' })).toBeVisible();

  // A line with no description is dropped from the payload, so an invoice built
  // only from blank lines would post an empty items[] and bill nothing. The
  // create button stays disabled until at least one line is real.
  //
  // Scoped to <main>: the app header carries a global quick-create button also
  // labelled "Oluştur", so a page-wide lookup is ambiguous and Playwright's
  // strict mode rejects it.
  const createBtn = app.locator('main').getByRole('button', { name: 'Oluştur', exact: true });
  await expect(createBtn).toBeDisabled();
  await app.getByPlaceholder('Açıklama').fill('Danışmanlık — Ağustos');
  await expect(createBtn).toBeEnabled();
});
