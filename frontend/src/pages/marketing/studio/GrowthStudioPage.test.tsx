import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import GrowthStudioPage from './GrowthStudioPage';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, o?: string) => (typeof o === 'string' ? o : k), i18n: { language: 'en' } }) }));
// Stub the heavy tab pages so the shell renders in isolation.
const stub = { default: () => null };
vi.mock('./StudioCalendarTab', () => stub);
vi.mock('../budget/BudgetAutopilotPage', () => stub);
vi.mock('../trends/TrendsPage', () => stub);
vi.mock('../CampaignsPage', () => stub);
vi.mock('../socialCampaigns/SocialCampaignsPage', () => stub);
vi.mock('../social', () => stub);
vi.mock('../emailTemplates', () => stub);
vi.mock('../triggerLinks', () => stub);
vi.mock('../ReviewsPage', () => stub);
vi.mock('../affiliate-portal/AffiliatePortalPage', () => stub);
// The wizard dialog has its own tests; here only its mount matters.
vi.mock('../budget/EnableAutopilotWizard', () => ({
  EnableAutopilotWizard: ({ open }: { open: boolean }) => (open ? <div>wizard-open</div> : null),
}));

function renderAt(path: string) {
  return render(<MemoryRouter initialEntries={[path]}><GrowthStudioPage /></MemoryRouter>);
}

describe('GrowthStudioPage', () => {
  it('renders the five unified tabs', () => {
    renderAt('/studio');
    for (const label of ['Content Calendar', 'Campaigns', 'Trends', 'Autopilot', 'More']) {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
    }
  });

  it('honors the ?tab= deep link (budget selected)', () => {
    renderAt('/studio?tab=budget');
    expect(screen.getByRole('tab', { name: 'Autopilot' })).toHaveAttribute('data-state', 'active');
  });

  it('honors the nested ?sub= deep link inside Campaigns', () => {
    renderAt('/studio?tab=campaigns&sub=planner');
    expect(screen.getByRole('tab', { name: 'Social Planner' })).toHaveAttribute('data-state', 'active');
  });

  it('honors the nested ?sub= deep link inside More', () => {
    renderAt('/studio?tab=more&sub=reviews');
    expect(screen.getByRole('tab', { name: 'Reviews' })).toHaveAttribute('data-state', 'active');
  });

  it('writes ?sub= to the URL when a nested tab is clicked (deep-linkable)', async () => {
    const user = userEvent.setup();
    renderAt('/studio?tab=campaigns');
    await user.click(screen.getByRole('tab', { name: 'Social Planner' }));
    expect(screen.getByRole('tab', { name: 'Social Planner' })).toHaveAttribute('data-state', 'active');
  });

  it('offers the Enable Autopilot header CTA that opens the wizard', async () => {
    const user = userEvent.setup();
    renderAt('/studio');
    await user.click(screen.getByRole('button', { name: 'Enable Autopilot' }));
    expect(screen.getByText('wizard-open')).toBeInTheDocument();
  });
});
