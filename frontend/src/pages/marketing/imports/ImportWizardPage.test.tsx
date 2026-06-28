import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import ImportWizardPage from './ImportWizardPage';

const get = vi.fn();
const post = vi.fn();
vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: (...args: unknown[]) => get(...args),
    post: (...args: unknown[]) => post(...args),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string | string[], opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ??
      (Array.isArray(key) ? key[0] : key),
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

describe('ImportWizardPage', () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    get.mockResolvedValue({ data: [] });
    post.mockResolvedValue({
      data: {
        jobId: 'job-1',
        headers: ['name', 'email'],
        suggestedMapping: { name: 'businessName', email: 'email' },
        total: 2,
      },
    });
  });

  it('mounts and shows the Upload step', () => {
    render(<ImportWizardPage />, { wrapper });
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.getByText('Upload')).toBeInTheDocument();
    expect(screen.getByText('Map columns')).toBeInTheDocument();
    expect(screen.getByText('Options')).toBeInTheDocument();
    expect(screen.getByText('Progress')).toBeInTheDocument();
    expect(screen.getByLabelText(/select csv file/i)).toBeInTheDocument();
  });

  it('shows the import history section', () => {
    render(<ImportWizardPage />, { wrapper });
    expect(screen.getByText('Import history')).toBeInTheDocument();
  });

  it('navigates to Map step after a file is uploaded', async () => {
    const { container } = render(<ImportWizardPage />, { wrapper });

    const csvContent = 'name,email\nAcme,acme@example.com\nFoo,foo@example.com\n';
    const file = new File([csvContent], 'leads.csv', { type: 'text/csv' });

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    await userEvent.upload(input, file);

    expect(await screen.findByText('Map columns', { selector: 'span.font-medium' })).toBeInTheDocument();
  });

  // Regression: the history "Results" cell rendered a stray double-slash
  // ("+10 / ~3 / /2"). Each count must carry a single, distinct prefix.
  it('renders the results counts without a stray double-slash', async () => {
    get.mockImplementation((url: string) =>
      url === '/imports'
        ? Promise.resolve({
            data: [
              {
                id: 'j1',
                filename: 'leads.csv',
                status: 'DONE',
                total: 15,
                created: 10,
                updated: 3,
                skipped: 2,
                failed: 0,
                createdAt: '2026-06-01T00:00:00Z',
                errors: [],
              },
            ],
          })
        : Promise.resolve({ data: [] }),
    );

    render(<ImportWizardPage />, { wrapper });

    const cell = await screen.findByText(/\+10 \/ ~3 \/ =2/);
    expect(cell).toBeInTheDocument();
    expect(cell.textContent).not.toContain('/ /');
  });
});
