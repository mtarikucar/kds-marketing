import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from './Tooltip';

function TooltipDemo() {
  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger>Hover me</TooltipTrigger>
        <TooltipContent>Helpful hint</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

describe('Tooltip', () => {
  it('exports a TooltipProvider', () => {
    expect(TooltipProvider).toBeDefined();
  });

  it('shows tooltip content on focus', async () => {
    const user = userEvent.setup();
    render(<TooltipDemo />);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Hover me' })).toHaveFocus();
    // Radix renders the tooltip content in a role="tooltip" node on focus.
    expect(await screen.findByRole('tooltip')).toBeInTheDocument();
    expect(screen.getAllByText('Helpful hint').length).toBeGreaterThan(0);
  });
});
