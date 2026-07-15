import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useMarketingAuthStore, type MarketingUser } from './marketingAuthStore';

// switchWorkspace pulls membershipApi in via a dynamic import() (to dodge a
// circular-import cycle — membershipApi -> marketingApi -> this store).
// vi.mock intercepts dynamic imports the same as static ones, so this still
// lets us stub both functions the action depends on.
vi.mock('../features/marketing/api/membershipApi', () => ({
  switchWorkspaceApi: vi.fn(),
  fetchMemberships: vi.fn(),
  createWorkspaceApi: vi.fn(),
}));

import {
  switchWorkspaceApi,
  fetchMemberships,
  createWorkspaceApi,
} from '../features/marketing/api/membershipApi';

const baseUser: MarketingUser = {
  id: 'u1',
  workspaceId: 'ws1',
  email: 'a@b.com',
  firstName: 'A',
  lastName: 'B',
  role: 'OWNER',
};

const initialState = useMarketingAuthStore.getState();

describe('marketingAuthStore — switchWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useMarketingAuthStore.setState(
      {
        ...initialState,
        user: baseUser,
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        isAuthenticated: true,
        agencyReturn: null,
        memberships: [],
      },
      true,
    );
  });

  afterEach(() => {
    useMarketingAuthStore.setState(initialState, true);
  });

  it('swaps the token pair and updates user.workspaceId/role from the switch response', async () => {
    vi.mocked(switchWorkspaceApi).mockResolvedValue({
      user: { ...baseUser, workspaceId: 'ws2', role: 'MANAGER' },
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
    });
    vi.mocked(fetchMemberships).mockResolvedValue([
      { workspaceId: 'ws1', workspaceName: 'WS One', role: 'OWNER' },
      { workspaceId: 'ws2', workspaceName: 'WS Two', role: 'MANAGER' },
    ]);

    await useMarketingAuthStore.getState().switchWorkspace('ws2');

    expect(switchWorkspaceApi).toHaveBeenCalledWith('ws2');

    const state = useMarketingAuthStore.getState();
    expect(state.accessToken).toBe('new-access');
    expect(state.refreshToken).toBe('new-refresh');
    expect(state.user?.workspaceId).toBe('ws2');
    expect(state.user?.role).toBe('MANAGER');
    // Other user fields (identity) are preserved by the merge, not clobbered.
    expect(state.user?.email).toBe(baseUser.email);
    expect(state.user?.id).toBe(baseUser.id);
  });

  it('does NOT touch agencyReturn when it was null before the switch (a switch is not impersonation)', async () => {
    vi.mocked(switchWorkspaceApi).mockResolvedValue({
      user: { ...baseUser, workspaceId: 'ws2', role: 'MANAGER' },
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
    });
    vi.mocked(fetchMemberships).mockResolvedValue([]);

    expect(useMarketingAuthStore.getState().agencyReturn).toBeNull();
    await useMarketingAuthStore.getState().switchWorkspace('ws2');
    expect(useMarketingAuthStore.getState().agencyReturn).toBeNull();
  });

  it('does NOT clear or replace an existing agencyReturn stash (leaves the agency-impersonation state exactly as-is)', async () => {
    const stash = {
      user: { ...baseUser, id: 'agency-owner' },
      refreshToken: 'agency-refresh',
      locationName: 'Some Sub-Account',
    };
    useMarketingAuthStore.setState({ agencyReturn: stash });

    vi.mocked(switchWorkspaceApi).mockResolvedValue({
      user: { ...baseUser, workspaceId: 'ws2', role: 'MANAGER' },
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
    });
    vi.mocked(fetchMemberships).mockResolvedValue([]);

    await useMarketingAuthStore.getState().switchWorkspace('ws2');

    // Untouched — same stash, still present, not cleared like login()/logout() do.
    expect(useMarketingAuthStore.getState().agencyReturn).toEqual(stash);
  });

  it('resolves even when fetchMemberships() rejects after a successful token swap (best-effort refresh)', async () => {
    vi.mocked(switchWorkspaceApi).mockResolvedValue({
      user: { ...baseUser, workspaceId: 'ws2', role: 'MANAGER' },
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
    });
    vi.mocked(fetchMemberships).mockRejectedValue(new Error('profile fetch failed'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      useMarketingAuthStore.getState().switchWorkspace('ws2'),
    ).resolves.toBeUndefined();

    // The token swap already committed — that must not be undone by the
    // membership-refresh failure.
    const state = useMarketingAuthStore.getState();
    expect(state.accessToken).toBe('new-access');
    expect(state.refreshToken).toBe('new-refresh');
    expect(state.user?.workspaceId).toBe('ws2');
    warnSpy.mockRestore();
  });

  it('refreshes memberships from fetchMemberships() after a successful switch', async () => {
    vi.mocked(switchWorkspaceApi).mockResolvedValue({
      user: { ...baseUser, workspaceId: 'ws2', role: 'MANAGER' },
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
    });
    const memberships = [
      { workspaceId: 'ws1', workspaceName: 'WS One', role: 'OWNER' },
      { workspaceId: 'ws2', workspaceName: 'WS Two', role: 'MANAGER' },
    ];
    vi.mocked(fetchMemberships).mockResolvedValue(memberships);

    await useMarketingAuthStore.getState().switchWorkspace('ws2');

    expect(fetchMemberships).toHaveBeenCalledTimes(1);
    expect(useMarketingAuthStore.getState().memberships).toEqual(memberships);
  });
});

describe('marketingAuthStore — createWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useMarketingAuthStore.setState(
      {
        ...initialState,
        user: baseUser,
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        isAuthenticated: true,
        agencyReturn: null,
        memberships: [],
      },
      true,
    );
  });

  afterEach(() => {
    useMarketingAuthStore.setState(initialState, true);
  });

  it('swaps the token pair and updates user.workspaceId/role from the create response', async () => {
    vi.mocked(createWorkspaceApi).mockResolvedValue({
      user: { ...baseUser, workspaceId: 'ws-new', role: 'OWNER' },
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      workspace: { id: 'ws-new', name: 'Second Shop', slug: 'second-shop' },
    });
    vi.mocked(fetchMemberships).mockResolvedValue([
      { workspaceId: 'ws1', workspaceName: 'WS One', role: 'OWNER' },
      { workspaceId: 'ws-new', workspaceName: 'Second Shop', role: 'OWNER' },
    ]);

    const workspace = await useMarketingAuthStore
      .getState()
      .createWorkspace({ workspaceName: 'Second Shop' });

    expect(createWorkspaceApi).toHaveBeenCalledWith({ workspaceName: 'Second Shop' });
    expect(workspace).toEqual({ id: 'ws-new', name: 'Second Shop', slug: 'second-shop' });

    const state = useMarketingAuthStore.getState();
    expect(state.accessToken).toBe('new-access');
    expect(state.refreshToken).toBe('new-refresh');
    expect(state.user?.workspaceId).toBe('ws-new');
    expect(state.user?.role).toBe('OWNER');
    // Other user fields (identity) are preserved by the merge, not clobbered.
    expect(state.user?.email).toBe(baseUser.email);
    expect(state.user?.id).toBe(baseUser.id);
  });

  it('does NOT touch agencyReturn (creating a workspace is not impersonation)', async () => {
    vi.mocked(createWorkspaceApi).mockResolvedValue({
      user: { ...baseUser, workspaceId: 'ws-new', role: 'OWNER' },
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      workspace: { id: 'ws-new', name: 'Second Shop', slug: 'second-shop' },
    });
    vi.mocked(fetchMemberships).mockResolvedValue([]);

    expect(useMarketingAuthStore.getState().agencyReturn).toBeNull();
    await useMarketingAuthStore.getState().createWorkspace({ workspaceName: 'Second Shop' });
    expect(useMarketingAuthStore.getState().agencyReturn).toBeNull();
  });

  it('resolves even when fetchMemberships() rejects after a successful create (best-effort refresh)', async () => {
    vi.mocked(createWorkspaceApi).mockResolvedValue({
      user: { ...baseUser, workspaceId: 'ws-new', role: 'OWNER' },
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      workspace: { id: 'ws-new', name: 'Second Shop', slug: 'second-shop' },
    });
    vi.mocked(fetchMemberships).mockRejectedValue(new Error('profile fetch failed'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      useMarketingAuthStore.getState().createWorkspace({ workspaceName: 'Second Shop' }),
    ).resolves.toEqual({ id: 'ws-new', name: 'Second Shop', slug: 'second-shop' });

    // The token swap already committed — that must not be undone by the
    // membership-refresh failure.
    const state = useMarketingAuthStore.getState();
    expect(state.accessToken).toBe('new-access');
    expect(state.refreshToken).toBe('new-refresh');
    expect(state.user?.workspaceId).toBe('ws-new');
    warnSpy.mockRestore();
  });

  it('refreshes memberships from fetchMemberships() after a successful create', async () => {
    vi.mocked(createWorkspaceApi).mockResolvedValue({
      user: { ...baseUser, workspaceId: 'ws-new', role: 'OWNER' },
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      workspace: { id: 'ws-new', name: 'Second Shop', slug: 'second-shop' },
    });
    const memberships = [
      { workspaceId: 'ws1', workspaceName: 'WS One', role: 'OWNER' },
      { workspaceId: 'ws-new', workspaceName: 'Second Shop', role: 'OWNER' },
    ];
    vi.mocked(fetchMemberships).mockResolvedValue(memberships);

    await useMarketingAuthStore.getState().createWorkspace({ workspaceName: 'Second Shop' });

    expect(fetchMemberships).toHaveBeenCalledTimes(1);
    expect(useMarketingAuthStore.getState().memberships).toEqual(memberships);
  });
});

describe('marketingAuthStore — login/logout reset memberships', () => {
  beforeEach(() => {
    useMarketingAuthStore.setState(initialState, true);
  });

  afterEach(() => {
    useMarketingAuthStore.setState(initialState, true);
  });

  it('login() clears any stale membership list from a previous session', () => {
    useMarketingAuthStore.setState({
      memberships: [{ workspaceId: 'stale', workspaceName: 'Stale', role: 'OWNER' }],
    });
    useMarketingAuthStore.getState().login(baseUser, 'at', 'rt');
    expect(useMarketingAuthStore.getState().memberships).toEqual([]);
  });

  it('setMemberships() replaces the membership list wholesale', () => {
    const list = [{ workspaceId: 'ws1', workspaceName: 'WS One', role: 'OWNER' }];
    useMarketingAuthStore.getState().setMemberships(list);
    expect(useMarketingAuthStore.getState().memberships).toEqual(list);
  });

  it('logout() clears the membership list', () => {
    useMarketingAuthStore.setState({
      memberships: [{ workspaceId: 'ws1', workspaceName: 'WS One', role: 'OWNER' }],
    });
    useMarketingAuthStore.getState().logout();
    expect(useMarketingAuthStore.getState().memberships).toEqual([]);
  });
});
