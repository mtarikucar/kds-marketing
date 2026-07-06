import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import GrowthStudioPage from './GrowthStudioPage';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, o?: string) => (typeof o === 'string' ? o : k), i18n: { language: 'en' } }) }));
// Stub the heavy surfaces so the shell renders in isolation. The Autopilot
// console is the default body; the rest are the behind-"Manual tools" surface.
const stub = { default: () => <div>autopilot-console</div> };
vi.mock('../budget/BudgetAutopilotPage', () => stub);
const nul = { default: () => null };
vi.mock('./StudioCalendarTab', () => nul);
vi.mock('../trends/TrendsPage', () => nul);
vi.mock('../CampaignsPage', () => nul);
vi.mock('../socialCampaigns/SocialCampaignsPage', () => nul);
vi.mock('../social', () => nul);
vi.mock('../social/AiStudioPage', () => nul);
vi.mock('../personas/PersonasPage', () => nul);
vi.mock('../emailTemplates', () => nul);
vi.mock('../ReviewsPage', () => nul);
vi.mock('../affiliate-portal/AffiliatePortalPage', () => nul);

function renderAt(path: string) {
  return render(<MemoryRouter initialEntries={[path]}><GrowthStudioPage /></MemoryRouter>);
}

// 2026-07 radical reshape: /studio IS the Growth Autopilot console by default.
// The old 6-tab hub is gone from the front door — manual tools live behind a
// single "Manual tools" button (?view=tools), deep-links preserved.
describe('GrowthStudioPage — Autopilot-first', () => {
  it('renders the Autopilot console by default (no tab bar at the top)', async () => {
    renderAt('/studio');
    expect(await screen.findByText('autopilot-console')).toBeInTheDocument();
    // No page-level tabs on the front door.
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    // The one affordance to the manual tools.
    expect(screen.getByRole('button', { name: 'Manual tools' })).toBeInTheDocument();
  });

  it('legacy ?tab=budget still lands on the Autopilot console (tab param ignored on the front door)', async () => {
    renderAt('/studio?tab=budget');
    expect(await screen.findByText('autopilot-console')).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  it('"Manual tools" opens the advanced surface with the 5 tool tabs', async () => {
    const user = userEvent.setup();
    renderAt('/studio');
    await user.click(screen.getByRole('button', { name: 'Manual tools' }));
    for (const label of ['Content Calendar', 'Create', 'Campaigns', 'Trends', 'More']) {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
    }
    // Autopilot is NOT one of the tool tabs anymore — it's the whole page.
    expect(screen.queryByRole('tab', { name: 'Autopilot' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to Autopilot' })).toBeInTheDocument();
  });

  it('honors the ?view=tools deep link and its nested ?tab=/?sub=', () => {
    renderAt('/studio?view=tools&tab=campaigns&sub=planner');
    expect(screen.getByRole('tab', { name: 'Campaigns', selected: true })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Social Planner' })).toHaveAttribute('data-state', 'active');
  });

  it('honors ?view=tools&tab=create defaulting to the AI Studio sub-tab', () => {
    renderAt('/studio?view=tools&tab=create');
    expect(screen.getByRole('tab', { name: 'AI Studio' })).toHaveAttribute('data-state', 'active');
  });

  it('More (in tools) offers Email/Reviews/Affiliates, not Trigger Links', () => {
    renderAt('/studio?view=tools&tab=more');
    expect(screen.queryByRole('tab', { name: 'Trigger Links' })).not.toBeInTheDocument();
    for (const label of ['Email Templates', 'Reviews', 'Affiliates']) {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
    }
  });

  it('"Back to Autopilot" returns to the console', async () => {
    const user = userEvent.setup();
    renderAt('/studio?view=tools&tab=trends');
    await user.click(screen.getByRole('button', { name: 'Back to Autopilot' }));
    expect(await screen.findByText('autopilot-console')).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });
});
