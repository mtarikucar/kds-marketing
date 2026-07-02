import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from 'i18next';
import '@/i18n/config';
import { useMarketingAuthStore, type MarketingUser } from '@/store/marketingAuthStore';
import { useCommandPaletteStore } from '@/store/commandPaletteStore';
import MarketingHeader from './MarketingHeader';

const MANAGER: MarketingUser = {
  id: 'u1', workspaceId: 'w1', email: 'm@x.io', firstName: 'M', lastName: 'X', role: 'MANAGER',
};

function makeQC() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderHeader() {
  useMarketingAuthStore.setState({
    user: MANAGER, accessToken: 't', refreshToken: 'r', isAuthenticated: true,
  });
  useCommandPaletteStore.setState({ open: false });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={makeQC()}>
        <MarketingHeader />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('MarketingHeader quick actions', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    useCommandPaletteStore.setState({ open: false });
  });

  it('opens the command palette from the search affordance', async () => {
    const user = userEvent.setup();
    renderHeader();
    const searchButtons = screen.getAllByRole('button', { name: /search/i });
    await user.click(searchButtons[0]);
    expect(useCommandPaletteStore.getState().open).toBe(true);
  });

  it('lists the quick-create actions in the "+ Create" menu', async () => {
    const user = userEvent.setup();
    renderHeader();
    await user.click(screen.getByRole('button', { name: /create/i }));
    expect(await screen.findByText(/New lead/i)).toBeInTheDocument();
    expect(screen.getByText(/New task/i)).toBeInTheDocument();
    expect(screen.getByText(/New opportunity/i)).toBeInTheDocument();
    expect(screen.getByText(/New company/i)).toBeInTheDocument();
  });

  it('renders a mobile menu button wired to onMenuClick', async () => {
    const user = userEvent.setup();
    const onMenuClick = vi.fn();
    useMarketingAuthStore.setState({
      user: MANAGER, accessToken: 't', refreshToken: 'r', isAuthenticated: true,
    });
    render(
      <MemoryRouter>
        <QueryClientProvider client={makeQC()}>
          <MarketingHeader onMenuClick={onMenuClick} />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: /open menu/i }));
    expect(onMenuClick).toHaveBeenCalled();
  });
});
