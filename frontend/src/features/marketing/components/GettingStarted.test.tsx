import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from 'i18next';
import '@/i18n/config';
import { useMarketingAuthStore, type MarketingUser } from '@/store/marketingAuthStore';
import { useOnboardingStore } from '@/store/onboardingStore';
import GettingStarted from './GettingStarted';

const MANAGER: MarketingUser = {
  id: 'u1', workspaceId: 'w1', email: 'm@x.io', firstName: 'M', lastName: 'X', role: 'MANAGER',
};

function makeQC() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderGS() {
  useMarketingAuthStore.setState({
    user: MANAGER, accessToken: 't', refreshToken: 'r', isAuthenticated: true,
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={makeQC()}>
        <GettingStarted />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('GettingStarted', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    useOnboardingStore.setState({ dismissed: {} });
  });

  it('renders the checklist including the invite-team step', async () => {
    renderGS();
    expect(await screen.findByText('Invite your team')).toBeInTheDocument();
  });

  it('leads with the growth-strategy step, deep-linked to onboarding', async () => {
    renderGS();
    const strategyLink = await screen.findByText('Build your growth strategy');
    expect(strategyLink).toBeInTheDocument();
    // The step links to the Strategy onboarding flow.
    expect(strategyLink.closest('a')).toHaveAttribute('href', '/onboarding/strategy');
    // …and it's the FIRST step (the brain that drives the rest).
    const titles = screen.getAllByText(
      /Build your growth strategy|Create your first AI agent|Invite your team/,
    );
    expect(titles[0]).toHaveTextContent('Build your growth strategy');
  });

  it('hides on dismiss and reappears on reopen', async () => {
    const user = userEvent.setup();
    renderGS();
    await screen.findByText('Invite your team');
    await user.click(screen.getByRole('button', { name: /Dismiss/i }));
    await waitFor(() =>
      expect(screen.queryByText('Invite your team')).not.toBeInTheDocument(),
    );
    act(() => useOnboardingStore.getState().reopen('w1'));
    expect(await screen.findByText('Invite your team')).toBeInTheDocument();
  });
});
