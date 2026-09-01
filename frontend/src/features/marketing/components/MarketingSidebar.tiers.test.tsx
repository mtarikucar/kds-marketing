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

const REP: MarketingUser = { ...MANAGER, id: 'u2', email: 'r@x.io', role: 'REP' };

function renderSidebar(user: MarketingUser = MANAGER) {
  useMarketingAuthStore.setState({
    user, accessToken: 't', refreshToken: 'r', isAuthenticated: true,
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

  it('lands the Inbox surface on a page every workspace may open', () => {
    // Until 2026-08-30 this assertion was hubTarget's FALLBACK doing the work:
    // the surface's first child was /inbox (conversationAi), so an unentitled
    // manager had to be re-aimed at the next page they could open. /inbox is an
    // alias of the ungated /leads now and no longer a menu entry, so the FIRST
    // child is already the answer — for everyone, entitled or not. The rail can
    // no longer point at a page you cannot open.
    renderSidebar();
    expect(screen.getByRole('link', { name: /^Inbox$/i })).toHaveAttribute('href', '/leads');
  });

  it('offers the person surface once, under one name', () => {
    renderSidebar();
    // The rail renders SURFACES, so "Inbox" here is the surface, not a page.
    // What must not come back is a second door to the same page: /inbox has no
    // link of its own anywhere in the chrome.
    expect(document.querySelectorAll('a[href="/inbox"]')).toHaveLength(0);
    expect(screen.getByRole('link', { name: /^Inbox$/i })).toHaveAttribute('href', '/leads');
  });

  it("aims a rep's Growth Studio rail item at Growth Studio", () => {
    // The user-visible symptom of the gate this change removed. `hubTarget`
    // reads the first SURVIVING child of a pathless hub, so while /studio was
    // managerOnly the rail rendered an item labelled "Growth Studio" whose href
    // was /reports — the label and the destination naming two different pages.
    renderSidebar(REP);
    expect(screen.getByRole('link', { name: /^Growth Studio$/i })).toHaveAttribute('href', '/studio');
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
