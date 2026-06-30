import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import AiStudioPage from './AiStudioPage';
import * as mediaService from '../../../features/marketing/api/media.service';

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

  it('"Add to post" on a READY asset navigates to /social with seedMedia state', async () => {
    render(<AiStudioPage />, { wrapper });
    const addBtn = await screen.findByRole('button', { name: /add to post/i });
    await userEvent.click(addBtn);
    expect(navigate).toHaveBeenCalledWith('/social', {
      state: { seedMedia: [{ url: 'https://r2/img.png', key: 'social/ws/img.png', mime: 'image/png' }] },
    });
  });
});
