import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CapabilityOut, MeOut } from '@/api/types';
import i18n from '@/i18n/config';
import tr from '@/i18n/tr.json';
import { formatRelative } from '@/lib/format';
import { budgetItems, capabilities, connectorHealth, groups, hooks, me, repMe } from '@/test/fixtures';
import { mockFetch, renderAt } from '@/test/render';

// Invented phones and computers; the serials are made up.

const ONLINE_ID = '0193a000-0000-7000-8000-0000000000d1';
const PLAIN_ID = '0193a000-0000-7000-8000-0000000000d2';
const UNLISTED_ID = '0193a000-0000-7000-8000-0000000000d3';
const SILENT_ID = '0193a000-0000-7000-8000-0000000000d4';
const NEVER_ID = '0193a000-0000-7000-8000-0000000000d5';
const BRIDGE_KEY_ID = '0193a000-0000-7000-8000-0000000000e1';

/** The owner, holding the phones' permissions too (`me` predates them). */
const deviceMe: MeOut = {
  ...me,
  memberships: [
    {
      ...me.memberships[0],
      permissions: [...me.memberships[0].permissions, 'devices.work', 'devices.bridge'],
    },
  ],
};

const KINDS = [
  'observe',
  'tap',
  'tap_on',
  'long_press',
  'swipe',
  'text',
  'key',
  'open_url',
  'launch_app',
  'shell',
  'push_file',
  'pull_file',
  'screenshot',
];

/** A phone a device bridge registered: `device` is what it reported (`connector_public.device`). */
function phone(
  id: string,
  name: string,
  status: CapabilityOut['capability']['status'],
  effective: CapabilityOut['effective_status'],
  lastSeen: string | null,
  device: Record<string, unknown> | null,
): CapabilityOut {
  return {
    capability: {
      ...capabilities[0].capability,
      id,
      kind_key: 'phone',
      name,
      reach: 'device',
      status,
      external_id: device ? `android:${String(device.serial)}` : null,
      last_verified_at: lastSeen,
      connector_public: device ? { device } : {},
    },
    effective_status: effective,
  };
}

function facts(serial: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    platform: 'android',
    serial,
    model: 'Galaxy A52',
    os_version: '13 (API 33)',
    screen: { w: 1080, h: 2400, rotation: 0 },
    features: [...KINDS, 'text.unicode'],
    bridge_id: 'ATOLYE-PC',
    version: '0.1.0',
    protocol: 1,
    listed_by: BRIDGE_KEY_ID,
    listed: true,
    ...extra,
  };
}

const seconds = (n: number) => new Date(Date.now() - n * 1000).toISOString();

/**
 * The canned answers, with phones last seen as of now: made in each test, so that the ages its
 * cards show are the ones it reads.
 */
function answers() {
  const online = phone(ONLINE_ID, 'Galaxy A52 (R58M00000XX)', 'verified', 'verified', seconds(12), facts('R58M00000XX'));
  const plain = phone(
    PLAIN_ID,
    'Redmi Note (R58M00000YY)',
    'verified',
    'verified',
    seconds(5),
    facts('R58M00000YY', { model: 'Redmi Note', features: KINDS }),
  );
  const unlisted = phone(
    UNLISTED_ID,
    'Pixel (R58M00000ZZ)',
    'verified',
    'verified',
    seconds(20),
    facts('R58M00000ZZ', { model: 'Pixel', listed: false }),
  );
  const silent = phone(
    SILENT_ID,
    'Tablet (R58M00000WW)',
    'unreachable',
    'unreachable',
    seconds(2 * 3600),
    facts('R58M00000WW', { model: 'Tablet' }),
  );
  const never = phone(NEVER_ID, 'Saha telefonu 2', 'declared', 'declared', null, null);

  return {
    'GET /api/auth/me': deviceMe,
    // One capability of another kind beside the phones.
    'GET /api/capabilities': [capabilities[0], online, plain, unlisted, silent, never],
    'GET /api/capability-groups': groups,
    'GET /api/budget/items': budgetItems,
    'GET /api/connectors/health': connectorHealth,
    'GET /api/connectors/hooks': hooks,
    [`GET /api/devices/${ONLINE_ID}/commands`]: [],
    [`GET /api/devices/${PLAIN_ID}/commands`]: [],
    [`GET /api/devices/${UNLISTED_ID}/commands`]: [],
    [`GET /api/devices/${SILENT_ID}/commands`]: [],
  };
}

/** The card of the capability named `name`. */
async function cardOf(name: string): Promise<HTMLElement> {
  return (await screen.findByRole('heading', { name })).closest('[data-capability-id]') as HTMLElement;
}

/** The device bridge's panel of the phone named `name`. */
async function panelOf(name: string): Promise<HTMLElement> {
  return within(await cardOf(name)).getByRole('group', { name: tr.capabilities.phone.title });
}

/** The value of the row labelled `label` in `panel`. */
function row(panel: HTMLElement, label: string): string {
  const term = within(panel).getByText(label, { selector: 'dt' });
  return term.nextElementSibling?.textContent ?? '';
}

describe('PhoneCard', () => {
  it('renders_phone_facts_and_status', async () => {
    mockFetch(answers());
    renderAt('/capabilities');
    const panel = await panelOf('Galaxy A52 (R58M00000XX)');
    expect(row(panel, tr.capabilities.phone.platform)).toBe(tr.capabilities.phone.platforms.android);
    expect(row(panel, tr.capabilities.phone.model)).toBe('Galaxy A52');
    expect(row(panel, tr.capabilities.phone.os)).toBe('13 (API 33)');
    expect(row(panel, tr.capabilities.phone.computer)).toBe('ATOLYE-PC');
    expect(row(panel, tr.capabilities.phone.version)).toBe('0.1.0');
    expect(row(panel, tr.capabilities.phone.unicode)).toBe(tr.capabilities.phone.yes);
    expect(row(panel, tr.capabilities.phone.commands)).toContain('tap_on');
    expect(row(panel, tr.capabilities.phone.commands)).not.toContain('text.unicode');
    // Online, with its heartbeat's age: seconds ago (12 when it was drawn).
    const seen = (ago: string) => i18n.t('capabilities.phone.seen', { ago });
    const status = row(panel, tr.capabilities.phone.status);
    const shown = `${tr.capabilities.phone.states.online} · ${seen('')}`;
    expect(status.startsWith(shown)).toBe(true);
    expect(status.slice(shown.length)).toMatch(/^\d+ saniye önce$/);

    // Verified, but its bridge's latest registration leaves it out: not online.
    const out = row(await panelOf('Pixel (R58M00000ZZ)'), tr.capabilities.phone.status);
    expect(out.startsWith(`${tr.capabilities.phone.states.unlisted} · `)).toBe(true);
    // Silent for hours: unreachable, and how long ago it was last seen.
    const gone = row(await panelOf('Tablet (R58M00000WW)'), tr.capabilities.phone.status);
    expect(gone).toBe(
      `${tr.capabilities.phone.states.unreachable} · ${seen(formatRelative(seconds(2 * 3600), 'tr'))}`,
    );
    // A phone declared by hand that no bridge registered yet says so.
    const declared = await panelOf('Saha telefonu 2');
    expect(within(declared).getByText(tr.capabilities.phone.never)).toBeInTheDocument();
    // Only its bridge's registrations verify a phone, and no verification age applies.
    const card = await cardOf('Galaxy A52 (R58M00000XX)');
    expect(within(card).queryByRole('button', { name: tr.capabilities.actions.verify })).toBeNull();
    expect(within(card).queryByText(i18n.t('capabilities.policy.verifyAge', { days: 30 }))).toBeNull();
    // Another kind has no phone panel.
    const other = await cardOf('Atölye Instagram');
    expect(within(other).queryByRole('group', { name: tr.capabilities.phone.title })).toBeNull();
  });

  it('unicode_hint_when_feature_missing', async () => {
    mockFetch(answers());
    renderAt('/capabilities');
    const source = tr.capabilities.phone.unicodeHint;
    const missing = await panelOf('Redmi Note (R58M00000YY)');
    expect(row(missing, tr.capabilities.phone.unicode)).toBe(tr.capabilities.phone.no);
    const shown = missing.querySelector('[data-unicode-hint]');
    expect(shown?.textContent).toBe(source.replace(/<\/?b>/g, ''));
    // "and enable" is the half people miss: it stands out.
    expect(shown?.querySelector('strong')?.textContent).toBe(source.match(/<b>(.*)<\/b>/)?.[1]);
    // A phone whose bridge lists text.unicode has no hint.
    const ready = await panelOf('Galaxy A52 (R58M00000XX)');
    expect(ready.querySelector('[data-unicode-hint]')).toBeNull();
  });

  it('pairing_shows_key_once', async () => {
    const user = userEvent.setup();
    const log = vi.spyOn(console, 'log');
    const secret = 'jt_ab12_cihaz_kopru_anahtari';
    // No phone yet: pairing is how the first one comes.
    const calls = mockFetch({
      ...answers(),
      'GET /api/capabilities': [],
      'POST /api/api-keys': {
        id: BRIDGE_KEY_ID,
        name: 'Atölye PC',
        prefix: 'jt_ab12',
        plaintext: secret,
        scopes: ['devices.bridge'],
        created_at: '2026-10-29T09:00:00Z',
      },
    });
    renderAt('/capabilities');
    await screen.findByText(tr.capabilities.empty);
    // Pairing is offered on the Devices tab.
    expect(screen.queryByRole('button', { name: tr.capabilities.phone.pair.open })).toBeNull();
    await user.click(screen.getByRole('button', { name: tr.capabilities.groups.device }));
    await user.click(await screen.findByRole('button', { name: tr.capabilities.phone.pair.open }));
    const dialog = await screen.findByRole('dialog');
    const name = within(dialog).getByRole('textbox', { name: new RegExp(`^${tr.fields.name}`) });
    expect(name).toHaveValue(tr.capabilities.phone.pair.defaultName);
    await user.clear(name);
    await user.type(name, 'Atölye PC');
    await user.click(within(dialog).getByRole('button', { name: tr.capabilities.phone.pair.submit }));

    // A key with exactly devices.bridge, never an empty scope list (which means every permission).
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      name: 'Atölye PC',
      scopes: ['devices.bridge'],
    }));
    expect(await within(dialog).findByDisplayValue(secret)).toBeInTheDocument();
    expect(within(dialog).getByText(tr.apiKeys.dialog.plaintextWarning)).toBeInTheDocument();
    // The three steps, the configuration file ready with the key and this server, and the note
    // that each computer's bridge holds a key of its own.
    const steps = within(dialog).getByRole('list', { name: tr.capabilities.phone.pair.stepsLabel });
    expect(within(steps).getAllByRole('listitem')).toHaveLength(3);
    const config = within(dialog).getByLabelText(tr.capabilities.phone.pair.configLabel) as HTMLTextAreaElement;
    expect(config.value).toBe(`base_url = "${window.location.origin}"\nkey = "${secret}"\n`);
    expect(within(dialog).getByText(tr.capabilities.phone.pair.ownKey)).toBeInTheDocument();

    // Neither Escape nor a click outside dismisses it while the key is shown.
    await user.keyboard('{Escape}');
    fireEvent.pointerDown(document.body);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: tr.common.close }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByDisplayValue(secret)).not.toBeInTheDocument();
    // Opened again, it asks for a new key: the old one is gone.
    await user.click(screen.getByRole('button', { name: tr.capabilities.phone.pair.open }));
    const again = await screen.findByRole('dialog');
    expect(within(again).queryByDisplayValue(secret)).not.toBeInTheDocument();
    expect(within(again).getByRole('button', { name: tr.capabilities.phone.pair.submit })).toBeInTheDocument();
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
  });

  it('offers pairing only to who holds api_keys.manage and devices.bridge', async () => {
    const user = userEvent.setup();
    for (const who of [me, repMe]) {
      mockFetch({ ...answers(), 'GET /api/auth/me': who, 'GET /api/capabilities': [] });
      const { unmount } = renderAt('/capabilities');
      await user.click(await screen.findByRole('button', { name: tr.capabilities.groups.device }));
      await screen.findByText(tr.capabilities.empty);
      expect(screen.queryByRole('button', { name: tr.capabilities.phone.pair.open })).toBeNull();
      unmount();
    }
  });

  it('command_log_expands_args', async () => {
    const user = userEvent.setup();
    const spies = (['log', 'info', 'debug', 'warn'] as const).map((level) => vi.spyOn(console, level));
    const typed = 'Merhaba dünya, şimdi geliyorum';
    const text = {
      command_id: '0193a000-0000-7000-8000-0000000000f1',
      capability_id: ONLINE_ID,
      kind: 'text',
      command: { kind: 'text', value: typed },
      status: 'done',
      attempts: 1,
      reason: null,
      detail: null,
      requested_by: { kind: 'agent', connection_id: '0193a000-0000-7000-8000-0000000000c1', user_id: me.user_id },
      created_at: '2026-10-29T09:00:00Z',
      expires_at: '2026-10-29T09:05:00Z',
      leased_at: '2026-10-29T09:00:01Z',
      done_at: '2026-10-29T09:00:02Z',
    };
    const shell = {
      ...text,
      command_id: '0193a000-0000-7000-8000-0000000000f2',
      kind: 'shell',
      command: { kind: 'shell', argv: ['getprop', 'ro.product.model'] },
      status: 'failed',
      reason: 'adb_error',
      detail: 'adb: device offline',
      created_at: '2026-10-29T08:59:00Z',
    };
    const calls = mockFetch({
      ...answers(),
      [`GET /api/devices/${ONLINE_ID}/commands`]: [text, shell],
      [`GET /api/devices/commands/${text.command_id}`]: {
        ...text,
        result: { kind: 'done', note: 'typed through ADBKeyBoard' },
        file_url: null,
      },
    });
    renderAt('/capabilities');
    const panel = await panelOf('Galaxy A52 (R58M00000XX)');
    const log = await within(panel).findByRole('list', { name: tr.capabilities.phone.log.title });
    const rows = within(log).getAllByRole('button', { expanded: false });
    expect(rows).toHaveLength(2);
    // The last 20, newest first as the server lists them.
    expect(calls.find((c) => c.path === `/api/devices/${ONLINE_ID}/commands`)?.search).toBe('?limit=20');
    expect(rows[0]).toHaveTextContent('text');
    expect(rows[0]).toHaveTextContent(tr.capabilities.phone.log.statuses.done);
    expect(rows[1]).toHaveTextContent('shell');
    expect(rows[1]).toHaveTextContent(tr.capabilities.phone.log.statuses.failed);
    // Arguments and results stay folded until asked for: nothing is fetched before.
    expect(within(log).queryByText(new RegExp(typed))).toBeNull();
    expect(calls.some((c) => c.path.startsWith('/api/devices/commands/'))).toBe(false);

    await user.click(rows[0]);
    expect(rows[0]).toHaveAttribute('aria-expanded', 'true');
    expect(within(log).getByText(new RegExp(typed))).toBeInTheDocument();
    // Its result, read at once (no wait on a command that ended).
    expect(await within(log).findByText(/typed through ADBKeyBoard/)).toBeInTheDocument();
    expect(calls.find((c) => c.path === `/api/devices/commands/${text.command_id}`)?.search).toBe('?wait_s=0');

    // A failed one shows why, beside its arguments.
    await user.click(rows[1]);
    expect(within(log).getByText(/"ro\.product\.model"/)).toBeInTheDocument();
    expect(within(log).getByText(tr.capabilities.phone.log.reasons.adb_error, { exact: false })).toBeInTheDocument();
    expect(within(log).getByText(/adb: device offline/)).toBeInTheDocument();
    // What was typed is shown, never written to the console.
    for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain(typed);
  });

  it('shows the command log only to who holds devices.work', async () => {
    const calls = mockFetch({ ...answers(), 'GET /api/auth/me': me });
    renderAt('/capabilities');
    const panel = await panelOf('Galaxy A52 (R58M00000XX)');
    expect(within(panel).queryByRole('list', { name: tr.capabilities.phone.log.title })).toBeNull();
    expect(calls.some((c) => c.path.startsWith('/api/devices/'))).toBe(false);
  });
});
