import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { StatCard } from './StatCard';

describe('StatCard', () => {
  it('renders label and value', () => {
    render(<StatCard label="Revenue" value="$12,340" />);
    expect(screen.getByText('Revenue')).toBeInTheDocument();
    expect(screen.getByText('$12,340')).toBeInTheDocument();
  });

  it('renders icon when provided', () => {
    render(
      <StatCard label="Users" value="1,024" icon={<span data-testid="icon">👤</span>} />,
    );
    expect(screen.getByTestId('icon')).toBeInTheDocument();
  });

  it('does not render delta section when delta is absent', () => {
    const { container } = render(<StatCard label="Orders" value="42" />);
    expect(container.querySelector('[data-direction]')).toBeNull();
  });

  it('renders up-delta with success color class', () => {
    const { container } = render(
      <StatCard label="Revenue" value="$100" delta={{ value: '+12%', direction: 'up' }} />,
    );
    const deltaEl = container.querySelector('[data-direction="up"]');
    expect(deltaEl).toBeInTheDocument();
    expect(deltaEl).toHaveClass('text-success');
  });

  it('renders down-delta with danger color class', () => {
    const { container } = render(
      <StatCard label="Churn" value="5%" delta={{ value: '-3%', direction: 'down' }} />,
    );
    const deltaEl = container.querySelector('[data-direction="down"]');
    expect(deltaEl).toBeInTheDocument();
    expect(deltaEl).toHaveClass('text-danger');
  });

  it('renders flat-delta with muted color class', () => {
    const { container } = render(
      <StatCard label="Sessions" value="800" delta={{ value: '0%', direction: 'flat' }} />,
    );
    const deltaEl = container.querySelector('[data-direction="flat"]');
    expect(deltaEl).toBeInTheDocument();
    expect(deltaEl).toHaveClass('text-muted-foreground');
  });

  it('renders value with tabular-nums and font-display', () => {
    render(<StatCard label="MRR" value="$9,999" />);
    const valueEl = screen.getByText('$9,999');
    expect(valueEl).toHaveClass('font-display', 'tabular-nums');
  });

  it('renders label with micro uppercase muted classes', () => {
    render(<StatCard label="ARR" value="$100k" />);
    const labelEl = screen.getByText('ARR');
    expect(labelEl).toHaveClass('text-micro', 'uppercase', 'text-muted-foreground');
  });

  it('merges custom className', () => {
    const { container } = render(
      <StatCard label="L" value="V" className="my-custom" />,
    );
    expect(container.firstChild).toHaveClass('my-custom');
  });
});
