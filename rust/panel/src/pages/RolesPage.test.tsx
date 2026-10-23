import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RoleDef } from '@/api/types';
import tr from '@/i18n/tr.json';
import { me, roles } from '@/test/fixtures';
import { mockFetch, renderAt } from '@/test/render';

describe('RolesPage', () => {
  it('lists system and custom roles', async () => {
    mockFetch({ 'GET /api/auth/me': me, 'GET /api/roles': roles });
    renderAt('/roles');
    expect(await screen.findByRole('heading', { level: 1, name: tr.roles.title })).toBeInTheDocument();
    expect(await screen.findByText('Denetçi')).toBeInTheDocument();
    expect(screen.getByText(tr.roleNames.owner)).toBeInTheDocument();
  });

  it.each(['inbox.work', 'inbox.manage'] as const)(
    'preserves %s when editing an unrelated permission',
    async (permission) => {
      const user = userEvent.setup();
      const role: RoleDef = {
        ...roles[1],
        permissions: ['workspace.read', 'ledger.read', permission],
      };
      const calls = mockFetch({
        'GET /api/auth/me': me,
        'GET /api/roles': [role],
        [`PATCH /api/roles/${role.id}`]: { ...role, permissions: ['workspace.read', permission] },
      });
      renderAt('/roles');
      await user.click(await screen.findByRole('button', { name: tr.roles.edit }));
      const dialog = within(await screen.findByRole('dialog'));
      await user.click(dialog.getByRole('checkbox', { name: /ledger\.read/ }));
      await user.click(dialog.getByRole('button', { name: tr.common.save }));

      await waitFor(() => {
        expect(calls.find((call) => call.method === 'PATCH' && call.path === `/api/roles/${role.id}`)?.body)
          .toEqual({ permissions: ['workspace.read', permission] });
      });
    },
  );
});
