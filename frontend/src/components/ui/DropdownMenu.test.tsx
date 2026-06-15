import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from './DropdownMenu';

function MenuDemo({ onSelect }: { onSelect?: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>Actions</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onSelect}>Edit</DropdownMenuItem>
        <DropdownMenuItem>Duplicate</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

describe('DropdownMenu', () => {
  it('opens on trigger click and renders a menu', async () => {
    const user = userEvent.setup();
    render(<MenuDemo />);
    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toBeInTheDocument();
  });

  it('highlights an item with ArrowDown and fires onSelect with Enter', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<MenuDemo onSelect={onSelect} />);
    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    await screen.findByRole('menu');

    // Radix moves DOM focus to the active item during keyboard navigation.
    await user.keyboard('{ArrowDown}');
    await waitFor(() =>
      expect(screen.getByRole('menuitem', { name: 'Edit' })).toHaveFocus(),
    );

    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
