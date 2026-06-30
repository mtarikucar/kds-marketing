import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
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

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('BrandingSettingsPage — logo upload', () => {
  it('only accepts the image types the backend allows (png/jpeg/webp, not svg)', () => {
    // The server rejects image/svg+xml (it can carry embedded scripts), so the
    // file picker must not advertise it — else picking an SVG silently fails.
    const { container } = render(<BrandingSettingsPage />, { wrapper });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.accept).toBe('image/png,image/jpeg,image/webp');
    expect(input.accept).not.toContain('svg');
  });
});
