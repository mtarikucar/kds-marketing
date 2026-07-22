import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import i18n from 'i18next';
import '@/i18n/config';
import { useMarketingAuthStore, type MarketingUser } from '@/store/marketingAuthStore';
import { useTourStore } from '@/store/tourStore';
import ProductTour from './ProductTour';

const MANAGER: MarketingUser = {
  id: 'u1', workspaceId: 'w1', email: 'm@x.io', firstName: 'M', lastName: 'X', role: 'MANAGER',
};

function renderTour(path = '/dashboard') {
  useMarketingAuthStore.setState({
    user: MANAGER, accessToken: 't', refreshToken: 'r', isAuthenticated: true,
  });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ProductTour />
    </MemoryRouter>,
  );
}

describe('ProductTour', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    useTourStore.setState({ open: false, dismissed: {} });
  });

  it('does NOT auto-start for a manager (WelcomeDialog owns first-touch)', () => {
    renderTour('/dashboard');
    expect(screen.queryByText('Jump anywhere with ⌘K')).not.toBeInTheDocument();
    expect(useTourStore.getState().open).toBe(false);
  });

  it('opens on demand (menu launch) and steps through to done', async () => {
    const user = userEvent.setup();
    renderTour('/dashboard');
    // The header "Take a tour" menu entry calls the store's setOpen(true).
    useTourStore.setState({ open: true });
    expect(await screen.findByText('Jump anywhere with ⌘K')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('A focused menu')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: /Got it/i }));
    expect(useTourStore.getState().dismissed.w1).toBe(true);
    expect(useTourStore.getState().open).toBe(false);
  });

  it('relaunches from the menu even once dismissed', async () => {
    useTourStore.setState({ open: false, dismissed: { w1: true } });
    renderTour('/dashboard');
    expect(screen.queryByText('Jump anywhere with ⌘K')).not.toBeInTheDocument();
    useTourStore.setState({ open: true });
    expect(await screen.findByText('Jump anywhere with ⌘K')).toBeInTheDocument();
  });
});
