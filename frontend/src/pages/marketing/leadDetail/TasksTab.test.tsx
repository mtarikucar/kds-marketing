import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import TasksTab from './TasksTab';
import type { MarketingTask } from '../../../features/marketing/types';

// Render inline defaultValues so the ConfirmDialog labels ("Delete task",
// "Cancel", "Delete") are queryable instead of raw catalog keys.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string | string[], opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ??
      (Array.isArray(key) ? key[key.length - 1] : key),
    i18n: { language: 'en' },
  }),
}));

const props = (leadId: string) => ({
  leadId,
  tasks: [] as MarketingTask[],
  fmtDate: () => 'Jun one',
  onCreate: vi.fn(),
  createPending: false,
  onComplete: vi.fn(),
  onDelete: vi.fn(),
});

const TASK = {
  id: 't1',
  title: 'Call the customer',
  type: 'FOLLOW_UP',
  priority: 'MEDIUM',
  status: 'PENDING',
  dueDate: '2026-06-01',
} as unknown as MarketingTask;

describe('TasksTab — draft resets per lead', () => {
  // The lead-detail route reuses this tab across /leads/:id navigations (no
  // remount). A half-typed task left open for one contact must not carry to the
  // next; changing the leadId must close + clear the draft.
  it('closes the new-task draft when the leadId changes', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<TasksTab {...props('leadA')} />);

    await user.click(screen.getByRole('button', { name: /new task/i }));
    expect(await screen.findByText('Due Date')).toBeInTheDocument();

    rerender(<TasksTab {...props('leadB')} />);

    await waitFor(() => expect(screen.queryByText('Due Date')).toBeNull());
  });
});

describe('TasksTab — delete confirmation (ConfirmDialog, not window.confirm)', () => {
  it('deletes only after the destructive confirm is accepted', async () => {
    const user = userEvent.setup();
    const p = { ...props('leadA'), tasks: [TASK] };
    render(<TasksTab {...p} />);

    await user.click(screen.getByRole('button', { name: /delete task/i }));
    // The trash click opens the design-system ConfirmDialog; nothing fires yet.
    expect(p.onDelete).not.toHaveBeenCalled();

    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    expect(p.onDelete).toHaveBeenCalledWith('t1');
  });

  it('does not delete when the confirmation is dismissed', async () => {
    const user = userEvent.setup();
    const p = { ...props('leadA'), tasks: [TASK] };
    render(<TasksTab {...p} />);

    await user.click(screen.getByRole('button', { name: /delete task/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(p.onDelete).not.toHaveBeenCalled();
  });
});
