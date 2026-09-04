/**
 * Account Center — /accounts, the one hub where a workspace connects every
 * external account (Meta, LinkedIn, TikTok, X, Pinterest, Google, plus the
 * manual SMS / Email / Web chat / Voice channels).
 *
 * Everything else routes people HERE to connect: the inbox empty state, the
 * channels tab ("Hesap Merkezi'nden kanal bağla") and the onboarding checklist
 * all dead-end if this page stops offering the catalogue. The catalogue itself
 * is a hardcoded server-side list (`CATALOG` in account-center.service.ts) that
 * the SPA renders verbatim, and the connect affordance is wired per provider in
 * two independent maps in AccountCenterPage.tsx (`PROVIDER_NETWORK` for OAuth,
 * `MANUAL_CHANNEL` for the inline dialogs). A provider that exists server-side
 * but is missing from either map renders a card with NO way to connect it —
 * silent, and invisible to unit tests that feed the page a 3-provider fixture.
 *
 * These tests pin, for a fresh (therefore fully unconnected) workspace:
 *   - the full catalogue is listed and every provider reads "Bağlı değil";
 *   - every provider carries the right connect affordance, and the OAuth ones
 *     are enabled/disabled exactly as the server's `configured` flag says;
 *   - clicking Bağla really performs the OAuth handoff — POST start with
 *     origin=account-center, then a full-page redirect to the returned URL.
 *
 * NO real OAuth flow is started: the third test stubs the start endpoint and
 * the outbound host, so the assertion stops at the redirect. Turkish copy
 * asserted here is verified in src/i18n/locales/tr/marketing.json under
 * `accounts.*` (title/connect/setUp/notConnected/disconnect); the provider
 * display names are English on purpose — they come from the server catalogue,
 * not from i18n. No production component was modified for these tests.
 */
import { test, expect } from './support/fixtures';
import { apiUrl } from './support/config';

/** The server catalogue, in display order (account-center.service.ts CATALOG). */
const META = 'Meta — Facebook, Instagram, WhatsApp & Ads';
const CATALOGUE = [
  META,
  'LinkedIn',
  'TikTok',
  'X (Twitter)',
  'Pinterest',
  'Google Business Profile',
  'SMS (NetGSM)',
  'Email',
  'Web chat',
  'Voice',
];

/**
 * The header row of a provider card: name + connected-state + the connect
 * button all live in the same `justify-between` flex row, so anchoring on the
 * (unique) display name and walking up to it scopes an assertion to ONE
 * provider without needing a test id on the production component.
 */
const CARD = 'xpath=ancestor::div[contains(@class,"justify-between")][1]';

test('the hub lists the whole provider catalogue, all unconnected on a fresh workspace', async ({
  app,
}) => {
  await app.goto('/accounts');

  await expect(app.getByRole('heading', { level: 1, name: 'Hesap Merkezi' })).toBeVisible();

  // Hardcoded on purpose: a provider quietly dropped from the server catalogue
  // would still pass a test that only re-read the API it is checking.
  // Every one of them is under the "not connected yet" heading on a fresh
  // workspace, and the other two sections do not render at all when there is
  // nothing connected and nothing broken.
  await expect(app.getByRole('heading', { name: 'Henüz bağlanmadı' })).toBeVisible();
  await expect(app.getByRole('heading', { name: 'Senden bir şey bekliyor' })).toHaveCount(0);
  await expect(app.getByRole('heading', { name: 'Bağlı ve çalışıyor' })).toHaveCount(0);

  for (const name of CATALOGUE) {
    const card = app.getByText(name, { exact: true }).locator(CARD);
    await expect(card, `${name} is missing from the catalogue`).toBeVisible();
  }

  // The row of an unconnected PROVIDER says what connecting it would add, not
  // that it is absent — "Bağlı değil" answers a question nobody asked, and the
  // one somebody arrives with is "do I need this?".
  await expect(app.getByText(/SMS gönder ve al/)).toBeVisible();
  for (const name of CATALOGUE) {
    const card = app.getByText(name, { exact: true }).locator(CARD);
    await expect(card.getByText('Bağlı değil'), `${name} still only says it is absent`).toHaveCount(0);
  }
  // Scoped to those rows on purpose. The telephony and voice-AI cards below
  // them use the same words as a status BADGE beside a title that already
  // explains the feature, which is a different thing from a row whose only
  // description was "not connected".

  // Nothing may claim a connection: accounts.connectedCount renders "N bağlı",
  // and every connected identity gets a disconnect control. Both absent is the
  // real "brand-new workspace is empty" assertion — and it is what fails if the
  // read-model ever leaks another workspace's accounts into this one.
  await expect(app.getByText(/^\d+ bağlı$/)).toHaveCount(0);
  await expect(app.getByRole('button', { name: 'Bağlantıyı kes' })).toHaveCount(0);
});

test('every provider offers a connect affordance, gated on the server’s configured flag', async ({
  app,
  api,
  workspace,
}) => {
  // The server truth the page is supposed to reflect. `configured` is derived
  // from platform app credentials in the backend env, so it differs between a
  // dev machine and CI — assert the RELATIONSHIP, never a fixed value.
  const res = await api.get(apiUrl('/marketing/connections'), {
    headers: { Authorization: `Bearer ${workspace.session.accessToken}` },
  });
  expect(res.status(), await res.text()).toBe(200);
  const { providers } = (await res.json()) as {
    providers: { provider: string; displayName: string; connectMethod: 'OAUTH' | 'MANUAL'; configured: boolean }[];
  };
  expect(providers.length).toBeGreaterThan(0);

  await app.goto('/accounts');
  await expect(app.getByRole('heading', { level: 1, name: 'Hesap Merkezi' })).toBeVisible();

  for (const p of providers) {
    const card = app.getByText(p.displayName, { exact: true }).locator(CARD);

    if (p.connectMethod === 'OAUTH') {
      // accounts.connect. Absent = the provider has no entry in the SPA's
      // PROVIDER_NETWORK map, i.e. a card nobody can ever connect.
      const connect = card.getByRole('button', { name: 'Bağla' });
      await expect(connect, `${p.displayName} has no OAuth connect button`).toBeVisible();
      // An unconfigured provider must be blocked here rather than sending the
      // user to a provider error page after the redirect.
      if (p.configured) {
        await expect(connect, `${p.displayName} is configured but not offerable`).toBeEnabled();
      } else {
        await expect(connect, `${p.displayName} is unconfigured but still clickable`).toBeDisabled();
      }
    } else {
      // accounts.setUp — manual channels are configured in an inline dialog.
      await expect(
        card.getByRole('button', { name: 'Kur' }),
        `${p.displayName} has no manual set-up button`,
      ).toBeVisible();
    }
  }
});

test('clicking Bağla performs the OAuth handoff and redirects the browser out', async ({ app }) => {
  const AUTHORIZE = 'https://oauth-stub.e2e.invalid/dialog/oauth?client_id=stub';
  let startBody: unknown = null;

  // Only the `configured` gate is overridden — everything else in the payload
  // is the real server response. Whether META_APP_ID happens to be set in the
  // env under test is not what this test is about, and CI runs without it.
  await app.route('**/marketing/connections', async (route) => {
    const response = await route.fetch();
    const json = (await response.json()) as { providers: { provider: string }[] };
    json.providers = json.providers.map((p) => (p.provider === 'META' ? { ...p, configured: true } : p));
    await route.fulfill({ response, json });
  });

  // Stubbed so the run never touches Meta: this is the outbound edge, and the
  // assertion deliberately stops at it.
  await app.route('**/marketing/social/oauth/facebook/start', async (route) => {
    startBody = route.request().postDataJSON();
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ authorizeUrl: AUTHORIZE }),
    });
  });
  await app.route('https://oauth-stub.e2e.invalid/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html><body>stub consent screen</body></html>' }),
  );

  await app.goto('/accounts');
  const connect = app.getByText(META, { exact: true }).locator(CARD).getByRole('button', { name: 'Bağla' });
  await expect(connect).toBeEnabled();
  await connect.click();

  // navigateExternal() must actually leave the SPA. Nothing else on this page
  // moves the browser off /accounts, so a redirect that silently stopped
  // working (a swallowed authorizeUrl, a rejected non-http(s) value) shows up
  // exactly here — as a click that does nothing.
  await expect(app).toHaveURL(/^https:\/\/oauth-stub\.e2e\.invalid\/dialog\/oauth/);

  // The origin is what routes the callback back to /accounts rather than the
  // social planner; losing it strands the user on the wrong page after consent.
  expect(startBody).toEqual({ origin: 'account-center' });
});
