import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import ImportWizardPage from './ImportWizardPage';

vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: vi.fn().mockResolvedValue({ data: [] }),
    post: vi.fn().mockResolvedValue({
      data: {
        jobId: 'job-1',
        headers: ['name', 'email'],
        suggestedMapping: { name: 'businessName', email: 'email' },
        total: 2,
      },
    }),
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
  beforeEach(() => vi.clearAllMocks());

  it('mounts and shows the Upload step', () => {
    render(<ImportWizardPage />, { wrapper });
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    // Step indicator shows step 1
    expect(screen.getByText('Upload')).toBeInTheDocument();
    expect(screen.getByText('Map columns')).toBeInTheDocument();
    expect(screen.getByText('Options')).toBeInTheDocument();
    expect(screen.getByText('Progress')).toBeInTheDocument();
    // Drop zone is present
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

    // The file input is visually hidden (sr-only); target it directly.
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    await userEvent.upload(input, file);

    // Wait for the Map step to appear (the API mock returns suggestedMapping)
    expect(await screen.findByText('Map columns', { selector: 'span.font-medium' })).toBeInTheDocument();
  });
});
