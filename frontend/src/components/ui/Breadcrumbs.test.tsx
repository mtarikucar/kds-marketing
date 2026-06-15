import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import type { ReactNode } from 'react';
import { Breadcrumbs, type BreadcrumbItem } from './Breadcrumbs';

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

  describe('renderLink prop', () => {
    it('uses renderLink instead of <a> for non-last items with href', () => {
      // Simulate a router Link by rendering a custom anchor with data-spa attr.
      const renderLink = (item: BreadcrumbItem, children: ReactNode) => (
        <a href={item.href} data-spa="true" key={item.href}>
          {children}
        </a>
      );
      render(<Breadcrumbs items={items} renderLink={renderLink} />);

      // Use querySelectorAll to find elements with the data-spa attribute.
      const spaLinks = document.querySelectorAll('[data-spa="true"]');
      // Should render spa links for Home and Settings (not Profile which is last)
      expect(spaLinks).toHaveLength(2);
      expect(spaLinks[0]).toHaveAttribute('href', '/');
      expect(spaLinks[1]).toHaveAttribute('href', '/settings');
    });

    it('does not render plain <a> tags for items when renderLink is provided', () => {
      const renderLink = (item: BreadcrumbItem, children: ReactNode) => (
        <button key={item.href} data-testid={`spa-link-${item.href?.replace('/', '-')}`}>
          {children}
        </button>
      );
      render(<Breadcrumbs items={items} renderLink={renderLink} />);
      // No native <a> links from the breadcrumbs (the custom renderer uses button instead)
      const links = screen.queryAllByRole('link');
      expect(links).toHaveLength(0);
      // Custom elements rendered for non-last items with href
      expect(screen.getByTestId('spa-link--')).toBeInTheDocument();
      expect(screen.getByTestId('spa-link--settings')).toBeInTheDocument();
    });
  });
});
