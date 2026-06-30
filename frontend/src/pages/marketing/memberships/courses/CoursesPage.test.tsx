import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import CoursesPage from './CoursesPage';
import marketingApi from '../../../../features/marketing/api/marketingApi';

const mockApi = marketingApi as unknown as {
  get: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
};

vi.mock('../../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: vi.fn().mockResolvedValue({ data: [] }),
    post: vi.fn().mockResolvedValue({ data: { id: 'c1' } }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string | string[], opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ?? (Array.isArray(key) ? key[0] : key),
    i18n: { language: 'en' },
  }),
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('CoursesPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mounts and renders the page heading', () => {
    render(<CoursesPage />, { wrapper });
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('opens the create dialog and validates an empty title', async () => {
    render(<CoursesPage />, { wrapper });
    const newBtn = screen.getAllByRole('button', { name: /new course/i })[0];
    await userEvent.click(newBtn);
    expect(await screen.findByRole('heading', { level: 2 })).toBeInTheDocument();
    const candidates = screen.getAllByRole('button', { name: /new course|save/i });
    const saveBtn = candidates[candidates.length - 1];
    await userEvent.click(saveBtn);
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.length).toBeGreaterThan(0);
  });

  it('archives a course from the row actions menu (PATCH status=ARCHIVED)', async () => {
    mockApi.get.mockResolvedValue({
      data: [
        { id: 'c1', title: 'Intro to Coffee', slug: 'intro-to-coffee', status: 'PUBLISHED', priceCents: null, currency: null },
      ],
    });
    render(<CoursesPage />, { wrapper });
    expect(await screen.findByText('Intro to Coffee')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /actions/i }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /archive/i }));

    // Archiving is the GHL-style soft-delete: it keeps the course (and its
    // enrollments + issued certificates) while retiring it from the catalog —
    // unlike Delete, which the backend now refuses once anyone has enrolled.
    expect(mockApi.patch).toHaveBeenCalledWith('/courses/c1', { status: 'ARCHIVED' });
  });
});
