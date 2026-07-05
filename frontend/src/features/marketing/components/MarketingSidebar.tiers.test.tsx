import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from 'i18next';
import '@/i18n/config';
import { useMarketingAuthStore, type MarketingUser } from '@/store/marketingAuthStore';
import { useSidebarPrefsStore } from '@/store/sidebarPrefsStore';
import MarketingSidebar from './MarketingSidebar';

const MANAGER: MarketingUser = {
  id: 'u1', workspaceId: 'w1', email: 'm@x.io', firstName: 'M', lastName: 'X', role: 'MANAGER',
};

function makeQC() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderSidebar() {
  useMarketingAuthStore.setState({
    user: MANAGER, accessToken: 't', refreshToken: 'r', isAuthenticated: true,
  });
  return render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <QueryClientProvider client={makeQC()}>
        <MarketingSidebar />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('MarketingSidebar — progressive disclosure', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    useSidebarPrefsStore.setState({ favorites: [], advancedOpen: false });
  });

  it('hides advanced hubs behind "More" while core hubs stay visible', () => {
    renderSidebar();
    // Core hub is directly visible…
    expect(screen.getByRole('link', { name: /Contacts/i })).toBeInTheDocument();
    // …the "More" disclosure exists…
    expect(screen.getByRole('button', { name: /^More$/i })).toBeInTheDocument();
    // …and an advanced hub (Payments) is not rendered until expanded.
    // (Growth Studio is CORE — the product's flagship surface — so it must
    // NOT hide behind More; that promotion is asserted in navigation.test.ts.)
    expect(screen.queryByRole('link', { name: /^Payments$/i })).not.toBeInTheDocument();
    // Growth Studio, being core, is always directly visible.
    expect(screen.getByRole('link', { name: /^Growth Studio$/i })).toBeInTheDocument();
  });

  it('reveals advanced hubs when "More" is expanded', async () => {
    const user = userEvent.setup();
    renderSidebar();
    await user.click(screen.getByRole('button', { name: /^More$/i }));
    expect(screen.getByRole('link', { name: /^Payments$/i })).toBeInTheDocument();
  });

  it('surfaces a "Pinned" section for favorited hubs', () => {
    useSidebarPrefsStore.setState({ favorites: ['sales'], advancedOpen: false });
    renderSidebar();
    expect(screen.getByText(/^Pinned$/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Sales/i })).toBeInTheDocument();
  });

  it('pins a hub to favorites when its star is clicked', async () => {
    const user = userEvent.setup();
    renderSidebar();
    const pinButtons = screen.getAllByRole('button', { name: /^Pin$/i });
    expect(pinButtons.length).toBeGreaterThan(0);
    await user.click(pinButtons[0]);
    expect(useSidebarPrefsStore.getState().favorites.length).toBe(1);
  });
});
