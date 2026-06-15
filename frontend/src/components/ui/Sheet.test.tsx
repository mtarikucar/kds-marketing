import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { Sheet, SheetTrigger, SheetContent, SheetTitle } from './Sheet';

function SheetDemo({ side }: { side?: 'left' | 'right' | 'top' | 'bottom' }) {
  return (
    <Sheet>
      <SheetTrigger>Open sheet</SheetTrigger>
      <SheetContent side={side}>
        <SheetTitle>Navigation</SheetTitle>
      </SheetContent>
    </Sheet>
  );
}

describe('Sheet', () => {
  it('opens on trigger click with role="dialog"', async () => {
    const user = userEvent.setup();
    render(<SheetDemo />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open sheet' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeInTheDocument();
    // Sheet reuses Radix dialog: accessible name comes from SheetTitle.
    expect(dialog).toHaveAccessibleName('Navigation');
  });

  it('renders content for the left side', async () => {
    const user = userEvent.setup();
    render(<SheetDemo side="left" />);
    await user.click(screen.getByRole('button', { name: 'Open sheet' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Navigation')).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    render(<SheetDemo />);
    await user.click(screen.getByRole('button', { name: 'Open sheet' }));
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
