import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from 'i18next';
import '@/i18n/config';
import { useMarketingAuthStore, type MarketingUser } from '@/store/marketingAuthStore';
import { useCommandPaletteStore } from '@/store/commandPaletteStore';
import marketingApiModule from '../api/marketingApi';
import MarketingHeader from './MarketingHeader';

/**
 * The notification bell used to be a dead end: clicking a row marked it read
 * and nothing else, and every row rendered permanently unread because the
 * component read `n.read` while the API returns `isRead`.
 */
vi.mock('../api/marketingApi', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

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
  role: 'REP',
};

type Row = {
  id: string;
  title: string;
  message: string;
  isRead: boolean;
  createdAt: string;
  type?: string;
  metadata?: unknown;
};

function mockNotifications(rows: Row[]) {
  marketingApi.get.mockImplementation((url: string) => {
    if (url === '/notifications') return Promise.resolve({ data: rows });
    if (url === '/notifications/unread-count') return Promise.resolve({ data: { count: 1 } });
    return Promise.resolve({ data: {} });
  });
  marketingApi.patch.mockResolvedValue({ data: {} });
}

/** Renders the header over a tiny route table so navigation is observable. */
async function openBell() {
  useMarketingAuthStore.setState({
    user: USER,
    accessToken: 't',
    refreshToken: 'r',
    isAuthenticated: true,
  });
  useCommandPaletteStore.setState({ open: false });
  render(
    <MemoryRouter initialEntries={['/home']}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}
      >
        <MarketingHeader />
        <Routes>
          <Route path="/home" element={<div>HOME PROBE</div>} />
          <Route path="/tasks" element={<div>TASKS PROBE</div>} />
          <Route path="/leads/:id" element={<div>LEAD PROBE</div>} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByLabelText('Notifications'));
  return user;
}

describe('MarketingHeader — notification click', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    marketingApi.get.mockReset();
    marketingApi.patch.mockReset();
  });

  it('marks read AND navigates to the kind’s destination, closing the popover', async () => {
    mockNotifications([
      {
        id: 'n1',
        title: 'New task assigned',
        message: 'Call the restaurant',
        isRead: false,
        createdAt: new Date().toISOString(),
        type: 'TASK_ASSIGNED',
        metadata: { taskId: 't1' },
      },
    ]);
    const user = await openBell();

    await user.click(await screen.findByText('New task assigned'));

    expect(marketingApi.patch).toHaveBeenCalledWith('/notifications/n1/read');
    expect(await screen.findByText('TASKS PROBE')).toBeInTheDocument();
    // The popover must not stay open over the page it just navigated to.
    await waitFor(() => expect(screen.queryByText('New task assigned')).not.toBeInTheDocument());
  });

  it('a routeless kind still marks read but does not navigate anywhere invented', async () => {
    mockNotifications([
      {
        id: 'n2',
        title: 'Automation',
        message: 'A workflow ran',
        isRead: false,
        createdAt: new Date().toISOString(),
        type: 'WORKFLOW',
        // Rows written before the producer started stamping leadId carry no
        // metadata at all — there is nothing to open.
      },
    ]);
    const user = await openBell();

    await user.click(await screen.findByText('Automation'));

    expect(marketingApi.patch).toHaveBeenCalledWith('/notifications/n2/read');
    expect(screen.getByText('HOME PROBE')).toBeInTheDocument();
    expect(screen.queryByText('TASKS PROBE')).not.toBeInTheDocument();
    expect(screen.queryByText('LEAD PROBE')).not.toBeInTheDocument();
  });

  it('routes a lead-shaped notification to that lead', async () => {
    mockNotifications([
      {
        id: 'n3',
        title: 'Lead status updated',
        message: 'Pizza Place → WON',
        isRead: false,
        createdAt: new Date().toISOString(),
        type: 'INACTIVE_LEAD',
        metadata: { leadId: 'lead-7', from: 'NEW', to: 'WON' },
      },
    ]);
    const user = await openBell();

    await user.click(await screen.findByText('Lead status updated'));

    expect(await screen.findByText('LEAD PROBE')).toBeInTheDocument();
  });

  it('an already-read row renders read and re-marking it is not attempted', async () => {
    // Regression: the component read `n.read` while the API returns `isRead`,
    // so every row was permanently unread — the dot never cleared and each
    // click fired a redundant PATCH.
    mockNotifications([
      {
        id: 'n4',
        title: 'Automation',
        message: 'A workflow ran',
        isRead: true,
        createdAt: new Date().toISOString(),
        type: 'WORKFLOW',
      },
    ]);
    const user = await openBell();

    const row = await screen.findByText('Automation');
    expect(screen.queryByTestId('notification-unread-dot')).not.toBeInTheDocument();

    await user.click(row);

    expect(marketingApi.patch).not.toHaveBeenCalled();
  });

  it('an unread row still shows the unread dot', async () => {
    mockNotifications([
      {
        id: 'n5',
        title: 'Automation',
        message: 'A workflow ran',
        isRead: false,
        createdAt: new Date().toISOString(),
        type: 'WORKFLOW',
      },
    ]);
    await openBell();

    await screen.findByText('Automation');
    expect(screen.getByTestId('notification-unread-dot')).toBeInTheDocument();
  });
});
