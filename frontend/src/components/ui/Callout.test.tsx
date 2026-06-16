import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Callout } from './Callout';

describe('Callout', () => {
  it('renders info callout with role="status" by default', () => {
    render(<Callout tone="info" title="Info title">Info body</Callout>);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders success callout with role="status"', () => {
    render(<Callout tone="success" title="Done">All good</Callout>);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders warning callout with role="alert"', () => {
    render(<Callout tone="warning" title="Heads up">Watch out</Callout>);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('renders danger callout with role="alert"', () => {
    render(<Callout tone="danger" title="Error">Something went wrong</Callout>);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('defaults to info tone (role="status") when no tone given', () => {
    render(<Callout title="Default">message</Callout>);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders title text', () => {
    render(<Callout title="My Title">body</Callout>);
    expect(screen.getByText('My Title')).toBeInTheDocument();
  });

  it('renders children', () => {
    render(<Callout>Child content</Callout>);
    expect(screen.getByText('Child content')).toBeInTheDocument();
  });

  it('renders icon slot', () => {
    render(
      <Callout icon={<span data-testid="icon">★</span>} title="With icon">
        body
      </Callout>,
    );
    expect(screen.getByTestId('icon')).toBeInTheDocument();
  });

  it('applies info tone classes', () => {
    const { container } = render(<Callout tone="info" title="i">msg</Callout>);
    expect(container.firstChild).toHaveClass('bg-info-subtle', 'border-info');
  });

  it('applies danger tone classes', () => {
    const { container } = render(<Callout tone="danger" title="d">msg</Callout>);
    expect(container.firstChild).toHaveClass('bg-danger-subtle', 'border-danger');
  });

  it('applies success tone classes', () => {
    const { container } = render(<Callout tone="success" title="s">msg</Callout>);
    expect(container.firstChild).toHaveClass('bg-success-subtle', 'border-success');
  });

  it('applies warning tone classes', () => {
    const { container } = render(<Callout tone="warning" title="w">msg</Callout>);
    expect(container.firstChild).toHaveClass('bg-warning-subtle', 'border-warning');
  });

  it('merges custom className', () => {
    const { container } = render(<Callout className="extra-class">msg</Callout>);
    expect(container.firstChild).toHaveClass('extra-class');
  });
});
