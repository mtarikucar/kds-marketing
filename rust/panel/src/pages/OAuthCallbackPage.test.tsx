import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from '@/i18n/config';
import tr from '@/i18n/tr.json';
import { PAGE_ID, PENDING_ID, budgetItems, capabilities, groups, me, pendingAssets, smsLine } from '@/test/fixtures';
import { rememberFlow } from '@/lib/oauthFlow';
import { delayed, mockFetch, renderAt, withStatus } from '@/test/render';

const CALLBACK = '/api/connectors/oauth/callback/meta';

describe('OAuthCallbackPage', () => {
  it('lists the assets the flow found and connects the chosen ones', async () => {
    const user = userEvent.setup();
    const connected = {
      ...smsLine,
      capability: { ...smsLine.capability, kind_key: 'facebook_page', name: 'Kahve Evi', external_id: 'page-1' },
    };
    const calls = mockFetch({
      'GET /api/auth/me': me,
      [`GET ${CALLBACK}`]: pendingAssets,
      [`POST /api/connectors/oauth/${PENDING_ID}/confirm`]: [connected],
      'GET /api/capabilities': capabilities,
      'GET /api/capability-groups': groups,
      'GET /api/budget/items': budgetItems,
      'GET /api/connectors/health': [],
    });
    const { router } = renderAt('/oauth/callback/meta?state=signed-state&code=one-time-code');

    // The page passes the provider's answer to the API once, then drops it from the address.
    const page = await screen.findByRole('checkbox', { name: /Kahve Evi/ });
    const completions = calls.filter((c) => c.path === CALLBACK);
    expect(completions).toHaveLength(1);
    expect(Object.fromEntries(new URLSearchParams(completions[0].search))).toEqual({
      state: 'signed-state',
      code: 'one-time-code',
    });
    await waitFor(() => expect(router.state.location.search).toBe(''));

    // Each asset: its kind, name, external id and the facts the provider gave.
    expect(screen.getByRole('checkbox', { name: /kahveevi/ })).toBeInTheDocument();
    expect(screen.getByText(i18n.t('oauthCallback.externalId', { id: 'page-1' }))).toBeInTheDocument();
    expect(
      screen.getByText(i18n.t('oauthCallback.scopes', { scopes: 'pages_manage_posts, pages_read_engagement' })),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Facebook sayfası').length).toBeGreaterThan(0);

    const confirm = screen.getByRole('button', { name: tr.oauthCallback.confirm });
    expect(confirm).toBeDisabled();
    await user.click(page);
    await user.click(confirm);
    await waitFor(() => expect(router.state.location.pathname).toBe('/capabilities'));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ selected: ['page-1'] });
    expect(await screen.findByText(i18n.t('oauthCallback.connected', { count: 1 }))).toBeInTheDocument();
  });

  it("shows the provider's refusal in its own words, never the provider's text", async () => {
    const calls = mockFetch({ 'GET /api/auth/me': me });
    renderAt('/oauth/callback/meta?error=access_denied&error_description=%3Cb%3Eraw%20provider%20text%3C%2Fb%3E');
    expect(await screen.findByText(tr.oauthCallback.providerDenied)).toBeInTheDocument();
    expect(screen.queryByText(/raw provider text/)).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain('raw provider text');
    expect(calls.some((c) => c.path === CALLBACK)).toBe(false);
    expect(screen.getByRole('link', { name: tr.oauthCallback.restart })).toHaveAttribute('href', '/connect');
  });

  it('maps any other provider error to the generic refusal', async () => {
    mockFetch({ 'GET /api/auth/me': me });
    renderAt('/oauth/callback/x?error=server_error&error_description=boom');
    expect(await screen.findByText(tr.oauthCallback.providerError)).toBeInTheDocument();
    expect(screen.queryByText('boom')).not.toBeInTheDocument();
  });

  it('says to start again when the state is refused', async () => {
    mockFetch({
      'GET /api/auth/me': me,
      [`GET ${CALLBACK}`]: withStatus(403, {
        code: 'FORBIDDEN',
        message: 'the OAuth state is not valid for this workspace, or was already used',
        details: {},
      }),
    });
    renderAt('/oauth/callback/meta?state=old&code=c');
    expect(await screen.findByText(tr.oauthCallback.stateRefused)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: tr.oauthCallback.restart })).toHaveAttribute('href', '/connect');
  });

  it('says so when it was opened without the provider’s answer', async () => {
    const calls = mockFetch({ 'GET /api/auth/me': me });
    renderAt('/oauth/callback/meta');
    expect(await screen.findByText(tr.oauthCallback.missingParams)).toBeInTheDocument();
    expect(calls.some((c) => c.path === CALLBACK)).toBe(false);
  });

  it('shows a busy provider in the panel’s words, with the wait, and never asks twice', async () => {
    const calls = mockFetch({
      'GET /api/auth/me': me,
      [`GET ${CALLBACK}`]: withStatus(503, {
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'the provider is unavailable; try again later',
        details: { provider: 'meta', retryable: true, retry_after_s: 30, reason: 'account_mismatch' },
      }),
    });
    renderAt('/oauth/callback/meta?state=s&code=c');
    expect(await screen.findByText(i18n.t('errors.upstreamRetryAfter', { seconds: 30 }))).toBeInTheDocument();
    // The provider's reason is never read as one of the panel's own.
    expect(screen.queryByText(tr.errors.accountMismatch)).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain('account_mismatch');
    expect(screen.getByRole('link', { name: tr.oauthCallback.restart })).toHaveAttribute('href', '/connect');
    expect(calls.filter((c) => c.path === CALLBACK)).toHaveLength(1);
  });

  it('starts a failed reconnection again for its capability', async () => {
    rememberFlow({ pending_id: PENDING_ID, capability_id: PAGE_ID, expires_at: '2099-01-01T00:00:00Z' });
    mockFetch({ 'GET /api/auth/me': me });
    renderAt('/oauth/callback/meta?error=access_denied');
    expect(await screen.findByText(tr.oauthCallback.providerDenied)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: tr.oauthCallback.restart })).toHaveAttribute(
      'href',
      `/connect?capability=${PAGE_ID}`,
    );
  });

  it('offers a Page and its Messenger, which share an id, as one choice', async () => {
    const user = userEvent.setup();
    const page = pendingAssets.assets[0];
    const calls = mockFetch({
      'GET /api/auth/me': me,
      [`GET ${CALLBACK}`]: {
        ...pendingAssets,
        assets: [page, { ...page, kind_key: 'messenger', public: { page_id: 'page-1' } }, pendingAssets.assets[1]],
      },
      [`POST /api/connectors/oauth/${PENDING_ID}/confirm`]: [],
      'GET /api/capabilities': capabilities,
      'GET /api/capability-groups': groups,
      'GET /api/budget/items': budgetItems,
      'GET /api/connectors/health': [],
    });
    renderAt('/oauth/callback/meta?state=s&code=c');
    const pageChoice = await screen.findByRole('checkbox', { name: /Kahve Evi/ });
    // Two accounts, two choices: the Page's row names both kinds it connects.
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    expect(
      screen.getByText(i18n.t('oauthCallback.together', { kinds: 'Facebook sayfası + Messenger' })),
    ).toBeInTheDocument();
    expect(screen.getByText('Messenger')).toBeInTheDocument();
    await user.click(pageChoice);
    expect(pageChoice).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /kahveevi/ })).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: tr.oauthCallback.confirm }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ selected: ['page-1'] }));
  });

  it('chooses the one account found, even when it carries several kinds', async () => {
    const page = pendingAssets.assets[0];
    mockFetch({
      'GET /api/auth/me': me,
      [`GET ${CALLBACK}`]: { ...pendingAssets, assets: [page, { ...page, kind_key: 'messenger' }] },
    });
    renderAt('/oauth/callback/meta?state=s&code=c');
    expect(await screen.findByRole('checkbox', { name: /Kahve Evi/ })).toBeChecked();
    expect(screen.getByRole('button', { name: tr.oauthCallback.confirm })).toBeEnabled();
  });

  it('says that the first account chosen becomes the capability the flow was started for', async () => {
    rememberFlow({ pending_id: PENDING_ID, capability_id: PAGE_ID, expires_at: '2099-01-01T00:00:00Z' });
    mockFetch({ 'GET /api/auth/me': me, [`GET ${CALLBACK}`]: pendingAssets });
    renderAt('/oauth/callback/meta?state=s&code=c');
    expect(await screen.findByText(tr.oauthCallback.firstBinds)).toBeInTheDocument();
  });

  // Development renders the panel under StrictMode, which runs the page's effect, cleans it up and
  // runs it again: the code is still spent once, and the answer, arriving after that, is shown.
  describe('under StrictMode, with the answer arriving late', () => {
    it('shows a refused state', async () => {
      const calls = mockFetch({
        'GET /api/auth/me': me,
        [`GET ${CALLBACK}`]: delayed(
          30,
          withStatus(403, {
            code: 'FORBIDDEN',
            message: 'the OAuth state is not valid for this workspace, or was already used',
            details: {},
          }),
        ),
      });
      renderAt('/oauth/callback/meta?state=s&code=c', { strict: true });
      expect(await screen.findByText(tr.oauthCallback.stateRefused)).toBeInTheDocument();
      expect(screen.queryByText(tr.oauthCallback.loading)).not.toBeInTheDocument();
      expect(screen.getByRole('link', { name: tr.oauthCallback.restart })).toHaveAttribute('href', '/connect');
      expect(calls.filter((c) => c.path === CALLBACK)).toHaveLength(1);
    });

    it('shows a busy provider', async () => {
      const calls = mockFetch({
        'GET /api/auth/me': me,
        [`GET ${CALLBACK}`]: delayed(
          30,
          withStatus(503, {
            code: 'UPSTREAM_UNAVAILABLE',
            message: 'the provider is unavailable; try again later',
            details: { provider: 'meta', retryable: true, retry_after_s: 30, reason: 'HTTP 503' },
          }),
        ),
      });
      renderAt('/oauth/callback/meta?state=s&code=c', { strict: true });
      expect(await screen.findByText(i18n.t('errors.upstreamRetryAfter', { seconds: 30 }))).toBeInTheDocument();
      expect(screen.queryByText(tr.oauthCallback.loading)).not.toBeInTheDocument();
      expect(calls.filter((c) => c.path === CALLBACK)).toHaveLength(1);
    });

    it('lists the assets found', async () => {
      const calls = mockFetch({
        'GET /api/auth/me': me,
        [`GET ${CALLBACK}`]: delayed(30, pendingAssets),
      });
      const { router } = renderAt('/oauth/callback/meta?state=s&code=c', { strict: true });
      expect(await screen.findByRole('checkbox', { name: /Kahve Evi/ })).toBeInTheDocument();
      expect(calls.filter((c) => c.path === CALLBACK)).toHaveLength(1);
      await waitFor(() => expect(router.state.location.search).toBe(''));
    });
  });

  it('completes an Instagram Login flow at its own callback', async () => {
    const instagram = '/api/connectors/oauth/callback/instagram';
    const calls = mockFetch({ 'GET /api/auth/me': me, [`GET ${instagram}`]: pendingAssets });
    renderAt('/oauth/callback/instagram?state=s&code=c');
    expect(await screen.findByRole('checkbox', { name: /Kahve Evi/ })).toBeInTheDocument();
    expect(calls.filter((c) => c.path === instagram)).toHaveLength(1);
    expect(calls.some((c) => c.path === CALLBACK)).toBe(false);
  });

  it('refuses a callback address the panel does not know, without asking the API', async () => {
    const calls = mockFetch({ 'GET /api/auth/me': me });
    renderAt('/oauth/callback/netgsm?state=s&code=c');
    expect(await screen.findByText(tr.oauthCallback.unknownCallback)).toBeInTheDocument();
    expect(calls.some((c) => c.path.startsWith('/api/connectors/oauth/callback/'))).toBe(false);
  });

  it('forgets a remembered flow that has expired', async () => {
    rememberFlow({ pending_id: PENDING_ID, capability_id: PAGE_ID, expires_at: '2000-01-01T00:00:00Z' });
    mockFetch({ 'GET /api/auth/me': me });
    renderAt('/oauth/callback/meta?error=access_denied');
    expect(await screen.findByRole('link', { name: tr.oauthCallback.restart })).toHaveAttribute('href', '/connect');
  });
});
