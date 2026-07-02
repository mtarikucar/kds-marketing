import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from 'i18next';
import '@/i18n/config';
import { useMarketingAuthStore, type MarketingUser } from '@/store/marketingAuthStore';

const patchMock = vi.hoisted(() => vi.fn());
vi.mock('../../../../features/marketing/api/marketingApi', () => ({
  default: { patch: patchMock, get: vi.fn() },
}));

import ModulesPage from './index';

const OWNER: MarketingUser = {
  id: 'u1', workspaceId: 'w1', email: 'o@x.io', firstName: 'O', lastName: 'X', role: 'OWNER',
};

function makeQC() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['marketing', 'billing', 'summary'], {
    entitlements: {
      features: { telephony: true, campaigns: false },
      entitledModules: ['telephony', 'campaigns'],
    },
  });
  return qc;
}

function renderPage() {
  useMarketingAuthStore.setState({
    user: OWNER, accessToken: 't', refreshToken: 'r', isAuthenticated: true,
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={makeQC()}>
        <ModulesPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('ModulesPage', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    patchMock.mockReset();
    patchMock.mockResolvedValue({ data: { activatedModules: [] } });
  });

  it('lists the entitled modules, each with a toggle', () => {
    renderPage();
    expect(screen.getByText('Phone & calls')).toBeInTheDocument();
    expect(screen.getByText('Campaigns')).toBeInTheDocument();
    expect(screen.getAllByRole('switch').length).toBe(2);
  });

  it('PATCHes /billing/modules with the new active set when a module is toggled', async () => {
    const user = userEvent.setup();
    renderPage();
    // Turn a module off — the page recomputes and PATCHes the active-module set.
    await user.click(screen.getAllByRole('switch')[0]);
    expect(patchMock).toHaveBeenCalledWith(
      '/billing/modules',
      expect.objectContaining({ activatedModules: expect.any(Array) }),
    );
  });
});
