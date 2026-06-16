import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import ResearchSettingsPage from './ResearchSettingsPage';

vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: vi.fn().mockResolvedValue({ data: [] }),
    post: vi.fn().mockResolvedValue({ data: { id: '1', token: 'tok_abc123' } }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ?? key,
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

describe('ResearchSettingsPage', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('mounts and renders the page heading', () => {
    render(<ResearchSettingsPage />, { wrapper });
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('renders a "New research profile" button', () => {
    render(<ResearchSettingsPage />, { wrapper });
    const btns = screen.getAllByRole('button', { name: /new research profile|research\.newProfile/i });
    expect(btns.length).toBeGreaterThan(0);
  });

  it('opens the create profile dialog when "New research profile" is clicked', async () => {
    render(<ResearchSettingsPage />, { wrapper });
    const btns = screen.getAllByRole('button', { name: /new research profile|research\.newProfile/i });
    await userEvent.click(btns[0]);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('shows validation error on short ICP description', async () => {
    render(<ResearchSettingsPage />, { wrapper });
    const btns = screen.getAllByRole('button', { name: /new research profile|research\.newProfile/i });
    await userEvent.click(btns[0]);
    // Fill name but leave icpDescription too short
    const nameInput = await screen.findByPlaceholderText(/TR cafes/i);
    await userEvent.type(nameInput, 'Test profile');
    const saveBtn = await screen.findByRole('button', { name: /^save$|common\.save/i });
    await userEvent.click(saveBtn);
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.length).toBeGreaterThan(0);
  });
});
