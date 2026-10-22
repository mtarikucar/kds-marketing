import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
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
});
