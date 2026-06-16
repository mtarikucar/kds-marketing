/**
 * Integration smoke test — renders the entire UI kitchen-sink page and asserts
 * it mounts without throwing and key headings are present. This exercises every
 * Console primitive in one render pass.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect } from 'vitest';
import UiKitchenSinkPage from './UiKitchenSinkPage';

function renderPage() {
  return render(
    <MemoryRouter>
      <UiKitchenSinkPage />
    </MemoryRouter>,
  );
}

describe('UiKitchenSinkPage', () => {
  it('mounts without throwing', () => {
    expect(() => renderPage()).not.toThrow();
  });

  it('renders the Buttons section heading', () => {
    renderPage();
    expect(screen.getByText('Buttons')).toBeInTheDocument();
  });

  it('renders the Form section heading', () => {
    renderPage();
    expect(screen.getByText('Form')).toBeInTheDocument();
  });

  it('renders the DataTable section heading', () => {
    renderPage();
    expect(screen.getByText('DataTable')).toBeInTheDocument();
  });

  it('renders the page title', () => {
    renderPage();
    expect(screen.getByText('UI Kitchen Sink')).toBeInTheDocument();
  });
});
