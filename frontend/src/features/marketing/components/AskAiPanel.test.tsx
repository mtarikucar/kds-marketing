import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import AskAiPanel from './AskAiPanel';
import { useMarketingAuthStore } from '@/store/marketingAuthStore';

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

// MemoryRouter: the out-of-credits pane offers a real <Link to="/billing">,
// which is the whole difference from the old plain-text "add credits from
// Billing" that pointed nowhere.
function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

function setRole(role: 'OWNER' | 'MANAGER' | 'REP') {
  useMarketingAuthStore.setState({
    user: { id: 'u1', workspaceId: 'w1', email: 'a@b.c', firstName: 'A', lastName: 'B', role },
  });
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

  /**
   * The backend returns 403 for TWO different situations — the feature is not
   * entitled (FEATURE_NOT_IN_PACKAGE) and the monthly AI credits are spent
   * (AI_CREDITS_EXHAUSTED) — and both used to render "not in your plan,
   * upgrade". That told a paying customer to buy something they already own,
   * and it got worse with the move to one plan plus low included credits,
   * where running out of credits is the NORMAL case.
   */
  async function ask(user: ReturnType<typeof userEvent.setup>) {
    render(<AskAiPanel />, { wrapper });
    await user.click(screen.getByTitle('Ask AI'));
    await user.type(screen.getByPlaceholderText(/ask a question/i), 'how many leads');
    await user.keyboard('{Enter}');
  }

  const creditsRejection = {
    response: { status: 403, data: { code: 'AI_CREDITS_EXHAUSTED' } },
  };

  it('gives an OWNER a real link to /billing, not the word "Billing"', async () => {
    setRole('OWNER');
    post.mockRejectedValue(creditsRejection);
    await ask(userEvent.setup());

    expect(await screen.findByText(/buy a pack in Billing/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /add credits/i })).toHaveAttribute('href', '/billing');
    expect(screen.queryByText(/not in your plan/i)).not.toBeInTheDocument();
  });

  it('tells a MANAGER who can buy, and still offers the page they can open', async () => {
    setRole('MANAGER');
    post.mockRejectedValue(creditsRejection);
    await ask(userEvent.setup());

    expect(await screen.findByText(/only the workspace owner can buy a pack/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open billing/i })).toHaveAttribute('href', '/billing');
  });

  /** /billing is managerOnly in the nav, so a REP gets the name, not a link. */
  it('names the owner for a REP and offers no dead-end link', async () => {
    setRole('REP');
    post.mockRejectedValue(creditsRejection);
    await ask(userEvent.setup());

    expect(await screen.findByText(/only the workspace owner can buy a pack/i)).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('still shows the upgrade hint when the feature genuinely is not entitled', async () => {
    post.mockRejectedValue({
      response: { status: 403, data: { code: 'FEATURE_NOT_IN_PACKAGE' } },
    });
    await ask(userEvent.setup());

    expect(await screen.findByText(/not in your plan/i)).toBeInTheDocument();
  });
});
