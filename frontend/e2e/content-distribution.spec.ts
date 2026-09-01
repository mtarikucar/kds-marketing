/**
 * The Distribution tab, in a real browser.
 *
 * ## Why this exists
 *
 * jsdom does not apply Tailwind, and the panel lives inside a Radix `Tabs`
 * whose inactive `TabsContent` is removed or hidden by CSS the unit environment
 * does not have. `DistributionPanel.test.tsx` proves the LOGIC — that nothing
 * sends on render, that there is no bulk send, that a gap's reason is rendered
 * where the missing section would be — and it proves all of it against a
 * component it renders directly, never through the tab. A tab that never
 * switches, or content that mounts behind a collapsed container, would leave
 * every one of those assertions green and the feature invisible.
 *
 * So this asserts the two things only a browser can answer:
 *
 *   1. the tab EXISTS on the campaign page, switches, and its content becomes
 *      visible at 1440px, alongside the two tabs that were already there;
 *   2. **the honest empty state is the thing on screen.** A campaign with
 *      nothing approved yet must show the sentence that says so — inside the
 *      tab panel — rather than a blank area. "Empty reads as done" is the
 *      failure this whole feature is built not to have, and a blank tab is
 *      exactly that failure in its most literal form.
 *
 * ## What this spec deliberately does NOT cover, and why
 *
 * The send flow. Reaching a draft in a browser needs a campaign ITEM at
 * APPROVED or PUBLISHED, and an item only gets there by the planner generating
 * it (`AI_DISABLED=1` in this harness, on purpose) and a real publish to a real
 * network. Faking that would mean writing rows this suite has no database
 * access to write. The full chain — plan, draft, the SYSTEM sentinel refused,
 * a real human's send stamping `sentById`, and the refusal to send twice — is
 * covered against real Postgres in
 * `backend/test/e2e/content-distribution.realdb.e2e-spec.ts`.
 *
 * Locale is pinned tr-TR by playwright.config.ts, so every asserted string is
 * the Turkish one, from src/i18n/locales/tr/marketing.json:
 * `socialCampaign.tabCalendar|tabQueue|tabDistribution`,
 * `contentDistribution.noItems`.
 */
import { test, expect } from './support/fixtures';
import { apiUrl } from './support/config';

/** The lazy campaign-detail chunk pays a Vite on-demand transform on first mount. */
const LAZY = { timeout: 20_000 };

const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1000)}`;

test('the campaign page has a Distribution tab whose content is really on screen', async ({
  app,
  api,
  workspace,
}) => {
  const auth = { Authorization: `Bearer ${workspace.session.accessToken}` };
  const id = stamp();

  // A campaign needs at least one target account, so connect one over the
  // MANUAL path the account hub already exposes. This is also what makes the
  // assertion below meaningful: the workspace is NOT in the zero-accounts state,
  // so the empty tab is about the calendar, not about the connection.
  const account = await api.post(apiUrl('/marketing/social-planner/accounts'), {
    headers: auth,
    data: {
      network: 'FACEBOOK',
      externalId: `e2e-fb-${id}`,
      displayName: `E2E Page ${id}`,
      accessToken: 'e2e-not-a-real-token',
    },
  });
  expect(account.ok(), await account.text()).toBeTruthy();
  const accountId = (await account.json()).id as string;

  const campaign = await api.post(apiUrl('/marketing/social-campaigns'), {
    headers: auth,
    data: {
      name: `E2E Distribution ${id}`,
      brief: { topics: ['Strandbeest'] },
      automationMode: 'APPROVAL',
      planningMode: 'USER_TOPICS',
      cadence: { perWeek: 1, daysOfWeek: [1], timeOfDay: '10:00' },
      startDate: new Date().toISOString(),
      targetAccountIds: [accountId],
      mediaKinds: ['VIDEO'],
    },
  });
  expect(campaign.ok(), await campaign.text()).toBeTruthy();
  const campaignId = (await campaign.json()).id as string;

  await app.setViewportSize({ width: 1440, height: 900 });
  await app.goto(`/social-campaigns/${campaignId}`);
  await expect(app.getByRole('heading', { name: `E2E Distribution ${id}` })).toBeVisible(LAZY);

  // Three tabs, and the count is the assertion: "contains Dağıtım" would also
  // pass if the two that were already there had been replaced.
  const tabs = app.getByRole('tablist');
  await expect(tabs.getByRole('tab')).toHaveCount(3);
  await expect(tabs.getByRole('tab', { name: 'İçerik takvimi' })).toBeVisible();
  await expect(tabs.getByRole('tab', { name: /Onay kuyruğu/ })).toBeVisible();

  const tab = tabs.getByRole('tab', { name: 'Dağıtım' });
  await expect(tab).toBeVisible();
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');

  /*
   * The witness. `tabpanel` is the boundary; the assertion is on content INSIDE
   * it. A brand-new campaign has planned nothing, so the honest sentence — "no
   * approved or published post yet, so there is nothing to distribute" — is
   * what must be readable. A blank panel would pass a test that only checked
   * that the tab switched.
   */
  const panel = app.getByRole('tabpanel');
  await expect(panel).toBeVisible();
  await expect(
    panel.getByText(/onaylanmış veya yayımlanmış bir gönderisi yok/i),
  ).toBeVisible(LAZY);

  // And nothing pretends there is work in progress: no send affordance can
  // exist on a campaign with nothing to distribute.
  await expect(panel.getByRole('button', { name: 'Gönder' })).toHaveCount(0);
});
