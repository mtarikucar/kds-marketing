import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
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
    expect(within(dialog).getByRole('button', { name: tr.common.copy })).toBeInTheDocument();
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.body).toEqual({ name: 'Yeni anahtar', scopes: ['ledger.read'] });
    expect(post?.headers.get('x-requested-with')).toBe('jeeta-panel');

    await user.click(within(dialog).getByRole('button', { name: tr.common.done }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: tr.apiKeys.create }));
    const again = await screen.findByRole('dialog');
    expect(within(again).queryByDisplayValue('jt_cd34_ornek_duz_metin')).not.toBeInTheDocument();
    expect(within(again).getByRole('button', { name: tr.apiKeys.dialog.submit })).toBeInTheDocument();
  });
});
