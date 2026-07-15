import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Deterministic labels (English defaults) regardless of the active language.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, d?: string) => d ?? _k }),
}));

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../api/marketingApi', () => ({ default: { get, post } }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import CallControlsPanel, { type CallControlsPanelProps } from './CallControlsPanel';

const base: CallControlsPanelProps = {
  callId: 'call-A',
  sipActive: true,
  held: false,
  muted: false,
  onHold: () => {},
  onUnhold: () => {},
  onMute: () => {},
  onUnmute: () => {},
  onDtmf: () => {},
  onCallEnded: () => {},
};

function makeQC() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('CallControlsPanel — transient state does not leak between calls', () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    get.mockResolvedValue({ data: [] });
    post.mockResolvedValue({ data: {} });
  });

  it('resets the Attended flag and closes the transfer dialog when the call leaves', () => {
    const qc = makeQC();
    const view = (props: CallControlsPanelProps) => (
      <QueryClientProvider client={qc}>
        <CallControlsPanel {...props} />
      </QueryClientProvider>
    );
    const { rerender } = render(view(base));

    // Open Transfer on call A and tick "Attended".
    fireEvent.click(screen.getByRole('button', { name: 'Transfer' }));
    const attended = screen.getByRole('checkbox');
    fireEvent.click(attended);
    expect(attended).toBeChecked();

    // Call A ends — the panel loses its call (returns null; the reset effect fires).
    rerender(view({ ...base, callId: null, sipActive: false }));
    // Call B arrives on the SAME (reused) panel instance.
    rerender(view({ ...base, callId: 'call-B', sipActive: true }));

    // The transfer dialog did NOT auto-reopen on call B (finding #4)…
    expect(screen.queryByRole('checkbox')).toBeNull();

    // …and reopening Transfer shows the checkbox unticked again (finding #2).
    fireEvent.click(screen.getByRole('button', { name: 'Transfer' }));
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  it('closes the DTMF keypad when the call leaves so it does not reappear on the next call', () => {
    const qc = makeQC();
    const view = (props: CallControlsPanelProps) => (
      <QueryClientProvider client={qc}>
        <CallControlsPanel {...props} />
      </QueryClientProvider>
    );
    const { rerender } = render(view(base));

    // Open the keypad on call A — the DTMF grid renders (digit "7" is unique to it).
    fireEvent.click(screen.getByRole('button', { name: 'Keypad' }));
    expect(screen.getByRole('button', { name: '7' })).toBeInTheDocument();

    // Call ends, then a new call starts.
    rerender(view({ ...base, callId: null, sipActive: false }));
    rerender(view({ ...base, callId: 'call-B', sipActive: true }));

    // Keypad is not auto-open on the new call.
    expect(screen.queryByRole('button', { name: '7' })).toBeNull();
  });
});
