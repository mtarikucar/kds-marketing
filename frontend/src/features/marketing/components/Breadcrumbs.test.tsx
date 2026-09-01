import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n from 'i18next';
import '@/i18n/config';
import Breadcrumbs from './Breadcrumbs';
import { useBreadcrumbStore } from '../hooks/useBreadcrumbLabel';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Breadcrumbs />
    </MemoryRouter>,
  );
}

describe('Breadcrumbs', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    useBreadcrumbStore.setState({ detailLabel: null });
  });
  afterEach(() => useBreadcrumbStore.setState({ detailLabel: null }));

  it('falls back to a generic Detail leaf when no record name is registered', () => {
    renderAt('/leads/abc-123');
    expect(screen.getByText('Detail')).toBeInTheDocument();
    // "People", not "Leads": the menu entry was renamed when /inbox and /leads
    // collapsed into one, because the surface it opens is headed Kişiler and a
    // trail that disagrees with the h1 is worse than no trail at all.
    expect(screen.getByText('People')).toBeInTheDocument();
  });

  // `/inbox` is an ALIAS of the /leads item now, with no menu entry of its own.
  // The breadcrumb is exactly what an alias must not lose: someone arriving on
  // their old bookmark still has to be told where they are.
  it('names the same page when it is reached by its alias', () => {
    renderAt('/inbox');
    expect(screen.getByText('People')).toBeInTheDocument();
  });

  it('shows the record name when a detail page registers one', () => {
    useBreadcrumbStore.setState({ detailLabel: 'Acme Corp' });
    renderAt('/leads/abc-123');
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
    expect(screen.queryByText('Detail')).not.toBeInTheDocument();
  });

  /**
   * Six pages left the Inbox menu on 2026-09-01 and stayed routes. A trail
   * built from the hubs alone would render NOTHING on any of them — the one
   * state this component treats as "I do not know where you are" — so a page
   * that is deliberately unlisted would have become a page that cannot say its
   * own name, which is a worse regression than the menu entry it lost.
   *
   * No group segment: an unlisted destination belongs to no surface, and
   * inventing one would be the trail disagreeing with the rail again.
   */
  it('names an unlisted destination, which has no hub to be filed under', () => {
    renderAt('/companies');
    expect(screen.getByText('Companies')).toBeInTheDocument();
    expect(screen.queryByText('Inbox')).not.toBeInTheDocument();
  });

  it('still resolves a detail route under an unlisted destination', () => {
    useBreadcrumbStore.setState({ detailLabel: 'Acme Corp' });
    renderAt('/documents/xyz');
    expect(screen.getByText('Documents')).toBeInTheDocument();
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
  });

  it('keeps New/Edit leaves literal even when a record name is set', () => {
    useBreadcrumbStore.setState({ detailLabel: 'Acme Corp' });
    renderAt('/leads/new');
    expect(screen.getByText('New')).toBeInTheDocument();
    expect(screen.queryByText('Acme Corp')).not.toBeInTheDocument();
  });
});
