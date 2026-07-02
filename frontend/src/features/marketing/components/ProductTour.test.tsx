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

  it('auto-starts for a manager and steps through to done', async () => {
    const user = userEvent.setup();
    renderTour('/dashboard');
    expect(await screen.findByText('Jump anywhere with ⌘K')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('A focused menu')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: /Got it/i }));
    expect(useTourStore.getState().dismissed.w1).toBe(true);
    expect(useTourStore.getState().open).toBe(false);
  });

  it('does NOT auto-start on the fresh-register (?welcome=1) moment', () => {
    renderTour('/dashboard?welcome=1');
    expect(screen.queryByText('Jump anywhere with ⌘K')).not.toBeInTheDocument();
    expect(useTourStore.getState().open).toBe(false);
  });

  it('does not auto-start once dismissed', () => {
    useTourStore.setState({ open: false, dismissed: { w1: true } });
    renderTour('/dashboard');
    expect(screen.queryByText('Jump anywhere with ⌘K')).not.toBeInTheDocument();
  });
});
