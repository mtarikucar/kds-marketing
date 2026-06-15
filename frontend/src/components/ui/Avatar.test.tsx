import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Avatar, AvatarGroup } from './Avatar';

describe('Avatar', () => {
  it('shows fallback initials when no src provided', () => {
    render(<Avatar initials="JD" />);
    expect(screen.getByText('JD')).toBeInTheDocument();
  });

  it('shows fallback initials when src fails to load (jsdom default)', () => {
    // In jsdom, Image onLoad doesn't fire, so Radix Avatar always shows Fallback.
    render(<Avatar src="https://example.com/photo.jpg" initials="AB" alt="Alice Bob" />);
    // Fallback should be visible since image never loads in jsdom
    expect(screen.getByText('AB')).toBeInTheDocument();
  });

  it('shows "?" as default fallback when no initials or src', () => {
    render(<Avatar />);
    expect(screen.getByText('?')).toBeInTheDocument();
  });

  it('applies size classes', () => {
    const { container } = render(<Avatar initials="SM" size="sm" />);
    // Root element should have sm size class
    expect(container.firstChild).toHaveClass('h-7');
  });
});

describe('AvatarGroup', () => {
  const avatars = [
    { initials: 'AA' },
    { initials: 'BB' },
    { initials: 'CC' },
    { initials: 'DD' },
    { initials: 'EE' },
  ];

  it('renders visible avatars up to maxVisible', () => {
    render(<AvatarGroup avatars={avatars} maxVisible={3} />);
    expect(screen.getByText('AA')).toBeInTheDocument();
    expect(screen.getByText('BB')).toBeInTheDocument();
    expect(screen.getByText('CC')).toBeInTheDocument();
  });

  it('renders overflow bubble with +N count', () => {
    render(<AvatarGroup avatars={avatars} maxVisible={3} />);
    // 5 avatars, 3 visible → +2 overflow
    expect(screen.getByText('+2')).toBeInTheDocument();
  });

  it('renders no overflow bubble when all fit', () => {
    render(<AvatarGroup avatars={avatars.slice(0, 2)} maxVisible={3} />);
    expect(screen.queryByText(/^\+/)).not.toBeInTheDocument();
  });

  it('stacks avatars with -ms-2 overlap on 2nd+ items', () => {
    const { container } = render(<AvatarGroup avatars={avatars.slice(0, 3)} maxVisible={3} />);
    // Find Avatar elements (the root Radix elements). The 2nd and 3rd should have -ms-2
    const avatarEls = container.querySelectorAll('[class*="-ms-2"]');
    expect(avatarEls.length).toBeGreaterThanOrEqual(2);
  });
});
