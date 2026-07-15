import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from 'i18next';
import '@/i18n/config';
import { toast } from 'sonner';
import { useMarketingAuthStore, type MarketingUser } from '@/store/marketingAuthStore';
import { useCommandPaletteStore } from '@/store/commandPaletteStore';
import marketingApiModule from '../api/marketingApi';
import MarketingHeader from './MarketingHeader';

// Task 21 — the profile-menu "New workspace" affordance. This is the ONLY
// reachable path for a single-workspace user to create a 2nd workspace:
// WorkspaceSwitcher (top-bar) renders nothing when memberships.length <= 1,
// so this action must live in the ALWAYS-visible account menu instead.
vi.mock('../api/marketingApi', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
  },
}));

// The store's real `createWorkspace` action dynamic-imports this module at
// call time (see marketingAuthStore.ts) — mocking it here lets the test drive
// the REAL store action end-to-end while stubbing only the network edge.
vi.mock('../api/membershipApi', () => ({
  createWorkspaceApi: vi.fn(),
  fetchMemberships: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigateMock };
});

import { createWorkspaceApi, fetchMemberships } from '../api/membershipApi';

const marketingApi = vi.mocked(marketingApiModule, { deep: true }) as unknown as {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
};

const USER: MarketingUser = {
  id: 'u1',
  workspaceId: 'w1',
  email: 'ada@x.io',
  firstName: 'Ada',
  lastName: 'Lovelace',
  role: 'OWNER',
};

function makeQC() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function seedStore() {
  useMarketingAuthStore.setState({
    user: USER,
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    isAuthenticated: true,
    agencyReturn: null,
    // Single membership — the WorkspaceSwitcher-hidden case this affordance
    // exists to cover.
    memberships: [{ workspaceId: 'w1', workspaceName: 'Home Shop', role: 'OWNER' }],
  });
  useCommandPaletteStore.setState({ open: false });
}

async function renderHeaderAndOpenCreateWorkspace(qc: QueryClient) {
  seedStore();
  render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <MarketingHeader />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByText('Ada Lovelace'));
  await user.click(await screen.findByText(/new workspace/i));
  await screen.findByLabelText(/workspace name/i);
  return user;
}

describe('MarketingHeader — create workspace (self-serve second brand)', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    marketingApi.get.mockReset().mockResolvedValue({ data: {} });
    marketingApi.post.mockReset();
    marketingApi.patch.mockReset();
    vi.mocked(createWorkspaceApi).mockReset();
    vi.mocked(fetchMemberships).mockReset().mockResolvedValue([]);
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
    navigateMock.mockReset();
  });

  it('exposes a "New workspace" action in the ALWAYS-visible profile menu', async () => {
    seedStore();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <QueryClientProvider client={makeQC()}>
          <MarketingHeader />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    await user.click(screen.getByText('Ada Lovelace'));
    expect(await screen.findByText(/new workspace/i)).toBeInTheDocument();
  });

  it('submitting the dialog calls createWorkspace, clears the query cache, and navigates to /dashboard', async () => {
    vi.mocked(createWorkspaceApi).mockResolvedValue({
      user: { ...USER, workspaceId: 'ws-new', role: 'OWNER' },
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      workspace: { id: 'ws-new', name: 'Second Shop', slug: 'second-shop' },
    });
    const qc = makeQC();
    const clearSpy = vi.spyOn(qc, 'clear');
    const user = await renderHeaderAndOpenCreateWorkspace(qc);

    await user.type(screen.getByLabelText(/workspace name/i), 'Second Shop');
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() =>
      expect(createWorkspaceApi).toHaveBeenCalledWith({ workspaceName: 'Second Shop' }),
    );
    await waitFor(() => expect(clearSpy).toHaveBeenCalledTimes(1));
    expect(navigateMock).toHaveBeenCalledWith('/dashboard');
    expect(toast.success).toHaveBeenCalled();

    // The store's real createWorkspace action ran end-to-end — token swap
    // landed and the dialog closes (form unmounts) on success.
    expect(useMarketingAuthStore.getState().accessToken).toBe('new-access');
    expect(useMarketingAuthStore.getState().user?.workspaceId).toBe('ws-new');
    await waitFor(() =>
      expect(screen.queryByLabelText(/workspace name/i)).not.toBeInTheDocument(),
    );

    // switchWorkspace/createWorkspace must resolve BEFORE the cache is
    // cleared / navigation fires (same ordering WorkspaceSwitcher relies on).
    const createOrder = vi.mocked(createWorkspaceApi).mock.invocationCallOrder[0];
    const clearOrder = clearSpy.mock.invocationCallOrder[0];
    expect(createOrder).toBeLessThan(clearOrder);
  });

  it('rejects an empty workspace name locally without calling the API', async () => {
    const user = await renderHeaderAndOpenCreateWorkspace(makeQC());

    await user.click(screen.getByRole('button', { name: /^create$/i }));

    expect(await screen.findByText(/workspace name is required/i)).toBeInTheDocument();
    expect(createWorkspaceApi).not.toHaveBeenCalled();
  });

  it('surfaces an API error as a toast and keeps the dialog open', async () => {
    vi.mocked(createWorkspaceApi).mockRejectedValue({
      response: {
        status: 409,
        data: { message: 'That workspace name was just taken — try another' },
      },
    });
    const qc = makeQC();
    const clearSpy = vi.spyOn(qc, 'clear');
    const user = await renderHeaderAndOpenCreateWorkspace(qc);

    await user.type(screen.getByLabelText(/workspace name/i), 'Second Shop');
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('That workspace name was just taken — try another'),
    );
    expect(navigateMock).not.toHaveBeenCalled();
    expect(clearSpy).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/workspace name/i)).toBeInTheDocument();
  });
});
