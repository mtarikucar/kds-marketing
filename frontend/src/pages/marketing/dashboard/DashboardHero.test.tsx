import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import i18n from 'i18next';
import '@/i18n/config';
import { DashboardHero } from './DashboardHero';

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}

type HeroProps = Parameters<typeof DashboardHero>[0];

function renderHero(props: HeroProps) {
  return render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <DashboardHero {...props} />
      <LocationProbe />
    </MemoryRouter>,
  );
}

describe('DashboardHero', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('renders nothing while stats are loading', () => {
    const { container } = renderHero({ stats: undefined, isManager: true });
    expect(screen.queryByText(/Welcome back/i)).not.toBeInTheDocument();
    // Only the LocationProbe should be present.
    expect(container.querySelector('h2')).toBeNull();
  });

  it('shows the first-lead CTA on an empty workspace', async () => {
    const user = userEvent.setup();
    renderHero({ stats: { totalLeads: 0 }, isManager: true });
    expect(screen.getByText(/Start with your first lead/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /New lead/i }));
    expect(screen.getByTestId('loc')).toHaveTextContent('/leads/new');
  });

  it('routes to overdue tasks when work is waiting', async () => {
    const user = userEvent.setup();
    renderHero({ stats: { totalLeads: 5 }, today: { overdueTasks: 3 }, isManager: true });
    await user.click(screen.getByRole('button', { name: /Review overdue tasks/i }));
    expect(screen.getByTestId('loc')).toHaveTextContent('/tasks?tab=overdue');
  });

  it('nudges back to leads when all caught up', async () => {
    const user = userEvent.setup();
    renderHero({
      stats: { totalLeads: 5, unassignedLeads: 0, pendingTasks: 0, activeOffers: 0 },
      today: { overdueTasks: 0 },
      isManager: true,
    });
    expect(screen.getByText(/all caught up/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Go to your leads/i }));
    expect(screen.getByTestId('loc')).toHaveTextContent('/leads');
  });

  it('ignores unassigned leads for a rep (no manager-only queue)', () => {
    renderHero({
      stats: { totalLeads: 5, unassignedLeads: 9, pendingTasks: 0, activeOffers: 0 },
      today: { overdueTasks: 0 },
      isManager: false,
    });
    // A rep never sees the "Assign leads" queue; they get the caught-up nudge.
    expect(screen.getByRole('button', { name: /Go to your leads/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Assign leads/i })).not.toBeInTheDocument();
  });

  it('does NOT show the create-lead CTA to a rep with no assigned leads', () => {
    // A rep's totalLeads is scoped to leads assigned to them, so zero means
    // "nothing assigned", not "empty workspace" — they should fall through.
    renderHero({
      stats: { totalLeads: 0, pendingTasks: 0, activeOffers: 0 },
      today: { overdueTasks: 0 },
      isManager: false,
    });
    expect(screen.queryByText(/Start with your first lead/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Go to your leads/i })).toBeInTheDocument();
  });

  it('routes to tasks when only pending tasks are waiting (count matches CTA)', async () => {
    const user = userEvent.setup();
    renderHero({
      stats: { totalLeads: 5, unassignedLeads: 0, pendingTasks: 3, activeOffers: 0 },
      today: { overdueTasks: 0 },
      isManager: false,
    });
    await user.click(screen.getByRole('button', { name: /Review your tasks/i }));
    expect(screen.getByTestId('loc')).toHaveTextContent('/tasks');
  });
});
