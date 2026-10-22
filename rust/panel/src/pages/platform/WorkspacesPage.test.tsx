import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import tr from '@/i18n/tr.json';
import { adminWorkspaces } from '@/test/fixtures';
import { mockFetch, renderAt } from '@/test/render';

describe('WorkspacesPage', () => {
  it('lists every workspace with its status actions', async () => {
    mockFetch({ 'GET /api/platform/workspaces': adminWorkspaces });
    renderAt('/platform/workspaces');
    expect(
      await screen.findByRole('heading', { level: 1, name: tr.platform.workspaces.title }),
    ).toBeInTheDocument();
    expect(await screen.findByText('alfa-atolye')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: tr.platform.workspaces.activate })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: tr.platform.workspaces.suspend })).toBeInTheDocument();
  });
});
