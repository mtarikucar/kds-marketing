import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from '@/i18n/config';
import tr from '@/i18n/tr.json';
import { browser } from '@/lib/browser';
import { PAGE_ID, PENDING_ID, SMS_LINE_ID, capabilities, lostPage, me, repMe, smsLine } from '@/test/fixtures';
import { mockFetch, renderAt } from '@/test/render';

const started = {
  authorize_url: 'https://oauth.test/meta/authorize?state=signed-state',
  pending_id: PENDING_ID,
  expires_at: '2026-10-22T09:10:00Z',
};

/** The kind buttons of one provider's section. */
function providerSection(name: string): HTMLElement {
  return screen.getByRole('group', { name });
}

describe('ConnectPage', () => {
  it('starts an OAuth flow for a Meta kind and sends the browser to the provider', async () => {
    const user = userEvent.setup();
    const assign = vi.spyOn(browser, 'assign').mockImplementation(() => {});
    const calls = mockFetch({ 'GET /api/auth/me': me, 'POST /api/connectors/oauth/start': started });
    renderAt('/connect');
    expect(await screen.findByRole('heading', { level: 1, name: tr.connect.title })).toBeInTheDocument();
    await user.click(within(providerSection(tr.connect.providers.meta)).getByRole('button', { name: 'Facebook sayfası' }));
    // A Meta kind signs in at the provider: no credentials are asked for.
    expect(screen.queryByLabelText(tr.connect.credentials.password)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: i18n.t('connect.oauth.submit', { provider: 'Meta' }) }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(started.authorize_url));
    const start = calls.find((c) => c.method === 'POST');
    expect(start?.path).toBe('/api/connectors/oauth/start');
    expect(start?.body).toEqual({ kind_key: 'facebook_page' });
  });

  it('never sends the browser anywhere but an https provider page', async () => {
    const user = userEvent.setup();
    const assign = vi.spyOn(browser, 'assign').mockImplementation(() => {});
    mockFetch({
      'GET /api/auth/me': me,
      'POST /api/connectors/oauth/start': { ...started, authorize_url: 'javascript:alert(1)' },
    });
    renderAt('/connect?kind=x');
    await user.click(await screen.findByRole('button', { name: i18n.t('connect.oauth.submit', { provider: 'X' }) }));
    expect(await screen.findByText(tr.errors.unknown)).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it('enters NetGSM credentials, never shows the password again, and shows the probe outcome', async () => {
    const user = userEvent.setup();
    const calls = mockFetch({ 'GET /api/auth/me': me, 'POST /api/connectors/credentials': smsLine });
    const { client } = renderAt('/connect');
    await screen.findByRole('heading', { level: 1, name: tr.connect.title });
    await user.click(within(providerSection(tr.connect.providers.netgsm)).getByRole('button', { name: 'SMS hattı' }));
    const password = screen.getByLabelText(tr.connect.credentials.password);
    expect(password).toHaveAttribute('type', 'password');
    await user.type(screen.getByLabelText(tr.connect.credentials.name), 'Kampanya hattı');
    await user.type(screen.getByLabelText(tr.connect.credentials.usercode), '8508001234');
    await user.type(password, 'gizli-parola-1');
    await user.type(screen.getByLabelText(tr.connect.credentials.msgheader), 'ALFA');
    await user.click(screen.getByRole('button', { name: tr.connect.credentials.submit }));

    expect(await screen.findByText(tr.connect.result.verified)).toBeInTheDocument();
    const sent = calls.find((c) => c.method === 'POST');
    expect(sent?.path).toBe('/api/connectors/credentials');
    expect(sent?.body).toEqual({
      kind_key: 'sms_line',
      name: 'Kampanya hattı',
      credential: { kind: 'netgsm_sms', usercode: '8508001234', password: 'gizli-parola-1', msgheader: 'ALFA' },
    });
    // The password is gone from the page, and no query holds it.
    expect(document.body.innerHTML).not.toContain('gizli-parola-1');
    const cached = JSON.stringify(client.getQueryCache().getAll().map((q) => q.state.data));
    expect(cached).not.toContain('gizli-parola-1');
    expect(screen.getByRole('link', { name: tr.connect.result.toCapabilities })).toHaveAttribute('href', '/capabilities');
  });

  it("shows a failed probe in the panel's words", async () => {
    const user = userEvent.setup();
    const failed = {
      ...smsLine,
      capability: {
        ...smsLine.capability,
        status: 'unreachable' as const,
        connector_public: {
          ...smsLine.capability.connector_public,
          health: { ok: false, at: '2026-10-22T08:00:00Z', latency_ms: 30, error_kind: 'auth' },
          reconnect_required: true,
        },
      },
      effective_status: 'unreachable' as const,
    };
    mockFetch({ 'GET /api/auth/me': me, 'POST /api/connectors/credentials': failed });
    renderAt('/connect?kind=netgsm_pbx');
    await user.type(await screen.findByLabelText(tr.connect.credentials.name), 'Santral');
    await user.type(screen.getByLabelText(tr.connect.credentials.username), 'santral-kullanici');
    await user.type(screen.getByLabelText(tr.connect.credentials.password), 'gizli-parola-2');
    await user.click(screen.getByRole('button', { name: tr.connect.credentials.submit }));
    expect(
      await screen.findByText(
        i18n.t('connect.result.failed', { reason: tr.capabilities.connector.errorKinds.auth }),
      ),
    ).toBeInTheDocument();
  });

  it('enters credentials for an existing line by its id', async () => {
    const user = userEvent.setup();
    const declared = {
      ...smsLine,
      capability: { ...smsLine.capability, status: 'declared' as const, has_sealed_config: false },
      effective_status: 'declared' as const,
    };
    const calls = mockFetch({
      'GET /api/auth/me': me,
      [`GET /api/capabilities/${SMS_LINE_ID}`]: declared,
      'POST /api/connectors/credentials': smsLine,
    });
    renderAt(`/connect?capability=${SMS_LINE_ID}`);
    expect(await screen.findByText(i18n.t('connect.forCapability', { name: 'Kampanya hattı' }))).toBeInTheDocument();
    // The kind is the capability's; no name is asked for.
    expect(screen.queryByLabelText(tr.connect.credentials.name)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(tr.connect.credentials.usercode), '8508001234');
    await user.type(screen.getByLabelText(tr.connect.credentials.password), 'gizli-parola-3');
    await user.type(screen.getByLabelText(tr.connect.credentials.msgheader), 'ALFA');
    await user.click(screen.getByRole('button', { name: tr.connect.credentials.submit }));
    await screen.findByText(tr.connect.result.verified);
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      capability_id: SMS_LINE_ID,
      credential: { kind: 'netgsm_sms', usercode: '8508001234', password: 'gizli-parola-3', msgheader: 'ALFA' },
    });
  });

  it('signs a declared page that names its account in for that capability', async () => {
    const user = userEvent.setup();
    const assign = vi.spyOn(browser, 'assign').mockImplementation(() => {});
    const declared = {
      ...lostPage,
      capability: { ...lostPage.capability, status: 'declared' as const, has_sealed_config: false },
      effective_status: 'declared' as const,
    };
    const calls = mockFetch({
      'GET /api/auth/me': me,
      [`GET /api/capabilities/${PAGE_ID}`]: declared,
      [`POST /api/connectors/${PAGE_ID}/reconnect`]: started,
    });
    renderAt(`/connect?capability=${PAGE_ID}`);
    await user.click(await screen.findByRole('button', { name: i18n.t('connect.oauth.submit', { provider: 'Meta' }) }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(started.authorize_url));
    // Bound to the capability, so confirming renews it rather than adding a second one.
    expect(calls.find((c) => c.method === 'POST')?.path).toBe(`/api/connectors/${PAGE_ID}/reconnect`);
  });

  it('binds a declared account without an id: the first account chosen becomes it', async () => {
    const user = userEvent.setup();
    const assign = vi.spyOn(browser, 'assign').mockImplementation(() => {});
    const declared = capabilities[0];
    const id = declared.capability.id;
    const calls = mockFetch({
      'GET /api/auth/me': me,
      [`GET /api/capabilities/${id}`]: declared,
      [`POST /api/connectors/${id}/reconnect`]: started,
    });
    renderAt(`/connect?capability=${id}`);
    expect(await screen.findByText(tr.connect.oauth.firstBindsNote)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: i18n.t('connect.oauth.submit', { provider: 'Meta' }) }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(started.authorize_url));
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([`/api/connectors/${id}/reconnect`]);
  });

  it('shows X no credential form, and keeps a pasted Meta token behind Advanced', async () => {
    const user = userEvent.setup();
    const calls = mockFetch({ 'GET /api/auth/me': me, 'POST /api/connectors/credentials': smsLine });
    renderAt('/connect');
    await screen.findByRole('heading', { level: 1, name: tr.connect.title });
    await user.click(within(providerSection(tr.connect.providers.x)).getByRole('button', { name: 'X' }));
    expect(screen.queryByLabelText(tr.connect.credentials.password)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: new RegExp(tr.connect.advanced) })).not.toBeInTheDocument();

    await user.click(within(providerSection(tr.connect.providers.meta)).getByRole('button', { name: 'Facebook sayfası' }));
    expect(screen.queryByLabelText(tr.connect.token.accessToken)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: new RegExp(tr.connect.advanced) }));
    const token = screen.getByLabelText(tr.connect.token.accessToken);
    expect(token).toHaveAttribute('type', 'password');
    await user.type(screen.getByLabelText(tr.connect.credentials.name), 'Atölye sayfası');
    await user.type(token, 'EAAB-yapistirilan');
    // A page token needs its page id.
    const submit = screen.getByRole('button', { name: tr.connect.token.submit });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText(tr.connect.token.externalId), 'page-1');
    await user.click(submit);
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
        kind_key: 'facebook_page',
        name: 'Atölye sayfası',
        external_id: 'page-1',
        credential: { kind: 'meta_token', access_token: 'EAAB-yapistirilan' },
      }),
    );
  });

  it('offers nothing to change to someone who may not', async () => {
    mockFetch({ 'GET /api/auth/me': repMe });
    renderAt('/connect');
    expect(await screen.findByText(tr.connect.noPermission)).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: tr.connect.providers.meta })).not.toBeInTheDocument();
  });
});
