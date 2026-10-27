import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from '@/i18n/config';
import tr from '@/i18n/tr.json';
import { browser } from '@/lib/browser';
import { PAGE_ID, PENDING_ID, SMS_LINE_ID, capabilities, lostPage, me, repMe, smsLine } from '@/test/fixtures';
import { mockFetch, renderAt, withStatus } from '@/test/render';

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

  it('does not offer Facebook comments, which no sign-in can connect yet', async () => {
    mockFetch({ 'GET /api/auth/me': me });
    renderAt('/connect?kind=review_facebook');
    expect(await screen.findByRole('heading', { level: 1, name: tr.connect.title })).toBeInTheDocument();
    const meta = within(providerSection(tr.connect.providers.meta));
    expect(meta.getByRole('button', { name: 'Messenger' })).toBeInTheDocument();
    expect(meta.queryByRole('button', { name: tr.capabilities.kinds.review_facebook })).not.toBeInTheDocument();
    // Asked for by link, it is not preselected either: no sign-in button appears.
    expect(screen.queryByRole('button', { name: i18n.t('connect.oauth.submit', { provider: 'Meta' }) })).not.toBeInTheDocument();
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

 it('connects a TLS mailbox and clears its password after probing', async () => {
    const user = userEvent.setup();
    const mailbox = { ...smsLine, capability: { ...smsLine.capability, kind_key: 'mailbox', name: 'Support' } };
    const calls = mockFetch({ 'GET /api/auth/me': me, 'POST /api/connectors/credentials': mailbox });
    const { client } = renderAt('/connect?kind=mailbox');
    await screen.findByText(tr.connect.mail.title);
    for (const [label, value] of [
      [tr.connect.mail.name, 'Support'], [tr.connect.mail.smtp_host, 'smtp.example.com'],
      [tr.connect.mail.imap_host, 'imap.example.com'], [tr.connect.mail.username, 'support@example.com'],
      [tr.connect.mail.password, 'private-mail-password'], [tr.connect.mail.from_address, 'support@example.com'],
    ]) await user.type(screen.getByLabelText(label), value);
    expect(screen.getByLabelText(tr.connect.mail.password)).toHaveAttribute('type', 'password');
    await user.selectOptions(screen.getByLabelText(tr.connect.mail.tls), 'start_tls');
    await user.click(screen.getByRole('button', { name: tr.connect.credentials.submit }));
    expect(await screen.findByText(tr.connect.result.verified)).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ kind_key: 'mailbox', name: 'Support', credential: {
      kind: 'mailbox', smtp_host: 'smtp.example.com', smtp_port: 587, imap_host: 'imap.example.com', imap_port: 143,
      username: 'support@example.com', password: 'private-mail-password', from_address: 'support@example.com', tls: 'start_tls',
    } });
    expect(document.body.innerHTML).not.toContain('private-mail-password');
    expect(JSON.stringify(client.getQueryCache().getAll().map((q) => q.state.data))).not.toContain('private-mail-password');
  });

 it('attaches optional IYS credentials to the existing SMS line without replacing SMS', async () => {
    const user = userEvent.setup();
    const calls = mockFetch({ 'GET /api/auth/me': me, [`GET /api/capabilities/${SMS_LINE_ID}`]: smsLine, 'POST /api/connectors/credentials': smsLine });
    const { client } = renderAt(`/connect?capability=${SMS_LINE_ID}`);
    await user.click(await screen.findByRole('button', { name: /İYS bağlantısı \(isteğe bağlı\)/ }));
    const code=screen.getByLabelText('İYS kullanıcı kodu');
    await user.clear(code);
    await user.type(code, '8508001234');
    await user.type(screen.getByLabelText('İYS parolası'), 'private-iys-password');
    await user.type(screen.getByLabelText('İYS marka kodu'), 'brand-42');
    expect(screen.getByLabelText('İYS parolası')).toHaveAttribute('type', 'password');
    await user.click(screen.getByRole('button', { name: 'İYS bağlantısını kaydet' }));
    expect(await screen.findByText('İYS bağlantısı kaydedildi.')).toBeInTheDocument();
    expect(calls.filter((c)=>c.method==='POST').map((c)=>c.body)).toEqual([{capability_id:SMS_LINE_ID,credential:{kind:'netgsm_iys',usercode:'8508001234',password:'private-iys-password',brand_code:'brand-42'}}]);
    expect(document.body.innerHTML).not.toContain('private-iys-password');
    await waitFor(()=>expect(JSON.stringify(client.getMutationCache().getAll().map((m)=>m.state.variables))).not.toContain('private-iys-password'));
  });

it('provider_missing_app_is_not_connection_success', async()=>{
  const user=userEvent.setup();
  const assign=vi.spyOn(browser,'assign').mockImplementation(()=>{});
  mockFetch({'GET /api/auth/me':me,'POST /api/connectors/oauth/start':withStatus(409,{code:'CONFLICT',message:'platform app missing',details:{reason:'provider_app_not_configured'}})});
  renderAt('/connect?kind=x');
  await user.click(await screen.findByRole('button',{name:i18n.t('connect.oauth.submit',{provider:'X'})}));
  expect(await screen.findByText('Sağlayıcı uygulaması yapılandırılmadı')).toBeInTheDocument();
  expect(assign).not.toHaveBeenCalled();
  expect(screen.queryByText(tr.connect.result.verified)).not.toBeInTheDocument();
});

it('reconnect_and_expiry_are_visible',async()=>{
  mockFetch({'GET /api/auth/me':me,[`GET /api/capabilities/${PAGE_ID}`]:{...lostPage,capability:{...lostPage.capability,connector_public:{reconnect_required:true,access:{expires_at:'2026-10-24T12:00:00Z'}}}},
    'GET /api/connectors/hooks':{meta:{url:'https://public.jeeta.test/jeeta/hooks/meta',verify_token_hint:'operator'},netgsm:[]}});
  renderAt(`/connect?capability=${PAGE_ID}`);
  expect(await screen.findByText('Yeniden bağlantı gerekli')).toBeInTheDocument();
  expect(screen.getByText('2026-10-24T12:00:00Z')).toBeInTheDocument();
  // Provider-app setup is operator material, folded away until opened.
  fireEvent.click(await screen.findByRole('button',{name:new RegExp(tr.providerSetup.title)}));
  expect(await screen.findByDisplayValue('https://public.jeeta.test/jeeta/oauth/callback/meta')).toBeInTheDocument();
  expect(screen.getByDisplayValue('https://public.jeeta.test/jeeta/hooks/meta')).toBeInTheDocument();
});

it('shows access metadata on the freshly connected result as well as on revisit',async()=>{
  const user=userEvent.setup();
  mockFetch({'GET /api/auth/me':me,'POST /api/connectors/credentials':{...smsLine,capability:{...smsLine.capability,connector_public:{reconnect_required:true,access:{expires_at:'2026-10-24T12:00:00Z'}}}}});
  renderAt('/connect?kind=sms_line');
  await user.type(await screen.findByLabelText(tr.connect.credentials.name),'SMS');
  await user.type(screen.getByLabelText(tr.connect.credentials.usercode),'8508001234');
  await user.type(screen.getByLabelText(tr.connect.credentials.password),'synthetic');
  await user.type(screen.getByLabelText(tr.connect.credentials.msgheader),'ALFA');
  await user.click(screen.getByRole('button',{name:tr.connect.credentials.submit}));
  expect(await screen.findByText('Yeniden bağlantı gerekli')).toBeInTheDocument();
  expect(screen.getByText('2026-10-24T12:00:00Z')).toBeInTheDocument();
});

it('keeps the browser and password managers from filling any provider credential', async () => {
  mockFetch({ 'GET /api/auth/me': me });
  for (const [kind, heading] of [
    ['sms_line', tr.connect.credentials.usercode],
    ['netgsm_pbx', tr.connect.credentials.username],
    ['mailbox', tr.connect.mail.username],
  ] as const) {
    const { unmount } = renderAt(`/connect?kind=${kind}`);
    await screen.findByLabelText(heading);
    const fields = [...document.querySelectorAll<HTMLInputElement>('form input:not([type=hidden])')].filter(
      (input) => input.type === 'text' || input.type === 'password',
    );
    expect(fields.some((input) => input.type === 'password')).toBe(true);
    for (const input of fields) {
      // A saved panel password must never land in a provider's password, nor the e-mail in its user.
      expect(input).toHaveAttribute('autocomplete', input.type === 'password' ? 'new-password' : 'off');
      for (const ignore of ['data-1p-ignore', 'data-lpignore', 'data-bwignore']) {
        expect(input).toHaveAttribute(ignore, 'true');
      }
    }
    unmount();
  }
});
