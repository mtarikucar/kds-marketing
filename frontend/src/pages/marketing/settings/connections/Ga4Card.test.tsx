import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { toast } from 'sonner';
import marketingApi from '../../../../features/marketing/api/marketingApi';
import { Ga4Card } from './Ga4Card';

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

function renderCard(entry = '/accounts?tab=integrations') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}>
        <Ga4Card />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function status(s: Record<string, unknown>) {
  api.get.mockImplementation((url: string) => {
    if (url === '/integrations/ga4/status') return Promise.resolve({ data: { configured: true, connected: false, ...s } });
    if (url === '/integrations/ga4/properties')
      return Promise.resolve({ data: [{ propertyId: 'properties/123', displayName: 'figurunica.com', account: 'Figurunica' }] });
    if (url === '/integrations/ga4/connect') return Promise.resolve({ data: { url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' } });
    return Promise.reject(new Error(`unexpected ${url}`));
  });
}

describe('Ga4Card (Account Center → Integrations)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.post.mockResolvedValue({ data: {} });
    api.delete.mockResolvedValue({ data: {} });
  });

  it('renders nothing while the feature is off on the server (404)', async () => {
    api.get.mockRejectedValue({ response: { status: 404 } });
    const { container } = renderCard();
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('says so when the server has no Google OAuth client', async () => {
    status({ configured: false });
    renderCard();
    expect(await screen.findByText(/not configured on this server/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /connect/i })).not.toBeInTheDocument();
  });

  it('Connect opens the Google consent URL the server built', async () => {
    status({});
    const assign = vi.fn();
    Object.defineProperty(window, 'location', { value: { ...window.location, assign }, writable: true });
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: /connect google analytics/i }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?x=1'));
    expect(api.get).toHaveBeenCalledWith('/integrations/ga4/connect');
  });

  it('after connecting, asks for the property and saves the choice', async () => {
    status({ connected: true, propertyId: null });
    renderCard();
    const select = await screen.findByLabelText(/ga4 property/i);
    await screen.findByRole('option', { name: /figurunica\.com/ });
    fireEvent.change(select, { target: { value: 'properties/123' } });
    fireEvent.click(screen.getByRole('button', { name: /save property/i }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/integrations/ga4/property', { propertyId: 'properties/123' }));
  });

  it('shows the connected property and its last sync, and disconnects after confirmation', async () => {
    status({ connected: true, propertyId: 'properties/123', propertyName: 'figurunica.com', lastSyncedAt: '2026-10-21T08:15:00.000Z', enabled: true });
    renderCard();
    expect(await screen.findByText('figurunica.com')).toBeInTheDocument();
    expect(screen.getByText(/last synced/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^disconnect$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^disconnect ga4$/i }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/integrations/ga4'));
  });

  it('asks to reconnect when Google revoked access', async () => {
    status({ connected: true, propertyId: 'properties/123', propertyName: 'x', enabled: false, lastError: 'REAUTH_REQUIRED' });
    renderCard();
    expect(await screen.findByText(/access was revoked/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reconnect/i })).toBeInTheDocument();
  });

  it('turns the OAuth callback result into a toast', async () => {
    status({ connected: true, propertyId: null });
    renderCard('/accounts?tab=integrations&ga4=connected');
    await waitFor(() => expect(toast.success).toHaveBeenCalled());

    vi.clearAllMocks();
    status({});
    renderCard('/accounts?tab=integrations&ga4=error&reason=exchange_redirect_uri_mismatch');
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/redirect/i)));
  });
});
