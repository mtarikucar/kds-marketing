import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from 'i18next';
import '@/i18n/config';
import { useMarketingAuthStore, type MarketingUser } from '@/store/marketingAuthStore';
import SettingsLayout from './SettingsLayout';

const MANAGER: MarketingUser = {
  id: 'u1', workspaceId: 'w1', email: 'm@x.io', firstName: 'M', lastName: 'X', role: 'MANAGER',
};

function makeQC() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderSettings() {
  useMarketingAuthStore.setState({
    user: MANAGER, accessToken: 't', refreshToken: 'r', isAuthenticated: true,
  });
  return render(
    <MemoryRouter initialEntries={['/branding']}>
      <QueryClientProvider client={makeQC()}>
        <SettingsLayout>
          <div>child</div>
        </SettingsLayout>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('SettingsLayout — sub-grouping', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('renders labelled setting groups instead of one flat list', () => {
    renderSettings();
    expect(screen.getByText('Workspace')).toBeInTheDocument();
    expect(screen.getByText('Team & access')).toBeInTheDocument();
    expect(screen.getByText('Developer')).toBeInTheDocument();
  });
});
