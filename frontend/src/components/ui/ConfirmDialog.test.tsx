import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';

describe('ConfirmDialog', () => {
  it('renders title and description when open', async () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Delete item?"
        description="This cannot be undone."
        confirmLabel="Delete"
        onConfirm={() => {}}
      />,
    );
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Delete item?')).toBeInTheDocument();
    expect(screen.getByText('This cannot be undone.')).toBeInTheDocument();
  });

  it('fires onConfirm when the confirm button is clicked', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Confirm"
        confirmLabel="Yes, proceed"
        onConfirm={onConfirm}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Yes, proceed' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('renders a destructive confirm button for danger tone', async () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Delete"
        confirmLabel="Delete"
        tone="danger"
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveClass('bg-danger');
  });

  it('uses the provided cancel label', () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Confirm"
        confirmLabel="OK"
        cancelLabel="Nevermind"
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Nevermind' })).toBeInTheDocument();
  });
});
