import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { ReopenLeadDialog } from './ReopenLeadDialog';

const props = {
  open: true,
  onOpenChange: () => {},
  currentStatus: 'DEMO_SCHEDULED',
  statusLabel: 'Demo Scheduled',
  onConfirm: () => {},
};

describe('ReopenLeadDialog', () => {
  it('names the stage being undone, so it is clear what the rewind affects', async () => {
    render(<ReopenLeadDialog {...props} />);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Demo Scheduled')).toBeInTheDocument();
  });

  it('will not submit without a real reason — the timeline entry is the point', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<ReopenLeadDialog {...props} onConfirm={onConfirm} />);

    const confirm = await screen.findByRole('button', { name: 'Reopen' });
    expect(confirm).toBeDisabled();

    // Backend ReopenLeadDto is @MinLength(10); anything shorter would 400.
    await user.type(screen.getByRole('textbox'), 'oops');
    expect(confirm).toBeDisabled();

    await user.clear(screen.getByRole('textbox'));
    await user.type(screen.getByRole('textbox'), 'demo was never held');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith('demo was never held');
  });
});
