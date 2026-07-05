import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import DocumentsHubPage from './DocumentsHubPage';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, o?: string) => (typeof o === 'string' ? o : k), i18n: { language: 'en' } }) }));
// Stub the heavy tab pages so the shell renders in isolation.
const stub = { default: () => null };
vi.mock('../offers/OffersPage', () => stub);
vi.mock('../estimates/EstimatesPage', () => stub);
vi.mock('./DocumentsPage', () => stub);

function renderAt(path: string) {
  return render(<MemoryRouter initialEntries={[path]}><DocumentsHubPage /></MemoryRouter>);
}

describe('DocumentsHubPage', () => {
  it('renders the three unified tabs', () => {
    renderAt('/documents');
    for (const label of ['Offers', 'Estimates', 'Documents']) {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
    }
  });

  it('defaults to the Offers tab', () => {
    renderAt('/documents');
    expect(screen.getByRole('tab', { name: 'Offers' })).toHaveAttribute('data-state', 'active');
  });

  it('honors the ?tab=estimates deep link', () => {
    renderAt('/documents?tab=estimates');
    expect(screen.getByRole('tab', { name: 'Estimates' })).toHaveAttribute('data-state', 'active');
  });

  it('honors the ?tab=files deep link (e-signature documents)', () => {
    renderAt('/documents?tab=files');
    expect(screen.getByRole('tab', { name: 'Documents' })).toHaveAttribute('data-state', 'active');
  });

  it('falls back to Offers on an unknown ?tab= value', () => {
    renderAt('/documents?tab=nope');
    expect(screen.getByRole('tab', { name: 'Offers' })).toHaveAttribute('data-state', 'active');
  });

  it('switches tabs on click (URL-synced)', async () => {
    const user = userEvent.setup();
    renderAt('/documents');
    await user.click(screen.getByRole('tab', { name: 'Estimates' }));
    expect(screen.getByRole('tab', { name: 'Estimates' })).toHaveAttribute('data-state', 'active');
  });
});
