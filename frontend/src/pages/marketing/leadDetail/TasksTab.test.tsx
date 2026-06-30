import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import TasksTab from './TasksTab';

const props = (leadId: string) => ({
  leadId,
  tasks: [],
  fmtDate: () => 'Jun one',
  onCreate: vi.fn(),
  createPending: false,
  onComplete: vi.fn(),
  onDelete: vi.fn(),
});

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
