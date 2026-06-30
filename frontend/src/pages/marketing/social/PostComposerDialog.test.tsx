import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PostComposerDialog } from './PostComposerDialog';
import * as mediaService from '../../../features/marketing/api/media.service';

vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: { post: vi.fn(), get: vi.fn() },
}));
vi.mock('../../../features/marketing/api/media.service', () => ({
  generateMedia: vi.fn(),
  getGeneration: vi.fn(),
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

const ACCOUNT = {
  id: 'acc-1', network: 'FACEBOOK', externalId: '1', displayName: 'Acme',
  accessToken: '••••', tokenExpiresAt: null, enabled: true, createdAt: '',
};

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('PostComposerDialog AI generate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('seedMedia prefills the media list when creating a new post', () => {
    render(
      <PostComposerDialog
        open
        onOpenChange={() => {}}
        accounts={[ACCOUNT as never]}
        onSubmit={() => {}}
        isPending={false}
        seedMedia={[{ url: 'https://r2/x.png', key: 'k', mime: 'image/png' }]}
      />,
      { wrapper },
    );
    expect(screen.getByText('x.png')).toBeInTheDocument();
  });

  it('generating in the AI panel appends a READY asset to the media list', async () => {
    vi.mocked(mediaService.generateMedia).mockResolvedValue({ assetId: 'a-1' });
    vi.mocked(mediaService.getGeneration).mockResolvedValue({
      id: 'a-1', type: 'IMAGE', status: 'READY', provider: 'fal', model: 'm',
      prompt: 'p', params: {}, url: 'https://r2/gen.png', r2Key: 'social/ws/gen.png',
      mime: 'image/png', createdById: 'u', createdAt: '', updatedAt: '',
    } as never);

    render(
      <PostComposerDialog open onOpenChange={() => {}} accounts={[ACCOUNT as never]} onSubmit={() => {}} isPending={false} />,
      { wrapper },
    );

    await userEvent.click(screen.getByRole('button', { name: /ai ile üret/i }));
    await userEvent.type(screen.getByRole('textbox', { name: /prompt/i }), 'a sunset');
    await userEvent.click(screen.getByRole('button', { name: /^generate$/i }));

    await waitFor(() => expect(screen.getByText('gen.png')).toBeInTheDocument());
    expect(mediaService.generateMedia).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'IMAGE', prompt: 'a sunset' }),
    );
  });
});
