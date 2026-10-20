import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import marketingApi from '../../../../features/marketing/api/marketingApi';
import { SiteTrackingCard } from './SiteTrackingCard';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../../features/marketing/api/marketingApi', () => ({
  default: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ?? key,
    i18n: { language: 'en' },
  }),
}));

const api = marketingApi as unknown as { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
const KEY = 'jst_0123456789abcdef0123456789abcdef';
const SNIPPET = `<script src="https://jeetagrowth.com/jeeta.js" data-site-key="${KEY}" async></script>`;

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SiteTrackingCard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('SiteTrackingCard (site snippet keys)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.post.mockResolvedValue({ data: { id: 'k2', key: KEY, snippet: SNIPPET } });
    api.delete.mockResolvedValue({ data: {} });
  });

  it('renders nothing while site tracking is off on the server (404)', async () => {
    api.get.mockRejectedValue({ response: { status: 404 } });
    const { container } = renderCard();
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/site-tracking/keys'));
    expect(container.textContent).toBe('');
  });

  it('shows each active key with the tag to paste', async () => {
    api.get.mockResolvedValue({
      data: [{ id: 'k1', key: KEY, label: 'Store', allowedHosts: ['figurunica.com'], status: 'ACTIVE', snippet: SNIPPET }],
    });
    renderCard();
    expect(await screen.findByText(SNIPPET)).toBeInTheDocument();
    expect(screen.getByText('figurunica.com')).toBeInTheDocument();
  });

  it('creates a key restricted to the hosts typed in', async () => {
    api.get.mockResolvedValue({ data: [] });
    renderCard();
    fireEvent.change(await screen.findByLabelText(/allowed hosts/i), { target: { value: 'figurunica.com, www.figurunica.com' } });
    fireEvent.click(screen.getByRole('button', { name: /create snippet key/i }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/site-tracking/keys', {
        label: undefined,
        allowedHosts: ['figurunica.com', 'www.figurunica.com'],
      }),
    );
  });

  it('revokes a key after confirmation', async () => {
    api.get.mockResolvedValue({
      data: [{ id: 'k1', key: KEY, label: null, allowedHosts: [], status: 'ACTIVE', snippet: SNIPPET }],
    });
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: /^revoke$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^revoke key$/i }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/site-tracking/keys/k1'));
  });
});
