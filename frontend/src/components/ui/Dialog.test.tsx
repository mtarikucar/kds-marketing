import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from './Dialog';

function DialogDemo() {
  return (
    <Dialog>
      <DialogTrigger>Open dialog</DialogTrigger>
      <DialogContent>
        <DialogTitle>Edit profile</DialogTitle>
        <DialogDescription>Make changes to your profile here.</DialogDescription>
        <input aria-label="Name" />
      </DialogContent>
    </Dialog>
  );
}

describe('Dialog', () => {
  it('opens on trigger click and renders a modal dialog', async () => {
    const user = userEvent.setup();
    render(<DialogDemo />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open dialog' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeInTheDocument();
    // Radix wires the accessible name from DialogTitle via aria-labelledby.
    expect(dialog).toHaveAttribute('aria-labelledby');
    expect(dialog).toHaveAccessibleName('Edit profile');
  });

  it('moves focus into the dialog when opened', async () => {
    const user = userEvent.setup();
    render(<DialogDemo />);
    await user.click(screen.getByRole('button', { name: 'Open dialog' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  });

  it('renders a labelled Close button', async () => {
    const user = userEvent.setup();
    render(<DialogDemo />);
    await user.click(screen.getByRole('button', { name: 'Open dialog' }));
    await screen.findByRole('dialog');
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    render(<DialogDemo />);
    await user.click(screen.getByRole('button', { name: 'Open dialog' }));
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
