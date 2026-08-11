/**
 * Reports (/reports) — the unified reporting hub.
 *
 * Overview / Ads / Performance / Analytics used to be four routes; they are now
 * four TABS of one page, and /ads, /performance and /analytics are redirects
 * into `/reports?tab=…` (App.tsx). Each tab is fed by a DIFFERENT backend
 * module: the classic lead reports (`/marketing/reports/*`, guarded by
 * `@RequiresFeature('advancedReports')`), ad reporting (`/marketing/ads/*`,
 * `reports.read`), sales targets (`/marketing/performance`) and lead analytics
 * (`/marketing/analytics/*`).
 *
 * What breaks if these fail:
 *
 *  1. The tab set / the `?tab=` deep link. Tab state lives in the URL on
 *     purpose — the ads OAuth callback 302s the browser to `/ads?connect=…`,
 *     which only reaches the ads tab because the redirect merges params into
 *     `?tab=ads`. Component-local tab state would silently break that return.
 *
 *  2. Empty-vs-broken. Every surface here renders the SAME empty state when its
 *     query FAILS as when it legitimately has no rows: a rejected request
 *     leaves react-query's `data` undefined and `(rows?.length ?? 0) === 0`
 *     reads that as "nothing to show". So a lost entitlement (both TRIAL and
 *     the single JEETA package grant `advancedReports` today) or a lost
 *     permission would look exactly like a quiet, correct empty page. Each
 *     test therefore asserts BOTH the honest empty state AND that the requests
 *     behind it actually answered 2xx.
 *
 * A fresh fixture workspace has no leads, no ad accounts and no targets, so the
 * empty states below are the true state of the system, not a fixture artefact.
 * No production component was modified for these tests.
 */
import { test, expect } from './support/fixtures';

/**
 * Response listener that records failures for ONE API path prefix, so unrelated
 * noise elsewhere on the page can't fail the assertion. Attach BEFORE goto.
 * Typed structurally so this file never imports from '@playwright/test'.
 */
function apiFailures(sink: string[], pathPrefix: string) {
  return (res: { url(): string; status(): number }) => {
    if (res.url().includes(pathPrefix) && res.status() >= 400) {
      sink.push(`${res.status()} ${res.url()}`);
    }
  };
}

test('the reports hub renders its four tabs and keeps the active one in the URL', async ({ app }) => {
  await app.goto('/reports');

  await expect(app.getByRole('heading', { level: 1, name: 'Raporlar' })).toBeVisible();

  // The overview tab mounts its OWN tablist for the nested lead reports, so
  // identify the page-level one by what it CONTAINS rather than by position.
  // `.first()` depends on mount order between two independently-rendered
  // tablists, which held when this ran alone and flaked under parallel load.
  const pageTabs = (page: typeof app) =>
    page
      .getByRole('tablist')
      .filter({ has: page.getByRole('tab', { name: 'Genel Bakış' }) })
      .first();

  await expect(pageTabs(app).getByRole('tab')).toHaveText([
    'Genel Bakış',
    'Reklamlar',
    'Performans',
    'Analitik',
  ]);

  await pageTabs(app).getByRole('tab', { name: 'Reklamlar' }).click();
  await expect(app).toHaveURL(/[?&]tab=ads/);

  // A reload proves the selection is URL state, not component state — that is
  // what makes the ads OAuth return land on this tab.
  await app.reload();
  await expect(
    pageTabs(app).getByRole('tab', { name: 'Reklamlar' }),
  ).toHaveAttribute('aria-selected', 'true');
});

test('the lead reports show an honest empty state, not a 403, on a leadless workspace', async ({ app }) => {
  const failures: string[] = [];
  app.on('response', apiFailures(failures, '/marketing/reports/'));

  await app.goto('/reports');

  // Overview defaults to the lead-source report.
  await expect(app.getByText('Henüz kaynak verisi yok')).toBeVisible();
  await expect(app.getByText('Lead kaynağı verileri lead yakalandıkça görünür.')).toBeVisible();

  const subTabs = app.getByRole('tablist').nth(1);
  await subTabs.getByRole('tab', { name: 'Bölgesel' }).click();
  await expect(app).toHaveURL(/[?&]sub=regional/);
  await expect(app.getByText('Bölgesel veri yok')).toBeVisible();
  // Radix unmounts the inactive panel: the sources copy going away is the proof
  // the sub-tab really switched rather than stacking a second report.
  await expect(app.getByText('Henüz kaynak verisi yok')).toHaveCount(0);

  expect(
    failures,
    'MarketingReportsController is @RequiresFeature("advancedReports") and a rejected ' +
      'request renders the SAME empty state as no data — these must be 2xx',
  ).toEqual([]);
});

test('the ads tab says no ad account is connected instead of failing silently', async ({ app }) => {
  const failures: string[] = [];
  app.on('response', apiFailures(failures, '/marketing/ads/'));

  await app.goto('/reports?tab=ads');

  // Both the overview and the accounts view title their empty state
  // "Bağlı reklam hesabı yok"; the description is what identifies the overview.
  await expect(
    app.getByText(
      'Harcama ve dönüşüm raporlarını görmek için bir Meta veya TikTok reklam hesabı bağlayın.',
    ),
  ).toBeVisible();

  expect(
    failures,
    'the ads endpoints require the `reports.read` permission; a rejection leaves the ' +
      'account list undefined, which renders as "no accounts connected"',
  ).toEqual([]);
});

test('the analytics tab reports a zeroed funnel and an empty source breakdown', async ({ app }) => {
  const failures: string[] = [];
  app.on('response', apiFailures(failures, '/marketing/analytics/'));

  await app.goto('/reports?tab=analytics');

  // AnalyticsPage's own copy is hardcoded English (it never calls t()), so the
  // strings below are what renders under the pinned tr-TR locale too.
  //
  // /analytics/funnel always answers with an object, so the honest empty state
  // here is a funnel of zeros — a FAILED request is what produces the
  // "No funnel data" placeholder instead. StatCard renders <p>label</p> then
  // <p>value</p> as siblings.
  const totalLeads = app.getByText('Total Leads', { exact: true }).locator('xpath=following-sibling::p[1]');
  const conversionRate = app
    .getByText('Conversion Rate', { exact: true })
    .locator('xpath=following-sibling::p[1]');
  await expect(totalLeads).toHaveText('0');
  await expect(conversionRate).toHaveText('0%');
  await expect(app.getByText('No funnel data')).toHaveCount(0);

  // The breakdown endpoints DO return an empty array, so this one has a real
  // empty state to show.
  await app.getByRole('tablist').nth(1).getByRole('tab', { name: 'By Source' }).click();
  await expect(app.getByText('No source data')).toBeVisible();

  expect(failures, 'analytics queries must answer 2xx for the zeros to mean anything').toEqual([]);
});
