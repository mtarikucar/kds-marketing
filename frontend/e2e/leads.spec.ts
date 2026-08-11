/**
 * Leads — the CRM core.
 *
 * The lead is the atom the whole product is built on: the dashboard counts it,
 * workflows enrol it, offers and tasks hang off it. So the one path that must
 * never break is "type a lead in, find it again": /leads/new → the lead's own
 * detail page → the row in the list → back into the detail page.
 *
 * What a failure here means:
 *   - empty-state test red → either workspace scoping leaked another test's
 *     rows into this workspace, or the list's empty branch stopped explaining
 *     itself (the copy is the ONLY thing a new user sees on this page).
 *   - create test red → a lead typed by hand is not persisted, not readable
 *     back, or a non-default select value (source) is dropped from the payload;
 *     the row-click tail also pins that a list row opens the SAME lead.
 *   - required-field test red → the form lets an unnamed/contactless lead
 *     through, which the backend rejects with a bare toast, or the Turkish
 *     validation copy regressed to a raw zod key.
 *
 * Verified against the app before asserting:
 *   - routes /leads, /leads/new, /leads/:id all exist in App.tsx (no redirect).
 *   - every Turkish string below comes from src/i18n/locales/tr/marketing.json:
 *     leads.title, leads.emptyManager, createLead.titleNew,
 *     createLead.fields.*, createLead.submitCreate, source.WEBSITE,
 *     validation.required.
 *   - required fields on the create form are ONLY businessName + contactPerson
 *     (leadSchema in features/marketing/schemas.ts); businessType/source/
 *     priority are required by the schema but ship with defaults.
 * No data-testid was added to production code for this spec.
 */
import { test, expect } from './support/fixtures';

/** Turkish-character name — also proves the value survives the round-trip. */
const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1000)}`;

test('a brand-new workspace shows the leads empty state instead of rows', async ({ app }) => {
  await app.goto('/leads');

  await expect(app.getByRole('heading', { level: 1, name: "Lead'ler" })).toBeVisible();

  // No rows at all — this is what proves the per-test workspace is really
  // isolated; a leak from another spec shows up here first.
  await expect(app.locator('tbody tr')).toHaveCount(0);

  // The owner is a manager, so the list renders `leads.emptyManager`, which is
  // the only guidance a fresh workspace gets on this page.
  await expect(app.getByText(/Henüz lead yok/)).toBeVisible();
});

test('a lead typed into /leads/new is saved, opened, and listed', async ({ app }) => {
  const suffix = stamp();
  const businessName = `Kahve Durağı ${suffix}`;
  const contactPerson = `Ayşe Yılmaz ${suffix}`;
  const email = `kahve.${suffix}@e2e.example.com`;
  const city = 'İzmir';

  await app.goto('/leads/new');
  await expect(app.getByRole('heading', { level: 1, name: 'Yeni lead' })).toBeVisible();

  await app.getByLabel('İşletme adı').fill(businessName);
  await app.getByLabel('İlgili kişi').fill(contactPerson);
  await app.getByLabel('E-posta').fill(email);
  await app.getByLabel('Şehir').fill(city);

  // Source defaults to PHONE, so picking WEBSITE is what proves the
  // Controller-bound Radix select actually reaches the payload rather than
  // silently submitting the default.
  await app.getByRole('combobox', { name: /Lead kaynağı/ }).click();
  await app.getByRole('option', { name: 'Web sitesi' }).click();

  await app.getByRole('button', { name: 'Lead oluştur' }).click();

  // The form navigates to the created lead — a real id in the URL is the
  // cheapest proof the POST succeeded.
  await expect(app).toHaveURL(/\/leads\/[0-9a-f-]{36}$/);
  const detailUrl = app.url();

  // Read the lead back from the server-rendered detail page.
  await expect(app.getByRole('heading', { level: 1, name: businessName })).toBeVisible();
  await expect(app.getByText(contactPerson)).toBeVisible();
  await expect(app.getByRole('link', { name: email })).toBeVisible();

  // A full reload of the list, not a cached client-side view.
  await app.goto('/leads');
  const row = app.locator('tbody tr').filter({ hasText: businessName });
  await expect(row).toHaveCount(1);
  // The workspace is fresh, so this must be the ONLY row.
  await expect(app.locator('tbody tr')).toHaveCount(1);
  // Optional fields and the chosen source came back through the list columns.
  await expect(row).toContainText('Web sitesi');
  await expect(row).toContainText(city);

  // Clicking the row opens that same lead (the row is the only way into the
  // detail page from the list — the cells are not links).
  await row.getByText(businessName).click();
  await expect(app).toHaveURL(detailUrl);
});

test('the create form refuses a lead with no business name or contact', async ({ app }) => {
  await app.goto('/leads/new');
  await expect(app.getByRole('heading', { level: 1, name: 'Yeni lead' })).toBeVisible();

  // Everything else on the form has a default, so an untouched submit must be
  // blocked by exactly these two fields.
  await app.getByRole('button', { name: 'Lead oluştur' }).click();

  await expect(app.getByText('Zorunlu', { exact: true })).toHaveCount(2);
  // A successful create navigates away; staying put is the "nothing was sent"
  // signal.
  await expect(app).toHaveURL(/\/leads\/new$/);

  // And nothing was written behind the form's back.
  await app.goto('/leads');
  await expect(app.locator('tbody tr')).toHaveCount(0);
});
