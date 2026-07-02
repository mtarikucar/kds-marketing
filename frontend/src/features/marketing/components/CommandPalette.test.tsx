import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from 'i18next';
import '@/i18n/config';
import { useMarketingAuthStore, type MarketingUser } from '@/store/marketingAuthStore';
import { useCommandPaletteStore } from '@/store/commandPaletteStore';
import CommandPalette from './CommandPalette';

const MANAGER: MarketingUser = {
  id: 'u1', workspaceId: 'w1', email: 'm@x.io', firstName: 'M', lastName: 'X', role: 'MANAGER',
};

function makeQC() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}

function renderPalette() {
  useMarketingAuthStore.setState({
    user: MANAGER, accessToken: 't', refreshToken: 'r', isAuthenticated: true,
  });
  useCommandPaletteStore.setState({ open: true });
  const qc = makeQC();
  return render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <QueryClientProvider client={qc}>
        <CommandPalette />
        <LocationProbe />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('CommandPalette', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });
  afterEach(() => useCommandPaletteStore.setState({ open: false }));

  it('opens with a search combobox', async () => {
    renderPalette();
    expect(await screen.findByRole('combobox')).toBeInTheDocument();
  });

  it('filters by typing and navigates to the destination on Enter', async () => {
    const user = userEvent.setup();
    renderPalette();
    const input = await screen.findByRole('combobox');
    await user.type(input, 'Leads');
    expect(screen.getByRole('option', { name: /Leads/i })).toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('loc')).toHaveTextContent('/leads');
  });

  it('runs the highlighted quick action after ArrowDown', async () => {
    const user = userEvent.setup();
    renderPalette();
    await screen.findByRole('combobox');
    // Empty query: quick actions come first; active row 0 is "New lead",
    // ArrowDown moves to "New task".
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('loc')).toHaveTextContent('/tasks?create=1');
  });

  it('shows an empty state when nothing matches', async () => {
    const user = userEvent.setup();
    renderPalette();
    const input = await screen.findByRole('combobox');
    await user.type(input, 'zzzznomatchzzz');
    expect(screen.getByText(/No results/i)).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    renderPalette();
    await screen.findByRole('combobox');
    await user.keyboard('{Escape}');
    expect(useCommandPaletteStore.getState().open).toBe(false);
  });
});
