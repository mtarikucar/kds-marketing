import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { Popover, PopoverTrigger, PopoverContent } from './Popover';

function PopoverDemo() {
  return (
    <div>
      <button>outside</button>
      <Popover>
        <PopoverTrigger>Open popover</PopoverTrigger>
        <PopoverContent>
          <p>Popover body</p>
        </PopoverContent>
      </Popover>
    </div>
  );
}

describe('Popover', () => {
  it('opens on trigger click', async () => {
    const user = userEvent.setup();
    render(<PopoverDemo />);
    expect(screen.queryByText('Popover body')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open popover' }));
    expect(await screen.findByText('Popover body')).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    render(<PopoverDemo />);
    await user.click(screen.getByRole('button', { name: 'Open popover' }));
    await screen.findByText('Popover body');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByText('Popover body')).not.toBeInTheDocument());
  });

  it('closes on outside click', async () => {
    const user = userEvent.setup();
    render(<PopoverDemo />);
    await user.click(screen.getByRole('button', { name: 'Open popover' }));
    await screen.findByText('Popover body');
    await user.click(screen.getByRole('button', { name: 'outside' }));
    await waitFor(() => expect(screen.queryByText('Popover body')).not.toBeInTheDocument());
  });
});
