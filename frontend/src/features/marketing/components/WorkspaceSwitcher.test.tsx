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
  /** `role` matters as of the sub-accounts group: `/agency/locations` is
   *  AGENCY-OWNER gated server-side, so only an OWNER is offered it. */
  user: { workspaceId: string; role?: string } | null;
  /** Non-null exactly while impersonating a sub-account. Omitted (undefined)
   *  in most tests, which the switcher's `!!s.agencyReturn` treats as falsy. */
  agencyReturn?: { user: { workspaceId: string }; refreshToken: string; locationName: string } | null;
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, d?: string) => (typeof d === 'string' ? d : k),
    i18n: { language: 'tr' },
  }),
}));

/**
 * The two agency reads, stubbed at the HOOK rather than at axios, because what
 * is under test is which of them the switcher RUNS.
 *
 * `useLocations`' `enabled` argument is itself part of the change: this header
 * mounts on every screen for every user, and `/agency/locations` is AGENCY-OWNER
 * gated, so an unconditional read would 403 once per session for the whole
 * product. `locationsEnabled` records what the component passed.
 */
const agency = vi.hoisted(() => ({
  isAgency: false,
  locations: [] as Array<{ id: string; name: string }>,
}));
const locationsEnabled = vi.hoisted(() => ({ value: undefined as boolean | undefined }));
const accessMutate = vi.hoisted(() => vi.fn());

vi.mock('../hooks/useWorkspaceProfile', () => ({
  useWorkspaceProfile: () => ({ isAgency: agency.isAgency }),
}));
vi.mock('../../../pages/marketing/agency/hooks', () => ({
  useLocations: (enabled?: boolean) => {
    locationsEnabled.value = enabled;
    return { data: enabled === false ? undefined : agency.locations };
  },
  useLocationMutations: () => ({ access: { mutate: accessMutate, isPending: false } }),
}));

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
    agency.isAgency = false;
    agency.locations = [];
    locationsEnabled.value = undefined;
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

  it('selecting a DIFFERENT workspace calls switchWorkspace(id) then clears the query cache and navigates to /home', async () => {
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
    expect(navigateMock).toHaveBeenCalledWith('/home');

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


/**
 * The daily agency act, moved out of the gear.
 *
 * A sub-account is NOT a membership — it is a separate workspace the agency
 * owner mints a session into — so the single-membership early return above hid
 * this control from exactly the operator who uses it most, leaving
 * `/agency/locations` (a SETTINGS-area page, i.e. the gear) as the only route to
 * a switch performed several times a day. Setting a sub-account up stays there;
 * switching in does not.
 */
describe('WorkspaceSwitcher — agency sub-accounts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    switchWorkspaceMock.mockResolvedValue(undefined);
    agency.isAgency = true;
    agency.locations = [
      { id: 'loc1', name: 'Kafe Şube' },
      { id: 'loc2', name: 'Butik Şube' },
    ];
    locationsEnabled.value = undefined;
    storeState = {
      memberships: [{ workspaceId: 'ws1', workspaceName: 'Ajans', role: 'OWNER' }],
      user: { workspaceId: 'ws1', role: 'OWNER' },
    };
  });

  it('renders for an agency owner even with the single membership that used to hide it', async () => {
    const user = userEvent.setup();
    renderSwitcher();

    await user.click(screen.getByRole('button', { name: /Ajans/i }));
    expect(await screen.findByText('Alt hesaplar')).toBeInTheDocument();
    expect(screen.getByTestId('switch-sub-account-loc1')).toHaveTextContent('Kafe Şube');
    expect(screen.getByTestId('switch-sub-account-loc2')).toBeInTheDocument();
  });

  it('switches in through the agency console’s OWN mutation rather than a copy of it', async () => {
    const user = userEvent.setup();
    renderSwitcher();

    await user.click(screen.getByRole('button', { name: /Ajans/i }));
    await user.click(await screen.findByTestId('switch-sub-account-loc1'));

    expect(accessMutate).toHaveBeenCalledWith({ id: 'loc1', name: 'Kafe Şube' });
    // Not the multi-workspace flow: the two session swaps must not tangle.
    expect(switchWorkspaceMock).not.toHaveBeenCalled();
  });

  /**
   * The guard that must survive untouched. Once inside a sub-account the banner
   * is the way back out, and offering a second session swap from in there would
   * have the two flows fighting over the same token slots in the store.
   */
  it('still renders nothing at all while impersonating', () => {
    storeState = {
      memberships: [{ workspaceId: 'ws1', workspaceName: 'Ajans', role: 'OWNER' }],
      user: { workspaceId: 'loc1', role: 'OWNER' },
      agencyReturn: {
        user: { workspaceId: 'ws1' },
        refreshToken: 'stashed-refresh-token',
        locationName: 'Kafe Şube',
      },
    };
    const { container } = renderSwitcher();
    expect(container).toBeEmptyDOMElement();
  });

  it('offers no sub-accounts to an agency MANAGER, whose read the server would refuse', async () => {
    const user = userEvent.setup();
    storeState = {
      memberships: [
        { workspaceId: 'ws1', workspaceName: 'Ajans', role: 'MANAGER' },
        { workspaceId: 'ws2', workspaceName: 'İkinci', role: 'MANAGER' },
      ],
      user: { workspaceId: 'ws1', role: 'MANAGER' },
    };
    renderSwitcher();

    // Positive anchor: the switcher IS up (two memberships), so the absence
    // below is about the role rather than about the component.
    await user.click(screen.getByRole('button', { name: /Ajans/i }));
    expect(await screen.findByText('Switch workspace')).toBeInTheDocument();
    expect(screen.queryByText('Alt hesaplar')).not.toBeInTheDocument();
    expect(locationsEnabled.value).toBe(false);
  });

  it('does not ask an ordinary workspace for the sub-accounts at all', () => {
    agency.isAgency = false;
    storeState = {
      memberships: [
        { workspaceId: 'ws1', workspaceName: 'WS One', role: 'OWNER' },
        { workspaceId: 'ws2', workspaceName: 'WS Two', role: 'OWNER' },
      ],
      user: { workspaceId: 'ws1', role: 'OWNER' },
    };
    renderSwitcher();

    expect(locationsEnabled.value).toBe(false);
    expect(screen.queryByText('Alt hesaplar')).not.toBeInTheDocument();
  });
});
