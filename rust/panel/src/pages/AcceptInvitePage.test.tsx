import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import tr from '@/i18n/tr.json';
import type { MeOut } from '@/api/types';
import { me } from '@/test/fixtures';
import { mockFetch, renderAt, withStatus } from '@/test/render';

const JOINED_WS = '0190a000-0000-7000-8000-000000000099';

describe('AcceptInvitePage', () => {
  it('offers a signed-in user to accept the invite', async () => {
    mockFetch({ 'GET /api/auth/me': me });
    renderAt('/invite/tok-123');
    expect(await screen.findByRole('heading', { level: 1, name: tr.invite.title })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: tr.invite.accept })).toBeInTheDocument();
  });

  it('moves a signed-in user to the workspace just joined before going home', async () => {
    const user = userEvent.setup();
    const joined: MeOut = {
      ...me,
      current_workspace: JOINED_WS,
      memberships: [
        ...me.memberships,
        {
          ...me.memberships[0],
          membership_id: '0190a000-0000-7000-8000-000000000098',
          workspace_id: JOINED_WS,
          workspace_name: 'Beta Atölye',
          workspace_slug: 'beta-atolye',
          role_key: 'rep',
          permissions: ['workspace.read'],
        },
      ],
    };
    const calls = mockFetch({
      'GET /api/auth/me': me,
      'POST /api/team/invites/accept': {
        workspace_id: JOINED_WS,
        membership_id: '0190a000-0000-7000-8000-000000000098',
      },
      'POST /api/auth/switch-workspace': joined,
    });
    renderAt('/invite/tok-123');
    await user.click(await screen.findByRole('button', { name: tr.invite.accept }));

    expect(await screen.findByText(tr.invite.accepted)).toBeInTheDocument();
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => c.path)).toEqual(['/api/team/invites/accept', '/api/auth/switch-workspace']);
    expect(posts[0].body).toEqual({ token: 'tok-123' });
    expect(posts[1].body).toEqual({ workspace_id: JOINED_WS });
    expect(screen.getByRole('link', { name: tr.invite.goHome })).toHaveAttribute('href', '/');
  });

  it('asks a visitor for a name and password, with a link to sign in', async () => {
    mockFetch({
      'GET /api/auth/me': withStatus(401, { code: 'UNAUTHENTICATED', message: 'no session', details: {} }),
    });
    renderAt('/invite/tok-123');
    expect(await screen.findByRole('heading', { level: 1, name: tr.invite.title })).toBeInTheDocument();
    expect(await screen.findByLabelText(tr.fields.display_name, { exact: false })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: tr.invite.loginLink })).toBeInTheDocument();
  });
});
