import * as clipboard from '@/lib/clipboard';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import tr from '@/i18n/tr.json';
import type { KeySummary } from '@/api/types';
import { agents, keys, me } from '@/test/fixtures';
import { mockFetch, renderAt } from '@/test/render';
import { accessesOf } from './AgentsPage';

const unused: KeySummary = { ...keys[0], id: '0190a000-0000-7000-8000-000000000022', name: 'Bekleyen ajan', prefix: 'jt_ef56', created_at: '2026-10-23T09:00:00Z' };
const revoked: KeySummary = { ...keys[0], id: '0190a000-0000-7000-8000-000000000023', name: 'Eski ajan', prefix: 'jt_gh78', status: 'revoked', revoked_at: '2026-10-21T08:00:00Z' };
const reader = { ...me, memberships: [{ ...me.memberships[0], permissions: me.memberships[0].permissions.filter(p => p !== 'api_keys.manage') }] };
/** The row of the key called `name`: the key and whoever connected with it. */
const rowOf = async (name: string) => (await screen.findByRole('heading', { level: 3, name })).closest('li') as HTMLElement;

describe('AgentsPage', () => {
  it('shows a key and the agent that connected with it as one row', async () => {
    mockFetch({ 'GET /api/auth/me': me, 'GET /api/agents': agents, 'GET /api/api-keys': keys });
    renderAt('/agents');
    expect(await screen.findByRole('heading', { level: 1, name: tr.agents.title })).toBeInTheDocument();
    const row = await rowOf('Gece işleri');
    expect(within(row).getByText('jt_ab12…')).toBeInTheDocument();
    expect(within(row).getByText('ornek-istemci')).toBeInTheDocument();
    expect(within(row).getByText('1.4.0')).toBeInTheDocument();
    expect(within(row).getByText('Araç çağrısı: 42')).toBeInTheDocument();
    expect(within(row).getByText(tr.agents.onTime)).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: tr.agents.revoke })).toBeInTheDocument();
    // What the key may do opens in the same row.
    expect(within(row).queryByText(tr.permissions.ledger.read)).not.toBeInTheDocument();
    await userEvent.setup().click(within(row).getByRole('button', { name: 'İzinler: 2' }));
    expect(within(row).getByText(tr.permissions.ledger.read)).toBeInTheDocument();
    // One list, not a table of keys and a table of agents.
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('flags each agent that is overdue for its check-in', async () => {
    const late = { ...agents[0], id: '0190a000-0000-7000-8000-000000000031', client_name: 'gec-istemci', overdue: true };
    mockFetch({ 'GET /api/auth/me': me, 'GET /api/agents': [agents[0], late], 'GET /api/api-keys': keys });
    renderAt('/agents');
    const lateLine = (await screen.findByText('gec-istemci')).closest('li') as HTMLElement;
    const onTimeLine = screen.getByText('ornek-istemci').closest('li') as HTMLElement;
    expect(within(lateLine).getByText(tr.agents.overdue)).toBeInTheDocument();
    expect(within(onTimeLine).getByText(tr.agents.onTime)).toBeInTheDocument();
    expect(within(onTimeLine).queryByText(tr.agents.overdue)).not.toBeInTheDocument();
    // Both connected with the same key, so both stand in its row.
    expect(lateLine.closest('ul')).toBe(onTimeLine.closest('ul'));
  });

  it('says of a key nobody used yet how its agent connects', async () => {
    const user = userEvent.setup();
    mockFetch({ 'GET /api/auth/me': me, 'GET /api/agents': agents, 'GET /api/api-keys': [keys[0], unused] });
    renderAt('/agents');
    const row = await rowOf('Bekleyen ajan');
    expect(within(row).getByText(tr.agents.waiting)).toBeInTheDocument();
    await user.click(within(row).getByText(tr.agents.howTo));
    expect(within(row).getByLabelText(tr.apiKeys.connect.url)).toHaveValue(`${window.location.origin}/mcp`);
    expect(within(row).getByText(tr.agents.keyShownOnce)).toBeInTheDocument();
    // The key in use comes first: the latest contact leads the list.
    const names = screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent);
    expect(names).toEqual(['Gece işleri', 'Bekleyen ajan']);
  });

  it('removes an agent’s access by revoking its key', async () => {
    const user = userEvent.setup();
    const calls = mockFetch({
      'GET /api/auth/me': me, 'GET /api/agents': agents, 'GET /api/api-keys': keys,
      [`DELETE /api/api-keys/${keys[0].id}`]: null,
    });
    renderAt('/agents');
    await user.click(within(await rowOf('Gece işleri')).getByRole('button', { name: tr.agents.revoke }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Gece işleri anahtarı iptal edilecek/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: tr.agents.revoke }));
    await waitFor(() => expect(calls.some(c => c.method === 'DELETE' && c.path === `/api/api-keys/${keys[0].id}`)).toBe(true));
    expect(await screen.findByText(tr.agents.revoked)).toBeInTheDocument();
  });

  it('keeps revoked keys apart, with their agents and without the action', async () => {
    const user = userEvent.setup();
    const old = { ...agents[0], id: '0190a000-0000-7000-8000-000000000032', api_key_id: revoked.id, api_key_name: revoked.name, client_name: 'eski-istemci' };
    mockFetch({ 'GET /api/auth/me': me, 'GET /api/agents': [agents[0], old], 'GET /api/api-keys': [keys[0], revoked] });
    renderAt('/agents');
    await rowOf('Gece işleri');
    const group = screen.getByText('Erişimi kesilenler: 1').closest('details') as HTMLElement;
    await user.click(within(group).getByText('Erişimi kesilenler: 1'));
    const row = within(group).getByRole('heading', { level: 3, name: 'Eski ajan' }).closest('li') as HTMLElement;
    expect(within(row).getByText('eski-istemci')).toBeInTheDocument();
    expect(within(row).getByText(tr.status.key.revoked)).toBeInTheDocument();
    // An agent that can no longer get in is neither on time nor overdue.
    expect(within(row).queryByText(tr.agents.onTime)).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: tr.agents.revoke })).not.toBeInTheDocument();
  });

  it('lists the agents under their keys’ names for a member who may not manage keys', async () => {
    const calls = mockFetch({ 'GET /api/auth/me': reader, 'GET /api/agents': agents });
    renderAt('/agents');
    const row = await rowOf('Gece işleri');
    expect(within(row).getByText('ornek-istemci')).toBeInTheDocument();
    expect(within(row).queryByText('jt_ab12…')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: tr.agents.connect })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: tr.agents.revoke })).not.toBeInTheDocument();
    expect(calls.some(c => c.path === '/api/api-keys')).toBe(false);
  });

  it('offers to connect the first agent when there is none', async () => {
    mockFetch({ 'GET /api/auth/me': me, 'GET /api/agents': [], 'GET /api/api-keys': [] });
    renderAt('/agents');
    expect(await screen.findByText(tr.agents.empty)).toBeInTheDocument();
    expect(screen.getByText(tr.agents.emptyBody)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: tr.agents.connect })).toHaveLength(2);
  });

  it('answers the old API keys address and opens the connect dialog when asked to', async () => {
    mockFetch({ 'GET /api/auth/me': me, 'GET /api/agents': agents, 'GET /api/api-keys': keys });
    const { router } = renderAt('/api-keys?connect=1');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: tr.agents.dialog.title })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/agents');
    // Closing it drops the request from the address, so a reload does not open it again.
    await userEvent.setup().keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(router.state.location.search).toBe('');
    expect(screen.getByRole('heading', { level: 1, name: tr.agents.title })).toBeInTheDocument();
  });
});

describe('accessesOf', () => {
  it('joins keys and connections, the latest contact first, then the newest unused key', () => {
    const newer = { ...agents[0], id: 'a2', api_key_id: 'k2', api_key_name: 'İkinci', last_seen_at: '2026-10-23T12:00:00Z' };
    const list = accessesOf([keys[0], unused], [agents[0], newer]);
    expect(list.map(access => access.name)).toEqual(['İkinci', 'Gece işleri', 'Bekleyen ajan']);
    expect(list[0].key).toBeNull();
    expect(list[1].agents).toEqual([agents[0]]);
    expect(list[2].agents).toEqual([]);
  });
});

describe('connecting an agent', () => {
  it('shows the key once, with a warning and the ready command, and forgets it on close', async () => {
    const user = userEvent.setup();
    const calls = mockFetch({
      'GET /api/auth/me': me,
      'GET /api/agents': agents,
      'GET /api/api-keys': keys,
      'POST /api/api-keys': {
        id: '0190a000-0000-7000-8000-000000000021',
        name: 'Yeni ajan',
        prefix: 'jt_cd34',
        plaintext: 'jt_cd34_ornek_duz_metin',
        scopes: ['ledger.read'],
        created_at: '2026-10-22T13:00:00Z',
      },
    });
    renderAt('/agents');
    await user.click(await screen.findByRole('button', { name: tr.agents.connect }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: new RegExp(`^${tr.agents.dialog.name}`) }), 'Yeni ajan');
    await user.click(within(dialog).getByLabelText(tr.permissions.ledger.read, { exact: false }));
    await user.click(within(dialog).getByRole('button', { name: tr.agents.dialog.submit }));

    expect(await within(dialog).findByDisplayValue('jt_cd34_ornek_duz_metin')).toBeInTheDocument();
    expect(within(dialog).getByText(tr.apiKeys.dialog.plaintextWarning)).toBeInTheDocument();
    // The key first, then the agent connection: the MCP address and the ready Claude Code command.
    expect(within(dialog).getAllByRole('button', { name: tr.common.copy }).length).toBe(3);
    expect(within(dialog).getByLabelText(tr.apiKeys.connect.url)).toHaveValue(`${window.location.origin}/mcp`);
    expect((within(dialog).getByLabelText(tr.apiKeys.connect.command) as HTMLInputElement).value).toContain('claude mcp add --transport http jeeta');
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.body).toEqual({ name: 'Yeni ajan', scopes: ['ledger.read'] });
    expect(post?.headers.get('x-requested-with')).toBe('jeeta-panel');

    // Neither Escape nor a click outside dismisses it while the key is shown, and there is no
    // close icon: only the explicit Close button.
    await user.keyboard('{Escape}');
    fireEvent.pointerDown(document.body);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(within(dialog).getByDisplayValue('jt_cd34_ornek_duz_metin')).toBeInTheDocument();
    expect(within(dialog).getAllByRole('button', { name: tr.common.close })).toHaveLength(1);

    await user.click(within(dialog).getByRole('button', { name: tr.common.close }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // Closing reads the agents again: the one that just got its key shows as soon as it connects.
    await waitFor(() => expect(calls.filter(c => c.path === '/api/agents').length).toBeGreaterThan(1));
    await user.click(screen.getByRole('button', { name: tr.agents.connect }));
    const again = await screen.findByRole('dialog');
    expect(within(again).queryByDisplayValue('jt_cd34_ornek_duz_metin')).not.toBeInTheDocument();
    expect(within(again).getByRole('button', { name: tr.agents.dialog.submit })).toBeInTheDocument();
    // Before anything secret is shown, Escape still dismisses the form.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('shows the key once and keeps it out of caches, logs, storage and the address', async () => {
    const user = userEvent.setup();
    const log = vi.spyOn(console, 'log');
    const copy = vi.spyOn(clipboard, 'copyText').mockResolvedValue(true);
    const secret = 'jt_once_only_secret';
    mockFetch({
      'GET /api/auth/me': me, 'GET /api/agents': agents, 'GET /api/api-keys': keys,
      'POST /api/api-keys': { id: 'new-key', name: 'Bot', prefix: 'jt_once', plaintext: secret, scopes: ['workspace.read'], created_at: '2026-10-24T10:00:00Z' },
    });
    const { client, router } = renderAt('/agents');
    await user.click(await screen.findByRole('button', { name: tr.agents.connect }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: new RegExp(`^${tr.agents.dialog.name}`) }), 'Bot');
    await user.click(within(dialog).getByRole('button', { name: tr.agents.dialog.submit }));
    expect(await screen.findByDisplayValue(secret)).toBeInTheDocument();
    expect(copy).not.toHaveBeenCalled();
    expect(JSON.stringify(client.getMutationCache().getAll().map(m => m.state))).not.toContain(secret);
    await user.click(within(dialog).getAllByRole('button', { name: tr.common.copy })[0]);
    expect(copy).toHaveBeenCalledWith(secret);
    await act(() => router.navigate('/onboarding'));
    await act(() => router.navigate('/agents'));
    expect(screen.queryByDisplayValue(secret)).not.toBeInTheDocument();
    expect(JSON.stringify(client.getQueryCache().getAll())).not.toContain(secret);
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(localStorage)).not.toContain(secret);
    expect(JSON.stringify(sessionStorage)).not.toContain(secret);
    expect(router.state.location.search).not.toContain(secret);
  });
});
