import type { ReactElement } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import i18n from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { LeftColumn } from './LeftColumn';
import tr from '../../../i18n/locales/tr/marketing.json';

// Stubbed so this is a test of the COLUMN — which panel is showing and what the
// tab strip says — and not a second, weaker test of the two panels themselves.
vi.mock('./TimelinePanel', () => ({ TimelinePanel: () => <div>TAKVIM</div> }));
vi.mock('./AgentActivity', () => ({ AgentActivity: () => <div>AKIS</div> }));

// Rendered against a REAL i18next instance holding the real tr catalogue,
// which no other component test in this repo does. Without one, react-i18next
// falls back to a `t` that hands back the inline default VERBATIM — so the
// badge's label reads the literal string "{{count}} başarısız iş" and any
// assertion loose enough to pass on that (e.g. /başarısız/) would pass whether
// or not the count ever reached a screen reader. The count is the entire
// content of this badge; a test that cannot see it is not testing it.
const instance = i18n.createInstance();

beforeAll(async () => {
  await instance.init({
    lng: 'tr',
    fallbackLng: 'en',
    resources: { tr: { marketing: tr } },
    interpolation: { escapeValue: false },
  });
});

const renderColumn = (ui: ReactElement) =>
  render(<I18nextProvider i18n={instance}>{ui}</I18nextProvider>);

describe('LeftColumn', () => {
  it('shows the calendar first and switches to the flow on click', async () => {
    const user = userEvent.setup();
    renderColumn(<LeftColumn failureCount={0} />);
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
    renderColumn(<LeftColumn failureCount={3} />);
    expect(screen.getByTestId('flow-badge')).toHaveTextContent('3');
  });

  it('drops the badge when nothing has failed', () => {
    renderColumn(<LeftColumn failureCount={0} />);
    expect(screen.queryByTestId('flow-badge')).not.toBeInTheDocument();
  });

  // A bare number is a number; the count only means something if the assistive
  // reading of the tab says what the number counts. Asserted WITH the digit —
  // `/başarısız/` alone would still pass if the placeholder never interpolated
  // and the label announced "{{count}} başarısız iş".
  it('says out loud what the badge counts', () => {
    renderColumn(<LeftColumn failureCount={2} />);
    expect(screen.getByRole('tab', { name: /2 başarısız/ })).toBeInTheDocument();
  });

  // A role="tablist"/role="tab" pair with no aria-controls, no ids and no
  // arrow-key navigation is a half-built ARIA pattern — worse than plain
  // buttons, because it promises a keyboard contract it does not honour.
  it('wires each tab to the panel it controls', async () => {
    const user = userEvent.setup();
    renderColumn(<LeftColumn failureCount={0} />);

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
    renderColumn(<LeftColumn failureCount={0} />);

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
