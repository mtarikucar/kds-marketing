import { describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import tr from '@/i18n/tr.json';
import { EFFECTIVE_STATUSES } from '@/api/types';
import i18n from '@/i18n/config';
import { browser } from '@/lib/browser';
import { formatRelative } from '@/lib/format';
import { rememberedFlow } from '@/lib/oauthFlow';
import {
  PAGE_ID,
  PENDING_ID,
  SMS_LINE_ID,
  budgetItems,
  capabilities,
  connectorHealth,
  groups,
  hooks,
  lostPage,
  me,
  repMe,
  smsLine,
} from '@/test/fixtures';
import { mockFetch, renderAt } from '@/test/render';
import { HOOKS_KEY } from './capabilities/queries';

const routes = {
  'GET /api/auth/me': me,
  'GET /api/capabilities': capabilities,
  'GET /api/capability-groups': groups,
  'GET /api/budget/items': budgetItems,
  'GET /api/connectors/health': connectorHealth,
  'GET /api/connectors/hooks': hooks,
};

/** Every fixture capability plus a verified NetGSM line and a Facebook page to reconnect. */
const withConnectors = {
  ...routes,
  'GET /api/capabilities': [...capabilities, smsLine, lostPage],
};

/** The card of the capability named `name`. */
async function cardOf(name: string): Promise<HTMLElement> {
  return (await screen.findByRole('heading', { name })).closest('[data-capability-id]') as HTMLElement;
}

/** The connection actions of a card, if it has any. */
function connectionActions(card: HTMLElement): HTMLElement | null {
  return within(card).queryByRole('group', { name: tr.capabilities.connector.actionsLabel });
}

describe('CapabilitiesPage', () => {
  it('shows each capability as a card with its effective status', async () => {
    mockFetch(routes);
    const { container } = renderAt('/capabilities');
    expect(await screen.findByRole('heading', { level: 1, name: tr.capabilities.title })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Atölye Instagram' })).toBeInTheDocument();
    for (const status of EFFECTIVE_STATUSES) {
      expect(screen.getAllByText(tr.status.capability[status]).length).toBeGreaterThan(0);
    }
    const shown = [...container.querySelectorAll('[data-capability-status]')].map((el) =>
      el.getAttribute('data-capability-status'),
    );
    expect(new Set(shown)).toEqual(new Set(EFFECTIVE_STATUSES));
    // Links and groups are named, not shown as ids.
    expect(screen.getAllByText('Saha giderleri').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Marka A').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: tr.capabilities.declare })).toBeInTheDocument();
  });

  it('edits a capability, sending only what changed', async () => {
    const user = userEvent.setup();
    const phone = capabilities[1];
    const id = phone.capability.id;
    const calls = mockFetch({
      ...routes,
      [`PATCH /api/capabilities/${id}`]: {
        capability: { ...phone.capability, name: 'Saha telefonu 2', description: 'Kampanya' },
        effective_status: phone.effective_status,
        verification_reset: false,
      },
    });
    renderAt('/capabilities');
    const card = (await screen.findByRole('heading', { name: 'Saha telefonu' })).closest(
      '[data-capability-id]',
    ) as HTMLElement;
    await user.click(within(card).getByRole('button', { name: tr.capabilities.actions.edit }));
    const dialog = await screen.findByRole('dialog');
    const name = within(dialog).getByLabelText(tr.fields.name, { exact: false });
    expect(name).toHaveValue('Saha telefonu');
    // Nothing changed yet: nothing to save. A device's account change resets nothing.
    const save = within(dialog).getByRole('button', { name: tr.common.save });
    expect(save).toBeDisabled();
    expect(within(dialog).queryByText(tr.capabilities.editDialog.connectorWarning)).not.toBeInTheDocument();
    await user.clear(name);
    await user.type(name, '  Saha telefonu 2 ');
    await user.type(within(dialog).getByLabelText(tr.fields.description, { exact: false }), 'Kampanya');
    await user.click(save);
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({
        name: 'Saha telefonu 2',
        description: 'Kampanya',
      }),
    );
    expect(await screen.findByText(tr.capabilities.editDialog.saved)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it("warns that a connector's new account resets its verification and drops its credentials", async () => {
    const user = userEvent.setup();
    const inbox = {
      ...capabilities[3],
      capability: { ...capabilities[3].capability, external_id: 'destek@acme.example' },
    };
    const id = inbox.capability.id;
    const calls = mockFetch({
      ...routes,
      'GET /api/capabilities': capabilities.map((c) => (c.capability.id === id ? inbox : c)),
      [`PATCH /api/capabilities/${id}`]: {
        capability: { ...inbox.capability, external_id: 'yardim@acme.example', status: 'declared' },
        effective_status: 'declared',
        verification_reset: true,
      },
    });
    renderAt('/capabilities');
    const card = (await screen.findByRole('heading', { name: 'Destek kutusu' })).closest(
      '[data-capability-id]',
    ) as HTMLElement;
    await user.click(within(card).getByRole('button', { name: tr.capabilities.actions.edit }));
    const dialog = await screen.findByRole('dialog');
    // The warning lands when the account is changed, not before.
    expect(within(dialog).queryByText(tr.capabilities.editDialog.connectorWarning)).not.toBeInTheDocument();
    expect(within(dialog).getByText(tr.capabilities.editDialog.externalIdConnectorHint)).toBeInTheDocument();
    const account = within(dialog).getByLabelText(tr.fields.external_id, { exact: false });
    expect(account).toHaveValue('destek@acme.example');
    await user.clear(account);
    await user.type(account, 'yardim@acme.example');
    expect(within(dialog).getByText(tr.capabilities.editDialog.connectorWarning)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: tr.common.save }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ external_id: 'yardim@acme.example' }),
    );
    // The answer says the verification was reset; the panel says so too.
    expect(await screen.findByText(tr.capabilities.editDialog.savedReset)).toBeInTheDocument();
  });

  it('renames a connector with padded stored text without touching its account', async () => {
    const user = userEvent.setup();
    // Declared over MCP before the server trimmed: whitespace around the stored values.
    const inbox = {
      ...capabilities[3],
      capability: {
        ...capabilities[3].capability,
        description: 'Kampanya\n',
        external_id: ' destek@acme.example ',
      },
    };
    const id = inbox.capability.id;
    const calls = mockFetch({
      ...routes,
      'GET /api/capabilities': capabilities.map((c) => (c.capability.id === id ? inbox : c)),
      [`PATCH /api/capabilities/${id}`]: {
        capability: { ...inbox.capability, name: 'Yardım kutusu' },
        effective_status: inbox.effective_status,
        verification_reset: false,
      },
    });
    renderAt('/capabilities');
    const card = (await screen.findByRole('heading', { name: 'Destek kutusu' })).closest(
      '[data-capability-id]',
    ) as HTMLElement;
    await user.click(within(card).getByRole('button', { name: tr.capabilities.actions.edit }));
    const dialog = await screen.findByRole('dialog');
    const name = within(dialog).getByLabelText(tr.fields.name, { exact: false });
    await user.clear(name);
    await user.type(name, 'Yardım kutusu');
    expect(within(dialog).queryByText(tr.capabilities.editDialog.connectorWarning)).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: tr.common.save }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ name: 'Yardım kutusu' }));
    expect(await screen.findByText(tr.capabilities.editDialog.saved)).toBeInTheDocument();
  });

  it('offers no edit on a retired capability', async () => {
    mockFetch(routes);
    renderAt('/capabilities');
    const card = (await screen.findByRole('heading', { name: 'Eski hat' })).closest(
      '[data-capability-id]',
    ) as HTMLElement;
    expect(within(card).queryByRole('button', { name: tr.capabilities.actions.edit })).not.toBeInTheDocument();
  });

  it('filters by kind group with the known query parameter', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(routes);
    renderAt('/capabilities');
    await user.click(await screen.findByRole('button', { name: tr.capabilities.groups.device }));
    await waitFor(() =>
      expect(calls.some((c) => c.path === '/api/capabilities' && c.search === '?group=device')).toBe(true),
    );
  });

  it('shows each connector its health and the connection actions that fit it', async () => {
    mockFetch(withConnectors);
    renderAt('/capabilities');

    // A declared Instagram account: never probed, waiting to be connected.
    const instagram = await cardOf('Atölye Instagram');
    expect(within(instagram).getByText(tr.capabilities.connector.health.never)).toBeInTheDocument();
    const declared = connectionActions(instagram) as HTMLElement;
    expect(within(declared).getByRole('button', { name: tr.capabilities.connector.connect })).toBeInTheDocument();
    expect(within(declared).queryByRole('button', { name: tr.capabilities.connector.probe })).not.toBeInTheDocument();

    // A verified line: its last probe succeeded; it can be probed, not reconnected by hand.
    const line = await cardOf('Kampanya hattı');
    expect(within(line).getByText(/Yoklama başarılı/)).toBeInTheDocument();
    const lineActions = connectionActions(line) as HTMLElement;
    expect(within(lineActions).getByRole('button', { name: tr.capabilities.connector.probe })).toBeInTheDocument();
    expect(
      within(lineActions).queryByRole('button', { name: tr.capabilities.connector.reconnect }),
    ).not.toBeInTheDocument();

    // A page whose login was refused: it must be reconnected.
    const page = await cardOf('Atölye sayfası');
    expect(within(page).getByText(tr.capabilities.connector.health.reconnect)).toBeInTheDocument();
    const pageActions = connectionActions(page) as HTMLElement;
    expect(within(pageActions).getByRole('button', { name: tr.capabilities.connector.reconnect })).toBeInTheDocument();

    // A mailbox without sealed credentials offers reconnection; a retired line has no actions.
    const mailboxActions = connectionActions(await cardOf('Destek kutusu')) as HTMLElement;
    expect(within(mailboxActions).queryByRole('button', { name: tr.capabilities.connector.probe })).not.toBeInTheDocument();
    expect(within(mailboxActions).getByRole('button', { name: tr.capabilities.connector.reconnect })).toBeInTheDocument();
    expect(connectionActions(await cardOf('Eski hat'))).toBeNull();
  });

  it('probes a connector, shows the outcome and refreshes the list', async () => {
    const user = userEvent.setup();
    const calls = mockFetch({
      ...withConnectors,
      [`POST /api/connectors/${SMS_LINE_ID}/probe`]: {
        result: { ok: true, latency_ms: 87, error_kind: null, error_reason: null, facts: { account_id: '8508001234' } },
        status: 'verified',
      },
    });
    renderAt('/capabilities');
    const line = await cardOf('Kampanya hattı');
    const listed = () => calls.filter((c) => c.method === 'GET' && c.path === '/api/capabilities').length;
    const before = listed();
    await user.click(within(line).getByRole('button', { name: tr.capabilities.connector.probe }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(tr.capabilities.connector.probeDialog.ok)).toBeInTheDocument();
    expect(within(dialog).getByText(i18n.t('capabilities.connector.probeDialog.latencyValue', { ms: 87 }))).toBeInTheDocument();
    await waitFor(() => expect(listed()).toBeGreaterThan(before));
    expect(calls.some((c) => c.method === 'GET' && c.path === '/api/connectors/health')).toBe(true);
  });

  it('reconnects a Meta page by sending the browser to the provider', async () => {
    const user = userEvent.setup();
    const assign = vi.spyOn(browser, 'assign').mockImplementation(() => {});
    const calls = mockFetch({
      ...withConnectors,
      [`POST /api/connectors/${PAGE_ID}/reconnect`]: {
        authorize_url: 'https://oauth.test/meta/authorize?state=again',
        pending_id: PENDING_ID,
        expires_at: '2026-10-22T09:10:00Z',
      },
    });
    renderAt('/capabilities');
    const page = await cardOf('Atölye sayfası');
    await user.click(within(page).getByRole('button', { name: tr.capabilities.connector.reconnect }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://oauth.test/meta/authorize?state=again'));
    expect(calls.some((c) => c.method === 'POST' && c.path === `/api/connectors/${PAGE_ID}/reconnect`)).toBe(true);
  });

  it('connects a declared Meta account through a sign-in bound to it, leaving no orphan', async () => {
    const user = userEvent.setup();
    const assign = vi.spyOn(browser, 'assign').mockImplementation(() => {});
    const instagramId = capabilities[0].capability.id;
    const calls = mockFetch({
      ...withConnectors,
      [`POST /api/connectors/${instagramId}/reconnect`]: {
        authorize_url: 'https://oauth.test/meta/authorize?state=bound',
        pending_id: PENDING_ID,
        expires_at: '2099-10-22T09:10:00Z',
      },
    });
    renderAt('/capabilities');
    const instagram = await cardOf('Atölye Instagram');
    // Declared, never connected, no account id: "Connect" still binds the sign-in to it.
    expect(capabilities[0].capability.external_id).toBeNull();
    await user.click(within(instagram).getByRole('button', { name: tr.capabilities.connector.connect }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://oauth.test/meta/authorize?state=bound'));
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/connectors/oauth/start')).toBe(false);
    // The flow is remembered for the callback page (its capability, never a secret).
    expect(rememberedFlow()).toEqual({
      pending_id: PENDING_ID,
      capability_id: instagramId,
      expires_at: '2099-10-22T09:10:00Z',
    });
  });

  it('connects a declared NetGSM line on the connect page, for that line', async () => {
    const user = userEvent.setup();
    const declaredLine = {
      ...smsLine,
      capability: { ...smsLine.capability, status: 'declared' as const, has_sealed_config: false },
      effective_status: 'declared' as const,
    };
    mockFetch({
      ...routes,
      'GET /api/capabilities': [declaredLine],
      [`GET /api/capabilities/${SMS_LINE_ID}`]: declaredLine,
    });
    const { router } = renderAt('/capabilities');
    const line = await cardOf('Kampanya hattı');
    await user.click(within(line).getByRole('button', { name: tr.capabilities.connector.connect }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/connect'));
    expect(router.state.location.search).toBe(`?capability=${SMS_LINE_ID}`);
    expect(await screen.findByLabelText(tr.connect.credentials.password)).toBeInTheDocument();
  });

  it('lets a rep probe but not connect', async () => {
    mockFetch({ ...withConnectors, 'GET /api/auth/me': repMe });
    renderAt('/capabilities');
    const line = await cardOf('Kampanya hattı');
    expect(within(line).getByRole('button', { name: tr.capabilities.connector.probe })).toBeInTheDocument();
    const instagram = await cardOf('Atölye Instagram');
    expect(within(instagram).queryByRole('button', { name: tr.capabilities.connector.connect })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: tr.connect.open })).not.toBeInTheDocument();
  });

  it('shows the webhook addresses to register at the providers, each one to copy', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mockFetch(routes);
    renderAt('/capabilities');
    const section = (await screen.findByRole('heading', { name: tr.capabilities.hooks.title })).closest(
      'section',
    ) as HTMLElement;
    expect(await within(section).findByText(tr.capabilities.hooks.netgsmHelp)).toBeInTheDocument();
    for (const hook of hooks.netgsm) {
      const field = within(section).getByRole('textbox', {
        name: i18n.t(`capabilities.hooks.purposes.${hook.purpose}`),
      });
      expect(field).toHaveValue(hook.url);
    }
    const meta = within(section).getByRole('textbox', { name: tr.capabilities.hooks.metaUrl });
    expect(meta).toHaveValue(hooks.meta?.url);
    expect(within(section).getByText(tr.capabilities.hooks.verifyTokenHint)).toBeInTheDocument();
    // The first copy button copies the incoming-SMS address.
    await user.click(within(section).getAllByRole('button', { name: tr.common.copy })[0]);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(hooks.netgsm[0].url));
  });

  it('says so when the platform has no Meta app yet', async () => {
    mockFetch({ ...routes, 'GET /api/connectors/hooks': { ...hooks, meta: null } });
    renderAt('/capabilities');
    expect(await screen.findByText(tr.capabilities.hooks.metaMissing)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: tr.capabilities.hooks.metaUrl })).not.toBeInTheDocument();
  });

  it('never shows nor asks for the hook tokens without capabilities.manage', async () => {
    const calls = mockFetch({ ...routes, 'GET /api/auth/me': repMe });
    renderAt('/capabilities');
    expect(await screen.findByRole('heading', { name: 'Atölye Instagram' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: tr.capabilities.hooks.title })).not.toBeInTheDocument();
    expect(calls.some((c) => c.path === '/api/connectors/hooks')).toBe(false);
  });

  it('drops the hook addresses from the query cache once they leave the screen', async () => {
    mockFetch(routes);
    const { router, client } = renderAt('/capabilities');
    expect(
      await screen.findByRole('textbox', { name: i18n.t('capabilities.hooks.purposes.mo') }),
    ).toHaveValue(hooks.netgsm[0].url);
    expect(client.getQueryData(HOOKS_KEY)).toEqual(hooks);
    await act(async () => {
      await router.navigate('/budget');
    });
    await waitFor(() => expect(client.getQueryCache().find({ queryKey: HOOKS_KEY })).toBeUndefined());
  });
});

 it('opens IYS setup from a verified SMS line without offering SMS credential replacement', async () => {
    const user=userEvent.setup();
    mockFetch({...withConnectors,[`GET /api/capabilities/${SMS_LINE_ID}`]:smsLine});
    renderAt('/capabilities');
    const line=await cardOf('Kampanya hattı');
    await user.click(within(line).getByRole('button',{name:'İYS ayarla'}));
    await user.click(await screen.findByRole('button',{name:/İYS bağlantısı \(isteğe bağlı\)/}));
    expect(screen.getByLabelText('İYS parolası')).toBeInTheDocument();
    expect(screen.queryByLabelText(tr.connect.credentials.password)).not.toBeInTheDocument();
    expect(screen.queryByRole('button',{name:tr.connect.credentials.submit})).not.toBeInTheDocument();
  });

it('pbx_policy_toggle: saves recording and call mode on the PBX card', async () => {
    const user = userEvent.setup();
    const pbx = {
      ...smsLine,
      capability: {
        ...smsLine.capability,
        id: '0193a000-0000-7000-8000-0000000000b1',
        kind_key: 'netgsm_pbx',
        name: 'Santral',
        connector_public: { ...smsLine.capability.connector_public, provider: 'netgsm' },
      },
    };
    const calls = mockFetch({
      ...routes,
      'GET /api/capabilities': [...capabilities, pbx],
      [`PUT /api/connectors/${pbx.capability.id}/pbx-policy`]: {
        capability_id: pbx.capability.id,
        call_mode: 'originate',
        recording_allowed: true,
      },
    });
    renderAt('/capabilities');
    const card = await cardOf('Santral');
    const panel = within(card).getByRole('group', { name: tr.capabilities.pbx.title });
    const recording = within(panel).getByRole('switch', { name: tr.capabilities.pbx.recording });
    // Off until the owner turns it on; originate is the default mode.
    expect(recording).toHaveAttribute('aria-checked', 'false');
    expect(within(panel).getByRole('radio', { name: tr.capabilities.pbx.modes.originate })).toBeChecked();
    await user.click(recording);
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'PUT')).toEqual([
        expect.objectContaining({
          path: `/api/connectors/${pbx.capability.id}/pbx-policy`,
          body: { recording_allowed: true },
        }),
      ]),
    );
    await user.click(within(panel).getByRole('radio', { name: tr.capabilities.pbx.modes.linkup }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([
        { recording_allowed: true },
        { call_mode: 'linkup' },
      ]),
    );
    // Another kind has no such panel.
    const other = await cardOf('Atölye Instagram');
    expect(within(other).queryByRole('group', { name: tr.capabilities.pbx.title })).toBeNull();
  });

it('voice_bridge_card_shows_engines_extension_and_heartbeat_age', async () => {
  const at = new Date(Date.now() - 30_000).toISOString();
  const bridge = {
    ...smsLine,
    capability: {
      ...smsLine.capability,
      id: '0193a000-0000-7000-8000-0000000000b3',
      kind_key: 'voice_bridge',
      name: 'Voice bridge 101',
      reach: 'device' as const,
      external_id: '101',
      has_sealed_config: false,
      last_verified_at: at,
      connector_public: {
        bridge: {
          extension: '101',
          codecs: ['PCMA', 'PCMU'],
          max_calls: 1,
          stt: { engine: 'vosk', model: 'vosk-model-small-tr-0.3' },
          tts: { engine: 'piper', voice: 'tr_TR-fahrettin-medium' },
          version: '0.1.0',
        },
      },
    },
  };
  const silent = {
    ...bridge,
    capability: {
      ...bridge.capability,
      id: '0193a000-0000-7000-8000-0000000000b4',
      name: 'Voice bridge 102',
      external_id: '102',
      status: 'declared' as const,
      last_verified_at: null,
      connector_public: {},
    },
    effective_status: 'declared' as const,
  };
  mockFetch({ ...routes, 'GET /api/capabilities': [...capabilities, bridge, silent] });
  renderAt('/capabilities');
  const card = await cardOf('Voice bridge 101');
  const panel = within(card).getByRole('group', { name: tr.capabilities.bridge.title });
  expect(within(panel).getByText('101')).toBeInTheDocument();
  expect(within(panel).getByText('vosk · vosk-model-small-tr-0.3')).toBeInTheDocument();
  expect(within(panel).getByText('piper · tr_TR-fahrettin-medium')).toBeInTheDocument();
  expect(within(panel).getByText('0.1.0')).toBeInTheDocument();
  expect(within(panel).getByText('PCMA, PCMU')).toBeInTheDocument();
  expect(within(panel).getByText(formatRelative(at, 'tr'))).toBeInTheDocument();
  // Only its own registration verifies it: no verification by evidence here.
  expect(within(card).queryByRole('button', { name: tr.capabilities.actions.verify })).toBeNull();
  expect(within(card).getByRole('button', { name: tr.capabilities.actions.edit })).toBeInTheDocument();
  // Nor is a phone (its device bridge's registrations verify it); a printer still is. Neither
  // bridge's kind shows how long a verification lasts by its policy: a heartbeat's does not.
  const phone = await cardOf('Saha telefonu');
  expect(within(phone).queryByRole('button', { name: tr.capabilities.actions.verify })).toBeNull();
  expect(within(phone).getByRole('button', { name: tr.capabilities.actions.edit })).toBeInTheDocument();
  const ageLine = i18n.t('capabilities.policy.verifyAge', { days: 30 });
  for (const heartbeat of [card, phone]) {
    expect(within(heartbeat).queryByText(ageLine)).toBeNull();
    expect(within(heartbeat).queryByText(tr.capabilities.policy.verifyNever)).toBeNull();
  }
  const printer = await cardOf('Ofis yazıcısı');
  expect(within(printer).getByRole('button', { name: tr.capabilities.actions.verify })).toBeInTheDocument();
  expect(within(printer).getByText(ageLine)).toBeInTheDocument();
  // A bridge declared in the panel that never registered says so.
  const never = await cardOf('Voice bridge 102');
  expect(within(never).getByText(tr.capabilities.bridge.never)).toBeInTheDocument();
  // Another kind has no bridge panel.
  const other = await cardOf('Atölye Instagram');
  expect(within(other).queryByRole('group', { name: tr.capabilities.bridge.title })).toBeNull();
});

it('offers a verified PBX\'s "Place a call" only to whoever holds calls.work', async () => {
  const pbx = {
    ...smsLine,
    capability: {
      ...smsLine.capability,
      id: '0193a000-0000-7000-8000-0000000000b2',
      kind_key: 'netgsm_pbx',
      name: 'Santral',
      connector_public: { ...smsLine.capability.connector_public, provider: 'netgsm' },
    },
  };
  const caller = {
    ...repMe,
    memberships: [
      { ...repMe.memberships[0], permissions: [...repMe.memberships[0].permissions, 'calls.work' as const] },
    ],
  };
  mockFetch({ ...routes, 'GET /api/auth/me': caller, 'GET /api/capabilities': [...capabilities, smsLine, pbx] });
  const { unmount } = renderAt('/capabilities');
  const card = await cardOf('Santral');
  expect(within(card).getByRole('link', { name: tr.calls.place.open })).toHaveAttribute('href', '/calls');
  // The SMS line is no PBX.
  const line = await cardOf('Kampanya hattı');
  expect(within(line).queryByRole('link', { name: tr.calls.place.open })).toBeNull();
  unmount();

  mockFetch({ ...routes, 'GET /api/auth/me': repMe, 'GET /api/capabilities': [...capabilities, pbx] });
  renderAt('/capabilities');
  const without = await cardOf('Santral');
  expect(within(without).queryByRole('link', { name: tr.calls.place.open })).toBeNull();
});
