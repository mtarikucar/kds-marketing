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

describe('MarketingSidebar — three surfaces, nothing hidden', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    useSidebarPrefsStore.setState({ favorites: [], advancedOpen: false });
  });

  it('renders the three surfaces and drops the "More" disclosure entirely', () => {
    renderSidebar();
    // The 2026-08 surface merge: what used to be ~15 hubs (Contacts, Sales,
    // Calendar, Tasks, Payments…) is Home / Inbox / Growth Studio, so there is
    // nothing left to hide and no reason to make the user open a section.
    expect(screen.getByRole('link', { name: /^Home$/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Inbox$/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Growth Studio$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^More$/i })).not.toBeInTheDocument();
    // The retired hubs are gone from the RAIL — their pages moved into a
    // surface's sub-nav (navigation.test.ts freezes the full path set).
    for (const retired of [/^Contacts$/i, /^Sales$/i, /^Payments$/i, /^Tasks$/i]) {
      expect(screen.queryByRole('link', { name: retired })).not.toBeInTheDocument();
    }
    // Settings stays pinned at the bottom as its own area.
    expect(screen.getByRole('link', { name: /^Settings$/i })).toBeInTheDocument();
  });

  it('lands the Inbox surface on the first page the workspace may actually open', () => {
    // This manager has no entitlements, so /inbox itself (conversationAi) is
    // gated out. A rail item pointing at a page you cannot open is worse than
    // one pointing at the first you can — hence hubTarget's fallback.
    renderSidebar();
    expect(screen.getByRole('link', { name: /^Inbox$/i })).toHaveAttribute('href', '/leads');
  });

  it('surfaces a "Pinned" section for favorited hubs', () => {
    useSidebarPrefsStore.setState({ favorites: ['studio'], advancedOpen: false });
    renderSidebar();
    expect(screen.getByText(/^Pinned$/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Growth Studio$/i })).toBeInTheDocument();
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
