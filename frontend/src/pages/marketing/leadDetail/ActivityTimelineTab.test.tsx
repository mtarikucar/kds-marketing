import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Established pattern: stub react-i18next so the component (and the reused
// ActivityTimeline) renders without a real i18n provider. `t` echoes the key.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string | string[]) => (Array.isArray(key) ? key[0] : key),
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

import ActivityTimelineTab from './ActivityTimelineTab';

describe('ActivityTimelineTab', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mounts with the timeline and an add-activity trigger', () => {
    render(<ActivityTimelineTab leadId="lead-1" activities={[]} onSubmit={vi.fn()} isPending={false} />);
    expect(screen.getByText('Activity Timeline')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add activity/i })).toBeInTheDocument();
  });

  it('fires validation and does not submit when title is empty', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ActivityTimelineTab leadId="lead-1" activities={[]} onSubmit={onSubmit} isPending={false} />);

    await user.click(screen.getByRole('button', { name: /add activity/i }));
    // Dialog open with the form
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^save$/i }));

    // Validation message surfaces (echoed key) and onSubmit is NOT called.
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits the activity payload when valid', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ActivityTimelineTab leadId="lead-1" activities={[]} onSubmit={onSubmit} isPending={false} />);

    await user.click(screen.getByRole('button', { name: /add activity/i }));
    await screen.findByRole('dialog');

    await user.type(screen.getByPlaceholderText('Activity title'), 'Called the lead');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'NOTE', title: 'Called the lead' }),
      ),
    );
  });

  // The lead-detail route reuses this tab across /leads/:id navigations (no
  // remount), so a half-typed activity draft must not carry to the next contact.
  it('closes the draft when the leadId changes', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ActivityTimelineTab leadId="leadA" activities={[]} onSubmit={vi.fn()} isPending={false} />,
    );

    await user.click(screen.getByRole('button', { name: /add activity/i }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    rerender(
      <ActivityTimelineTab leadId="leadB" activities={[]} onSubmit={vi.fn()} isPending={false} />,
    );

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
