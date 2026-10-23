import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from '@/i18n/config';
import tr from '@/i18n/tr.json';
import { PENDING_ID, budgetItems, capabilities, groups, me, pendingAssets, smsLine } from '@/test/fixtures';
import { mockFetch, renderAt, withStatus } from '@/test/render';

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
});
