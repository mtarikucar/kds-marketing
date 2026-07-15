import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigateMock };
});

const switchWorkspaceMock = vi.fn();
// Mutable store state read by the mocked selector hook below — tests mutate
// this directly rather than re-mocking the module per test.
let storeState: {
  memberships: { workspaceId: string; workspaceName: string; role: string }[];
  user: { workspaceId: string } | null;
  /** Non-null exactly while impersonating a sub-account. Omitted (undefined)
   *  in most tests, which the switcher's `!!s.agencyReturn` treats as falsy. */
  agencyReturn?: { user: { workspaceId: string }; refreshToken: string; locationName: string } | null;
};

vi.mock('../../../store/marketingAuthStore', () => ({
  useMarketingAuthStore: (selector: (s: typeof storeState & { switchWorkspace: typeof switchWorkspaceMock }) => unknown) =>
    selector({ ...storeState, switchWorkspace: switchWorkspaceMock }),
}));

import { WorkspaceSwitcher } from './WorkspaceSwitcher';

function renderSwitcher(qc = new QueryClient()) {
  const clearSpy = vi.spyOn(qc, 'clear');
  const result = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <WorkspaceSwitcher />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, clearSpy };
}

describe('WorkspaceSwitcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    switchWorkspaceMock.mockResolvedValue(undefined);
  });

  it('renders nothing when the user has a single membership', () => {
    storeState = {
      memberships: [{ workspaceId: 'ws1', workspaceName: 'WS One', role: 'OWNER' }],
      user: { workspaceId: 'ws1' },
    };
    const { container } = renderSwitcher();
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the user has no memberships', () => {
    storeState = { memberships: [], user: { workspaceId: 'ws1' } };
    const { container } = renderSwitcher();
    expect(container).toBeEmptyDOMElement();
  });

  it('renders one menu item per membership when there is more than one', async () => {
    storeState = {
      memberships: [
        { workspaceId: 'ws1', workspaceName: 'WS One', role: 'OWNER' },
        { workspaceId: 'ws2', workspaceName: 'WS Two', role: 'MANAGER' },
        { workspaceId: 'ws3', workspaceName: 'WS Three', role: 'REP' },
      ],
      user: { workspaceId: 'ws1' },
    };
    const user = userEvent.setup();
    renderSwitcher();

    // Trigger shows the ACTIVE workspace's name.
    expect(screen.getByRole('button', { name: /WS One/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /WS One/i }));
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    expect(screen.getAllByRole('menuitem')).toHaveLength(3);
    expect(screen.getByRole('menuitem', { name: /WS Two/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /WS Three/i })).toBeInTheDocument();
  });

  it('selecting a DIFFERENT workspace calls switchWorkspace(id) then clears the query cache and navigates to /dashboard', async () => {
    storeState = {
      memberships: [
        { workspaceId: 'ws1', workspaceName: 'WS One', role: 'OWNER' },
        { workspaceId: 'ws2', workspaceName: 'WS Two', role: 'MANAGER' },
      ],
      user: { workspaceId: 'ws1' },
    };
    const user = userEvent.setup();
    const { clearSpy } = renderSwitcher();

    await user.click(screen.getByRole('button', { name: /WS One/i }));
    await screen.findByRole('menu');
    await user.click(screen.getByRole('menuitem', { name: /WS Two/i }));

    expect(switchWorkspaceMock).toHaveBeenCalledWith('ws2');
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith('/dashboard');

    // switchWorkspace must resolve BEFORE the cache is cleared / navigation fires.
    const switchOrder = switchWorkspaceMock.mock.invocationCallOrder[0];
    const clearOrder = clearSpy.mock.invocationCallOrder[0];
    expect(switchOrder).toBeLessThan(clearOrder);
  });

  it('renders nothing while impersonating a sub-account, even with more than one membership', () => {
    storeState = {
      memberships: [
        { workspaceId: 'ws1', workspaceName: 'WS One', role: 'OWNER' },
        { workspaceId: 'ws2', workspaceName: 'WS Two', role: 'MANAGER' },
      ],
      user: { workspaceId: 'loc1' },
      agencyReturn: {
        user: { workspaceId: 'ws1' },
        refreshToken: 'stashed-refresh-token',
        locationName: 'Sub-account Location',
      },
    };
    const { container } = renderSwitcher();
    expect(container).toBeEmptyDOMElement();
  });

  it('selecting the CURRENT workspace is a no-op', async () => {
    storeState = {
      memberships: [
        { workspaceId: 'ws1', workspaceName: 'WS One', role: 'OWNER' },
        { workspaceId: 'ws2', workspaceName: 'WS Two', role: 'MANAGER' },
      ],
      user: { workspaceId: 'ws1' },
    };
    const user = userEvent.setup();
    const { clearSpy } = renderSwitcher();

    await user.click(screen.getByRole('button', { name: /WS One/i }));
    await screen.findByRole('menu');
    // Two menu items match /WS One/ once open: the active one in the list.
    await user.click(screen.getByRole('menuitem', { name: /WS One/i }));

    expect(switchWorkspaceMock).not.toHaveBeenCalled();
    expect(clearSpy).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
