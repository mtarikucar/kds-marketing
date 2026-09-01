import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import AiStudioPage from './AiStudioPage';
import * as mediaService from '../../../features/marketing/api/media.service';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';

const navigate = vi.fn();
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

vi.mock('../../../features/marketing/api/media.service', () => ({
  generateMedia: vi.fn(),
  listGenerations: vi.fn(),
  getGeneration: vi.fn(),
  regenerateMedia: vi.fn(),
  deleteGeneration: vi.fn(),
  isTerminal: (s: string) => s === 'READY' || s === 'FAILED' || s === 'BLOCKED',
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string | string[], opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ?? (Array.isArray(key) ? key[0] : key),
    i18n: { language: 'en' },
  }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// The page gates its whole surface behind the `mediaGen` entitlement (plan-audit
// #126). Render it in the entitled state — matching GrowthStudioPage.test.tsx —
// so these tests exercise the generate panel + library, not the UpgradeCallout.
vi.mock('../../../features/marketing/hooks/useEntitlements', () => ({
  useEntitlements: () => ({ has: () => true, isLoading: false, isError: false, features: {}, entitledModules: [] }),
}));

const READY = {
  id: 'a-ready', type: 'IMAGE', status: 'READY', provider: 'fal', model: 'fal-ai/qwen-image',
  prompt: 'a cat', params: {}, url: 'https://r2/img.png', r2Key: 'social/ws/img.png',
  mime: 'image/png', createdById: 'u1', createdAt: '', updatedAt: '',
};

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('AiStudioPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mediaService.listGenerations).mockResolvedValue([READY] as never);
    vi.mocked(mediaService.getGeneration).mockResolvedValue(READY as never);
    vi.mocked(mediaService.generateMedia).mockResolvedValue({ assetId: 'a-new' });
  });

  it('renders the page heading and the library asset from listGenerations', async () => {
    render(<AiStudioPage />, { wrapper });
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(await screen.findByText(/a cat/i)).toBeInTheDocument();
  });

  it('submitting the prompt calls generateMedia with the panel values', async () => {
    render(<AiStudioPage />, { wrapper });
    await userEvent.type(screen.getByRole('textbox', { name: /prompt/i }), 'a dog');
    await userEvent.click(screen.getByRole('button', { name: /^generate$/i }));
    await waitFor(() =>
      expect(mediaService.generateMedia).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'IMAGE', prompt: 'a dog' }),
      ),
    );
  });

  it('a partially-failed batch keeps the accepted generations instead of dropping the whole batch', async () => {
    // 2 requested: one succeeds, one rejects.
    vi.mocked(mediaService.generateMedia)
      .mockReset()
      .mockResolvedValueOnce({ assetId: 'a-ok' })
      .mockRejectedValueOnce(new Error('boom'));
    // Keep the accepted one visibly "Generating" (non-terminal) so it isn't cleared.
    vi.mocked(mediaService.getGeneration).mockResolvedValue({
      ...READY,
      id: 'a-ok',
      status: 'GENERATING',
    } as never);

    render(<AiStudioPage />, { wrapper });
    await userEvent.type(screen.getByRole('textbox', { name: /prompt/i }), 'a dog');
    fireEvent.change(screen.getByRole('spinbutton', { name: /how many/i }), {
      target: { value: '2' },
    });
    await userEvent.click(screen.getByRole('button', { name: /^generate$/i }));

    // The accepted generation is polled (i.e. added to pendingIds), not dropped.
    await waitFor(() => expect(mediaService.getGeneration).toHaveBeenCalledWith('a-ok'));
    expect(screen.getByRole('heading', { name: /generating/i })).toBeInTheDocument();
    // Partial failure is surfaced as a warning, not a plain success.
    expect(toast.error).toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('a status poll that keeps failing stops polling, drops from pending, and shows failed', async () => {
    vi.mocked(mediaService.getGeneration).mockReset().mockRejectedValue(new Error('gone'));

    render(<AiStudioPage />, { wrapper });
    await userEvent.type(screen.getByRole('textbox', { name: /prompt/i }), 'a dog');
    await userEvent.click(screen.getByRole('button', { name: /^generate$/i }));

    // The card polls the failing status endpoint once...
    await waitFor(() => expect(mediaService.getGeneration).toHaveBeenCalledWith('a-new'));
    // ...then treats the persistent failure as terminal: removed from "Generating".
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: /generating/i })).not.toBeInTheDocument(),
    );
    // Polling is bounded — no endless 4s re-fetch loop.
    expect(vi.mocked(mediaService.getGeneration).mock.calls.length).toBe(1);
  });

  it('"Add to post" on a READY asset navigates straight to the Studio planner with seedMedia state', async () => {
    render(<AiStudioPage />, { wrapper });
    const addBtn = await screen.findByRole('button', { name: /add to post/i });
    await userEvent.click(addBtn);
    // Direct to the planner INSIDE Growth Studio — the legacy /social redirect
    // hop would drop location.state and lose the seeded media.
    expect(navigate).toHaveBeenCalledWith('/studio?view=tools&tab=campaigns&sub=planner', {
      state: { seedMedia: [{ url: 'https://r2/img.png', key: 'social/ws/img.png', mime: 'image/png' }] },
    });
  });
});

/**
 * The generate mutation used to toast `e.response.data.message` — the backend's
 * own English sentence ("Monthly AI credit limit reached (100) and prepaid
 * credits are insufficient") — straight into a Turkish UI, and it named neither
 * the cause nor who could clear it.
 */
describe('AiStudioPage — running out of AI credits', () => {
  const creditsRejection = {
    response: {
      status: 403,
      data: {
        code: 'AI_CREDITS_EXHAUSTED',
        message: 'Monthly AI credit limit reached (100) and prepaid credits are insufficient',
      },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mediaService.listGenerations).mockResolvedValue([READY] as never);
    vi.mocked(mediaService.getGeneration).mockResolvedValue(READY as never);
    useMarketingAuthStore.setState({
      user: { id: 'u1', workspaceId: 'w1', email: 'a@b.c', firstName: 'A', lastName: 'B', role: 'OWNER' },
    });
  });

  it('says it is a credit wall, with a way to act, and never echoes the backend English', async () => {
    vi.mocked(mediaService.generateMedia).mockRejectedValue(creditsRejection as never);
    render(<AiStudioPage />, { wrapper });

    await userEvent.type(screen.getByRole('textbox', { name: /prompt/i }), 'a dog');
    await userEvent.click(screen.getByRole('button', { name: /^generate$/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    const [message, opts] = vi.mocked(toast.error).mock.calls[0];
    expect(message).toMatch(/out of AI credits/i);
    expect(message).not.toMatch(/Monthly AI credit limit reached/);
    expect((opts as { action?: { label: string } })?.action?.label).toBe('Add credits');
  });

  it('still reports an ordinary failure with the page own message', async () => {
    vi.mocked(mediaService.generateMedia).mockRejectedValue({
      response: { status: 500, data: { message: 'boom' } },
    } as never);
    render(<AiStudioPage />, { wrapper });

    await userEvent.type(screen.getByRole('textbox', { name: /prompt/i }), 'a dog');
    await userEvent.click(screen.getByRole('button', { name: /^generate$/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Generation failed'));
  });
});
