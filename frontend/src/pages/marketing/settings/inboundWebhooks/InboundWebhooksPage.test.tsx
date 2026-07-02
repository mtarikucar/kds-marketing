import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import InboundWebhooksPage from './index';

const list = vi.fn();
const rotate = vi.fn();
vi.mock('../../../../features/marketing/api/inbound-webhooks.service', () => ({
  listInboundWebhooks: (...a: unknown[]) => list(...a),
  createInboundWebhook: vi.fn(),
  updateInboundWebhook: vi.fn(),
  rotateInboundWebhookSecret: (...a: unknown[]) => rotate(...a),
  deleteInboundWebhook: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, dv?: string | { defaultValue?: string }) =>
      (typeof dv === 'string' ? dv : dv?.defaultValue) ?? key,
    i18n: { language: 'en' },
  }),
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const hook = {
  id: 'w1',
  name: 'Zapier',
  url: 'https://x/api/hooks/w1',
  enabled: true,
  receivedCount: 5,
  lastReceivedAt: null,
};

describe('InboundWebhooksPage — rotate-secret confirmation', () => {
  beforeEach(() => {
    list.mockReset();
    rotate.mockReset();
    list.mockResolvedValue([hook]);
    rotate.mockResolvedValue({ ...hook, secret: 'new-secret' });
  });

  it('confirms before rotating — a stray click must not silently break live integrations', async () => {
    const user = userEvent.setup();
    render(<InboundWebhooksPage />, { wrapper });
    await screen.findByText('Zapier');

    // Rotation is irreversible (old secret dies instantly), so the row button must
    // open a confirm, NOT rotate on the first click.
    await user.click(screen.getByRole('button', { name: /rotate secret/i }));
    expect(rotate).not.toHaveBeenCalled();

    // Confirming (distinct label) actually rotates.
    await user.click(await screen.findByRole('button', { name: 'Rotate now' }));
    await waitFor(() => expect(rotate).toHaveBeenCalledWith('w1'));
  });
});
