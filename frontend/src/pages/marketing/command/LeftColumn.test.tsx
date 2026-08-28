import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { LeftColumn } from './LeftColumn';

// Stubbed so this is a test of the COLUMN — which panel is showing and what the
// tab strip says — and not a second, weaker test of the two panels themselves.
vi.mock('./TimelinePanel', () => ({ TimelinePanel: () => <div>TAKVIM</div> }));
vi.mock('./AgentActivity', () => ({ AgentActivity: () => <div>AKIS</div> }));

describe('LeftColumn', () => {
  it('shows the calendar first and switches to the flow on click', async () => {
    const user = userEvent.setup();
    render(<LeftColumn failureCount={0} />);
    expect(screen.getByText('TAKVIM')).toBeInTheDocument();
    // Not merely hidden: the whole point of tabbing over stacking is that the
    // visible panel gets the full height, which only holds if the other is gone.
    expect(screen.queryByText('AKIS')).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /akış/i }));
    expect(screen.getByText('AKIS')).toBeInTheDocument();
    expect(screen.queryByText('TAKVIM')).not.toBeInTheDocument();
  });

  // The cost of tabbing is blindness: while you are reading the calendar, a run
  // can fail in the flow and nothing on screen would say so. The badge is what
  // pays that cost back, so it is the load-bearing part of this component.
  it('badges the flow tab when something failed, so a tab you cannot see still reaches you', () => {
    render(<LeftColumn failureCount={3} />);
    expect(screen.getByTestId('flow-badge')).toHaveTextContent('3');
  });

  it('drops the badge when nothing has failed', () => {
    render(<LeftColumn failureCount={0} />);
    expect(screen.queryByTestId('flow-badge')).not.toBeInTheDocument();
  });

  // A bare number is a number; the count only means something if the assistive
  // reading of the tab says what the number counts.
  it('says out loud what the badge counts', () => {
    render(<LeftColumn failureCount={2} />);
    expect(screen.getByRole('tab', { name: /başarısız/i })).toBeInTheDocument();
  });

  // A role="tablist"/role="tab" pair with no aria-controls, no ids and no
  // arrow-key navigation is a half-built ARIA pattern — worse than plain
  // buttons, because it promises a keyboard contract it does not honour.
  it('wires each tab to the panel it controls', async () => {
    const user = userEvent.setup();
    render(<LeftColumn failureCount={0} />);

    const timelineTab = screen.getByRole('tab', { name: /takvim/i });
    expect(timelineTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /akış/i })).toHaveAttribute('aria-selected', 'false');

    const panel = screen.getByRole('tabpanel');
    expect(timelineTab).toHaveAttribute('aria-controls', panel.id);
    expect(panel).toHaveAttribute('aria-labelledby', timelineTab.id);

    await user.click(screen.getByRole('tab', { name: /akış/i }));
    const flowPanel = screen.getByRole('tabpanel');
    expect(flowPanel).toHaveTextContent('AKIS');
    expect(screen.getByRole('tab', { name: /akış/i })).toHaveAttribute('aria-controls', flowPanel.id);
  });

  it('moves between tabs with the arrow keys', async () => {
    const user = userEvent.setup();
    render(<LeftColumn failureCount={0} />);

    await user.tab();
    expect(screen.getByRole('tab', { name: /takvim/i })).toHaveFocus();

    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: /akış/i })).toHaveFocus();
    expect(screen.getByText('AKIS')).toBeInTheDocument();

    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: /takvim/i })).toHaveFocus();
    expect(screen.getByText('TAKVIM')).toBeInTheDocument();
  });
});
