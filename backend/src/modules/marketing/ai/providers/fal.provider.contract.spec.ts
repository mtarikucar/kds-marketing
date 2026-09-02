import { buildFalInput, mapFalOutputs } from './fal.provider';
import { MediaGenSubmit } from './media-provider.interface';

function build(over: Partial<MediaGenSubmit> & Pick<MediaGenSubmit, 'model'>) {
  return buildFalInput({ type: 'VIDEO', prompt: 'a hero shot of the bottle', ...over });
}

/**
 * The provider must serialise from each model's INPUT CONTRACT. These are the
 * three failure modes the old flat mapping had: a duration of the wrong TYPE,
 * a parameter the endpoint does not accept, and source media under the wrong
 * parameter name. Each is a 422 (or a silently ignored input), not a coercion.
 */
describe('buildFalInput — per-model wire shape', () => {
  describe('duration encoding', () => {
    it('sends Seedance 2.5 a DIGIT-STRING (an integer is a 422 there)', () => {
      const input = build({ model: 'bytedance/seedance-2.5/text-to-video', durationSec: 8 });
      expect(input.duration).toBe('8');
    });

    it("sends Veo 3.1 a trailing-'s' string (neither 8 nor \"8\" is accepted)", () => {
      const input = build({ model: 'fal-ai/veo3.1', durationSec: 8 });
      expect(input.duration).toBe('8s');
    });

    it('sends the v1 models a real integer', () => {
      const input = build({ model: 'fal-ai/bytedance/seedance/v1/lite/text-to-video', durationSec: 8 });
      expect(input.duration).toBe(8);
    });

    it('sends ElevenLabs Music MILLISECONDS under music_length_ms', () => {
      const input = build({ model: 'fal-ai/elevenlabs/music', prompt: 'warm lo-fi bed', durationSec: 30 });
      expect(input.music_length_ms).toBe(30_000);
      expect(input.duration).toBeUndefined();
    });

    it("snaps DOWN to the model's offered lengths, never up", () => {
      // Veo offers 4s/6s/8s. A 5s request must bill and buy 4s: snapping up would
      // charge the customer for capacity they did not ask for.
      expect(build({ model: 'fal-ai/veo3.1', durationSec: 5 }).duration).toBe('4s');
      expect(build({ model: 'fal-ai/veo3.1', durationSec: 30 }).duration).toBe('8s');
      expect(build({ model: 'fal-ai/veo3.1', durationSec: 1 }).duration).toBe('4s');
    });
  });

  describe('parameters the model does not accept', () => {
    it('never sends a seed to Seedance 2.5 text-to-video (seed is output-only there)', () => {
      const input = build({ model: 'bytedance/seedance-2.5/text-to-video', seed: 7 });
      expect(input).not.toHaveProperty('seed');
      // …while its image-to-video sibling DOES take one.
      const sibling = build({
        model: 'bytedance/seedance-2.5/image-to-video', seed: 7,
        sources: { images: ['https://cdn/still.png'] },
      });
      expect(sibling.seed).toBe(7);
    });

    it('never sends negative_prompt to a model without one', () => {
      const input = build({
        model: 'fal-ai/nano-banana-pro/edit', negativePrompt: 'blurry',
        sources: { images: ['https://cdn/a.png'] },
      });
      expect(input).not.toHaveProperty('negative_prompt');
    });

    it('sends no prompt at all to a pure transform', () => {
      const input = build({
        model: 'fal-ai/topaz/upscale/image', prompt: 'make it pop',
        sources: { images: ['https://cdn/a.png'] },
      });
      expect(input).not.toHaveProperty('prompt');
      expect(input.image_url).toBe('https://cdn/a.png');
    });

    it('renames the prompt where the model renames it', () => {
      expect(build({
        model: 'fal-ai/bria/product-shot', prompt: 'on a marble counter',
        sources: { images: ['https://cdn/p.png'] },
      })).toMatchObject({ scene_description: 'on a marble counter', placement_type: 'automatic' });
      expect(build({
        model: 'fal-ai/elevenlabs/tts/multilingual-v2', prompt: 'Merhaba', type: 'AUDIO',
      })).toMatchObject({ text: 'Merhaba' });
    });
  });

  describe('source media', () => {
    it('puts the same image under image_url, image_urls or start_image_url per model', () => {
      const images = ['https://cdn/a.png', 'https://cdn/b.png'];
      expect(build({ model: 'fal-ai/flux-pro/kontext', sources: { images } }).image_url)
        .toBe('https://cdn/a.png');
      expect(build({ model: 'fal-ai/nano-banana-pro/edit', sources: { images } }).image_urls)
        .toEqual(images);
      expect(build({
        model: 'fal-ai/wan-flf2v', sources: { images, lastImage: 'https://cdn/z.png' },
      })).toMatchObject({ start_image_url: 'https://cdn/a.png', end_image_url: 'https://cdn/z.png' });
    });

    it('routes video + audio sources for lipsync', () => {
      expect(build({
        model: 'fal-ai/latentsync',
        sources: { video: 'https://cdn/take.mp4', audio: 'https://cdn/vo.mp3' },
      })).toMatchObject({ video_url: 'https://cdn/take.mp4', audio_url: 'https://cdn/vo.mp3' });
    });

    it("trims a reference list to the model's own cap", () => {
      const many = Array.from({ length: 12 }, (_, i) => `https://cdn/${i}.png`);
      const input = build({ model: 'bytedance/seedream/v5/pro/edit', sources: { images: many } });
      expect((input.image_urls as string[]).length).toBe(10);
    });

    it('throws rather than posting a request missing a required source', () => {
      expect(() => build({ model: 'fal-ai/latentsync', sources: { video: 'https://cdn/take.mp4' } }))
        .toThrow(/requires a source: audio_url/);
    });
  });

  describe('resolution, aspect and audio', () => {
    it('always sends resolution explicitly, defaulting rather than omitting', () => {
      // Omitting it lets a fal default decide, and several models default to
      // their priciest tier — while the credit estimate was taken on a tier.
      expect(build({ model: 'fal-ai/veo3.1' }).resolution).toBe('720p');
      expect(build({ model: 'fal-ai/veo3.1', resolution: '4k' }).resolution).toBe('4k');
      expect(build({ model: 'fal-ai/veo3.1', resolution: '4K' }).resolution).toBe('720p');
    });

    it('maps the canonical ratio onto whichever spelling the model publishes', () => {
      expect(build({ model: 'fal-ai/veo3.1', aspectRatio: '9:16' }).aspect_ratio).toBe('9:16');
      // Seedream takes a NAMED ImageSize preset, not a bare ratio.
      const seedream = build({
        model: 'fal-ai/bytedance/seedream/v4/text-to-image', aspectRatio: '9:16', type: 'IMAGE',
      });
      expect(seedream.image_size).toBe('portrait_16_9');
      expect(seedream).not.toHaveProperty('aspect_ratio');
    });

    it('always sends the audio flag under the name and default THIS model uses', () => {
      expect(build({ model: 'fal-ai/veo3.1' }).generate_audio).toBe(true);
      // PixVerse names it differently and defaults it off.
      const px = build({ model: 'fal-ai/pixverse/v6/extend', sources: { video: 'https://cdn/v.mp4' } });
      expect(px.generate_audio_switch).toBe(false);
      expect(px).not.toHaveProperty('generate_audio');
      expect(build({
        model: 'fal-ai/pixverse/v6/extend', generateAudio: true,
        sources: { video: 'https://cdn/v.mp4' },
      }).generate_audio_switch).toBe(true);
    });
  });


  /**
   * PRICE DIALS. Some fal parameters are not settings, they are the bill: an
   * unsent one lets fal pick, and fal's pick is the expensive branch of a price
   * table we already quoted the customer against.
   */
  describe('parameters that decide the price', () => {
    it('does NOT pin the Topaz video frame rate — setting it is what doubles the bill', () => {
      // fal: "$0.01/s up to 720p, $0.02 to 1080p, $0.08 above — price DOUBLES
      // for 60fps output", and, on target_fps itself: "set it and you also pay
      // the 60fps multiplier". So the multiplier attaches to SETTING the
      // parameter, not to the value: pinning 30 to avoid the doubling buys the
      // doubling. Unset, the endpoint costs what its published pricing says.
      // (This model is withheld for a separate reason — its bill is the source
      // clip's length, which nothing here can measure — but its entry has to
      // describe the price fal actually charges, or the research is worthless
      // the day a probe lands.)
      const input = build({ model: 'fal-ai/topaz/upscale/video', sources: { video: 'https://cdn/v.mp4' } });
      expect('target_fps' in input).toBe(false);
    });

    it('pins the Seedream 5 Pro EDIT size tier, not just the text-to-image one', () => {
      // This family defaults image_size to auto_2K, which is $0.135 — double the
      // $0.0675 tier the catalogue bills. The text-to-image sibling pins a preset
      // for exactly that reason; the edit endpoint sent nothing, which is not
      // "no opinion", it is choosing fal's expensive default.
      const edit = build({ model: 'bytedance/seedream/v5/pro/edit', type: 'IMAGE', sources: { images: ['https://cdn/a.png'] } });
      expect(edit.image_size).toBe('auto_1K');
      expect(edit.image_size).not.toBe('auto_2K');
    });
  });

  describe('catalogue-declared choices', () => {
    it('defaults the TTS voice/language and accepts a free-form override', () => {
      expect(build({ model: 'fal-ai/elevenlabs/tts/multilingual-v2', type: 'AUDIO' }))
        .toMatchObject({ voice: 'Rachel', language_code: 'tr' });
      expect(build({
        model: 'fal-ai/elevenlabs/tts/multilingual-v2', type: 'AUDIO',
        voice: 'Charlotte', language: 'en',
      })).toMatchObject({ voice: 'Charlotte', language_code: 'en' });
    });

    it('rejects an avatar id outside the enum and falls back to the default', () => {
      expect(build({ model: 'veed/avatars/text-to-video', avatar: 'not_a_real_avatar' }).avatar_id)
        .toBe('emily_vertical_primary');
      expect(build({ model: 'veed/avatars/text-to-video', avatar: 'marcus_primary' }).avatar_id)
        .toBe('marcus_primary');
    });
  });
});

describe('mapFalOutputs — fal has no single result envelope', () => {
  it('reads a singular image object (the finishing family returns one)', () => {
    expect(mapFalOutputs({ image: { url: 'https://fal/up.png', content_type: 'image/png' } }))
      .toEqual([{ url: 'https://fal/up.png', mime: 'image/png', width: undefined, height: undefined, durationSec: undefined }]);
  });

  it('reads an audio object (ElevenLabs) as an mp3 output', () => {
    expect(mapFalOutputs({ audio: { url: 'https://fal/vo.mp3' } }))
      .toEqual([{ url: 'https://fal/vo.mp3', mime: 'audio/mpeg', durationSec: undefined }]);
  });

  it('reads a top-level duration for models that report length there', () => {
    // Kling's avatar endpoints put `duration` beside `video`, not on it — and the
    // caller cannot set the length, so this is the only figure the credit
    // true-up can use.
    const [out] = mapFalOutputs({ video: { url: 'https://fal/a.mp4' }, duration: 12.5 });
    expect(out).toMatchObject({ url: 'https://fal/a.mp4', durationSec: 12.5 });
  });

  it('ignores an entry with no url instead of emitting a broken output', () => {
    expect(mapFalOutputs({ images: [{ content_type: 'image/png' }] })).toEqual([]);
  });
});
