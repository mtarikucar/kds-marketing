import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import BrandingSettingsPage from './BrandingSettingsPage';

vi.mock('../../features/marketing/api/marketingApi', () => ({
  default: {
    get: vi.fn().mockResolvedValue({ data: { brandName: '', accentColor: '#1e40af', logoUrl: null } }),
    post: vi.fn().mockResolvedValue({ data: {} }),
  },
}));
vi.mock('../../lib/env', () => ({ API_URL: 'http://test/api' }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, d?: unknown) =>
      (typeof d === 'string' ? d : (d as { defaultValue?: string })?.defaultValue) ?? _k,
    i18n: { language: 'en' },
  }),
}));
// Stub the heavy embedded tab pages so the shell renders in isolation.
vi.mock('./BrandKitPage', () => ({ default: () => <div>kit-tab-body</div> }));
vi.mock('./brandBrain/BrandBrainPage', () => ({ default: () => <div>brain-tab-body</div> }));

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <BrandingSettingsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('BrandingSettingsPage — unified Brand tabs', () => {
  it('renders the three brand tabs with Business selected by default', () => {
    renderAt('/branding');
    for (const label of ['Business', 'Brand Kit', 'Brand Brain']) {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole('tab', { name: 'Business' })).toHaveAttribute('data-state', 'active');
  });

  it('honors the ?tab=kit deep link (Brand Kit selected)', async () => {
    renderAt('/branding?tab=kit');
    expect(screen.getByRole('tab', { name: 'Brand Kit' })).toHaveAttribute('data-state', 'active');
    expect(await screen.findByText('kit-tab-body')).toBeInTheDocument();
  });

  it('honors the ?tab=brain deep link (Brand Brain selected)', async () => {
    renderAt('/branding?tab=brain');
    expect(screen.getByRole('tab', { name: 'Brand Brain' })).toHaveAttribute('data-state', 'active');
    expect(await screen.findByText('brain-tab-body')).toBeInTheDocument();
  });

  it('falls back to Business on an unknown ?tab= value', () => {
    renderAt('/branding?tab=nope');
    expect(screen.getByRole('tab', { name: 'Business' })).toHaveAttribute('data-state', 'active');
  });

  it('switches tabs on click (deep-linkable ?tab= write)', async () => {
    const user = userEvent.setup();
    renderAt('/branding');
    await user.click(screen.getByRole('tab', { name: 'Brand Brain' }));
    expect(screen.getByRole('tab', { name: 'Brand Brain' })).toHaveAttribute('data-state', 'active');
    expect(await screen.findByText('brain-tab-body')).toBeInTheDocument();
  });
});

describe('BrandingSettingsPage — logo upload (Business tab)', () => {
  it('only accepts the image types the backend allows (png/jpeg/webp, not svg)', () => {
    // The server rejects image/svg+xml (it can carry embedded scripts), so the
    // file picker must not advertise it — else picking an SVG silently fails.
    const { container } = renderAt('/branding');
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.accept).toBe('image/png,image/jpeg,image/webp');
    expect(input.accept).not.toContain('svg');
  });
});
