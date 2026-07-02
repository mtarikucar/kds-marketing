import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import i18n from 'i18next';
import '@/i18n/config';
import { WelcomeDialog } from './WelcomeDialog';

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

describe('WelcomeDialog', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('shows first-win actions and navigates + closes on click', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <WelcomeDialog open onClose={onClose} />
        <LocationProbe />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Welcome to Jeeta/i)).toBeInTheDocument();
    await user.click(screen.getByText('Choose your modules'));
    expect(onClose).toHaveBeenCalled();
    expect(screen.getByTestId('loc')).toHaveTextContent('/settings/modules');
  });
});
