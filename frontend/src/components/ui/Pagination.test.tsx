import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Pagination } from './Pagination';

describe('Pagination', () => {
  function renderPagination(page: number, pageCount: number, onPage = vi.fn()) {
    return { onPage, ...render(<Pagination page={page} pageCount={pageCount} onPage={onPage} />) };
  }

  it('renders prev and next buttons', () => {
    renderPagination(2, 5);
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeInTheDocument();
  });

  it('renders page number buttons', () => {
    renderPagination(1, 5);
    for (let i = 1; i <= 5; i++) {
      expect(screen.getByRole('button', { name: `Page ${i}` })).toBeInTheDocument();
    }
  });

  it('active page button has aria-current="page"', () => {
    renderPagination(3, 5);
    expect(screen.getByRole('button', { name: 'Page 3' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Page 1' })).not.toHaveAttribute('aria-current');
  });

  it('clicking next calls onPage(page + 1)', async () => {
    const user = userEvent.setup();
    const { onPage } = renderPagination(2, 5);
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(onPage).toHaveBeenCalledWith(3);
  });

  it('clicking prev calls onPage(page - 1)', async () => {
    const user = userEvent.setup();
    const { onPage } = renderPagination(3, 5);
    await user.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(onPage).toHaveBeenCalledWith(2);
  });

  it('clicking a page number calls onPage with that number', async () => {
    const user = userEvent.setup();
    const { onPage } = renderPagination(1, 5);
    await user.click(screen.getByRole('button', { name: 'Page 4' }));
    expect(onPage).toHaveBeenCalledWith(4);
  });

  it('prev button is disabled on page 1', () => {
    renderPagination(1, 5);
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
  });

  it('next button is disabled on last page', () => {
    renderPagination(5, 5);
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
  });

  it('prev button is enabled when not on first page', () => {
    renderPagination(2, 5);
    expect(screen.getByRole('button', { name: 'Previous page' })).not.toBeDisabled();
  });

  it('next button is enabled when not on last page', () => {
    renderPagination(4, 5);
    expect(screen.getByRole('button', { name: 'Next page' })).not.toBeDisabled();
  });

  it('renders navigation landmark', () => {
    renderPagination(1, 3);
    expect(screen.getByRole('navigation', { name: 'Pagination' })).toBeInTheDocument();
  });
});
