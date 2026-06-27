import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import InboxPage from './InboxPage';

const get = vi.fn();
const post = vi.fn().mockResolvedValue({ data: {} });

vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
}));
vi.mock('../../../store/marketingAuthStore', () => ({
  useMarketingAuthStore: () => ({ accessToken: 'tok', user: { role: 'MANAGER' } }),
}));
vi.mock('../../../lib/env', () => ({ API_URL: 'http://test' }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, d?: { defaultValue?: string } | string) =>
      (typeof d === 'string' ? d : d?.defaultValue) ?? k,
    i18n: { language: 'en' },
  }),
}));

// Isolate InboxPage's own state logic from the heavy child trees: the
// ConversationList exposes onSelect, the ThreadPane exposes the controlled draft.
vi.mock('./ConversationList', () => ({
  ConversationList: ({ conversations, onSelect }: any) => (
    <div>
      {(conversations ?? []).map((c: any) => (
        <button key={c.id} onClick={() => onSelect(c.id)}>
          {c.id}
        </button>
      ))}
    </div>
  ),
}));
vi.mock('./ThreadPane', () => ({
  ThreadPane: ({ draft, onDraftChange }: any) => (
    <input aria-label="composer" value={draft} onChange={(e: any) => onDraftChange(e.target.value)} />
  ),
}));
vi.mock('./LeadContextPane', () => ({ LeadContextPane: () => null }));

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('InboxPage — composer draft isolation', () => {
  beforeEach(() => {
    // The live SSE stream uses fetch(); reject it so the component renders without
    // a real connection (the effect just schedules a reconnect, harmless here).
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no sse')));
    get.mockReset();
    post.mockClear();
    get.mockImplementation((url: string) =>
      url === '/conversations'
        ? Promise.resolve({
            data: [
              { id: 'cA', status: 'OPEN', aiPaused: false, unreadCount: 0 },
              { id: 'cB', status: 'OPEN', aiPaused: false, unreadCount: 0 },
            ],
          })
        : Promise.resolve({
            data: { conversation: { id: 'x', aiPaused: false }, lead: null, messages: [], channel: null },
          }),
    );
  });

  it('clears the reply draft when switching conversations (no cross-customer leak)', async () => {
    render(<InboxPage />, { wrapper });

    await userEvent.click(await screen.findByRole('button', { name: 'cA' }));
    const composer = screen.getByLabelText('composer') as HTMLInputElement;
    await userEvent.type(composer, 'private note for A');
    expect(composer.value).toBe('private note for A');

    // Switching to another customer's thread must NOT carry the half-typed reply.
    await userEvent.click(screen.getByRole('button', { name: 'cB' }));
    expect((screen.getByLabelText('composer') as HTMLInputElement).value).toBe('');
  });
});
