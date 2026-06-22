import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OAuthConnectButtons } from './OAuthConnectButtons';
import { AccountSelectDialog } from './AccountSelectDialog';
import type { NetworkStatus } from './types';

const getMock = vi.fn();
const postMock = vi.fn().mockResolvedValue({ data: {} });
vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: (...a: unknown[]) => getMock(...a),
    post: (...a: unknown[]) => postMock(...a),
  },
}));

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

const status: NetworkStatus = {
  FACEBOOK: true,
  INSTAGRAM: true,
  LINKEDIN: false,
  TIKTOK: false,
  secretBoxConfigured: true,
};

describe('OAuthConnectButtons', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    postMock.mockResolvedValue({ data: { authorizeUrl: 'https://provider/auth' } });
    // jsdom: make location.href assignable without navigating
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { href: '' },
    });
  });

  it('renders a button only for configured networks', () => {
    wrap(<OAuthConnectButtons status={status} />);
    expect(screen.getByText(/Connect Facebook/i)).toBeTruthy();
    expect(screen.getByText(/Connect Instagram/i)).toBeTruthy();
    expect(screen.queryByText(/Connect LinkedIn/i)).toBeNull();
  });

  it('starts OAuth and redirects to the authorize URL', async () => {
    wrap(<OAuthConnectButtons status={status} />);
    fireEvent.click(screen.getByText(/Connect Facebook/i));
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/social/oauth/facebook/start'),
    );
    await waitFor(() => expect(window.location.href).toBe('https://provider/auth'));
  });
});

describe('AccountSelectDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMock.mockResolvedValue({
      data: {
        network: 'FACEBOOK',
        assets: [
          { externalId: 'P1', displayName: 'Acme', accountType: 'PAGE' },
          { externalId: 'IG1', displayName: '@acme', accountType: 'IG_BUSINESS' },
        ],
      },
    });
    postMock.mockResolvedValue({ data: { connected: 1 } });
  });

  it('lists pending assets and confirms the selection', async () => {
    const onOpenChange = vi.fn();
    wrap(<AccountSelectDialog pendingId="pend-1" onOpenChange={onOpenChange} />);

    await waitFor(() => expect(screen.getByText('Acme')).toBeTruthy());
    expect(screen.getByText('@acme')).toBeTruthy();

    fireEvent.click(screen.getByText(/Connect selected/i));
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith(
        '/social/oauth/pending/pend-1/confirm',
        { selected: ['P1', 'IG1'] },
      ),
    );
  });
});
