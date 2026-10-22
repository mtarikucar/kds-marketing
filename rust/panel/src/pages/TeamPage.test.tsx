import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import tr from '@/i18n/tr.json';
import { me, members, roles } from '@/test/fixtures';
import { mockFetch, renderAt } from '@/test/render';

describe('TeamPage', () => {
  it('lists the members', async () => {
    mockFetch({ 'GET /api/auth/me': me, 'GET /api/team': members, 'GET /api/roles': roles });
    renderAt('/team');
    expect(await screen.findByRole('heading', { level: 1, name: tr.team.title })).toBeInTheDocument();
    expect(await screen.findByText('invitee@alpha.example')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: tr.team.invite })).toBeInTheDocument();
  });
});

describe('TeamPage invite dialog', () => {
  it('shows the one-time invite link with a copy button', async () => {
    const user = userEvent.setup();
    const calls = mockFetch({
      'GET /api/auth/me': me,
      'GET /api/team': members,
      'GET /api/roles': roles,
      'POST /api/team/invites': {
        membership_id: '0190a000-0000-7000-8000-000000000005',
        invite_token: 'ornek-davet-jetonu',
        expires_at: '2026-10-29T10:00:00Z',
      },
    });
    renderAt('/team');
    await user.click(await screen.findByRole('button', { name: tr.team.invite }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(tr.fields.email, { exact: false }), 'new@alpha.example');
    await user.click(within(dialog).getByRole('button', { name: tr.team.dialog.submit }));

    expect(
      await within(dialog).findByDisplayValue(`${window.location.origin}/invite/ornek-davet-jetonu`),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(tr.team.dialog.linkWarning)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: tr.common.copy })).toBeInTheDocument();
    const post = calls.find((c) => c.method === 'POST');
    // The fixture roles have no "rep", so the default is the first role the server listed.
    expect(post?.body).toEqual({ email: 'new@alpha.example', role_key: 'owner' });
  });
});
