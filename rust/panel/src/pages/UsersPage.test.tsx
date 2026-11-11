import { expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockFetch, renderAt } from '@/test/render';
import { me, members, roles } from '@/test/fixtures';

it('combines team and role actions under one Users heading in that order', async () => {
  mockFetch({ 'GET /api/auth/me': me, 'GET /api/team': members, 'GET /api/roles': roles });
  renderAt('/users');
  expect(await screen.findByRole('heading', { level: 1, name: 'Kullanıcılar' })).toBeVisible();
  expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  const team = screen.getByRole('region', { name: 'Ekip' });
  const roleSection = screen.getByRole('region', { name: 'Roller' });
  expect(team.compareDocumentPosition(roleSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(await within(team).findByText(members[0].email)).toBeVisible();
  await userEvent.click(within(team).getByRole('button', { name: 'Üye davet et' }));
  expect(await screen.findByRole('dialog')).toBeVisible();
  await userEvent.keyboard('{Escape}');
  expect(within(roleSection).getByRole('button', { name: 'Rol oluştur' })).toBeVisible();
});
