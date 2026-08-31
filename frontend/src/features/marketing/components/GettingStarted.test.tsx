import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from 'i18next';
import '@/i18n/config';
import { useMarketingAuthStore, type MarketingUser } from '@/store/marketingAuthStore';
import GettingStarted from './GettingStarted';

const MANAGER: MarketingUser = {
  id: 'u1', workspaceId: 'w1', email: 'm@x.io', firstName: 'M', lastName: 'X', role: 'MANAGER',
};

// Dismissal is server state now (Workspace.settings.onboarding), not a
// localStorage flag — it is a workspace fact, not a per-device opinion.
const getOnboarding = vi.fn();
const setOnboardingDismissed = vi.fn();
vi.mock('../api/onboarding.service', async () => {
  const actual = await vi.importActual<typeof import('../api/onboarding.service')>(
    '../api/onboarding.service',
  );
  return {
    ...actual,
    getOnboarding: () => getOnboarding(),
    setOnboardingDismissed: (d: boolean) => setOnboardingDismissed(d),
  };
});

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
    // A tiny stateful fake server: the mutation must actually change what a
    // subsequent read returns, because the hook invalidates and refetches after
    // every write. A mock that always replied "not dismissed" would make the
    // checklist reappear and hide a real regression behind a passing test.
    let dismissed = false;
    getOnboarding
      .mockReset()
      .mockImplementation(async () => ({
        dismissed,
        // The fourth step's own signals. Proven + autonomous here so these
        // cases keep being about the three they were written for.
        claudeLaneProven: true,
        mcpWriteMode: 'AUTONOMOUS',
      }));
    setOnboardingDismissed.mockReset().mockImplementation(async (next: boolean) => {
      dismissed = next;
      return { dismissed };
    });
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

  it('calls out the first outstanding step so there is one obvious next action', async () => {
    renderGS();
    const next = await screen.findByTestId('onboarding-next-step');
    expect(next).toHaveAttribute('href', '/onboarding/strategy');
  });

  it('hides on dismiss and persists that to the server', async () => {
    const user = userEvent.setup();
    renderGS();
    await screen.findByText('Invite your team');

    await user.click(screen.getByRole('button', { name: /Dismiss/i }));

    await waitFor(() =>
      expect(screen.queryByText('Invite your team')).not.toBeInTheDocument(),
    );
    // The whole point of the move off localStorage: the dismissal reaches the
    // workspace, so another device or teammate sees the same state.
    expect(setOnboardingDismissed).toHaveBeenCalledWith(true);
  });

  it('stays hidden when the workspace has already dismissed it elsewhere', async () => {
    getOnboarding.mockImplementation(async () => ({
      dismissed: true,
      claudeLaneProven: true,
      mcpWriteMode: 'AUTONOMOUS',
    }));
    renderGS();

    await waitFor(() => expect(getOnboarding).toHaveBeenCalled());
    expect(screen.queryByText('Invite your team')).not.toBeInTheDocument();
  });
});

/**
 * The fourth step, and the only one whose completion is PROOF rather than
 * intent.
 *
 * "A key exists" is the failure this step is built to avoid: a key with no
 * scheduled task behind it looks exactly like a working lane from every other
 * angle, so ticking the step for one would mean the checklist certifies the
 * broken setup it exists to prevent. `claudeLaneProven` is a real
 * `claim_research_job` having succeeded.
 */
describe('GettingStarted — connect your Claude', () => {
  const state = (over: Partial<Record<string, unknown>> = {}) => ({
    dismissed: false,
    claudeLaneProven: false,
    mcpWriteMode: 'AUTONOMOUS',
    ...over,
  });

  beforeEach(async () => {
    await i18n.changeLanguage('en');
    setOnboardingDismissed.mockReset().mockResolvedValue({ dismissed: true });
  });

  it('offers the step, pointed at the connector console', async () => {
    getOnboarding.mockReset().mockImplementation(async () => state());
    renderGS();

    const step = await screen.findByText('Connect your Claude');
    expect(step.closest('a')).toHaveAttribute('href', '/settings/mcp-console');
  });

  it('is NOT done until a research job was actually claimed', async () => {
    getOnboarding.mockReset().mockImplementation(async () => state({ claudeLaneProven: false }));
    renderGS();

    const title = await screen.findByText('Connect your Claude');
    expect(title.className).not.toMatch(/line-through/);
  });

  it('is done once one was', async () => {
    getOnboarding.mockReset().mockImplementation(async () => state({ claudeLaneProven: true }));
    renderGS();

    const title = await screen.findByText('Connect your Claude');
    expect(title.className).toMatch(/line-through/);
  });

  /**
   * Measured in v2.286.0: under APPROVAL the three Jeeta-keyed data tools are
   * not delayed, they are unusable, and the lane silently degrades to plain web
   * search. Somebody being walked through setup must be told BEFORE they
   * finish — afterwards it just looks like research found weak prospects.
   */
  it('warns about APPROVAL write mode, which makes the lane half-work', async () => {
    getOnboarding.mockReset().mockImplementation(async () => state({ mcpWriteMode: 'APPROVAL' }));
    renderGS();

    const warning = await screen.findByTestId('onboarding-warning-claude');
    expect(warning).toHaveTextContent(/google maps/i);
  });

  it('says nothing about it when the workspace is already autonomous', async () => {
    getOnboarding.mockReset().mockImplementation(async () => state({ mcpWriteMode: 'AUTONOMOUS' }));
    renderGS();

    await screen.findByText('Connect your Claude');
    expect(screen.queryByTestId('onboarding-warning-claude')).not.toBeInTheDocument();
  });
});
