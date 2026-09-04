import { buildRunwareTask, mapRunwareItem, RUNWARE_RECIPES } from './runware.provider';
import { MediaGenSubmit } from './media-provider.interface';
import { allMediaModels, DEFAULT_VIDEO_MODEL } from '../media/media-models.config';

const UUID = '11111111-2222-4333-8444-555555555555';
function build(over: Partial<MediaGenSubmit> & Pick<MediaGenSubmit, 'model'>) {
  return buildRunwareTask({ type: 'VIDEO', prompt: 'a hero shot of the bottle', ...over }, UUID);
}

/**
 * Runware normalises most of fal's per-endpoint parameter names away, but what
 * is left is still per model: which task type, which sizing table, whether the
 * model takes a seed / audio flag / frame images. Each of these is a 400 (or a
 * silently ignored input) if wrong, so each is pinned here without a network.
 * Field names come from docs/superpowers/specs/2026-09-04-runware-api-notes.md.
 */
describe('buildRunwareTask — per-model wire shape', () => {
  it('has a recipe for every catalogue binding', () => {
    for (const m of allMediaModels().filter((x) => x.runware)) {
      expect(RUNWARE_RECIPES[m.runware!.model]).toBeDefined();
    }
  });

  it('sends every task async, as URL output, with cost reporting and the client uuid', () => {
    expect(build({ model: 'fal-ai/qwen-image', type: 'IMAGE' })).toMatchObject({
      taskUUID: UUID, deliveryMethod: 'async', outputType: 'URL', includeCost: true, numberResults: 1,
    });
  });

  it('drops reference images on a text-to-video model instead of promoting one into a first frame', () => {
    // The campaign engine passes the brand kit's reference images on EVERY
    // generation. fal ignores them on a model with no source slot; Runware must
    // too, or the clip becomes an image-to-video render of the logo.
    for (const model of ['bytedance/seedance-2.5/text-to-video', DEFAULT_VIDEO_MODEL]) {
      const t = build({ model, aspectRatio: '9:16', sources: { images: ['https://cdn/logo.png'], lastImage: 'https://cdn/b.png' } });
      expect(t).not.toHaveProperty('inputs');
      expect(t).not.toHaveProperty('resolution');
      expect(t).toHaveProperty('width');
    }
  });

  it('Seedance 2.5 text-to-video: width/height from the aspect table, integer duration, audio on by default, no seed', () => {
    const t = build({
      model: 'bytedance/seedance-2.5/text-to-video', aspectRatio: '9:16', resolution: '720p', durationSec: 8, seed: 7,
    });
    expect(t).toMatchObject({
      taskType: 'videoInference', model: 'bytedance:seedance@2.5', positivePrompt: 'a hero shot of the bottle',
      width: 720, height: 1280, duration: 8, settings: { audio: true },
    });
    expect(t).not.toHaveProperty('seed');
    expect(t).not.toHaveProperty('resolution');
    expect(t).not.toHaveProperty('negativePrompt');
  });

  it('Seedance 2.5 image-to-video: frameImages + resolution, never width/height, last frame optional', () => {
    const t = build({
      model: 'bytedance/seedance-2.5/image-to-video', resolution: '480p', durationSec: 5,
      sources: { images: ['https://cdn/a.png'], lastImage: 'https://cdn/b.png' }, generateAudio: false,
    });
    expect(t).toMatchObject({
      resolution: '480p',
      inputs: { frameImages: [{ image: 'https://cdn/a.png', frame: 'first' }, { image: 'https://cdn/b.png', frame: 'last' }] },
      settings: { audio: false },
    });
    expect(t).not.toHaveProperty('width');
    expect(t).not.toHaveProperty('height');
    const single = build({ model: 'bytedance/seedance-2.5/image-to-video', sources: { images: ['https://cdn/a.png'] } });
    expect((single.inputs as { frameImages: unknown[] }).frameImages).toHaveLength(1);
  });

  it('bills and buys the same length: duration goes through the catalogue contract', () => {
    // Seedance 2.5 floors at 4s; Pro Fast caps at 12s.
    expect(build({ model: 'bytedance/seedance-2.5/text-to-video', durationSec: 2 }).duration).toBe(4);
    expect(build({ model: DEFAULT_VIDEO_MODEL, durationSec: 30 }).duration).toBe(12);
  });

  it('Seedance 1.0 Pro Fast: 720p dims for 16:9 by default, seed accepted, no audio setting', () => {
    const t = build({ model: DEFAULT_VIDEO_MODEL, seed: 42, durationSec: 5 });
    expect(t).toMatchObject({ model: 'bytedance:2@2', width: 1248, height: 704, duration: 5, seed: 42 });
    expect(t).not.toHaveProperty('settings');
    expect(build({ model: DEFAULT_VIDEO_MODEL, aspectRatio: '1:1', resolution: '1080p' }))
      .toMatchObject({ width: 1440, height: 1440 });
  });

  it('falls back to 16:9 for a ratio the sizing table does not offer', () => {
    expect(build({ model: DEFAULT_VIDEO_MODEL, aspectRatio: '4:5' })).toMatchObject({ width: 1248, height: 704 });
  });

  it('Qwen-Image: 1024x1024, 20 steps, PNG, negative prompt and seed pass through', () => {
    const t = build({ model: 'fal-ai/qwen-image', type: 'IMAGE', negativePrompt: 'blurry', seed: 3 });
    expect(t).toMatchObject({
      taskType: 'imageInference', model: 'runware:108@1', width: 1024, height: 1024, steps: 20,
      outputFormat: 'PNG', negativePrompt: 'blurry', seed: 3,
    });
  });

  it('BiRefNet: removeBackground on inputs.image as PNG, and refuses to run without a source', () => {
    const t = build({ model: 'fal-ai/birefnet/v2', type: 'IMAGE', prompt: '', sources: { images: ['https://cdn/p.jpg'] } });
    expect(t).toMatchObject({
      taskType: 'removeBackground', model: 'runware:112@5', inputs: { image: 'https://cdn/p.jpg' }, outputFormat: 'PNG',
    });
    expect(t).not.toHaveProperty('positivePrompt');
    // Not in the removeBackground schema; an unknown field is a validation error.
    expect(t).not.toHaveProperty('numberResults');
    expect(() => build({ model: 'fal-ai/birefnet/v2', type: 'IMAGE', prompt: '' })).toThrow(/source image/);
  });

  it('refuses a model with no Runware binding', () => {
    expect(() => build({ model: 'fal-ai/veo3.1', durationSec: 8 })).toThrow(/no Runware binding/);
  });
});

describe('mapRunwareItem', () => {
  it('maps a video result', () => {
    expect(mapRunwareItem({ taskType: 'videoInference', videoURL: 'https://vm.runware.ai/video/x.mp4', cost: 1.16 }))
      .toEqual([{ url: 'https://vm.runware.ai/video/x.mp4', mime: 'video/mp4', width: undefined, height: undefined, durationSec: undefined }]);
  });

  it('maps an image result and infers the mime from the extension', () => {
    expect(mapRunwareItem({ taskType: 'imageBackgroundRemoval', imageURL: 'https://im.runware.ai/i/a.png' })[0].mime).toBe('image/png');
    expect(mapRunwareItem({ taskType: 'imageInference', imageURL: 'https://im.runware.ai/i/a.jpg' })[0].mime).toBe('image/jpeg');
  });

  it('returns nothing for an item with no media', () => {
    expect(mapRunwareItem({ taskType: 'videoInference', status: 'processing', progress: 40 })).toEqual([]);
  });
});
