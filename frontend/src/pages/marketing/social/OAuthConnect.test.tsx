/**
 * The post-consent account picker.
 *
 * `OAuthConnectButtons` used to be tested here too. It was a second, parallel
 * connect surface that NOTHING imported — the Account Center owns the connect
 * affordance now — and it was the only caller that started an OAuth flow
 * without an `origin`, i.e. the only way to reach the callback's stranded
 * landing path. Deleting it removes that caller; its live test suite was the
 * only thing keeping a dead component looking maintained.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AccountSelectDialog } from './AccountSelectDialog';

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

    // The selection must already be there in the SAME paint that first shows
    // the list. It used to be applied by an effect one commit later, which left
    // a frame where every box was empty and the primary action was disabled on
    // a dialog that had just finished loading — and made this test flaky,
    // because a click landing in that frame hit a disabled button and nothing
    // was ever posted.
    expect(screen.getByText(/Connect selected/i).closest('button')).not.toBeDisabled();

    fireEvent.click(screen.getByText(/Connect selected/i));
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith(
        '/social/oauth/pending/pend-1/confirm',
        { selected: ['P1', 'IG1'] },
      ),
    );
  });

  /**
   * Error is not empty. A pending hand-off that cannot be LOADED — it expired
   * (they are valid 15 minutes), or it belongs to another workspace — used to
   * render the same panel as a successful load of zero assets: "No connectable
   * accounts found — make sure you granted access to at least one page". That
   * sends someone who consented correctly off to re-check permissions that were
   * never the problem, and the one action that would work (start again) is the
   * one it does not mention.
   */
  it('says the attempt could not be loaded — not that the user granted nothing', async () => {
    getMock.mockRejectedValue(new Error('Request failed with status code 400'));
    const onOpenChange = vi.fn();
    wrap(<AccountSelectDialog pendingId="pend-expired" onOpenChange={onOpenChange} />);

    expect(await screen.findByText(/no longer available/i)).toBeTruthy();
    expect(screen.getByText(/start the connection again/i)).toBeTruthy();
    expect(screen.queryByText(/granted access/i)).toBeNull();
  });

  it('still says "nothing to connect" when the hand-off loads with no assets', async () => {
    getMock.mockResolvedValue({ data: { network: 'FACEBOOK', assets: [] } });
    const onOpenChange = vi.fn();
    wrap(<AccountSelectDialog pendingId="pend-empty" onOpenChange={onOpenChange} />);

    expect(await screen.findByText(/granted access/i)).toBeTruthy();
    expect(screen.queryByText(/no longer available/i)).toBeNull();
  });

  it('includes provisionMessaging when the per-account messaging toggle is on', async () => {
    const onOpenChange = vi.fn();
    wrap(<AccountSelectDialog pendingId="pend-1" onOpenChange={onOpenChange} />);

    await waitFor(() => expect(screen.getByText('Acme')).toBeTruthy());
    // Both Page + IG are selected by default → their messaging toggles render.
    fireEvent.click(screen.getByLabelText('messaging:P1'));

    fireEvent.click(screen.getByText(/Connect selected/i));
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith(
        '/social/oauth/pending/pend-1/confirm',
        { selected: ['P1', 'IG1'], provisionMessaging: ['P1'] },
      ),
    );
  });
});
