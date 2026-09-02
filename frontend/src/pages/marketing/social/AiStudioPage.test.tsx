import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
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

vi.mock('../../../features/marketing/api/media.service', async (orig) => ({
  // estimateMediaCredits and the ceilings are pure functions the panel prices
  // with — mocking them would test the mock, so the real ones are kept and only
  // the network calls are replaced.
  ...(await orig<typeof import('../../../features/marketing/api/media.service')>()),
  generateMedia: vi.fn(),
  listGenerations: vi.fn(),
  listMediaModels: vi.fn(),
  getGeneration: vi.fn(),
  regenerateMedia: vi.fn(),
  deleteGeneration: vi.fn(),
  uploadSourceMedia: vi.fn(),
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

/**
 * A slice of the real `GET /ai/media/models` payload — ids, rates, tiers and
 * contracts copied from media-models.config.ts rather than invented, because
 * what these tests are pinning is precisely that the panel obeys the contract
 * the backend serves instead of a shape the UI assumed.
 */
const CATALOGUE = {
  techniques: ['IMAGE_CREATE', 'IMAGE_EDIT', 'IMAGE_CLEANUP', 'VIDEO_ANIMATE', 'AVATAR', 'VOICE'],
  models: [
    {
      id: 'fal-ai/qwen-image',
      technique: 'IMAGE_CREATE', type: 'IMAGE', label: 'Draft image', credits: 2,
      // No aspect contract at all: this endpoint does not document one.
      contract: { promptParam: 'prompt', negativePrompt: true, seedInput: true },
    },
    {
      id: 'fal-ai/bytedance/seedream/v4/text-to-image',
      technique: 'IMAGE_CREATE', type: 'IMAGE', label: 'Final image', credits: 3,
      contract: {
        promptParam: 'prompt', negativePrompt: false, seedInput: true,
        aspect: {
          param: 'image_size',
          values: { '1:1': 'square_hd', '3:4': 'portrait_4_3', '16:9': 'landscape_16_9' },
        },
      },
    },
    {
      id: 'bytedance/seedance-2.5/image-to-video',
      technique: 'VIDEO_ANIMATE', type: 'VIDEO', label: 'Seedance 2.5 animate', creditsPerSec: 48,
      tiers: { '480p': { creditsPerSec: 23 }, '1080p': { creditsPerSec: 117 } },
      contract: {
        promptParam: 'prompt', negativePrompt: false, seedInput: true,
        duration: { param: 'duration', minSec: 4, maxSec: 30 },
        resolution: { param: 'resolution', values: ['480p', '720p', '1080p'], default: '720p' },
        aspect: { param: 'aspect_ratio', values: { '16:9': '16:9', '1:1': '1:1', '9:16': '9:16' } },
        audio: { param: 'generate_audio', default: true },
        sources: [
          { slot: 'firstImage', param: 'image_url', arity: 'single', required: true },
          { slot: 'lastImage', param: 'end_image_url', arity: 'single', required: false },
        ],
      },
    },
    {
      id: 'fal-ai/veo3.1/image-to-video',
      technique: 'VIDEO_ANIMATE', type: 'VIDEO', label: 'Veo 3.1 animate', creditsPerSec: 40,
      tiers: { '4k': { creditsPerSec: 60 } },
      contract: {
        promptParam: 'prompt', negativePrompt: true, seedInput: true,
        duration: { param: 'duration', minSec: 4, maxSec: 8, allowedSec: [4, 6, 8] },
        resolution: { param: 'resolution', values: ['720p', '1080p', '4k'], default: '720p' },
        aspect: { param: 'aspect_ratio', values: { '16:9': '16:9', '9:16': '9:16' } },
        audio: { param: 'generate_audio', default: true },
        sources: [{ slot: 'firstImage', param: 'image_url', arity: 'single', required: true }],
      },
    },
    {
      // A pure transform: no prompt at all, one source.
      id: 'fal-ai/birefnet/v2',
      technique: 'IMAGE_CLEANUP', type: 'IMAGE', label: 'BiRefNet v2', credits: 2,
      contract: {
        promptParam: null, negativePrompt: false, seedInput: false,
        resolution: {
          param: 'operating_resolution',
          values: ['1024x1024', '2048x2048', '2304x2304'],
          default: '1024x1024',
        },
        sources: [{ slot: 'firstImage', param: 'image_url', arity: 'single', required: true }],
      },
    },
    {
      // The one served model whose length is not something the request asks for:
      // the clip is as long as the SCRIPT takes to read, and the script is the
      // prompt, so the panel can price it exactly without measuring any file.
      id: 'veed/avatars/text-to-video',
      technique: 'AVATAR', type: 'VIDEO', label: 'VEED Avatar', creditsPerSec: 1,
      contract: {
        promptParam: 'text', negativePrompt: false, seedInput: false,
        sourceMetering: { quantity: 'durationSec', from: 'script', charsPerSec: 12 },
        choices: {
          avatar: {
            param: 'avatar_id',
            values: ['emily_vertical_primary', 'marcus_vertical_primary'],
            default: 'emily_vertical_primary',
          },
        },
      },
    },
    {
      id: 'fal-ai/elevenlabs/tts/multilingual-v2',
      technique: 'VOICE', type: 'AUDIO', label: 'ElevenLabs voiceover', creditsPerKChar: 10,
      contract: {
        promptParam: 'text', negativePrompt: false, seedInput: false,
        choices: {
          voice: { param: 'voice', values: [], default: 'Rachel' },
          language: { param: 'language_code', values: [], default: 'tr' },
        },
      },
    },
  ],
};

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

/** The panel only exists once the catalogue has arrived — it is what decides
 *  which controls exist at all. */
const waitForPanel = () => screen.findByRole('button', { name: /create an image/i });

describe('AiStudioPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mediaService.listMediaModels).mockResolvedValue(CATALOGUE as never);
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
    await waitForPanel();
    await userEvent.type(screen.getByRole('textbox', { name: /prompt/i }), 'a dog');
    await userEvent.click(screen.getByRole('button', { name: /^generate$/i }));
    await waitFor(() =>
      expect(mediaService.generateMedia).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'IMAGE', prompt: 'a dog', model: 'fal-ai/qwen-image' }),
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
    await waitForPanel();
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
    await waitForPanel();
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
 * The panel is technique-first and CONTRACT-driven: the user chooses the job, then
 * a price tier, and only then the controls that particular model publishes. A
 * control the model does not accept is not a cosmetic bug — the backend rejects
 * the request (`fal-ai/qwen-image does not take an aspect ratio`) before the
 * reserve, so an always-on field would make a whole technique unusable.
 */
describe('AiStudioPage — technique-first, contract-driven panel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mediaService.listMediaModels).mockResolvedValue(CATALOGUE as never);
    vi.mocked(mediaService.listGenerations).mockResolvedValue([READY] as never);
    vi.mocked(mediaService.getGeneration).mockResolvedValue(READY as never);
    vi.mocked(mediaService.generateMedia).mockResolvedValue({ assetId: 'a-new' });
  });

  it('renders only the controls the chosen model publishes, and re-renders them on a tier change', async () => {
    render(<AiStudioPage />, { wrapper });
    await waitForPanel();

    // Cheapest IMAGE_CREATE tier is selected by default: qwen, which documents a
    // negative prompt and NO aspect ratio.
    expect(screen.getByRole('textbox', { name: /avoid/i })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /aspect ratio/i })).not.toBeInTheDocument();

    // Seedream v4 is the other way round: an image_size preset, no negative prompt.
    await userEvent.click(screen.getByRole('button', { name: /final image/i }));
    expect(await screen.findByRole('combobox', { name: /aspect ratio/i })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /avoid/i })).not.toBeInTheDocument();
  });

  it('a technique needing source media asks for it and will not generate without it', async () => {
    render(<AiStudioPage />, { wrapper });
    await waitForPanel();
    await userEvent.click(screen.getByRole('button', { name: /animate a still/i }));

    const source = await screen.findByRole('group', { name: /source image/i });
    // Everything else is filled in: the source is the only thing still missing,
    // and the click is blocked here rather than surfacing as a 400 afterwards.
    await userEvent.type(screen.getByRole('textbox', { name: /prompt/i }), 'pan left');
    expect(screen.getByRole('button', { name: /^generate$/i })).toBeDisabled();

    await userEvent.type(
      within(source).getByRole('textbox', { name: /paste a link/i }),
      'https://r2/still.png',
    );
    await userEvent.click(within(source).getByRole('button', { name: /add link/i }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^generate$/i })).not.toBeDisabled(),
    );
  });

  it('sends the source URL and the model own duration/resolution/audio — and nothing else', async () => {
    render(<AiStudioPage />, { wrapper });
    await waitForPanel();
    await userEvent.click(screen.getByRole('button', { name: /animate a still/i }));
    await userEvent.click(screen.getByRole('button', { name: /seedance 2\.5 animate/i }));

    const source = await screen.findByRole('group', { name: /source image/i });
    await userEvent.type(
      within(source).getByRole('textbox', { name: /paste a link/i }),
      'https://r2/still.png',
    );
    await userEvent.click(within(source).getByRole('button', { name: /add link/i }));
    await userEvent.type(screen.getByRole('textbox', { name: /prompt/i }), 'pan left');
    await userEvent.click(screen.getByRole('button', { name: /^generate$/i }));

    await waitFor(() => expect(mediaService.generateMedia).toHaveBeenCalled());
    expect(mediaService.generateMedia).toHaveBeenCalledWith({
      type: 'VIDEO',
      prompt: 'pan left',
      model: 'bytedance/seedance-2.5/image-to-video',
      aspectRatio: '1:1',
      resolution: '720p',
      durationSec: 5,
      generateAudio: true,
      referenceImageUrls: ['https://r2/still.png'],
    });
    // Seedance 2.5 image-to-video publishes no negative prompt and no mask; the
    // payload must not carry the fields of a technique the user left behind.
    const sent = vi.mocked(mediaService.generateMedia).mock.calls[0][0];
    expect(sent).not.toHaveProperty('negativePrompt');
    expect(sent).not.toHaveProperty('maskUrl');
    expect(sent).not.toHaveProperty('videoUrl');
  });

  it('quotes the credits before the click and re-prices when the resolution tier changes', async () => {
    render(<AiStudioPage />, { wrapper });
    await waitForPanel();
    await userEvent.click(screen.getByRole('button', { name: /animate a still/i }));
    await userEvent.click(screen.getByRole('button', { name: /seedance 2\.5 animate/i }));

    // 720p is the model's default tier: 48 credits/s × the 5s default.
    expect(screen.getByTestId('credit-estimate')).toHaveTextContent('240');

    // 480p is a cheaper TIER, not a cheaper average — 23/s.
    await userEvent.click(screen.getByRole('button', { name: '480p' }));
    await waitFor(() => expect(screen.getByTestId('credit-estimate')).toHaveTextContent('115'));

    // …and 1080p is the one that costs real money.
    await userEvent.click(screen.getByRole('button', { name: '1080p' }));
    await waitFor(() => expect(screen.getByTestId('credit-estimate')).toHaveTextContent('585'));
  });

  it('re-prices when the duration changes, and offers only the lengths the model will produce', async () => {
    render(<AiStudioPage />, { wrapper });
    await waitForPanel();
    await userEvent.click(screen.getByRole('button', { name: /animate a still/i }));

    // Veo is the cheapest VIDEO_ANIMATE tier (40/s at its 4s default) and takes an
    // ENUM of lengths — 5s would be snapped down provider-side, so it is not offered.
    expect(screen.getByRole('button', { name: /veo 3\.1 animate/i })).toHaveAttribute('aria-pressed', 'true');
    const duration = screen.getByRole('group', { name: /duration/i });
    expect(within(duration).getAllByRole('button').map((b) => b.textContent)).toEqual(['4', '6', '8']);
    expect(screen.getByTestId('credit-estimate')).toHaveTextContent('160');

    await userEvent.click(within(duration).getByRole('button', { name: '8' }));
    await waitFor(() => expect(screen.getByTestId('credit-estimate')).toHaveTextContent('320'));
  });

  it('a prompt-less technique drops the prompt box and asks for its source', async () => {
    render(<AiStudioPage />, { wrapper });
    await waitForPanel();
    await userEvent.click(screen.getByRole('button', { name: /clean up an image/i }));

    // BiRefNet takes no prompt at all, so there is no prompt box to gate on.
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: /prompt/i })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('group', { name: /source image/i })).toBeInTheDocument();
    // Flat per run, so it has a price the moment the technique is chosen.
    expect(screen.getByTestId('credit-estimate')).toHaveTextContent('2');
  });

  it('picks a source out of the workspace library, offering only assets that finished', async () => {
    vi.mocked(mediaService.listGenerations).mockResolvedValue([
      READY,
      // Neither of these is usable as a source: one never produced a file, the
      // other has no URL yet.
      { ...READY, id: 'a-failed', status: 'FAILED', prompt: 'a burnt run', url: null },
      { ...READY, id: 'a-running', status: 'GENERATING', prompt: 'still cooking', url: null },
    ] as never);

    render(<AiStudioPage />, { wrapper });
    await waitForPanel();
    await userEvent.click(screen.getByRole('button', { name: /animate a still/i }));

    const source = await screen.findByRole('group', { name: /source image/i });
    await userEvent.click(within(source).getByRole('button', { name: /from library/i }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByText(/a burnt run/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/still cooking/i)).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByText(/a cat/i));

    // Chosen, so the slot is filled and the generate gate opens.
    await waitFor(() =>
      expect(within(source).getByTestId('source-image')).toHaveAttribute('src', 'https://r2/img.png'),
    );
  });

  it('prices a voiceover on the length of the script, not on seconds', async () => {
    render(<AiStudioPage />, { wrapper });
    await waitForPanel();
    await userEvent.click(screen.getByRole('button', { name: /voiceover/i }));

    // 10 credits per 1000 characters, rounded up and floored at 1.
    const script = await screen.findByRole('textbox', { name: /script/i });
    await userEvent.type(script, 'merhaba');
    await waitFor(() => expect(screen.getByTestId('credit-estimate')).toHaveTextContent('1'));
    // The TTS choices are free-form on the wire, so they are text inputs seeded
    // with the catalogue's own defaults.
    expect(screen.getByRole('textbox', { name: /language/i })).toHaveValue('tr');
  });
});

describe('AiStudioPage — audio results', () => {
  const AUDIO_ASSET = {
    ...READY,
    id: 'a-audio', type: 'AUDIO', model: 'fal-ai/elevenlabs/tts/multilingual-v2',
    prompt: 'merhaba dünya', url: 'https://r2/voice.mp3', mime: 'audio/mpeg',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mediaService.listMediaModels).mockResolvedValue(CATALOGUE as never);
    vi.mocked(mediaService.listGenerations).mockResolvedValue([AUDIO_ASSET] as never);
    vi.mocked(mediaService.getGeneration).mockResolvedValue(AUDIO_ASSET as never);
  });

  it('gives an audio asset a player instead of an image, and no post hand-off', async () => {
    render(<AiStudioPage />, { wrapper });
    // An <img src="…mp3"> is a broken-image icon; a voiceover can only be judged
    // by listening to it.
    expect(await screen.findByTestId('asset-audio')).toHaveAttribute('src', 'https://r2/voice.mp3');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    // The composer's media list is image/video only — there is nowhere for an
    // mp3 to land in a post.
    expect(screen.queryByRole('button', { name: /add to post/i })).not.toBeInTheDocument();
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
    vi.mocked(mediaService.listMediaModels).mockResolvedValue(CATALOGUE as never);
    vi.mocked(mediaService.listGenerations).mockResolvedValue([READY] as never);
    vi.mocked(mediaService.getGeneration).mockResolvedValue(READY as never);
    useMarketingAuthStore.setState({
      user: { id: 'u1', workspaceId: 'w1', email: 'a@b.c', firstName: 'A', lastName: 'B', role: 'OWNER' },
    });
  });

  it('says it is a credit wall, with a way to act, and never echoes the backend English', async () => {
    vi.mocked(mediaService.generateMedia).mockRejectedValue(creditsRejection as never);
    render(<AiStudioPage />, { wrapper });
    await waitForPanel();

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
    await waitForPanel();

    await userEvent.type(screen.getByRole('textbox', { name: /prompt/i }), 'a dog');
    await userEvent.click(screen.getByRole('button', { name: /^generate$/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Generation failed'));
  });
});

/**
 * A model billed by its SOURCE has no price until the source is measured. The
 * point of measuring it in the panel is that a 60-second upscale reads as
 * expensive BEFORE the click — the old flat quote said 40 credits for a job that
 * costs 480, and nothing downstream could ever correct it.
 */
/**
 * A COST THAT COMES FROM THE SCRIPT.
 *
 * The VEED avatar has no duration input and reports none back: its clip is as
 * long as its script takes to read. Quoting it off a requested length showed a
 * flat 5 credits for a minute-long read that bills $0.35, so the panel prices it
 * off the script instead — the one metered quantity the request itself carries.
 *
 * The models billed on a property of a customer's FILE are not tested here
 * because they are not offered here: pricing one needs the file measured, that
 * needs a real probe on the server where the charge is decided, and until it
 * exists those four models are withheld from the catalogue the panel is built
 * from.
 */
describe('AiStudioPage — a cost that comes from the script', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mediaService.listMediaModels).mockResolvedValue(CATALOGUE as never);
    vi.mocked(mediaService.listGenerations).mockResolvedValue([] as never);
    vi.mocked(mediaService.generateMedia).mockResolvedValue({ assetId: 'a-new' });
  });

  const openAvatar = async () => {
    render(<AiStudioPage />, { wrapper });
    await waitForPanel();
    await userEvent.click(screen.getByRole('button', { name: /presenter reads your script/i }));
  };

  it('will not quote — or let you buy — an avatar with no script yet', async () => {
    await openAvatar();
    // Not "0 credits" and not the flat base rate: no price at all yet.
    expect(await screen.findByTestId('credit-estimate-unpriced')).toBeInTheDocument();
    expect(screen.queryByTestId('credit-estimate')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled();
  });

  it('prices the read by its length once the script is written', async () => {
    await openAvatar();
    // AVATAR labels the prompt box 'Script', which is what it is.
    const box = await screen.findByRole('textbox', { name: /script/i });
    // 720 characters at 12 chars/s is a 60-second read: 60 credits, not the 5 a
    // requested-length quote showed for the same click.
    fireEvent.change(box, { target: { value: 'x'.repeat(720) } });
    expect(await screen.findByTestId('credit-estimate')).toHaveTextContent('60');
    expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled();
  });

  it('keeps a one-line script at a one-line price', async () => {
    await openAvatar();
    // AVATAR labels the prompt box 'Script', which is what it is.
    const box = await screen.findByRole('textbox', { name: /script/i });
    fireEvent.change(box, { target: { value: 'x'.repeat(60) } });
    expect(await screen.findByTestId('credit-estimate')).toHaveTextContent('5');
  });

  it('sends no measurement of its own — the server prices from the same script', async () => {
    await openAvatar();
    // AVATAR labels the prompt box 'Script', which is what it is.
    const box = await screen.findByRole('textbox', { name: /script/i });
    fireEvent.change(box, { target: { value: 'x'.repeat(720) } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));

    await waitFor(() => expect(mediaService.generateMedia).toHaveBeenCalled());
    const [payload] = vi.mocked(mediaService.generateMedia).mock.calls[0];
    // A quantity the CLIENT states is the payer choosing their own bill. The
    // request carries the script and nothing else about what it will cost.
    expect(payload).not.toHaveProperty('sourceDurationSec');
    expect(payload).not.toHaveProperty('sourceWidth');
    expect(payload).not.toHaveProperty('sourceHeight');
    expect(payload).not.toHaveProperty('durationSec');
  });
});
