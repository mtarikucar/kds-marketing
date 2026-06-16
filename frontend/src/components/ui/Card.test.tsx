import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from './Card';

describe('Card', () => {
  it('renders Card with children', () => {
    const { container } = render(<Card>content</Card>);
    expect(container.firstChild).toHaveClass('rounded-xl', 'border-border', 'bg-surface', 'shadow-sm');
  });

  it('merges custom className on Card', () => {
    const { container } = render(<Card className="custom-class">content</Card>);
    expect(container.firstChild).toHaveClass('custom-class');
  });

  it('renders CardHeader with correct classes', () => {
    const { container } = render(<CardHeader>header</CardHeader>);
    expect(container.firstChild).toHaveClass('flex', 'flex-col', 'gap-1', 'p-5');
  });

  it('renders CardTitle as h3 with display font', () => {
    render(<CardTitle>My Title</CardTitle>);
    const heading = screen.getByRole('heading', { level: 3, name: 'My Title' });
    expect(heading).toBeInTheDocument();
    expect(heading).toHaveClass('font-display', 'text-h3', 'text-foreground');
  });

  it('renders CardDescription as a paragraph', () => {
    const { container } = render(<CardDescription>desc</CardDescription>);
    expect(container.querySelector('p')).toHaveClass('text-sm', 'text-muted-foreground');
  });

  it('renders CardContent with correct classes', () => {
    const { container } = render(<CardContent>body</CardContent>);
    expect(container.firstChild).toHaveClass('p-5', 'pt-0');
  });

  it('renders CardFooter with correct classes', () => {
    const { container } = render(<CardFooter>footer</CardFooter>);
    expect(container.firstChild).toHaveClass('flex', 'items-center', 'gap-2', 'p-5', 'pt-0');
  });

  it('renders a composed card with heading and content', () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Dashboard</CardTitle>
          <CardDescription>Overview</CardDescription>
        </CardHeader>
        <CardContent>Main body</CardContent>
        <CardFooter>Actions</CardFooter>
      </Card>,
    );
    expect(screen.getByRole('heading', { level: 3, name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByText('Overview')).toBeInTheDocument();
    expect(screen.getByText('Main body')).toBeInTheDocument();
    expect(screen.getByText('Actions')).toBeInTheDocument();
  });
});
