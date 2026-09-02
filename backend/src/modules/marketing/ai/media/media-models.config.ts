import { BadRequestException } from '@nestjs/common';
import { GeneratedAssetType } from './media-asset.constants';

/**
 * The 14 production TECHNIQUES the studio offers. This — not the model name —
 * is the user's top-level choice ("what do you want to make"); the model is the
 * quality/price tier inside it.
 */
export const MEDIA_TECHNIQUES = [
  'IMAGE_CREATE',     // a picture from a description
  'IMAGE_EDIT',       // change one thing, keep the rest
  'IMAGE_CLEANUP',    // background removal, upscale, product-in-a-scene
  'VIDEO_CREATE',     // a clip from a description
  'VIDEO_ANIMATE',    // animate a still
  'VIDEO_REFERENCE',  // keep a character/product consistent across shots
  'VIDEO_TRANSITION', // first frame → last frame
  'VIDEO_EXTEND',     // continue an existing clip
  'VIDEO_UPSCALE',    // finish a clip at delivery resolution
  'AVATAR',           // a person reading your script
  'LIPSYNC',          // drive an existing face from an audio track
  'VOICE',            // voiceover (TTS)
  'MUSIC',            // a music bed or a sound effect
  'VIDEO_SOUND',      // a soundtrack for a silent clip
] as const;
export type MediaTechnique = (typeof MEDIA_TECHNIQUES)[number];

// ---------------------------------------------------------------------------
// INPUT CONTRACT
//
// fal does NOT share one request shape. The same logical parameter is spelled,
// typed and defaulted differently per endpoint, and sending a value of the wrong
// TYPE is a 422, not a coerced value. The contract below is what each model's own
// fal.ai page states (research pass 2026-09-02); the provider serialises from it
// instead of shipping one flat parameter set at every endpoint.
// ---------------------------------------------------------------------------

/** How a model wants a duration on the wire. Three of these coexist inside the
 *  video family alone, which is why there is no shared coercion helper. */
export type MediaDurationEncoding =
  | 'integerSeconds'      // duration: 8          (Seedance v1, PixVerse v6 extend)
  | 'digitStringSeconds'  // duration: "8"        (Seedance 2.5 — an int is a 422)
  | 'suffixedSeconds'     // duration: "8s"       (Veo 3.1 — "8" is also a 422)
  | 'floatSeconds'        // duration_seconds: 8.5 (ElevenLabs SFX, MMAudio)
  | 'milliseconds';       // music_length_ms: 8000 (ElevenLabs Music)

export interface MediaDurationContract {
  /** Wire parameter name — `duration` is not universal. */
  param: string;
  encoding: MediaDurationEncoding;
  minSec: number;
  maxSec: number;
  /** When the model takes an enum of lengths, the request is snapped DOWN to the
   *  nearest allowed value (never up — snapping up would over-charge). */
  allowedSec?: readonly number[];
}

export interface MediaResolutionContract {
  /** `resolution` on the video models, `operating_resolution` on BiRefNet. */
  param: string;
  /** The literal wire values, cheapest first. Casing is load-bearing ("4k"). */
  values: readonly string[];
  /** Always sent explicitly — several models default to their priciest tier. */
  default: string;
}

/** Aspect ratio arrives as either a bare `aspect_ratio` enum or a named
 *  `image_size` preset, so the catalogue maps our canonical ratio to the literal
 *  wire value instead of assuming one spelling. A ratio absent from `values` is
 *  not offered by that model. */
export interface MediaAspectContract {
  param: 'aspect_ratio' | 'image_size';
  values: Readonly<Record<string, string>>;
}

/** Native synchronised audio. The flag name and its DEFAULT both vary, and audio
 *  roughly doubles Veo's price, so the provider always sends it explicitly. */
export interface MediaAudioContract {
  param: string;
  default: boolean;
}

/** Where the caller's source media goes. `firstImage` reads sources.images[0]. */
export type MediaSourceSlot = 'images' | 'firstImage' | 'lastImage' | 'video' | 'audio' | 'mask';

export interface MediaSourceContract {
  slot: MediaSourceSlot;
  /** image_url vs image_urls vs start_image_url vs video_url vs audio_url — four
   *  spellings for "the source image" alone. Never pattern-match this. */
  param: string;
  arity: 'single' | 'array';
  required: boolean;
  maxCount?: number;
}

/** A caller-selectable enum that is neither prompt nor media (voice, language,
 *  stock avatar). `values: []` means the field is free-form. */
export type MediaChoiceSlot = 'voice' | 'language' | 'avatar';

export interface MediaChoiceContract {
  param: string;
  values: readonly string[];
  default: string;
}

// ---------------------------------------------------------------------------
// SOURCE METERING
//
// Most models bill on a quantity the REQUEST names: a duration we sent, a
// resolution we picked, a script we typed. A handful bill on a quantity that is
// a property of the caller's SOURCE instead — the length of the clip handed to
// an upscaler, the pixel count of the image handed to Topaz, the spoken length
// of a script an avatar reads. For those the request says nothing about the
// bill, so estimating from the request means estimating from a default: the old
// `dto.durationSec ?? 5` reserved 40 credits for a 60-second Topaz upscale that
// costs $4.80, and no finalize true-up could ever correct it because these
// endpoints return no duration and no dimensions.
//
// The catalogue's own idiom for an unresolvable cost is "meter the worst case".
// That was applied to resolution and never to duration or to source size. The
// answer is not a worse worst case — a 2-hour ceiling would price every 5-second
// upscale like a feature film. It is to MEASURE.
//
// WHICH IS WHY FOUR MODELS ARE `withheld` (see the field below). A measurement
// the CALLER states is not a measurement — it is a number the payer chooses —
// so the quantity has to be read from the file server-side, and the only way to
// do that without a real media probe in the production image was a hand-written
// container parser. That parser was proved unsound in BOTH directions: it
// invented a duration for roughly one non-faststart phone video in three (52x
// to 419x over-charge) and a decoy `mvhd` box walked it into a 600x
// under-charge. Guessing cheap and guessing dear are the same defect. So the
// four models whose price is a property of a customer-supplied FILE are
// withheld until a real probe (ffprobe, server-side) exists to measure it, and
// their metering contracts stay here — verified, tested and unserved — as the
// specification that probe has to satisfy.
//
// What still ships is the one metered quantity the REQUEST honestly carries: a
// script, which is the prompt, which is already ours to read (`from: 'script'`).
// ---------------------------------------------------------------------------

/** What a source-metered model bills on. */
export type MediaMeteredQuantity =
  | 'durationSec'  // seconds of source media (or of the script's spoken read)
  | 'megapixels';  // OUTPUT megapixels, derived from the source's pixel count

/** Where the measurement comes from. `'script'` is the prompt text's spoken
 *  length; otherwise the named source slots, of which the LARGEST decides
 *  (LatentSync loops the shorter of video/audio up to the longer one). */
export type MediaMeteredFrom = 'script' | readonly MediaSourceSlot[];

/** One rung of a banded rate. The rung that applies is the cheapest whose
 *  `maxUnits` is at or above the measured quantity — Topaz image publishes a
 *  step function of output megapixels, not a per-megapixel price.
 *
 *  Stated in USD only. A metered rate is declared ONCE and the customer's credit
 *  figure is derived from it (`ceil(usd * 100)`); a second, hand-rounded credit
 *  rate alongside it is how the two estimates drifted apart in the first place. */
export interface MediaRateStep {
  maxUnits: number;
  priceUsd: number;
}

export interface MediaSourceMeteringContract {
  quantity: MediaMeteredQuantity;
  from: MediaMeteredFrom;
  /** Source → OUTPUT multiplier. Topaz bills OUTPUT pixels and its pinned
   *  `upscale_factor: 2` makes those 4x the source's. 1 (the default) where the
   *  output matches the source, as on a mask-aligned inpaint. */
  outputFactor?: number;
  /** Units already covered by the model's FLAT rate. LatentSync is $0.20 for
   *  anything up to 40s and $0.005/s after, so `freeUnits: 40` bills the flat
   *  base plus per-unit overage. With no `freeUnits` the flat base is not part
   *  of the bill at all and the per-unit rate stands alone. */
  freeUnits?: number;
  /** Per-unit rate beyond `freeUnits`, in USD. Omit where the model's own
   *  per-second rate already applies and the measurement only supplies the
   *  seconds. There is deliberately no `creditsPerUnit` twin: the credit figure
   *  is `ceil(usd * 100)` of the EXACT amount, computed once, because rounding a
   *  sub-cent rate up per unit and then multiplying is what billed a 300-second
   *  LatentSync 280 credits ($2.80) on the same row that recorded $1.50. */
  pricePerUnitUsd?: number;
  /** Banded rate, cheapest rung first. Mutually exclusive with the per-unit pair. */
  ladder?: readonly MediaRateStep[];
  /** The endpoint's own published ceiling on the metered quantity. Past it the
   *  request is refused rather than billed off the end of the ladder. */
  maxUnits?: number;
  /** Characters of script per second of speech, for `from: 'script'`. Deliberately
   *  a SLOW read: a slower rate estimates MORE seconds, which is the safe
   *  direction when the true length is only knowable after the render. */
  charsPerSec?: number;
}

export interface MediaInputContract {
  /** Wire name for the prompt, or null for a pure transform (upscale, matting,
   *  lipsync) that takes no prompt at all. `scene_description` on Bria, `text`
   *  on the ElevenLabs/VEED endpoints. */
  promptParam: string | null;
  negativePrompt: boolean;
  /** Whether the model accepts a seed as INPUT. Seedance 2.5 returns a seed but
   *  does not take one — sending it is not a supported param there. */
  seedInput: boolean;
  duration?: MediaDurationContract;
  resolution?: MediaResolutionContract;
  aspect?: MediaAspectContract;
  audio?: MediaAudioContract;
  sources?: readonly MediaSourceContract[];
  choices?: Partial<Record<MediaChoiceSlot, MediaChoiceContract>>;
  /** Present when the billable quantity is a property of the caller's SOURCE
   *  rather than of the request. The service refuses such a generation before
   *  the reserve until the measurement is supplied — see SOURCE METERING. */
  sourceMetering?: MediaSourceMeteringContract;
  /** The RESPONSE carries the rendered length, so a per-second model with no
   *  duration INPUT is still exactly billable: the reserve is provisional and
   *  `finalizeAsset` trues it up — in both directions — against what fal says it
   *  actually produced. Declared, not assumed: it is the difference between a
   *  model whose seconds are knowable after the fact and one (the upscalers)
   *  whose seconds are never knowable at all. */
  returnsDuration?: true;
  /** Literal params pinned by the catalogue — usually because a fal default is
   *  load-bearing (a price dial, or a mode that changes the output shape). */
  fixed?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// PRICING
//
// ~1 credit ≈ $0.01 of generation spend, rounded UP so we never under-charge.
// Where a price varies by resolution AND the UI exposes that choice, the tier
// carries its own rate: one averaged rate under-charges the top tier, which is
// the tier that costs real money. `tiers` lists only the DEVIATIONS — the
// model's own fields are the rate for `contract.resolution.default`.
// ---------------------------------------------------------------------------

export interface MediaRate {
  /** Flat USD per image / per run. */
  priceUsd?: number;
  credits?: number;
  /** USD per second of output. */
  pricePerSecUsd?: number;
  creditsPerSec?: number;
  /** USD per 1000 characters of script (TTS). */
  pricePerKCharUsd?: number;
  creditsPerKChar?: number;
  /** USD per output minute, billed in whole minutes rounded up (music). */
  pricePerMinuteUsd?: number;
  creditsPerMinute?: number;
}

export interface MediaModel extends MediaRate {
  /** The EXACT queue.fal.run/{id} path. Never derived from a sibling. */
  id: string;
  technique: MediaTechnique;
  type: GeneratedAssetType;
  label: string;
  contract: MediaInputContract;
  tiers?: Readonly<Record<string, MediaRate>>;
  /** Why this price/contract is what it is, where that is not obvious. */
  note?: string;
  /**
   * WITHHELD — the entry stays, the model is not offered. The string is the
   * reason, in the model's own terms.
   *
   * A withheld model keeps everything that was verified about it: its exact
   * endpoint id, its input contract and its published pricing. It is simply not
   * sold. `listMediaModels` drops it (so the models endpoint and the studio
   * never see it) and the service refuses it BEFORE any credit is reserved, so
   * naming one directly on the API is a 400 rather than a mispriced render. The
   * live fitness probe still walks it, because a withheld model is still a real
   * endpoint and we want to know if it dies.
   *
   * Withdrawal is not deletion: the research is the point. When the blocker in
   * the reason clears, un-withholding is deleting one line.
   */
  withheld?: string;
}

export const DEFAULT_IMAGE_MODEL = 'fal-ai/bytedance/seedream/v4/text-to-image';
export const DEFAULT_VIDEO_MODEL = 'fal-ai/bytedance/seedance/v1/lite/text-to-video';
export const DEFAULT_AUDIO_MODEL = 'fal-ai/elevenlabs/tts/multilingual-v2';

// Shared aspect maps. Reused verbatim where two endpoints genuinely publish the
// same enum — never to "fill in" an endpoint whose enum was not read.

/** The named ImageSize presets (Seedream v4/v5, Ideogram). All of these land
 *  under 1536x1536, which is also what keeps Seedream v5 Pro in its cheap tier. */
const IMAGE_SIZE_PRESETS: MediaAspectContract = {
  param: 'image_size',
  values: {
    '1:1': 'square_hd',
    '3:4': 'portrait_4_3',
    '9:16': 'portrait_16_9',
    '4:3': 'landscape_4_3',
    '16:9': 'landscape_16_9',
  },
};

/** Seedance 2.5's aspect enum, identical across its t2v/i2v/r2v endpoints. */
const SEEDANCE_25_ASPECT: MediaAspectContract = {
  param: 'aspect_ratio',
  values: {
    '21:9': '21:9', '16:9': '16:9', '4:3': '4:3',
    '1:1': '1:1', '3:4': '3:4', '9:16': '9:16',
  },
};

const SEEDANCE_25_RESOLUTION: MediaResolutionContract = {
  param: 'resolution', values: ['480p', '720p', '1080p'], default: '720p',
};

/** Seedance 2.5 duration is a DIGIT-STRING enum "auto"|"4".."30". */
const SEEDANCE_25_DURATION: MediaDurationContract = {
  param: 'duration', encoding: 'digitStringSeconds', minSec: 4, maxSec: 30,
};

/** Token-priced, so the per-second figures are the practical rates the model
 *  page quotes: 480p ≈ $0.2205/s, 720p ≈ $0.4730/s, 1080p ≈ $1.164/s. */
const SEEDANCE_25_TIERS: Record<string, MediaRate> = {
  '480p': { pricePerSecUsd: 0.2205, creditsPerSec: 23 },
  '1080p': { pricePerSecUsd: 1.164, creditsPerSec: 117 },
};

const VEO_31_RESOLUTION: MediaResolutionContract = {
  param: 'resolution', values: ['720p', '1080p', '4k'], default: '720p', // lowercase "4k", not "4K"
};

/** Veo is the only family whose duration carries a literal trailing 's'. */
const VEO_31_DURATION: MediaDurationContract = {
  param: 'duration', encoding: 'suffixedSeconds', minSec: 4, maxSec: 8, allowedSec: [4, 6, 8],
};

/**
 * The shared first half of every `withheld` reason: the one thing all four have
 * in common is that their price is a property of a file the customer supplies,
 * and nothing here can measure that file yet. Each entry appends what is
 * specific to it.
 *
 * Stated once because it is one decision, not four, and because the sentence
 * that unblocks it is the same sentence in every case: put a real probe
 * (ffprobe) in the production image and measure the quantity instead of
 * asserting it.
 */
const WITHHELD_NEEDS_A_REAL_PROBE =
  'This model is priced by measuring a file the customer supplies, and there is '
  + 'no sound way to measure it yet, so it is not sold. A quantity stated by the '
  + 'CALLER is not a measurement — it is a number the payer chooses — and these '
  + 'endpoints report nothing back that a finalize true-up could correct, so '
  + 'whatever is used at reserve time is what is billed, permanently. The '
  + 'server-side container parser written to read it was withdrawn for being '
  + 'unsound in BOTH directions: it invented a duration for roughly one ordinary '
  + 'non-faststart phone video in three (52x to 419x OVER) and a decoy `mvhd` box '
  + 'walked it into a 600x UNDER-charge. Guessing dear is not safer than guessing '
  + 'cheap; it is the same defect. What unblocks it is a real probe in the '
  + 'production image (ffprobe, server-side) so the billable quantity is MEASURED '
  + 'rather than asserted — its own change, with its own deploy risk. Until then '
  + 'the entry stays exactly as verified against fal\'s published contract and '
  + 'pricing, and un-withholding it is deleting one line. ';

/**
 * fal.ai model catalogue, organised by TECHNIQUE.
 *
 * IDs are the EXACT queue.fal.run/{id} endpoint path, copied verbatim from each
 * model's own fal.ai page. fal's prefix scheme is genuinely inconsistent — it
 * differs WITHIN one model family (`bytedance/seedream/v5/pro/...` carries no
 * `fal-ai/` prefix while `fal-ai/bytedance/seedream/v5/lite/...` does), and
 * Veo has no `/text-to-video` suffix at all. This repo has already shipped a
 * derived id (`fal-ai/bytedance/seedream/v4` without its `/text-to-image`
 * suffix) and burned 7 production generations on the 404. Never pattern-match
 * an id; `media-models.catalogue.spec.ts` probes every one of these against
 * fal's schema endpoint under FAL_CATALOGUE_PROBE=1.
 *
 * Credits are the customer-facing meter; prices are USD bookkeeping.
 */
export const MEDIA_MODELS: Record<string, MediaModel> = {
  // ---------------------------------------------------------------- IMAGE_CREATE
  'fal-ai/qwen-image': {
    id: 'fal-ai/qwen-image',
    technique: 'IMAGE_CREATE', type: 'IMAGE', label: 'Draft image',
    priceUsd: 0.02, credits: 2,
    // Legacy entry, catalogued before the 2026-09-02 schema pass and not covered
    // by it. Its aspect handling is deliberately absent rather than guessed: the
    // old provider sent `aspect_ratio`, which this endpoint does not document, so
    // it was being ignored on the wire anyway. Dropping it changes nothing.
    contract: { promptParam: 'prompt', negativePrompt: true, seedInput: true },
  },
  [DEFAULT_IMAGE_MODEL]: {
    id: DEFAULT_IMAGE_MODEL,
    technique: 'IMAGE_CREATE', type: 'IMAGE', label: 'Final image',
    priceUsd: 0.03, credits: 3,
    // No aspect_ratio and no negative_prompt on this endpoint — size is chosen
    // through the ImageSize presets. image_size is only sent when the caller
    // asked for a ratio, so the model's own `auto` default is preserved.
    contract: { promptParam: 'prompt', negativePrompt: false, seedInput: true, aspect: IMAGE_SIZE_PRESETS },
  },
  'bytedance/seedream/v5/pro/text-to-image': {
    id: 'bytedance/seedream/v5/pro/text-to-image',
    technique: 'IMAGE_CREATE', type: 'IMAGE', label: 'Seedream 5 Pro — multilingual text & layout',
    priceUsd: 0.0675, credits: 7,
    note: 'NO fal-ai/ prefix (the v5 LITE sibling has one). Native text in 14 '
      + 'languages. $0.0675/image up to 1536x1536, $0.135 above it — image_size is '
      + 'pinned to a named preset so we always bill and buy the cheap tier.',
    contract: {
      promptParam: 'prompt', negativePrompt: false, seedInput: false,
      aspect: IMAGE_SIZE_PRESETS, fixed: { image_size: 'square_hd', output_format: 'jpeg' },
    },
  },
  'fal-ai/bytedance/seedream/v5/lite/text-to-image': {
    id: 'fal-ai/bytedance/seedream/v5/lite/text-to-image',
    technique: 'IMAGE_CREATE', type: 'IMAGE', label: 'Seedream 5 Lite — high volume',
    priceUsd: 0.035, credits: 4,
    note: 'PRICE IS THE WEAK LINK: this endpoint\'s own page states no figure. '
      + '$0.035 is what its /lite/edit sibling publishes. Re-measure before this '
      + 'is trusted as a margin. return_byteplus_urls is deliberately NOT set — '
      + 'those URLs expire after 24h and we persist results to R2.',
    contract: {
      promptParam: 'prompt', negativePrompt: false, seedInput: false, aspect: IMAGE_SIZE_PRESETS,
    },
  },
  'fal-ai/ideogram/v3': {
    id: 'fal-ai/ideogram/v3',
    technique: 'IMAGE_CREATE', type: 'IMAGE', label: 'Ideogram V3 — typography & headlines',
    priceUsd: 0.06, credits: 6,
    note: 'rendering_speed IS the price dial ($0.03 TURBO / $0.06 BALANCED / '
      + '$0.09 QUALITY) so it is pinned to the metered tier rather than exposed. '
      + 'expand_prompt is forced off: it is MagicPrompt rewriting, which silently '
      + 'rewords the headline copy the customer asked to be rendered literally.',
    contract: {
      promptParam: 'prompt', negativePrompt: true, seedInput: true, aspect: IMAGE_SIZE_PRESETS,
      fixed: { rendering_speed: 'BALANCED', expand_prompt: false },
    },
  },

  // ------------------------------------------------------------------ IMAGE_EDIT
  'bytedance/seedream/v5/pro/edit': {
    id: 'bytedance/seedream/v5/pro/edit',
    technique: 'IMAGE_EDIT', type: 'IMAGE', label: 'Seedream 5 Pro — region-precise edit',
    priceUsd: 0.108, credits: 11,
    note: 'NO fal-ai/ prefix. $0.0675 + $0.0045 per ADDITIONAL input image at the '
      + 'cheap size tier; billed here at the 10-input worst case ($0.108) because '
      + 'the estimate is taken before the reserve and a per-input meter is not '
      + 'worth the drift. image_size IS pinned, for the same reason its '
      + 'text-to-image sibling pins it: this family defaults to auto_2K, which is '
      + '$0.135 — above the tier we bill — and sending nothing was choosing that '
      + 'default. auto_1K is the cheap tier while still following the source\'s '
      + 'shape, which square_hd would not on an edit. The page\'s form exposes '
      + 'only prompt + image_urls, so this parameter is documented-by-family '
      + 'rather than read off this endpoint: if it is ignored, the size tier goes '
      + 'back to being fal\'s choice (the catalogue probe spec is what would '
      + 'catch it).',
    contract: {
      promptParam: 'prompt', negativePrompt: false, seedInput: false,
      sources: [{ slot: 'images', param: 'image_urls', arity: 'array', required: true, maxCount: 10 }],
      fixed: { image_size: 'auto_1K' },
    },
  },
  'fal-ai/flux-pro/kontext': {
    id: 'fal-ai/flux-pro/kontext',
    technique: 'IMAGE_EDIT', type: 'IMAGE', label: 'FLUX.1 Kontext Pro — single-image edit',
    priceUsd: 0.04, credits: 4,
    note: 'Takes image_url SINGULAR, unlike every other edit endpoint here. Flat '
      + 'rate per image regardless of output size, so large edits are predictable.',
    contract: {
      promptParam: 'prompt', negativePrompt: false, seedInput: true,
      aspect: {
        param: 'aspect_ratio',
        values: {
          '21:9': '21:9', '16:9': '16:9', '4:3': '4:3', '3:2': '3:2', '1:1': '1:1',
          '2:3': '2:3', '3:4': '3:4', '9:16': '9:16', '9:21': '9:21',
        },
      },
      sources: [{ slot: 'firstImage', param: 'image_url', arity: 'single', required: true }],
    },
  },
  'fal-ai/nano-banana-pro/edit': {
    id: 'fal-ai/nano-banana-pro/edit',
    technique: 'IMAGE_EDIT', type: 'IMAGE', label: 'Nano Banana Pro — multi-reference edit',
    priceUsd: 0.15, credits: 15,
    tiers: { '4K': { priceUsd: 0.30, credits: 30 } }, // 4K bills at double the family rate
    note: 'Holds product/character identity across up to 14 references — the "one '
      + 'product shot → a campaign" primitive. resolution is a STRING enum '
      + '"1K"|"2K"|"4K", and 4K costs double, so it carries its own tier rather '
      + 'than an average that would under-charge every 4K render.',
    contract: {
      promptParam: 'prompt', negativePrompt: false, seedInput: true,
      resolution: { param: 'resolution', values: ['1K', '2K', '4K'], default: '1K' },
      aspect: {
        param: 'aspect_ratio',
        values: {
          '21:9': '21:9', '16:9': '16:9', '3:2': '3:2', '4:3': '4:3', '5:4': '5:4',
          '1:1': '1:1', '4:5': '4:5', '3:4': '3:4', '2:3': '2:3', '9:16': '9:16',
        },
      },
      sources: [{ slot: 'images', param: 'image_urls', arity: 'array', required: true, maxCount: 14 }],
      fixed: { output_format: 'png' },
    },
  },
  'fal-ai/qwen-image-edit/inpaint': {
    id: 'fal-ai/qwen-image-edit/inpaint',
    technique: 'IMAGE_EDIT', type: 'IMAGE', label: 'Qwen Inpaint — masked retouch',
    priceUsd: 0.12, credits: 12,
    withheld: WITHHELD_NEEDS_A_REAL_PROBE
      + 'Here the quantity is the megapixels of the source image, and this entry '
      + 'carries a SECOND unknown on top of the measurement: whether the output '
      + 'matches the input at all (see the note). Both have to be settled before '
      + 'it can be sold, and a real probe settles only the first.',
    note: 'Billed per MEGAPIXEL ($0.03/MP). UNVERIFIED, and deliberately bounded '
      + 'because of it: the fal page lists image_size on this endpoint but does '
      + 'not state its default, so whether the OUTPUT matches the input (making '
      + 'output MP = source MP, outputFactor 1) or is resized to a fixed preset '
      + 'the way its siblings are is an inference, not a reading. If it resizes, '
      + 'metering the source would bill a 24 MP phone photo 72 credits for a '
      + '$0.03 render. So the source is capped at 4 MP (maxUnits): past that the '
      + 'request is refused with "use a smaller source" instead of being charged '
      + 'a figure we cannot stand behind, and the worst bill this model can '
      + 'produce is the 12 credits it was flat-rated at before it was metered. '
      + 'image_size is still not SENT — resizing the output would break alignment '
      + 'with mask_url — so within the cap the source megapixels remain the '
      + 'safest reading of the output\'s. Re-measure against a real render before '
      + 'raising the cap.',
    contract: {
      promptParam: 'prompt', negativePrompt: true, seedInput: true,
      sources: [
        { slot: 'firstImage', param: 'image_url', arity: 'single', required: true },
        { slot: 'mask', param: 'mask_url', arity: 'single', required: true },
      ],
      sourceMetering: {
        quantity: 'megapixels', from: ['firstImage'], outputFactor: 1,
        pricePerUnitUsd: 0.03,
        // 4 MP is the largest source we will price on an unverified output
        // size — see the note. It also pins the ceiling of this model's bill to
        // the 12 credits it has always published.
        maxUnits: 4,
      },
    },
  },

  // --------------------------------------------------------------- IMAGE_CLEANUP
  'fal-ai/topaz/upscale/image': {
    id: 'fal-ai/topaz/upscale/image',
    technique: 'IMAGE_CLEANUP', type: 'IMAGE', label: 'Topaz — print-ready upscale',
    priceUsd: 0.32, credits: 32,
    withheld: WITHHELD_NEEDS_A_REAL_PROBE
      + 'Here the quantity is the source image\'s pixel count, and the spread is '
      + 'the widest in the catalogue: the same published ladder charges $0.08 for '
      + 'a small source and $1.36 for a large one, a 17x range decided entirely '
      + 'by a number nobody has measured.',
    note: 'Billed by OUTPUT megapixels ($0.08 ≤24MP, $0.16 ≤48MP, $0.32 ≤96MP, '
      + '$1.36 ≤512MP), and upscale_factor is pinned at 2 so the output is 4x the '
      + 'SOURCE\'s megapixels. The old ≤96MP flat meter assumed the source came '
      + 'from this catalogue (4096x4096 = 16.8MP → 67MP, inside that band); the '
      + 'studio\'s upload/link picker takes an arbitrary source, and a 9000x9000 '
      + 'one lands at 324MP — $1.36 billed as $0.32. So the source is measured '
      + 'and the published BAND is charged, which also stops a 1MP source paying '
      + 'the 96MP rate. Returns NO width/height, so no finalize true-up exists '
      + 'and the finalize path stores dimensions as null.',
    contract: {
      promptParam: null, negativePrompt: false, seedInput: false,
      sources: [{ slot: 'firstImage', param: 'image_url', arity: 'single', required: true }],
      sourceMetering: {
        quantity: 'megapixels', from: ['firstImage'],
        // upscale_factor 2 → 4x the source's pixels. Kept in step with `fixed`
        // by a catalogue fitness test: raising the factor without raising this
        // is exactly the under-charge this entry already made once.
        outputFactor: 4,
        ladder: [
          { maxUnits: 24, priceUsd: 0.08 },
          { maxUnits: 48, priceUsd: 0.16 },
          { maxUnits: 96, priceUsd: 0.32 },
          { maxUnits: 512, priceUsd: 1.36 },
        ],
        maxUnits: 512, // the endpoint's own published output ceiling
      },
      fixed: { upscale_factor: 2, output_format: 'png' },
    },
  },
  'fal-ai/birefnet/v2': {
    id: 'fal-ai/birefnet/v2',
    technique: 'IMAGE_CLEANUP', type: 'IMAGE', label: 'BiRefNet v2 — background removal',
    priceUsd: 0.02, credits: 2,
    note: 'PRICE IS UNPUBLISHED: the page shows only a per-compute-second estimator '
      + 'with no rate. 2 credits is a deliberately generous placeholder for a '
      + 'few GPU-seconds and MUST be replaced with a measured figure. '
      + 'operating_resolution is the STRING "1024x1024", not a pair of integers.',
    contract: {
      promptParam: null, negativePrompt: false, seedInput: false,
      resolution: {
        param: 'operating_resolution',
        values: ['1024x1024', '2048x2048', '2304x2304'],
        default: '1024x1024',
      },
      sources: [{ slot: 'firstImage', param: 'image_url', arity: 'single', required: true }],
      // refine_foreground is what makes the matte usable for compositing rather
      // than a hard-edged cutout; output_format png keeps the alpha channel.
      fixed: { refine_foreground: true, output_format: 'png' },
    },
  },
  'fal-ai/bria/product-shot': {
    id: 'fal-ai/bria/product-shot',
    technique: 'IMAGE_CLEANUP', type: 'IMAGE', label: 'Bria — product in a scene',
    priceUsd: 0.04, credits: 4,
    note: 'The prompt is `scene_description`, not `prompt`. placement_type is '
      + 'pinned to "automatic": its default is "manual_placement", which makes '
      + 'manual_placement_selection load-bearing and would otherwise pin every '
      + 'product to one grid cell. Licensed training data, so it is commercially '
      + 'safe for e-commerce. num_results is pinned at 1 — it multiplies the price.',
    contract: {
      promptParam: 'scene_description', negativePrompt: false, seedInput: false,
      sources: [{ slot: 'firstImage', param: 'image_url', arity: 'single', required: true }],
      fixed: { placement_type: 'automatic', num_results: 1 },
    },
  },

  // ---------------------------------------------------------------- VIDEO_CREATE
  [DEFAULT_VIDEO_MODEL]: {
    id: DEFAULT_VIDEO_MODEL,
    technique: 'VIDEO_CREATE', type: 'VIDEO', label: 'Short video',
    pricePerSecUsd: 0.025, creditsPerSec: 3,
    // Legacy entry: catalogued before the 2026-09-02 schema pass and not re-read
    // by it, so its contract is exactly the shape this repo has been shipping
    // (integer duration, bare aspect_ratio) rather than a guess at a newer one.
    contract: {
      promptParam: 'prompt', negativePrompt: true, seedInput: true,
      duration: { param: 'duration', encoding: 'integerSeconds', minSec: 1, maxSec: 10 },
      aspect: { param: 'aspect_ratio', values: { '1:1': '1:1', '9:16': '9:16', '16:9': '16:9', '4:5': '4:5' } },
    },
  },
  'fal-ai/bytedance/seedance/v1/pro/text-to-video': {
    id: 'fal-ai/bytedance/seedance/v1/pro/text-to-video',
    technique: 'VIDEO_CREATE', type: 'VIDEO', label: 'Premium video',
    pricePerSecUsd: 0.15, creditsPerSec: 15,
    contract: {
      promptParam: 'prompt', negativePrompt: true, seedInput: true,
      duration: { param: 'duration', encoding: 'integerSeconds', minSec: 1, maxSec: 10 },
      aspect: { param: 'aspect_ratio', values: { '1:1': '1:1', '9:16': '9:16', '16:9': '16:9', '4:5': '4:5' } },
    },
  },
  'fal-ai/veo3/fast': {
    id: 'fal-ai/veo3/fast',
    technique: 'VIDEO_CREATE', type: 'VIDEO', label: 'Video + audio',
    pricePerSecUsd: 0.25, creditsPerSec: 25,
    note: 'Legacy entry, inherited unchanged. Its successor fal-ai/veo3.1/fast was '
      + 'schema-read on 2026-09-02 and wants "8s"; this v3 endpoint was NOT '
      + 're-read, so its integer duration is kept as shipped rather than migrated '
      + 'on a guess. Prefer veo3.1/fast — it is verified and cheaper.',
    contract: {
      promptParam: 'prompt', negativePrompt: true, seedInput: true,
      duration: { param: 'duration', encoding: 'integerSeconds', minSec: 1, maxSec: 10 },
      aspect: { param: 'aspect_ratio', values: { '1:1': '1:1', '9:16': '9:16', '16:9': '16:9', '4:5': '4:5' } },
    },
  },
  'bytedance/seedance-2.5/text-to-video': {
    id: 'bytedance/seedance-2.5/text-to-video',
    technique: 'VIDEO_CREATE', type: 'VIDEO', label: 'Seedance 2.5 — 30s single shot + audio',
    pricePerSecUsd: 0.4730, creditsPerSec: 48, tiers: SEEDANCE_25_TIERS,
    note: 'NO fal-ai/ prefix. The only model here that holds one coherent shot to '
      + '30s, with native synchronised audio at no premium — and by far the most '
      + 'expensive per second (a 5s 720p clip is ~240 credits), so the estimate '
      + 'must be shown before the click. It takes NO seed input; seed is '
      + 'output-only. Its duration is a digit-string: 8 is a 422, "8" is not.',
    contract: {
      promptParam: 'prompt', negativePrompt: false, seedInput: false,
      duration: SEEDANCE_25_DURATION, resolution: SEEDANCE_25_RESOLUTION,
      aspect: SEEDANCE_25_ASPECT, audio: { param: 'generate_audio', default: true },
    },
  },
  'fal-ai/veo3.1': {
    id: 'fal-ai/veo3.1',
    technique: 'VIDEO_CREATE', type: 'VIDEO', label: 'Veo 3.1 — hero shot, up to 4K',
    pricePerSecUsd: 0.40, creditsPerSec: 40,
    tiers: { '4k': { pricePerSecUsd: 0.60, creditsPerSec: 60 } },
    note: 'Bare id — appending /text-to-video is a 404. $0.20/s without audio vs '
      + '$0.40/s with, and we default audio ON, so the with-audio rate is the one '
      + 'metered. 16:9 and 9:16 only; no 1:1. Ceiling is 8s.',
    contract: {
      promptParam: 'prompt', negativePrompt: true, seedInput: true,
      duration: VEO_31_DURATION, resolution: VEO_31_RESOLUTION,
      aspect: { param: 'aspect_ratio', values: { '16:9': '16:9', '9:16': '9:16' } },
      audio: { param: 'generate_audio', default: true },
      fixed: { safety_tolerance: '4' }, // STRING enum "1".."6", not an integer
    },
  },
  'fal-ai/veo3.1/fast': {
    id: 'fal-ai/veo3.1/fast',
    technique: 'VIDEO_CREATE', type: 'VIDEO', label: 'Veo 3.1 Fast — draft tier',
    pricePerSecUsd: 0.15, creditsPerSec: 15,
    tiers: { '4k': { pricePerSecUsd: 0.35, creditsPerSec: 35 } },
    note: 'Identical schema and output shape to Veo 3.1 at ~1/2.7 the cost with '
      + 'audio at 1080p. The 4k discount is much smaller, which is why 4k carries '
      + 'its own rate instead of a scaled-down average.',
    contract: {
      promptParam: 'prompt', negativePrompt: true, seedInput: true,
      duration: VEO_31_DURATION, resolution: VEO_31_RESOLUTION,
      aspect: { param: 'aspect_ratio', values: { '16:9': '16:9', '9:16': '9:16' } },
      audio: { param: 'generate_audio', default: true },
      fixed: { safety_tolerance: '4' },
    },
  },

  // --------------------------------------------------------------- VIDEO_ANIMATE
  'bytedance/seedance-2.5/image-to-video': {
    id: 'bytedance/seedance-2.5/image-to-video',
    technique: 'VIDEO_ANIMATE', type: 'VIDEO', label: 'Seedance 2.5 — animate a still',
    pricePerSecUsd: 0.4730, creditsPerSec: 48, tiers: SEEDANCE_25_TIERS,
    note: 'NO fal-ai/ prefix. Unlike its text-to-video sibling this endpoint DOES '
      + 'take a seed. An optional end_image_url turns the same call into a '
      + 'controlled A→B transition.',
    contract: {
      promptParam: 'prompt', negativePrompt: false, seedInput: true,
      duration: SEEDANCE_25_DURATION, resolution: SEEDANCE_25_RESOLUTION,
      aspect: SEEDANCE_25_ASPECT, audio: { param: 'generate_audio', default: true },
      sources: [
        { slot: 'firstImage', param: 'image_url', arity: 'single', required: true },
        { slot: 'lastImage', param: 'end_image_url', arity: 'single', required: false },
      ],
    },
  },
  'fal-ai/veo3.1/image-to-video': {
    id: 'fal-ai/veo3.1/image-to-video',
    technique: 'VIDEO_ANIMATE', type: 'VIDEO', label: 'Veo 3.1 — animate a still, up to 4K',
    pricePerSecUsd: 0.40, creditsPerSec: 40,
    tiers: { '4k': { pricePerSecUsd: 0.60, creditsPerSec: 60 } },
    contract: {
      promptParam: 'prompt', negativePrompt: true, seedInput: true,
      duration: VEO_31_DURATION, resolution: VEO_31_RESOLUTION,
      aspect: { param: 'aspect_ratio', values: { '16:9': '16:9', '9:16': '9:16' } },
      audio: { param: 'generate_audio', default: true },
      sources: [{ slot: 'firstImage', param: 'image_url', arity: 'single', required: true }],
      fixed: { safety_tolerance: '4' },
    },
  },

  // ------------------------------------------------------------- VIDEO_REFERENCE
  'bytedance/seedance-2.5/reference-to-video': {
    id: 'bytedance/seedance-2.5/reference-to-video',
    technique: 'VIDEO_REFERENCE', type: 'VIDEO', label: 'Seedance 2.5 — consistent character/product',
    pricePerSecUsd: 0.4730, creditsPerSec: 48, tiers: SEEDANCE_25_TIERS,
    note: 'NO fal-ai/ prefix. Takes image_urls (ARRAY) — the singular spelling its '
      + 'own image-to-video sibling uses is a validation failure here. References '
      + 'are addressed positionally from the prompt text as [Image1], [Image2].',
    contract: {
      promptParam: 'prompt', negativePrompt: false, seedInput: true,
      duration: SEEDANCE_25_DURATION, resolution: SEEDANCE_25_RESOLUTION,
      aspect: SEEDANCE_25_ASPECT, audio: { param: 'generate_audio', default: true },
      sources: [{ slot: 'images', param: 'image_urls', arity: 'array', required: true, maxCount: 50 }],
    },
  },

  // ------------------------------------------------------------ VIDEO_TRANSITION
  'fal-ai/wan-flf2v': {
    id: 'fal-ai/wan-flf2v',
    technique: 'VIDEO_TRANSITION', type: 'VIDEO', label: 'Wan FLF2V — first frame → last frame',
    priceUsd: 0.40, credits: 40,
    tiers: { '480p': { priceUsd: 0.20, credits: 20 } },
    note: 'Priced FLAT PER RUN, not per second — hence credits, not creditsPerSec. '
      + 'Both frames are REQUIRED, and the params are start_image_url/end_image_url: '
      + 'the plausible-sounding first_frame_url/last_frame_url appear nowhere in '
      + 'the schema and are exactly the fabricated-param failure mode that burned '
      + 'this repo before. Length comes from num_frames, so there is no duration.',
    contract: {
      promptParam: 'prompt', negativePrompt: true, seedInput: true,
      resolution: { param: 'resolution', values: ['480p', '720p'], default: '720p' },
      aspect: { param: 'aspect_ratio', values: { '16:9': '16:9', '9:16': '9:16', '1:1': '1:1' } },
      sources: [
        { slot: 'firstImage', param: 'start_image_url', arity: 'single', required: true },
        { slot: 'lastImage', param: 'end_image_url', arity: 'single', required: true },
      ],
    },
  },

  // ---------------------------------------------------------------- VIDEO_EXTEND
  'fal-ai/pixverse/v6/extend': {
    id: 'fal-ai/pixverse/v6/extend',
    technique: 'VIDEO_EXTEND', type: 'VIDEO', label: 'PixVerse V6 — continue a clip',
    pricePerSecUsd: 0.060, creditsPerSec: 6,
    tiers: {
      '360p': { pricePerSecUsd: 0.035, creditsPerSec: 4 },
      '540p': { pricePerSecUsd: 0.045, creditsPerSec: 5 },
      '1080p': { pricePerSecUsd: 0.115, creditsPerSec: 12 },
    },
    note: 'The audio flag is `generate_audio_switch` here, not `generate_audio`, '
      + 'and it defaults FALSE. Rates metered are the with-audio ones so enabling '
      + 'it cannot under-charge. duration is a real INTEGER 1-15 on v6 — the '
      + 'string enum ["5","8"] shown on the same docs page belongs to older '
      + 'PixVerse endpoints.',
    contract: {
      promptParam: 'prompt', negativePrompt: true, seedInput: true,
      duration: { param: 'duration', encoding: 'integerSeconds', minSec: 1, maxSec: 15 },
      resolution: { param: 'resolution', values: ['360p', '540p', '720p', '1080p'], default: '720p' },
      audio: { param: 'generate_audio_switch', default: false },
      sources: [{ slot: 'video', param: 'video_url', arity: 'single', required: true }],
    },
  },

  // --------------------------------------------------------------- VIDEO_UPSCALE
  'fal-ai/topaz/upscale/video': {
    id: 'fal-ai/topaz/upscale/video',
    technique: 'VIDEO_UPSCALE', type: 'VIDEO', label: 'Topaz — finish a clip at delivery resolution',
    pricePerSecUsd: 0.08, creditsPerSec: 8,
    withheld: WITHHELD_NEEDS_A_REAL_PROBE
      + 'Here the quantity is the SOURCE clip\'s length, and it is the sharpest '
      + 'case in the catalogue: no duration goes in, none comes back, and the '
      + 'rate is $0.08/s, so a 60-second clip is $4.80 priced off a five-second '
      + 'guess. The 60fps multiplier is left exactly where the published pricing '
      + 'puts it (see the note) rather than pinned away, because SETTING '
      + 'target_fps is what triggers the doubling.',
    note: '$0.01/s up to 720p, $0.02/s to 1080p, $0.08/s above — and DOUBLE for '
      + '60fps OUTPUT. The output resolution is unresolvable at estimate time, so '
      + 'the top ($0.08/s) tier is metered. target_fps is deliberately NOT sent: '
      + 'fal attaches the 60fps multiplier to SETTING the parameter ("set it and '
      + 'you also pay the 60fps multiplier"), so pinning it to 30 to avoid the '
      + 'doubling guarantees the very 2x it was meant to avoid. Left unset the '
      + 'output keeps the source\'s frame rate — which means a 1080p60 phone clip '
      + 'really can cost $0.16/s against the $0.08/s metered here, and that is '
      + 'the second reason this entry is withheld rather than shipped with a pin '
      + 'that made it worse. The seconds the rate multiplies are the SOURCE '
      + 'clip\'s, not anything the request names: this endpoint has no duration '
      + 'input and returns no duration, so a `durationSec ?? 5` fallback reserves '
      + '40 credits for every upscale — 12x short on a 60s clip, with no true-up '
      + 'able to catch it.',
    contract: {
      promptParam: null, negativePrompt: false, seedInput: false,
      sources: [{ slot: 'video', param: 'video_url', arity: 'single', required: true }],
      // No per-unit rate: the model's own $0.08/s is the rate, and the
      // measurement only supplies the seconds it multiplies.
      sourceMetering: { quantity: 'durationSec', from: ['video'] },
      fixed: { upscale_factor: 2 },
    },
  },

  // ----------------------------------------------------------------------- AVATAR
  'veed/avatars/text-to-video': {
    id: 'veed/avatars/text-to-video',
    technique: 'AVATAR', type: 'VIDEO', label: 'VEED Avatar — stock presenter reads your script',
    pricePerSecUsd: 0.00583, creditsPerSec: 1,
    note: 'NO fal-ai/ prefix. $0.35/minute with TTS included — script in, finished '
      + 'UGC ad out, one call. The voice is implied by avatar_id and there is NO '
      + 'language param, so this is ENGLISH ONLY: Turkish copy must go through '
      + 'the TTS → LIPSYNC/AVATAR pipeline instead. Output length follows the '
      + 'SCRIPT: there is no duration input and none comes back, so the estimate '
      + 'used to ride a requested duration this endpoint never sees — a flat 5 '
      + 'credits whether the read was 5 seconds or a minute ($0.35 against '
      + '$0.05). The script is the measurement, and it is in the REQUEST — no '
      + 'file of the customer\'s is measured to price this, which is why it '
      + 'ships while the four file-metered models are withheld. '
      + 'CAVEAT, and it is ours: charsPerSec 12 is an ASSUMPTION, not a figure '
      + 'fal publishes. It is deliberately a slow read (≈145 wpm, under an '
      + 'ordinary ad pace) so the seconds are over-counted rather than under-, '
      + 'and the endpoint returns no duration, so nothing ever trues it up. A '
      + 'script that reads faster than assumed is quoted dearer than it costs; '
      + 'replace this with a measured pace once real renders exist to measure.',
    contract: {
      promptParam: 'text', negativePrompt: false, seedInput: false,
      // 12 chars/s ≈ 145 wpm — under a normal ad-read pace, so a script that
      // reads faster than assumed can only cost LESS than it was quoted. Our
      // number, not fal's: see the note.
      sourceMetering: { quantity: 'durationSec', from: 'script', charsPerSec: 12 },
      choices: {
        avatar: {
          param: 'avatar_id',
          // The `_vertical_` ids are 9:16 for Reels/TikTok; `_walking` is the
          // walk-and-talk format. Full 28-value enum, sent verbatim.
          values: [
            'emily_vertical_primary', 'emily_vertical_secondary',
            'marcus_vertical_primary', 'marcus_vertical_secondary',
            'mira_vertical_primary', 'mira_vertical_secondary',
            'jasmine_vertical_primary', 'jasmine_vertical_secondary', 'jasmine_vertical_walking',
            'aisha_vertical_walking', 'elena_vertical_primary', 'elena_vertical_secondary',
            'any_male_vertical_primary', 'any_female_vertical_primary',
            'any_male_vertical_secondary', 'any_female_vertical_secondary',
            'any_female_vertical_walking',
            'emily_primary', 'emily_side', 'marcus_primary', 'marcus_side',
            'aisha_walking', 'elena_primary', 'elena_side',
            'any_male_primary', 'any_female_primary', 'any_male_side', 'any_female_side',
          ],
          default: 'emily_vertical_primary',
        },
      },
    },
  },
  'fal-ai/kling-video/ai-avatar/v2/standard': {
    id: 'fal-ai/kling-video/ai-avatar/v2/standard',
    technique: 'AVATAR', type: 'VIDEO', label: 'Kling Avatar — your photo reads the script',
    pricePerSecUsd: 0.0562, creditsPerSec: 6,
    withheld:
      'Withheld for the same reason as the upscalers, arrived at the long way '
      + 'round. Its bill is the length of the caller\'s `audio_url`, a file the '
      + 'server never opens — and it was kept when they were withdrawn because '
      + 'its response carries a `duration`, so finalize can settle the LEDGER '
      + 'exactly. That is true and it is not enough: the reserve is the only gate '
      + 'that can say NO, and it is sized off a 5-second default because the '
      + 'length was never on the wire. MEDIA_GEN_MAX_VIDEO_SEC, which bounds every '
      + 'other video model\'s per-call spend, cannot reach it. So a caller passing '
      + 'a ten-minute mp3 holds 30 credits and commits ~3,372, and reconcile\'s '
      + 'chargeOverage is an unconditional bump that cannot refuse — 112x the '
      + 'authorisation, and a workspace with 30 credits left can commit $200 of '
      + 'vendor spend in one call. An honest ledger after the fact is not an '
      + 'honest authorisation before it. The same server-side probe that unblocks '
      + 'the upscalers unblocks this — ffprobe in the production image — by '
      + 'measuring the audio before the reserve. '
      + 'The AVATAR technique still ships: veed/avatars/text-to-video is metered '
      + 'on the SCRIPT, which is in the request.',
    note: 'One still + an audio track → a talking head, in any language the audio '
      + 'is in. There is no duration input — the length follows the AUDIO — but '
      + 'this is the one model in that position whose RESPONSE carries a '
      + 'top-level `duration` float, so once the reserve can be sized honestly '
      + 'this needs no source measurement to be billed exactly: finalize settles '
      + 'against what fal actually rendered, refunding a short read and charging '
      + 'a long one. That is what `returnsDuration` declares.',
    contract: {
      promptParam: 'prompt', negativePrompt: false, seedInput: false,
      sources: [
        { slot: 'firstImage', param: 'image_url', arity: 'single', required: true },
        { slot: 'audio', param: 'audio_url', arity: 'single', required: true },
      ],
      // fal's own page: "{ video: { url }, duration: float } — RETURNS `duration`
      // (float, seconds). Use this returned value for per-second billing rather
      // than your own estimate, since you cannot set the length."
      returnsDuration: true,
    },
  },

  // ---------------------------------------------------------------------- LIPSYNC
  'fal-ai/latentsync': {
    id: 'fal-ai/latentsync',
    technique: 'LIPSYNC', type: 'VIDEO', label: 'LatentSync — drive a face from an audio track',
    priceUsd: 0.20, credits: 20,
    withheld: WITHHELD_NEEDS_A_REAL_PROBE
      + 'Here the quantity is whichever of the video and the audio is longer, and '
      + 'only the overage past the flat 40-second window depends on it — which is '
      + 'precisely why an unsound parser is worse than none: nearly every request '
      + 'is the flat $0.20, so inventing a length turns the common, '
      + 'correctly-priced case into a wild over-charge for no revenue at all.',
    note: 'FLAT $0.20 for anything up to 40 seconds, then $0.005/s — so it is '
      + 'priced per run for the length that covers nearly every ad, and metered '
      + 'from the source only past that line. Takes no prompt at all. Returns no '
      + 'duration, so the overage has no true-up either: an unmeasured 2-minute '
      + 'lipsync billed $0.20 against $0.60.',
    contract: {
      promptParam: null, negativePrompt: false, seedInput: true,
      sources: [
        { slot: 'video', param: 'video_url', arity: 'single', required: true },
        { slot: 'audio', param: 'audio_url', arity: 'single', required: true },
      ],
      // loop_mode makes the OUTPUT as long as the LONGER of the two inputs, so
      // both are measured and the larger decides. freeUnits 40 keeps the common
      // case at exactly the flat 20 credits it has always been.
      sourceMetering: {
        quantity: 'durationSec', from: ['video', 'audio'],
        // $0.005/s is HALF a credit, so there is no honest per-unit credit rate
        // to declare: rounding it up per second billed a 5-minute lipsync 280
        // credits against the $1.50 the same row recorded. The charge is
        // ceil(usd * 100) of the exact figure instead.
        freeUnits: 40, pricePerUnitUsd: 0.005,
      },
      // Lets a short source loop under a longer voiceover instead of erroring.
      fixed: { loop_mode: 'loop' },
    },
  },

  // ------------------------------------------------------------------------ VOICE
  [DEFAULT_AUDIO_MODEL]: {
    id: DEFAULT_AUDIO_MODEL,
    technique: 'VOICE', type: 'AUDIO', label: 'ElevenLabs — voiceover',
    pricePerKCharUsd: 0.10, creditsPerKChar: 10,
    note: 'Billed per 1000 characters of script, not per second, so the estimate '
      + 'reads the script length. Turkish is supported via language_code "tr" '
      + '(ElevenLabs\' own model docs list it among multilingual-v2\'s 29 '
      + 'languages; the fal page only exposes the ISO 639-1 field). An '
      + 'unsupported code is an ERROR, not a fallback.',
    contract: {
      promptParam: 'text', negativePrompt: false, seedInput: false,
      choices: {
        // Free-form on the wire (values: [] = not an enum) — the page lists these
        // as examples, not as the accepted set.
        voice: { param: 'voice', values: [], default: 'Rachel' },
        language: { param: 'language_code', values: [], default: 'tr' },
      },
    },
  },

  // ------------------------------------------------------------------------ MUSIC
  'fal-ai/elevenlabs/music': {
    id: 'fal-ai/elevenlabs/music',
    technique: 'MUSIC', type: 'AUDIO', label: 'ElevenLabs — music bed',
    pricePerMinuteUsd: 0.60, creditsPerMinute: 60,
    note: '$0.60 per output minute ROUNDED UP to the whole minute — a 30-second '
      + 'bed still bills a full minute, and a 61-second one bills two. Hence a '
      + 'per-minute-block rate rather than a per-second one. Length is '
      + 'music_length_ms, in MILLISECONDS.',
    contract: {
      promptParam: 'prompt', negativePrompt: false, seedInput: false,
      duration: { param: 'music_length_ms', encoding: 'milliseconds', minSec: 3, maxSec: 600 },
    },
  },
  'fal-ai/elevenlabs/sound-effects/v2': {
    id: 'fal-ai/elevenlabs/sound-effects/v2',
    technique: 'MUSIC', type: 'AUDIO', label: 'ElevenLabs — sound effect',
    priceUsd: 0.044, credits: 5,
    note: '$0.002/s against a 22-second ceiling, so the whole ceiling is $0.044 — '
      + 'cheaper to meter as one flat 5-credit run than to carry a per-second rate '
      + 'that rounds up to 1 credit on every single second. duration_seconds is a '
      + 'FLOAT and the prompt param is `text`.',
    contract: {
      promptParam: 'text', negativePrompt: false, seedInput: false,
      duration: { param: 'duration_seconds', encoding: 'floatSeconds', minSec: 1, maxSec: 22 },
    },
  },

  // ------------------------------------------------------------------ VIDEO_SOUND
  'fal-ai/mmaudio-v2': {
    id: 'fal-ai/mmaudio-v2',
    technique: 'VIDEO_SOUND', type: 'VIDEO',
    label: 'MMAudio — soundtrack a silent clip',
    pricePerSecUsd: 0.001, creditsPerSec: 1,
    note: 'Typed VIDEO, not AUDIO: it watches the frames, generates a temporally '
      + 'synced bed and foley, and hands back the ORIGINAL VIDEO WITH THE AUDIO '
      + 'MUXED IN — no muxing step on our side. At $0.001/s it is essentially '
      + 'free to run over every clip the other video models return mute.',
    contract: {
      promptParam: 'prompt', negativePrompt: true, seedInput: true,
      duration: { param: 'duration', encoding: 'floatSeconds', minSec: 1, maxSec: 30 },
      sources: [{ slot: 'video', param: 'video_url', arity: 'single', required: true }],
    },
  },
};

const FALLBACK_IMAGE_CREDITS = 3;
/** What a video/audio estimate assumes when no duration was requested. */
const DEFAULT_DURATION_SEC = 5;
/** What a TTS estimate assumes when no script length was supplied. */
const DEFAULT_TEXT_LENGTH = 500;

/** Reading pace assumed for a script-metered model that names none. */
const DEFAULT_SCRIPT_CHARS_PER_SEC = 12;

export interface MediaEstimateOpts {
  durationSec?: number;
  /** The wire resolution value — picks the tier rate where one exists. */
  resolution?: string;
  /** Script length in characters; TTS bills on it, and it is also the
   *  measurement for a `from: 'script'` source-metered model. */
  textLength?: number;
  /**
   * MEASURED length / pixel dimensions of the caller's source media — for
   * `durationSec`, the longest of the slots the model's `sourceMetering.from`
   * names. Never a REQUESTED length: a source-metered model has no duration
   * input to request one with.
   *
   * Nothing in production supplies these today, and deliberately so. Every
   * model that would need one is `withheld`, because measuring a
   * customer-supplied file needs a real probe (ffprobe, server-side) that does
   * not exist yet, and a figure the caller states is not a measurement. What
   * they are for is the SPECIFICATION: they let the pricing tests state, in
   * executable form, what each withheld model must cost once its quantity is
   * genuinely measured — which is the acceptance criterion for the probe.
   */
  sourceDurationSec?: number;
  sourceWidth?: number;
  sourceHeight?: number;
}

/**
 * The quantity a source-metered model bills on, or null when the measurement it
 * needs has not been supplied — which is the signal to refuse, not to guess.
 *
 * Seconds are rounded UP to a whole second: fal bills "for every second a
 * video", and half a second of source is a second of bill.
 */
export function meteredUnits(m: MediaModel, opts: MediaEstimateOpts): number | null {
  const sm = m.contract.sourceMetering;
  if (!sm) return null;
  if (sm.from === 'script') {
    const chars = opts.textLength ?? 0;
    if (chars <= 0) return null;
    return Math.ceil(chars / (sm.charsPerSec ?? DEFAULT_SCRIPT_CHARS_PER_SEC));
  }
  if (sm.quantity === 'durationSec') {
    const secs = opts.sourceDurationSec;
    return secs && secs > 0 ? Math.ceil(secs) : null;
  }
  const { sourceWidth: w, sourceHeight: h } = opts;
  if (!w || !h || w <= 0 || h <= 0) return null;
  return ((w * h) / 1_000_000) * (sm.outputFactor ?? 1);
}

/** The rung of a banded rate that applies at `units`: the cheapest whose ceiling
 *  is at or above it. Past the top rung the top rate stands — the service has
 *  already refused anything above the endpoint's own `maxUnits`, so this only
 *  ever guards the estimate against reading off the end of the ladder. */
function ladderStep(ladder: readonly MediaRateStep[], units: number): MediaRateStep {
  return ladder.find((s) => units <= s.maxUnits) ?? ladder[ladder.length - 1];
}

/**
 * The USD a source-metered model's OWN rate produces at `units` — or null when
 * its rate is not the deciding one (the upscalers and avatars carry no metered
 * rate: the measurement merely supplies the seconds their ordinary per-second
 * rate multiplies) or when the measurement is missing.
 *
 * This is the single place the metered charge is computed. `estimateMediaUsd`
 * returns it as-is and `estimateMediaCredits` returns `ceil(usd * 100)` of it,
 * so the two cannot drift: the credit figure IS the dollar figure, in cents,
 * rounded up once at the end. Rounding earlier — per unit, as a hand-written
 * credit rate — is what made a 300-second LatentSync book 280 credits ($2.80)
 * and $1.50 on the same row.
 */
function sourceMeteredUsd(m: MediaModel, rate: MediaRate, units: number | null): number | null {
  const sm = m.contract.sourceMetering;
  if (!sm || units === null) return null;
  if (sm.ladder) return ladderStep(sm.ladder, units).priceUsd;
  if (sm.pricePerUnitUsd === undefined) return null;
  // freeUnits is what the model's FLAT rate already covers; with none, the
  // per-unit rate stands alone and the flat rate is not part of the bill.
  const free = sm.freeUnits ?? 0;
  const base = free > 0 ? (rate.priceUsd ?? 0) : 0;
  return base + sm.pricePerUnitUsd * Math.max(0, units - free);
}

/** Dollars → the customer's credit meter: 1 credit = $0.01, rounded UP once.
 *  `toFixed(6)` first because 0.2 + 0.005*80 is 0.6000000000000001 in binary
 *  floating point, and ceil()ing that alone would charge a phantom credit. */
function creditsForUsd(usd: number): number {
  return Math.max(1, Math.ceil(Number((usd * 100).toFixed(6))));
}

/** Back-compat: callers that only ever knew about duration may pass a number. */
type EstimateArg = number | MediaEstimateOpts | undefined;

/**
 * The length this model will ACTUALLY render for a requested one: clamped into
 * the contract's published range, then snapped DOWN to an offered value where it
 * publishes an enum. This is the ONLY duration that may be billed — the provider
 * encodes exactly this number onto the wire, so estimating against the raw
 * request is wrong in both directions: 1s asked of Veo 3.1 renders (and costs us)
 * 4s, and 5s asked of it also renders 4s while the customer is quoted five.
 * `buildFalInput` calls the same helper so the two can never drift.
 */
export function billableDurationSec(c: MediaDurationContract, requestedSec: number): number {
  const secs = Math.min(Math.max(Math.round(requestedSec), c.minSec), c.maxSec);
  if (!c.allowedSec?.length) return secs;
  const atOrBelow = c.allowedSec.filter((v) => v <= secs);
  return atOrBelow.length ? Math.max(...atOrBelow) : Math.min(...c.allowedSec);
}

function toOpts(arg: EstimateArg): MediaEstimateOpts {
  return typeof arg === 'number' ? { durationSec: arg } : (arg ?? {});
}

/** The rate that applies at `resolution`. `tiers` lists only deviations, so a
 *  miss (including the model's default tier) correctly falls back to the model. */
function rateFor(model: MediaModel, resolution?: string): MediaRate {
  return (resolution && model.tiers?.[resolution]) || model;
}

/** Every entry, withheld ones included. The catalogue as RESEARCH: pricing
 *  tests and the live endpoint probe read this, because a withheld model is
 *  still a real endpoint whose death we want to hear about. Nothing that
 *  decides what a customer may generate may read it — use `listMediaModels`. */
export function allMediaModels(): MediaModel[] {
  return Object.values(MEDIA_MODELS);
}

/** True when this id exists but is not for sale. `undefined` for an id that is
 *  not catalogued at all — that is a different refusal, with a different
 *  message. */
export function isMediaModelWithheld(id: string): boolean {
  return Boolean(MEDIA_MODELS[id]?.withheld);
}

export function getMediaModel(id: string): MediaModel | undefined {
  return MEDIA_MODELS[id];
}

/**
 * Is `id` in the catalogue AS a model of this kind?
 *
 * Stricter than `getMediaModel(id) !== undefined`, and the extra strictness is
 * the point. The catalogue is what prices a generation, and it prices the two
 * kinds in different UNITS — images flat per image, video per second. So an
 * IMAGE id accepted for a VIDEO request is not a cosmetic mislabel: it bills a
 * per-second clip at the flat 3-credit image rate, which is the same
 * under-charge the "unknown model" refusal was written to stop. Membership and
 * kind are one question, so they are one function.
 */
export function isCataloguedModel(id: string, type: GeneratedAssetType): boolean {
  return MEDIA_MODELS[id]?.type === type;
}

/**
 * The refusal, in ONE place, for every surface that stores a model id.
 *
 * There are two such surfaces — the workspace default
 * (`MediaModelDefaultsService.set`) and the CAMPAIGN override
 * (`SocialCampaignsService.create` / `update`) — and only the first had it.
 * The campaign columns took any string at all, so a catalogued id of the WRONG
 * KIND (`fal-ai/qwen-image` as `defaultVideoModel`, one keystroke away in a
 * picker that lists both) was accepted, and then hard-failed EVERY item of that
 * campaign at generation time with `MEDIA_GEN_UNKNOWN_MODEL` — hours later, on
 * the scheduled-job path, one item at a time, with the reason on an item row
 * rather than on the screen where the mistake was made.
 *
 * Same message from both doors deliberately: the person reading it is choosing
 * between the same five options either way, and the message is what tells them
 * what those options are.
 */
export function assertCataloguedModel(id: string, type: GeneratedAssetType): string {
  if (isCataloguedModel(id, type)) return id;
  const options = Object.values(MEDIA_MODELS)
    .filter((m) => m.type === type && !m.withheld)
    .map((m) => m.id)
    .join(', ');
  throw new BadRequestException(
    `"${id}" is not a catalogued ${type.toLowerCase()} model, so its price is unknown and it cannot be run. Choose one of: ${options}.`,
  );
}

/** The code constant for a kind — the last term of the resolution order
 *  (campaign override ?? workspace default ?? THIS). */
export function defaultModelFor(type: GeneratedAssetType): string {
  if (type === 'VIDEO') return DEFAULT_VIDEO_MODEL;
  // AUDIO joined the asset types with the voice/music techniques; without this
  // arm a TTS request that names no model resolves to an IMAGE default and is
  // priced per image.
  if (type === 'AUDIO') return DEFAULT_AUDIO_MODEL;
  return DEFAULT_IMAGE_MODEL;
}

/** The catalogue as a MENU: what may actually be offered and generated.
 *  Withheld models are dropped here, which is the single place that decision is
 *  made — the models endpoint, and therefore the studio, is built from this. */
export function listMediaModels(technique?: MediaTechnique): MediaModel[] {
  const served = allMediaModels().filter((m) => !m.withheld);
  return technique ? served.filter((m) => m.technique === technique) : served;
}

/**
 * Customer-facing credit estimate. Every branch rounds UP and floors at 1, so an
 * estimate is never below what the generation actually costs us. The branch is
 * chosen by which rate the model carries, NOT by its asset type: wan-flf2v and
 * latentsync are VIDEO yet billed flat per run, and MMAudio is VIDEO yet billed
 * per second of audio.
 */
export function estimateMediaCredits(modelId: string, arg?: EstimateArg): number {
  const m = MEDIA_MODELS[modelId];
  if (!m) return FALLBACK_IMAGE_CREDITS;
  const opts = toOpts(arg);
  const rate = rateFor(m, opts.resolution);

  // A source-metered model with its measurement in hand bills on the measured
  // quantity. Its own banded/per-unit rate wins where it carries one; where it
  // does not (the upscalers, the avatars) the measurement merely supplies the
  // seconds the model's ordinary per-second rate multiplies, below. The figure
  // is the USD one in cents — the SAME call `estimateMediaUsd` makes — so the
  // two are one computation, not two that are meant to agree.
  const meteredUsd = sourceMeteredUsd(m, rate, meteredUnits(m, opts));
  if (meteredUsd !== null) return creditsForUsd(meteredUsd);

  if (rate.creditsPerKChar !== undefined) {
    const chars = Math.max(1, opts.textLength ?? DEFAULT_TEXT_LENGTH);
    return Math.max(1, Math.ceil((rate.creditsPerKChar * chars) / 1000));
  }
  if (rate.creditsPerMinute !== undefined) {
    const minutes = Math.max(1, Math.ceil(durationOrDefault(m, opts) / 60));
    return Math.max(1, rate.creditsPerMinute * minutes);
  }
  if (rate.creditsPerSec !== undefined) {
    return Math.max(1, Math.ceil(rate.creditsPerSec * durationOrDefault(m, opts)));
  }
  return Math.max(1, rate.credits ?? FALLBACK_IMAGE_CREDITS);
}

/** USD bookkeeping — the vendor-cost side of the same estimate. Mirrors
 *  estimateMediaCredits branch for branch, but does NOT round: this figure feeds
 *  the growth-wallet pre-debit and the spend ledger, where cents matter. */
export function estimateMediaUsd(modelId: string, arg?: EstimateArg): number {
  const m = MEDIA_MODELS[modelId];
  if (!m) return 0;
  const opts = toOpts(arg);
  const rate = rateFor(m, opts.resolution);

  // The same call the credit branch makes — there is one metered computation,
  // and the credit figure is this one in cents.
  const meteredUsd = sourceMeteredUsd(m, rate, meteredUnits(m, opts));
  if (meteredUsd !== null) return meteredUsd;

  if (rate.pricePerKCharUsd !== undefined) {
    const chars = Math.max(1, opts.textLength ?? DEFAULT_TEXT_LENGTH);
    return (rate.pricePerKCharUsd * chars) / 1000;
  }
  if (rate.pricePerMinuteUsd !== undefined) {
    // ElevenLabs bills whole minutes rounded up, so the USD figure rounds too.
    return rate.pricePerMinuteUsd * Math.max(1, Math.ceil(durationOrDefault(m, opts) / 60));
  }
  if (rate.pricePerSecUsd !== undefined) return rate.pricePerSecUsd * durationOrDefault(m, opts);
  return rate.priceUsd ?? 0;
}

/** The billable length for `m`: the request, defaulted, then put through the
 *  model's own duration contract. A model with no duration contract (wan-flf2v,
 *  latentsync) bills flat anyway, so the raw figure is harmless there. */
function durationOrDefault(m: MediaModel, opts: MediaEstimateOpts): number {
  // A source-metered length is the SOURCE's, and is deliberately not put through
  // a duration contract: these models publish none, because the length was never
  // ours to choose. Falling back to DEFAULT_DURATION_SEC here is what made a
  // 60-second upscale cost the same as a 5-second one.
  if (m.contract.sourceMetering?.quantity === 'durationSec') {
    const measured = meteredUnits(m, opts);
    if (measured !== null) return measured;
  }
  const requested = Math.max(1, opts.durationSec ?? DEFAULT_DURATION_SEC);
  return m.contract.duration ? billableDurationSec(m.contract.duration, requested) : requested;
}
