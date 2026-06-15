import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Button } from './Button';

describe('Button', () => {
  it('renders text and is a button by default', () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('disables and shows spinner when loading', () => {
    render(<Button loading>Save</Button>);
    expect(screen.getByRole('button')).toBeDisabled();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders as child element with asChild', () => {
    render(<Button asChild><a href="/x">Link</a></Button>);
    expect(screen.getByRole('link', { name: 'Link' })).toHaveClass('bg-primary');
  });

  it('applies primary variant class by default', () => {
    render(<Button>Click</Button>);
    expect(screen.getByRole('button')).toHaveClass('bg-primary');
  });

  it('applies destructive variant classes', () => {
    render(<Button variant="destructive">Delete</Button>);
    expect(screen.getByRole('button')).toHaveClass('bg-danger');
  });

  it('disables when disabled prop is set', () => {
    render(<Button disabled>No</Button>);
    expect(screen.getByRole('button')).toBeDisabled();
  });
});
