import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Stepper } from './Stepper';

const STEPS = [
  { id: 'goal', label: 'Goal' },
  { id: 'brief', label: 'Brief' },
  { id: 'review', label: 'Review' },
];

describe('Stepper', () => {
  it('renders a nav landmark with the provided aria-label', () => {
    render(<Stepper steps={STEPS} current={0} aria-label="Builder steps" />);
    expect(screen.getByRole('navigation', { name: 'Builder steps' })).toBeInTheDocument();
  });

  it('marks the current step with aria-current="step"', () => {
    render(<Stepper steps={STEPS} current={1} aria-label="Builder steps" />);
    expect(screen.getByRole('button', { name: /Brief/ })).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('button', { name: /Goal/ })).not.toHaveAttribute('aria-current', 'step');
  });

  it('invokes onStepClick for a completed step but not a future one', async () => {
    const user = userEvent.setup();
    const onStepClick = vi.fn();
    render(<Stepper steps={STEPS} current={1} onStepClick={onStepClick} aria-label="Builder steps" />);
    await user.click(screen.getByRole('button', { name: /Goal/ }));    // completed → allowed
    expect(onStepClick).toHaveBeenCalledWith(0);
    onStepClick.mockClear();
    await user.click(screen.getByRole('button', { name: /Review/ }));   // future → disabled, no-op
    expect(onStepClick).not.toHaveBeenCalled();
  });
});
