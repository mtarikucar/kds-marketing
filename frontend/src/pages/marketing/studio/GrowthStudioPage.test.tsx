import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import GrowthStudioPage from './GrowthStudioPage';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, o?: string) => (typeof o === 'string' ? o : k) }) }));
// Stub the heavy tab pages so the shell renders in isolation.
const stub = { default: () => null };
vi.mock('../contentCalendar/ContentCalendarPage', () => stub);
vi.mock('../budget/BudgetAutopilotPage', () => stub);
vi.mock('../trends/TrendsPage', () => stub);
vi.mock('../CampaignsPage', () => stub);
vi.mock('../socialCampaigns/SocialCampaignsPage', () => stub);
vi.mock('../social', () => stub);
vi.mock('../emailTemplates', () => stub);
vi.mock('../triggerLinks', () => stub);
vi.mock('../ReviewsPage', () => stub);
vi.mock('../affiliate-portal/AffiliatePortalPage', () => stub);

function renderAt(path: string) {
  return render(<MemoryRouter initialEntries={[path]}><GrowthStudioPage /></MemoryRouter>);
}

describe('GrowthStudioPage', () => {
  it('renders the five unified tabs', () => {
    renderAt('/studio');
    for (const label of ['Content Calendar', 'Campaigns', 'Trends', 'Ad Budget', 'More']) {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
    }
  });

  it('honors the ?tab= deep link (budget selected)', () => {
    renderAt('/studio?tab=budget');
    expect(screen.getByRole('tab', { name: 'Ad Budget' })).toHaveAttribute('data-state', 'active');
  });
});
