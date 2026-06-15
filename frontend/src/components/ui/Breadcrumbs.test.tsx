import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Breadcrumbs } from './Breadcrumbs';

const items = [
  { label: 'Home', href: '/' },
  { label: 'Settings', href: '/settings' },
  { label: 'Profile' },
];

describe('Breadcrumbs', () => {
  it('renders all labels', () => {
    render(<Breadcrumbs items={items} />);
    expect(screen.getByText('Home')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
    expect(screen.getByText('Profile')).toBeInTheDocument();
  });

  it('last item has aria-current="page"', () => {
    render(<Breadcrumbs items={items} />);
    const lastCrumb = screen.getByText('Profile');
    expect(lastCrumb).toHaveAttribute('aria-current', 'page');
  });

  it('non-last items do not have aria-current', () => {
    render(<Breadcrumbs items={items} />);
    expect(screen.getByText('Home')).not.toHaveAttribute('aria-current');
    expect(screen.getByText('Settings')).not.toHaveAttribute('aria-current');
  });

  it('renders links for items with href', () => {
    render(<Breadcrumbs items={items} />);
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
  });

  it('last item is not a link', () => {
    render(<Breadcrumbs items={items} />);
    const links = screen.getAllByRole('link');
    // Only 2 links (Home + Settings), not 3
    expect(links).toHaveLength(2);
  });

  it('has nav with aria-label="Breadcrumb"', () => {
    render(<Breadcrumbs items={items} />);
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toBeInTheDocument();
  });

  it('renders single item with aria-current="page"', () => {
    render(<Breadcrumbs items={[{ label: 'Home' }]} />);
    expect(screen.getByText('Home')).toHaveAttribute('aria-current', 'page');
  });
});
