import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import tr from '@/i18n/tr.json';
import { me } from '@/test/fixtures';
import { mockFetch, renderAt, withStatus } from '@/test/render';

describe('AcceptInvitePage', () => {
  it('offers a signed-in user to accept the invite', async () => {
    mockFetch({ 'GET /api/auth/me': me });
    renderAt('/invite/tok-123');
    expect(await screen.findByRole('heading', { level: 1, name: tr.invite.title })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: tr.invite.accept })).toBeInTheDocument();
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
