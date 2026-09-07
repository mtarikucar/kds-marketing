import type { ReactNode } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toast } from 'sonner';
import { BatchDetail, POLL_MS, batchPollMs, needsFrame } from './BatchDetail';
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
const editShot = vi.mocked(contentLine.editShot);

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

  it('renders a READY frame as the picture, a rendering one as pending, a failed one with its reason AS TEXT — and offers a redraw', async () => {
    const shots = [
      shot(0, { description: 'the beest on the beach', keyframe: { assetId: 'a', status: 'READY', url: 'https://r2/f0.png', model: 'm', attempts: 1 } }),
      shot(1, { keyframe: { assetId: 'b', status: 'GENERATING', model: 'm', attempts: 1 } }),
      shot(2, { keyframe: { assetId: 'c', status: 'BLOCKED', model: 'm', attempts: 2, error: 'content policy' } }),
    ];
    getBatch.mockResolvedValue([concept({ shotPlan: { ...concept().shotPlan, shots } })]);
    regenerateKeyframe.mockResolvedValue(concept());
    wrap(<BatchDetail batchId="b1" onClose={vi.fn()} />);

    const strip = await screen.findByRole('list', { name: 'Storyboard' });
    // The picture is described by what it shows, not by the beat's timing.
    expect(within(strip).getByRole('img', { name: 'the beest on the beach' })).toHaveAttribute('src', 'https://r2/f0.png');
    expect(within(screen.getByTestId('frame-1')).getByText('çiziliyor')).toBeInTheDocument();
    expect(within(screen.getByTestId('frame-2')).getByText('çizilemedi')).toBeInTheDocument();
    // The vendor's reason is readable, not hidden in a tooltip.
    expect(within(screen.getByTestId('frame-2')).getByText('content policy')).toBeInTheDocument();
    // The whole-storyboard button is gone while a frame is rendering and no
    // beat is wanted (beat 2 is exhausted — its own button only); redraw is
    // per beat, and not offered while a frame is still rendering.
    expect(screen.queryByRole('button', { name: 'Storyboard oluştur' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Yeniden üret 2-4s/ })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Yeniden üret 4-6s/ }));
    await waitFor(() => expect(regenerateKeyframe).toHaveBeenCalledWith('c1', 2));
  });

  it('a frame refused once (under the cap) still lets the whole storyboard be asked for again; an exhausted one does not', () => {
    expect(needsFrame(shot(0))).toBe(true);
    expect(needsFrame(shot(0, { keyframe: { assetId: 'x', status: 'FAILED', model: 'm', attempts: 1 } }))).toBe(true);
    expect(needsFrame(shot(0, { keyframe: { assetId: 'x', status: 'FAILED', model: 'm', attempts: 2 } }))).toBe(false);
    expect(needsFrame(shot(0, { keyframe: { assetId: 'x', status: 'READY', url: 'u', model: 'm', attempts: 1 } }))).toBe(false);
    expect(needsFrame(shot(0, { keyframe: { assetId: '', status: 'QUEUED', model: 'm', attempts: 0 } }))).toBe(false);
  });

  it('polls while a frame of a concept somebody may still act on is in flight — a merely requested frame counts, a DISCARDED concept never does', () => {
    const requested = shot(0, { keyframe: { assetId: '', status: 'QUEUED', model: 'm', attempts: 0 } });
    const rendering = shot(1, { keyframe: { assetId: 'b', status: 'GENERATING', model: 'm', attempts: 1 } });
    expect(batchPollMs(undefined)).toBe(false);
    expect(batchPollMs([concept()])).toBe(false);
    expect(batchPollMs([concept({ shotPlan: { ...concept().shotPlan, shots: [requested] } })])).toBe(POLL_MS);
    expect(batchPollMs([concept({ shotPlan: { ...concept().shotPlan, shots: [rendering] } })])).toBe(POLL_MS);
    expect(batchPollMs([concept({ status: 'DISCARDED', shotPlan: { ...concept().shotPlan, shots: [rendering] } })])).toBe(false);
  });

  it('a refused action shows the backend\'s own reason, not a generic line', async () => {
    getBatch.mockResolvedValue([concept()]);
    requestStoryboard.mockRejectedValue({ response: { data: { message: 'This concept is already in production, which draws its own frames.' } } });
    wrap(<BatchDetail batchId="b1" onClose={vi.fn()} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Storyboard oluştur' }));
    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith('This concept is already in production, which draws its own frames.'),
    );
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

  describe('directing a beat by hand — the frame text and the motion text', () => {
    const ready = (ord: number) =>
      shot(ord, { keyframe: { assetId: `a${ord}`, status: 'READY', url: `https://r2/f${ord}.png`, model: 'm', attempts: 1 } });

    it('opens the editor from a tile with both texts prefilled — the raw frame prompt and the clip prompt', async () => {
      getBatch.mockResolvedValue([concept({ shotPlan: { ...concept().shotPlan, shots: [ready(0), ready(1)] } })]);
      wrap(<BatchDetail batchId="b1" onClose={vi.fn()} />);

      await userEvent.click(await screen.findByRole('button', { name: 'Düzenle 2-4s' }));
      expect(screen.getByRole('heading', { name: '2-4s · düzenle' })).toBeInTheDocument();
      expect(screen.getByLabelText('Bu karede ne var')).toHaveValue('still 1');
      expect(screen.getByLabelText('Sonra ne olsun')).toHaveValue('clip 1');
      // Nothing changed yet: a plain save, no credits mentioned.
      expect(screen.getByRole('button', { name: 'Kaydet' })).toBeInTheDocument();
    });

    it('changing only the motion text saves it — nothing is bought, so the button is a plain "Kaydet"', async () => {
      getBatch.mockResolvedValue([concept({ shotPlan: { ...concept().shotPlan, shots: [ready(0)] } })]);
      editShot.mockResolvedValue(concept());
      wrap(<BatchDetail batchId="b1" onClose={vi.fn()} />);

      await userEvent.click(await screen.findByRole('button', { name: 'Düzenle 0-2s' }));
      const motion = screen.getByLabelText('Sonra ne olsun');
      await userEvent.clear(motion);
      await userEvent.type(motion, 'slow push-in, she smiles');
      const save = screen.getByRole('button', { name: 'Kaydet' });
      await userEvent.click(save);

      await waitFor(() => expect(editShot).toHaveBeenCalledWith('c1', 0, { prompt: 'slow push-in, she smiles' }));
      await waitFor(() => expect(screen.queryByLabelText('Sonra ne olsun')).not.toBeInTheDocument());
      await waitFor(() => expect(getBatch).toHaveBeenCalledTimes(2));
    });

    it('changing the frame text redraws the frame — the button names the price, and only the frame text is sent', async () => {
      getBatch.mockResolvedValue([concept({ shotPlan: { ...concept().shotPlan, shots: [ready(0)] } })]);
      editShot.mockResolvedValue(concept());
      wrap(<BatchDetail batchId="b1" onClose={vi.fn()} />);

      await userEvent.click(await screen.findByRole('button', { name: 'Düzenle 0-2s' }));
      const frame = screen.getByLabelText('Bu karede ne var');
      await userEvent.clear(frame);
      await userEvent.type(frame, '  a walking beest on the beach  ');
      expect(screen.queryByRole('button', { name: 'Kaydet' })).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Kaydet ve kareyi yeniden çiz (3 kredi)' }));

      await waitFor(() => expect(editShot).toHaveBeenCalledWith('c1', 0, { keyframePrompt: 'a walking beest on the beach' }));
    });

    it('saving with nothing changed calls nothing and just closes', async () => {
      getBatch.mockResolvedValue([concept({ shotPlan: { ...concept().shotPlan, shots: [ready(0)] } })]);
      wrap(<BatchDetail batchId="b1" onClose={vi.fn()} />);

      await userEvent.click(await screen.findByRole('button', { name: 'Düzenle 0-2s' }));
      await userEvent.click(screen.getByRole('button', { name: 'Kaydet' }));
      expect(editShot).not.toHaveBeenCalled();
      expect(screen.queryByLabelText('Bu karede ne var')).not.toBeInTheDocument();
    });

    it('a frame still rendering cannot be redrawn from the editor — the save waits, and says why', async () => {
      const rendering = shot(0, { keyframe: { assetId: 'a0', status: 'GENERATING', model: 'm', attempts: 1 } });
      getBatch.mockResolvedValue([concept({ shotPlan: { ...concept().shotPlan, shots: [rendering] } })]);
      wrap(<BatchDetail batchId="b1" onClose={vi.fn()} />);

      await userEvent.click(await screen.findByRole('button', { name: 'Düzenle 0-2s' }));
      const frame = screen.getByLabelText('Bu karede ne var');
      await userEvent.type(frame, ' at dusk');
      expect(screen.getByRole('button', { name: 'Kaydet ve kareyi yeniden çiz (3 kredi)' })).toBeDisabled();
      expect(screen.getByText('Kare hâlâ çiziliyor; bitince yeniden çizebilirsin.')).toBeInTheDocument();
    });

    it('the MOTION text stays savable while the frame renders — only the redraw waits', async () => {
      const rendering = shot(0, { keyframe: { assetId: 'a0', status: 'GENERATING', model: 'm', attempts: 1 } });
      getBatch.mockResolvedValue([concept({ shotPlan: { ...concept().shotPlan, shots: [rendering] } })]);
      editShot.mockResolvedValue(concept());
      wrap(<BatchDetail batchId="b1" onClose={vi.fn()} />);

      await userEvent.click(await screen.findByRole('button', { name: 'Düzenle 0-2s' }));
      const motion = screen.getByLabelText('Sonra ne olsun');
      await userEvent.clear(motion);
      await userEvent.type(motion, 'she turns to camera');
      const save = screen.getByRole('button', { name: 'Kaydet' });
      expect(save).toBeEnabled();
      await userEvent.click(save);
      await waitFor(() => expect(editShot).toHaveBeenCalledWith('c1', 0, { prompt: 'she turns to camera' }));
    });

    it('a frame merely REQUESTED (asked for, not yet drawn) takes new frame words — the job draws it from them', async () => {
      const requested = shot(0, { keyframe: { assetId: '', status: 'QUEUED', model: 'm', attempts: 0 } });
      getBatch.mockResolvedValue([concept({ shotPlan: { ...concept().shotPlan, shots: [requested] } })]);
      editShot.mockResolvedValue(concept());
      wrap(<BatchDetail batchId="b1" onClose={vi.fn()} />);

      await userEvent.click(await screen.findByRole('button', { name: 'Düzenle 0-2s' }));
      await userEvent.type(screen.getByLabelText('Bu karede ne var'), ' at dusk');
      const save = screen.getByRole('button', { name: 'Kaydet ve kareyi yeniden çiz (3 kredi)' });
      expect(save).toBeEnabled();
      expect(screen.queryByText('Kare hâlâ çiziliyor; bitince yeniden çizebilirsin.')).not.toBeInTheDocument();
      await userEvent.click(save);
      await waitFor(() => expect(editShot).toHaveBeenCalledWith('c1', 0, { keyframePrompt: 'still 0 at dusk' }));
    });

    it('opening another beat starts from THAT beat\'s texts, not the previous one\'s edits', async () => {
      getBatch.mockResolvedValue([concept({ shotPlan: { ...concept().shotPlan, shots: [ready(0), ready(1)] } })]);
      wrap(<BatchDetail batchId="b1" onClose={vi.fn()} />);

      await userEvent.click(await screen.findByRole('button', { name: 'Düzenle 0-2s' }));
      await userEvent.type(screen.getByLabelText('Bu karede ne var'), ' with a red bicycle');
      await userEvent.click(screen.getByRole('button', { name: 'Düzenle 2-4s' }));
      expect(screen.getByRole('heading', { name: '2-4s · düzenle' })).toBeInTheDocument();
      expect(screen.getByLabelText('Bu karede ne var')).toHaveValue('still 1');
      expect(screen.getByLabelText('Sonra ne olsun')).toHaveValue('clip 1');
      expect(screen.getByRole('button', { name: 'Düzenle 2-4s' })).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByRole('button', { name: 'Düzenle 0-2s' })).toHaveAttribute('aria-expanded', 'false');
    });

    it('an emptied text holds the save and says so — the backend would only refuse it', async () => {
      getBatch.mockResolvedValue([concept({ shotPlan: { ...concept().shotPlan, shots: [ready(0)] } })]);
      wrap(<BatchDetail batchId="b1" onClose={vi.fn()} />);

      await userEvent.click(await screen.findByRole('button', { name: 'Düzenle 0-2s' }));
      await userEvent.clear(screen.getByLabelText('Bu karede ne var'));
      expect(screen.getByText('Metin boş olamaz.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Kaydet/ })).toBeDisabled();
      expect(editShot).not.toHaveBeenCalled();
    });

    it('a beat that changed underneath (a poll brought a teammate\'s words) holds the save and says why', async () => {
      const first = concept({ shotPlan: { ...concept().shotPlan, shots: [ready(0)] } });
      const theirs = concept({ shotPlan: { ...concept().shotPlan, shots: [{ ...ready(0), keyframePrompt: 'their words' }] } });
      getBatch.mockResolvedValueOnce([first]).mockResolvedValue([theirs]);
      requestStoryboard.mockResolvedValue(theirs);
      wrap(<BatchDetail batchId="b1" onClose={vi.fn()} />);

      await userEvent.click(await screen.findByRole('button', { name: 'Düzenle 0-2s' }));
      await userEvent.type(screen.getByLabelText('Bu karede ne var'), ' mine');
      // Something else re-reads the batch (here: the refetch any action triggers).
      await userEvent.click(screen.getByRole('button', { name: 'Yeniden üret 0-2s' }));
      await screen.findByText('Bu beat sen bakarken değişti; düzenleyiciyi kapatıp yeniden aç.');
      expect(screen.getByRole('button', { name: /Kaydet/ })).toBeDisabled();
      // The typed words are still there for the reviewer to copy.
      expect(screen.getByLabelText('Bu karede ne var')).toHaveValue('still 0 mine');
    });

    it('Escape closes the editor without saving', async () => {
      getBatch.mockResolvedValue([concept({ shotPlan: { ...concept().shotPlan, shots: [ready(0)] } })]);
      wrap(<BatchDetail batchId="b1" onClose={vi.fn()} />);
      await userEvent.click(await screen.findByRole('button', { name: 'Düzenle 0-2s' }));
      await userEvent.type(screen.getByLabelText('Bu karede ne var'), ' x');
      await userEvent.keyboard('{Escape}');
      expect(screen.queryByLabelText('Bu karede ne var')).not.toBeInTheDocument();
      expect(editShot).not.toHaveBeenCalled();
    });

    it('a concept in production offers no editor, like it offers no redraw', async () => {
      getBatch.mockResolvedValue([
        concept({ status: 'APPROVED', promotedItemId: 'item-1', shotPlan: { ...concept().shotPlan, shots: [ready(0)] } }),
      ]);
      wrap(<BatchDetail batchId="b1" onClose={vi.fn()} />);
      expect(await screen.findByRole('img', { name: '0-2s' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Düzenle/ })).not.toBeInTheDocument();
    });

    it("a backend refusal shows the backend's own reason", async () => {
      getBatch.mockResolvedValue([concept({ shotPlan: { ...concept().shotPlan, shots: [ready(0)] } })]);
      editShot.mockRejectedValue({ response: { data: { message: "Beat 0's frame is still rendering; wait for it to land." } } });
      wrap(<BatchDetail batchId="b1" onClose={vi.fn()} />);

      await userEvent.click(await screen.findByRole('button', { name: 'Düzenle 0-2s' }));
      const motion = screen.getByLabelText('Sonra ne olsun');
      await userEvent.type(motion, ', then a cut');
      await userEvent.click(screen.getByRole('button', { name: 'Kaydet' }));
      await waitFor(() =>
        expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Beat 0's frame is still rendering; wait for it to land."),
      );
      // The editor stays open so the text is not lost.
      expect(screen.getByLabelText('Sonra ne olsun')).toHaveValue('clip 0, then a cut');
    });
  });
});
