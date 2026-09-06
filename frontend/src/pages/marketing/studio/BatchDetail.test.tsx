import type { ReactNode } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BatchDetail } from './BatchDetail';
import * as contentLine from '../../../features/marketing/api/contentLine.service';
import type { ConceptRow, Shot } from '../../../features/marketing/api/contentLine.service';

vi.mock('../../../features/marketing/api/contentLine.service');
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, d?: string | Record<string, unknown>, o?: Record<string, unknown>) => {
      const def = typeof d === 'string' ? d : '';
      const vars = (typeof d === 'string' ? o : (d as Record<string, unknown>)) ?? {};
      return def.replace(/\{\{(\w+)\}\}/g, (_m, k) => String(vars[k] ?? ''));
    },
    i18n: { language: 'tr' },
  }),
}));

const getBatch = vi.mocked(contentLine.getBatch);
const requestStoryboard = vi.mocked(contentLine.requestStoryboard);
const regenerateKeyframe = vi.mocked(contentLine.regenerateKeyframe);

const shot = (ord: number, over: Partial<Shot> = {}): Shot => ({
  ord,
  scene: `${ord * 2}-${ord * 2 + 2}s`,
  voiceover: '',
  prompt: `clip ${ord}`,
  durationSec: 2,
  cameraNote: 'wide',
  keyframePrompt: `still ${ord}`,
  ...over,
});

const concept = (over: Partial<ConceptRow> = {}): ConceptRow => ({
  id: 'c1',
  batchId: 'b1',
  ordinal: 0,
  angle: 'curiosity',
  hook: 'Bunun motoru yok.',
  title: 'Motorsuz yürüyen şey',
  rationale: null,
  status: 'PROPOSED',
  selectionReason: null,
  promotedItemId: null,
  shotPlan: {
    aspectRatio: '9:16',
    durationSec: 6,
    shots: [shot(0), shot(1), shot(2)],
    storyboard: { imageModel: 'fal-ai/bytedance/seedream/v4/text-to-image', seed: 7 },
    production: {
      model: 'fal-ai/bytedance/seedance/v1/pro/fast/image-to-video',
      modelSource: 'storyboard',
      aspectRatio: '9:16',
      billedSecPerBeat: [2, 2, 2],
      billedSec: 6,
      keyframes: { model: 'fal-ai/bytedance/seedream/v4/text-to-image', perFrameCredits: 3, credits: 9, usd: 0.09 },
      credits: 27,
      usd: 0.22,
    },
  },
  ...over,
});

function wrap(children: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => vi.clearAllMocks());

describe('BatchDetail — the storyboard a reviewer looks at', () => {
  it('shows the price a reviewer approves — frames and clips as one number — and one tile per beat', async () => {
    getBatch.mockResolvedValue([concept()]);
    wrap(<BatchDetail batchId="b1" onClose={vi.fn()} />);

    expect(await screen.findByTestId('concept-quote')).toHaveTextContent('27 kredi · 3 kare + 6 sn video');
    const strip = screen.getByRole('list', { name: 'Storyboard' });
    expect(within(strip).getAllByRole('listitem')).toHaveLength(3);
    // No frame yet: every tile says so, and the whole storyboard can be asked for.
    expect(within(strip).getAllByText('kare yok')).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Storyboard oluştur' })).toBeInTheDocument();
  });

  it('asks for the storyboard and re-reads the batch', async () => {
    getBatch.mockResolvedValue([concept()]);
    requestStoryboard.mockResolvedValue(concept());
    wrap(<BatchDetail batchId="b1" onClose={vi.fn()} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Storyboard oluştur' }));
    await waitFor(() => expect(requestStoryboard).toHaveBeenCalledWith('c1'));
    await waitFor(() => expect(getBatch).toHaveBeenCalledTimes(2));
  });

  it('renders a READY frame as the picture, a rendering one as pending, a failed one with its reason — and offers a redraw', async () => {
    const shots = [
      shot(0, { keyframe: { assetId: 'a', status: 'READY', url: 'https://r2/f0.png', model: 'm', attempts: 1 } }),
      shot(1, { keyframe: { assetId: 'b', status: 'GENERATING', model: 'm', attempts: 1 } }),
      shot(2, { keyframe: { assetId: 'c', status: 'BLOCKED', model: 'm', attempts: 2, error: 'content policy' } }),
    ];
    getBatch.mockResolvedValue([concept({ shotPlan: { ...concept().shotPlan, shots } })]);
    regenerateKeyframe.mockResolvedValue(concept());
    wrap(<BatchDetail batchId="b1" onClose={vi.fn()} />);

    const strip = await screen.findByRole('list', { name: 'Storyboard' });
    expect(within(strip).getByRole('img', { name: '0-2s' })).toHaveAttribute('src', 'https://r2/f0.png');
    expect(within(screen.getByTestId('frame-1')).getByText('çiziliyor')).toBeInTheDocument();
    expect(within(screen.getByTestId('frame-2')).getByText('çizilemedi')).toHaveAttribute('title', 'content policy');
    // The whole-storyboard button is gone once frames exist; redraw is per beat,
    // and not offered while a frame is still rendering.
    expect(screen.queryByRole('button', { name: 'Storyboard oluştur' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Yeniden üret 2-4s/ })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Yeniden üret 4-6s/ }));
    await waitFor(() => expect(regenerateKeyframe).toHaveBeenCalledWith('c1', 2));
  });

  it('a concept planned before storyboards says so instead of showing an empty strip', async () => {
    getBatch.mockResolvedValue([concept({ shotPlan: { durationSec: 6, shots: [shot(0), shot(1)] } })]);
    wrap(<BatchDetail batchId="b1" onClose={vi.fn()} />);
    expect(await screen.findByText(/storyboard'dan önce planlandı/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Storyboard oluştur' })).not.toBeInTheDocument();
  });

  it('a concept already in production shows its frames but offers no more drawing', async () => {
    const shots = [shot(0, { keyframe: { assetId: 'a', status: 'READY', url: 'https://r2/f0.png', model: 'm', attempts: 1 } })];
    getBatch.mockResolvedValue([concept({ status: 'APPROVED', promotedItemId: 'item-1', shotPlan: { ...concept().shotPlan, shots } })]);
    wrap(<BatchDetail batchId="b1" onClose={vi.fn()} />);
    expect(await screen.findByRole('img', { name: '0-2s' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Yeniden üret/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Üretimde/)).toBeInTheDocument();
  });
});
