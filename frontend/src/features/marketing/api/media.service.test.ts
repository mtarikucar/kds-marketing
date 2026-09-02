import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./marketingApi', () => ({
  default: { get: vi.fn(), post: vi.fn(), delete: vi.fn(), put: vi.fn() },
}));

import marketingApi from './marketingApi';
import {
  generateMedia,
  listGenerations,
  getGeneration,
  regenerateMedia,
  deleteGeneration,
  isTerminal,
  listMediaModels,
  uploadSourceMedia,
  estimateMediaCredits,
  meteredQuantityMissing,
  type MediaModelInfo,
  type MediaSourceMeteringContract,
} from './media.service';

const api = marketingApi as unknown as {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

describe('media.service', () => {
  beforeEach(() => vi.clearAllMocks());

  it('generateMedia POSTs the payload to /ai/media/generate and returns { assetId }', async () => {
    api.post.mockResolvedValue({ data: { assetId: 'a-1' } });
    const out = await generateMedia({ type: 'IMAGE', prompt: 'a cat', aspectRatio: '1:1' });
    expect(api.post).toHaveBeenCalledWith('/ai/media/generate', {
      type: 'IMAGE',
      prompt: 'a cat',
      aspectRatio: '1:1',
    });
    expect(out).toEqual({ assetId: 'a-1' });
  });

  it('listGenerations passes filters as query params', async () => {
    api.get.mockResolvedValue({ data: [] });
    await listGenerations({ type: 'VIDEO', status: 'READY' });
    expect(api.get).toHaveBeenCalledWith('/ai/media/generations', {
      params: { type: 'VIDEO', status: 'READY' },
    });
  });

  it('getGeneration hits the :id status route', async () => {
    api.get.mockResolvedValue({ data: { id: 'a-1', status: 'GENERATING' } });
    const a = await getGeneration('a-1');
    expect(api.get).toHaveBeenCalledWith('/ai/media/generations/a-1');
    expect(a.status).toBe('GENERATING');
  });

  it('regenerateMedia and deleteGeneration use the right verbs/paths', async () => {
    api.post.mockResolvedValue({ data: { assetId: 'a-2' } });
    api.delete.mockResolvedValue({ data: { message: 'ok' } });
    expect(await regenerateMedia('a-1')).toEqual({ assetId: 'a-2' });
    expect(api.post).toHaveBeenCalledWith('/ai/media/generations/a-1/regenerate');
    expect(await deleteGeneration('a-1')).toEqual({ message: 'ok' });
    expect(api.delete).toHaveBeenCalledWith('/ai/media/generations/a-1');
  });

  it('listMediaModels reads the technique catalogue', async () => {
    api.get.mockResolvedValue({ data: { techniques: ['IMAGE_CREATE'], models: [] } });
    const c = await listMediaModels();
    expect(api.get).toHaveBeenCalledWith('/ai/media/models');
    expect(c.techniques).toEqual(['IMAGE_CREATE']);
  });

  it('uploadSourceMedia posts a multipart file to the planner media endpoint', async () => {
    api.post.mockResolvedValue({ data: { url: 'https://r2/x.png', key: 'k', mime: 'image/png' } });
    const out = await uploadSourceMedia(new File(['x'], 'x.png', { type: 'image/png' }));
    // Deliberately the composer's own upload route, not a second one: same
    // bucket, same size cap, same permission.
    const [path, body, cfg] = api.post.mock.calls[0];
    expect(path).toBe('/social-planner/media');
    expect(body).toBeInstanceOf(FormData);
    expect((body as FormData).get('file')).toBeInstanceOf(File);
    expect(cfg).toEqual({ headers: { 'Content-Type': 'multipart/form-data' } });
    expect(out.url).toBe('https://r2/x.png');
  });

  it('isTerminal is true only for READY/FAILED/BLOCKED', () => {
    expect(isTerminal('READY')).toBe(true);
    expect(isTerminal('FAILED')).toBe(true);
    expect(isTerminal('BLOCKED')).toBe(true);
    expect(isTerminal('QUEUED')).toBe(false);
    expect(isTerminal('GENERATING')).toBe(false);
  });
});

/**
 * The quote the user sees before the click. It mirrors the backend's
 * estimateMediaCredits branch for branch: the branch is chosen by which RATE the
 * model carries, never by its asset type (wan-flf2v is VIDEO yet flat per run,
 * MMAudio is VIDEO yet per second), every branch rounds UP, and the resolution
 * TIER is part of the price — an averaged rate under-charges the top tier.
 */
describe('estimateMediaCredits', () => {
  const model = (over: Partial<MediaModelInfo>): MediaModelInfo => ({
    id: 'x', technique: 'VIDEO_CREATE', type: 'VIDEO', label: 'x',
    contract: { promptParam: 'prompt', negativePrompt: false, seedInput: false },
    ...over,
  });

  it('meters per second at the tier that was asked for', () => {
    const seedance = model({
      creditsPerSec: 48,
      tiers: { '480p': { creditsPerSec: 23 }, '1080p': { creditsPerSec: 117 } },
    });
    expect(estimateMediaCredits(seedance, { durationSec: 5, resolution: '720p' })).toBe(240);
    expect(estimateMediaCredits(seedance, { durationSec: 5, resolution: '480p' })).toBe(115);
    expect(estimateMediaCredits(seedance, { durationSec: 5, resolution: '1080p' })).toBe(585);
    // `tiers` lists DEVIATIONS only, so an unlisted tier is the base rate, not a miss.
    expect(estimateMediaCredits(seedance, { durationSec: 5 })).toBe(240);
  });

  it('bills a flat-per-run model per run, however long the output is', () => {
    const latentsync = model({ credits: 20 });
    expect(estimateMediaCredits(latentsync, { durationSec: 40 })).toBe(20);
  });

  it('bills TTS per 1000 characters of script, rounded up and floored at one', () => {
    const tts = model({ type: 'AUDIO', technique: 'VOICE', creditsPerKChar: 10 });
    expect(estimateMediaCredits(tts, { textLength: 250 })).toBe(3);
    expect(estimateMediaCredits(tts, { textLength: 1000 })).toBe(10);
    expect(estimateMediaCredits(tts, { textLength: 1 })).toBe(1);
  });

  it('quotes the length fal will RENDER, not the length that was asked for', () => {
    // The server bills the duration it actually puts on the wire: clamped into
    // the contract's range and snapped DOWN to a published value. Quoting the raw
    // request would show a number the reserve then disagrees with — and on Veo,
    // whose response carries no duration, nothing later corrects it.
    const veo = model({
      creditsPerSec: 40,
      contract: {
        promptParam: 'prompt', negativePrompt: true, seedInput: true,
        duration: { param: 'duration', minSec: 4, maxSec: 8, allowedSec: [4, 6, 8] },
      },
    });
    expect(estimateMediaCredits(veo, { durationSec: 5 })).toBe(160); // renders 4s
    expect(estimateMediaCredits(veo, { durationSec: 1 })).toBe(160); // floored at 4s
    expect(estimateMediaCredits(veo, { durationSec: 10 })).toBe(320); // capped at 8s

    const seedance = model({
      creditsPerSec: 48,
      contract: {
        promptParam: 'prompt', negativePrompt: false, seedInput: false,
        duration: { param: 'duration', minSec: 4, maxSec: 30 },
      },
    });
    expect(estimateMediaCredits(seedance, { durationSec: 1 })).toBe(192); // floored at 4s
  });

  it('bills music in whole minutes rounded up — a 30-second bed still costs a minute', () => {
    const music = model({ type: 'AUDIO', technique: 'MUSIC', creditsPerMinute: 60 });
    expect(estimateMediaCredits(music, { durationSec: 30 })).toBe(60);
    expect(estimateMediaCredits(music, { durationSec: 61 })).toBe(120);
  });
});

/**
 * The number shown BEFORE the click is the whole point: a minute-long avatar
 * read has to look like a minute-long avatar read while there is still a
 * decision to make. So where a model's length is not something the request asks
 * for, the panel's mirror of the meter moves with the quantity that DOES decide
 * it — and where that quantity is not there yet, it admits it has no price
 * rather than showing the base rate as if it were one.
 *
 * Only one such quantity survives here: the SCRIPT, which is the prompt. The
 * models billed on a property of a customer's FILE cannot be priced this side of
 * the network at all, so they are withheld from the catalogue rather than quoted
 * off a browser's guess, and the panel never sees one.
 */
describe('estimateMediaCredits — a model billed on its script', () => {
  const metered = (
    sourceMetering: MediaSourceMeteringContract,
    over: Partial<MediaModelInfo> = {},
    promptParam: string | null = null,
  ): MediaModelInfo => ({
    id: 'x', technique: 'AVATAR', type: 'VIDEO', label: 'x',
    ...over,
    contract: { promptParam, negativePrompt: false, seedInput: false, sourceMetering },
  });

  const plain = (over: Partial<MediaModelInfo>): MediaModelInfo => ({
    id: 'y', technique: 'VIDEO_CREATE', type: 'VIDEO', label: 'y',
    contract: { promptParam: 'prompt', negativePrompt: false, seedInput: false },
    ...over,
  });

  const veed = metered(
    { quantity: 'durationSec', from: 'script', charsPerSec: 12 },
    { technique: 'AVATAR', creditsPerSec: 1 },
    'text',
  );

  it('quotes an avatar on how long its script takes to read', () => {
    // 720 characters at a deliberately slow 12 chars/s is a 60-second read —
    // $0.35 of VEED, against the flat 5 credits a requested-length quote showed.
    expect(estimateMediaCredits(veed, { textLength: 720 })).toBe(60);
    expect(estimateMediaCredits(veed, { textLength: 60 })).toBe(5);
  });

  it('ignores a requested duration the endpoint has no input for', () => {
    // The panel cannot offer a length here, but nothing stops one being left in
    // state from another technique. Quoting it would quote a number the endpoint
    // never sees.
    expect(estimateMediaCredits(veed, { durationSec: 5, textLength: 720 })).toBe(60);
  });

  it('reports that there is no price yet when the script is empty', () => {
    // estimateMediaCredits still returns a number here — the base rate, which is
    // exactly the leak — so the panel asks this question instead of showing it.
    expect(meteredQuantityMissing(veed, {})).toBe(true);
    expect(meteredQuantityMissing(veed, { textLength: 0 })).toBe(true);
    expect(meteredQuantityMissing(veed, { durationSec: 5 })).toBe(true);

    expect(meteredQuantityMissing(veed, { textLength: 10 })).toBe(false);
  });

  it('has no price at all for a model metered from a FILE', () => {
    // These are withheld server-side and never served to the panel. If one ever
    // arrives anyway, the honest answer is "no price", not a number invented
    // from a browser probe — the reserve would disagree with it, and the reserve
    // is what the customer pays.
    const upscaler = metered({ quantity: 'durationSec', from: ['video'] }, { creditsPerSec: 8 });
    expect(meteredQuantityMissing(upscaler, { durationSec: 60 })).toBe(true);
  });

  it('leaves an ordinary model alone', () => {
    const veo = plain({ creditsPerSec: 40 });
    expect(meteredQuantityMissing(veo, {})).toBe(false);
    expect(estimateMediaCredits(veo, { durationSec: 8 })).toBe(320);
  });
});
