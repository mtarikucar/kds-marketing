import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Progress } from './Progress';

describe('Progress', () => {
  it('renders a progressbar role', () => {
    render(<Progress value={50} />);
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('sets aria-valuenow to the provided value', () => {
    render(<Progress value={42} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '42');
  });

  it('sets aria-valuemin to 0', () => {
    render(<Progress value={10} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuemin', '0');
  });

  it('sets aria-valuemax to 100', () => {
    render(<Progress value={10} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '100');
  });

  it('clamps value to 0 when given a negative number', () => {
    render(<Progress value={-10} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  });

  it('clamps value to 100 when given a value over 100', () => {
    render(<Progress value={150} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  });

  it('fills bar to correct width percentage', () => {
    const { container } = render(<Progress value={75} />);
    const fill = container.querySelector('[style]');
    expect(fill).toHaveStyle({ width: '75%' });
  });

  it('applies primary tone by default', () => {
    const { container } = render(<Progress value={50} />);
    const fill = container.querySelector('.bg-primary');
    expect(fill).toBeInTheDocument();
  });

  it('applies success tone fill class', () => {
    const { container } = render(<Progress value={50} tone="success" />);
    expect(container.querySelector('.bg-success')).toBeInTheDocument();
  });

  it('applies danger tone fill class', () => {
    const { container } = render(<Progress value={50} tone="danger" />);
    expect(container.querySelector('.bg-danger')).toBeInTheDocument();
  });

  it('applies warning tone fill class', () => {
    const { container } = render(<Progress value={50} tone="warning" />);
    expect(container.querySelector('.bg-warning')).toBeInTheDocument();
  });

  it('merges custom className onto progressbar', () => {
    const { container } = render(<Progress value={50} className="custom-progress" />);
    expect(container.firstChild).toHaveClass('custom-progress');
  });
});
