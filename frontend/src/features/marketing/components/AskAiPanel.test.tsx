import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AskAiPanel from './AskAiPanel';

const post = vi.fn();
vi.mock('../api/marketingApi', () => ({
  default: { post: (...a: unknown[]) => post(...a) },
}));
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

describe('AskAiPanel', () => {
  beforeEach(() => {
    post.mockReset();
    // Never resolves → the first ask stays pending while we press Enter again.
    post.mockImplementation(() => new Promise(() => {}));
  });

  it('ignores a second Enter while a question is still in flight (no double credit charge)', async () => {
    const user = userEvent.setup();
    render(<AskAiPanel />, { wrapper });

    await user.click(screen.getByTitle('Ask AI')); // open the panel
    await user.type(screen.getByPlaceholderText(/ask a question/i), 'how many leads');
    await user.keyboard('{Enter}'); // first submit → pending
    await user.keyboard('{Enter}'); // second Enter while pending → must be ignored

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('/ai/ask', { question: 'how many leads' });
  });
});
