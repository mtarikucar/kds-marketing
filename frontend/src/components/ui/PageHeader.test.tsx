import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { PageHeader } from './PageHeader';

describe('PageHeader', () => {
  it('renders the title', () => {
    render(<PageHeader title="Dashboard" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
  });

  it('renders actions', () => {
    render(
      <PageHeader
        title="Dashboard"
        actions={<button>Create</button>}
      />,
    );
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
  });

  it('renders description when provided', () => {
    render(<PageHeader title="Dashboard" description="Overview of everything" />);
    expect(screen.getByText('Overview of everything')).toBeInTheDocument();
  });

  it('renders breadcrumbs when provided', () => {
    render(
      <PageHeader
        title="Detail"
        breadcrumbs={[{ label: 'Home', href: '/' }, { label: 'Detail' }]}
      />,
    );
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toBeInTheDocument();
    expect(screen.getByText('Home')).toBeInTheDocument();
  });

  it('does not render breadcrumbs nav when not provided', () => {
    render(<PageHeader title="Simple" />);
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });
});
