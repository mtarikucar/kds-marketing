import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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

function renderSidebar(props: { forceExpanded?: boolean }) {
  useMarketingAuthStore.setState({
    user: MANAGER, accessToken: 't', refreshToken: 'r', isAuthenticated: true,
  });
  return render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <QueryClientProvider client={makeQC()}>
        <MarketingSidebar {...props} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('MarketingSidebar — mobile drawer expansion', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    useSidebarPrefsStore.setState({ favorites: [], advancedOpen: false });
    localStorage.setItem('kds-sidebar-collapsed', '1'); // desktop "collapsed" pref
  });

  it('honours the collapsed preference by default (icon rail)', () => {
    renderSidebar({});
    expect(screen.getByRole('complementary').className).toMatch(/w-16/);
  });

  it('forces an expanded, labelled rail when rendered inside the drawer', () => {
    renderSidebar({ forceExpanded: true });
    const aside = screen.getByRole('complementary');
    expect(aside.className).toMatch(/w-64/);
    expect(aside.className).not.toMatch(/w-16/);
  });
});
