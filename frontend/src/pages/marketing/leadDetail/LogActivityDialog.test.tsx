import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Established pattern: stub react-i18next so the component renders without a
// real i18n provider. `t` echoes the key.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string | string[]) => (Array.isArray(key) ? key[0] : key),
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

import LogActivityDialog from './LogActivityDialog';

/**
 * What survived the five-tabs-to-four collapse.
 *
 * `ActivityTimelineTab` was two things stapled together: a rendering of
 * `lead.activities` and the form that WRITES one. The rendering is now
 * `LeadStream`'s job (activities and messages on one axis, fetched from
 * `/leads/:id/timeline`), but "Log call" and "Add Activity" are the only way a
 * rep records a call they made from their own handset — deleting the tab
 * without keeping them would have removed a feature nobody asked to lose.
 *
 * These cases are inherited verbatim from ActivityTimelineTab.test.tsx; only
 * the timeline assertions are gone, because there is no timeline here.
 */
describe('LogActivityDialog', () => {
  beforeEach(() => vi.clearAllMocks());

  it('offers both first-class triggers', () => {
    render(<LogActivityDialog leadId="lead-1" onSubmit={vi.fn()} isPending={false} />);
    expect(screen.getByRole('button', { name: /add activity/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /log call/i })).toBeInTheDocument();
  });

  it('fires validation and does not submit when title is empty', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<LogActivityDialog leadId="lead-1" onSubmit={onSubmit} isPending={false} />);

    await user.click(screen.getByRole('button', { name: /add activity/i }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^save$/i }));

    // Validation message surfaces (echoed key) and onSubmit is NOT called.
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits the activity payload when valid', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<LogActivityDialog leadId="lead-1" onSubmit={onSubmit} isPending={false} />);

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

  // "Log call" is not a shortcut to the same blank form — it pre-selects CALL,
  // which is the whole reason it is a separate button.
  it('opens Log call pre-set to a CALL activity', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<LogActivityDialog leadId="lead-1" onSubmit={onSubmit} isPending={false} />);

    await user.click(screen.getByRole('button', { name: /log call/i }));
    await screen.findByRole('dialog');

    await user.type(screen.getByPlaceholderText('Activity title'), 'Aradım');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ type: 'CALL' })),
    );
  });

  // The lead-detail route reuses this across /leads/:id navigations (no
  // remount), so a half-typed activity draft must not carry to the next
  // contact. Inherited from ActivityTimelineTab, where the bug was first paid
  // for.
  it('closes the draft when the leadId changes', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <LogActivityDialog leadId="leadA" onSubmit={vi.fn()} isPending={false} />,
    );

    await user.click(screen.getByRole('button', { name: /add activity/i }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    rerender(<LogActivityDialog leadId="leadB" onSubmit={vi.fn()} isPending={false} />);

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
