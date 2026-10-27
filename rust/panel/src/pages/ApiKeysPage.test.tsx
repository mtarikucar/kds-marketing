import * as clipboard from '@/lib/clipboard';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import tr from '@/i18n/tr.json';
import { keys, me } from '@/test/fixtures';
import { mockFetch, renderAt } from '@/test/render';

describe('ApiKeysPage', () => {
  it('lists the keys without any plaintext', async () => {
    mockFetch({ 'GET /api/auth/me': me, 'GET /api/api-keys': keys });
    renderAt('/api-keys');
    expect(await screen.findByRole('heading', { level: 1, name: tr.apiKeys.title })).toBeInTheDocument();
    expect(await screen.findByText('Gece işleri')).toBeInTheDocument();
    expect(screen.getByText('jt_ab12…')).toBeInTheDocument();
  });
});

describe('ApiKeysPage create dialog', () => {
  it('shows the plaintext once, with a warning, and forgets it on close', async () => {
    const user = userEvent.setup();
    const calls = mockFetch({
      'GET /api/auth/me': me,
      'GET /api/api-keys': keys,
      'POST /api/api-keys': {
        id: '0190a000-0000-7000-8000-000000000021',
        name: 'Yeni anahtar',
        prefix: 'jt_cd34',
        plaintext: 'jt_cd34_ornek_duz_metin',
        scopes: ['ledger.read'],
        created_at: '2026-10-22T13:00:00Z',
      },
    });
    renderAt('/api-keys');
    await user.click(await screen.findByRole('button', { name: tr.apiKeys.create }));
    const dialog = await screen.findByRole('dialog');
    // The name field's label is "Ad" plus the required mark; anchor it so "…read" labels do not match.
    await user.type(within(dialog).getByRole('textbox', { name: new RegExp(`^${tr.fields.name}`) }), 'Yeni anahtar');
    await user.click(within(dialog).getByLabelText(tr.permissions.ledger.read, { exact: false }));
    await user.click(within(dialog).getByRole('button', { name: tr.apiKeys.dialog.submit }));

    expect(await within(dialog).findByDisplayValue('jt_cd34_ornek_duz_metin')).toBeInTheDocument();
    expect(within(dialog).getByText(tr.apiKeys.dialog.plaintextWarning)).toBeInTheDocument();
    // The key first, then the agent connection: the MCP address and the ready Claude Code command.
    expect(within(dialog).getAllByRole('button', { name: tr.common.copy }).length).toBe(3);
    expect(within(dialog).getByLabelText(tr.apiKeys.connect.url)).toHaveValue(`${window.location.origin}/mcp`);
    expect((within(dialog).getByLabelText(tr.apiKeys.connect.command) as HTMLInputElement).value).toContain('claude mcp add --transport http jeeta');
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.body).toEqual({ name: 'Yeni anahtar', scopes: ['ledger.read'] });
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
    await user.click(screen.getByRole('button', { name: tr.apiKeys.create }));
    const again = await screen.findByRole('dialog');
    expect(within(again).queryByDisplayValue('jt_cd34_ornek_duz_metin')).not.toBeInTheDocument();
    expect(within(again).getByRole('button', { name: tr.apiKeys.dialog.submit })).toBeInTheDocument();
    // Before anything secret is shown, Escape still dismisses the form.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

it('key_is_shown_once_and_not_logged', async()=>{
  const user=userEvent.setup();
  const log=vi.spyOn(console,'log');
  const copy=vi.spyOn(clipboard,'copyText').mockResolvedValue(true);
  const secret='jt_once_only_secret';
  mockFetch({'GET /api/auth/me':me,'GET /api/api-keys':keys,'POST /api/api-keys':{id:'new-key',name:'Bot',prefix:'jt_once',plaintext:secret,scopes:['workspace.read'],created_at:'2026-10-24T10:00:00Z'}});
  const {client,router}=renderAt('/api-keys');
  await user.click(await screen.findByRole('button',{name:tr.apiKeys.create}));
  const dialog=await screen.findByRole('dialog');
  await user.type(within(dialog).getByRole('textbox',{name:new RegExp(`^${tr.fields.name}`)}),'Bot');
  await user.click(within(dialog).getByRole('button',{name:tr.apiKeys.dialog.submit}));
  expect(await screen.findByDisplayValue(secret)).toBeInTheDocument();
  expect(copy).not.toHaveBeenCalled();
  expect(JSON.stringify(client.getMutationCache().getAll().map(m=>m.state))).not.toContain(secret);
  await user.click(within(dialog).getAllByRole('button',{name:tr.common.copy})[0]);
  expect(copy).toHaveBeenCalledWith(secret);
  await act(()=>router.navigate('/onboarding'));
  await act(()=>router.navigate('/api-keys'));
  expect(screen.queryByDisplayValue(secret)).not.toBeInTheDocument();
  expect(JSON.stringify(client.getQueryCache().getAll())).not.toContain(secret);
  expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
  expect(JSON.stringify(localStorage)).not.toContain(secret);
  expect(JSON.stringify(sessionStorage)).not.toContain(secret);
  expect(router.state.location.search).not.toContain(secret);
});
