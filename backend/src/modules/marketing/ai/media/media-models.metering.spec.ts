import {
  MEDIA_MODELS, estimateMediaCredits, estimateMediaUsd, meteredUnits,
} from './media-models.config';

/**
 * SOURCE METERING — the estimator, and the specification four withheld models
 * are waiting on.
 *
 * A cost that cannot be resolved at estimate time was historically metered at
 * the worst case. That idiom was applied to resolution and never to DURATION or
 * to SOURCE SIZE, so several models billed a quantity nobody had measured: an
 * upscale reserved five seconds' worth whatever the clip's length, an avatar
 * five credits whatever the script's length, and Topaz's megapixel bands were
 * charged as if every source came from this catalogue.
 *
 * Only ONE of those is fixable from the request: a script, which is the prompt.
 * The rest are properties of a file the customer supplies, the endpoints report
 * nothing back that a finalize true-up could correct, and no sound way exists
 * here to measure the file — so those four models are WITHHELD (not served, and
 * refused by the service) until a real server-side probe exists.
 *
 * Their metering contracts stay, and so do the cases below, because they are the
 * specification that probe has to satisfy: this is what each model must cost
 * once its quantity is genuinely measured. Note what these cases also show —
 * the fix has to make the COMMON case cheaper, not merely the extreme case
 * dearer, or it is only a price rise.
 */

const TOPAZ_VIDEO = 'fal-ai/topaz/upscale/video';
const TOPAZ_IMAGE = 'fal-ai/topaz/upscale/image';
const VEED = 'veed/avatars/text-to-video';
const INPAINT = 'fal-ai/qwen-image-edit/inpaint';
const LATENTSYNC = 'fal-ai/latentsync';
const KLING = 'fal-ai/kling-video/ai-avatar/v2/standard';

describe('source metering — a duration that comes from the clip, not the request', () => {
  it('bills a Topaz video upscale for the SOURCE clip\'s length', () => {
    // $0.08/s (the top tier, since the output resolution is unresolvable) over a
    // 60-second clip is $4.80. The old `durationSec ?? 5` fallback reserved 40
    // credits for it — 12x short, with no true-up able to notice.
    expect(estimateMediaCredits(TOPAZ_VIDEO, { sourceDurationSec: 60 })).toBe(480);
    expect(estimateMediaUsd(TOPAZ_VIDEO, { sourceDurationSec: 60 })).toBeCloseTo(4.8, 6);
  });

  it('ignores a requested duration on a model that has no duration input', () => {
    // The panel cannot even offer a length here, but an API caller can send one.
    // Billing it would be billing a number the endpoint never sees.
    expect(estimateMediaCredits(TOPAZ_VIDEO, { durationSec: 5, sourceDurationSec: 60 })).toBe(480);
  });

  it('rounds a fractional source length UP to a whole second', () => {
    // fal bills "for every second a video"; half a second is a second of bill.
    expect(estimateMediaCredits(TOPAZ_VIDEO, { sourceDurationSec: 12.2 })).toBe(104);
  });

  it('leaves a short upscale at what a short upscale costs', () => {
    expect(estimateMediaCredits(TOPAZ_VIDEO, { sourceDurationSec: 5 })).toBe(40);
  });

  it('bills a VEED avatar for how long its SCRIPT takes to read', () => {
    // 720 characters at the catalogue's deliberately slow 12 chars/s is a
    // 60-second read: $0.35 of VEED against the 5 credits it used to charge.
    expect(meteredUnits(MEDIA_MODELS[VEED], { textLength: 720 })).toBe(60);
    expect(estimateMediaCredits(VEED, { textLength: 720 })).toBe(60);
  });

  it('keeps a one-line avatar script at a one-line price', () => {
    expect(estimateMediaCredits(VEED, { textLength: 60 })).toBe(5);
  });

  it('bills the Kling avatar for the length fal says it rendered', () => {
    // This one is NOT source-metered, and deliberately so: its length follows
    // the audio and cannot be requested, but the response carries a duration, so
    // the reserve is provisional and finalize settles it exactly. The estimator
    // therefore reads an ordinary duration — the requested one at reserve time,
    // the RENDERED one at settlement — and needs no measurement of the source.
    expect(MEDIA_MODELS[KLING].contract.sourceMetering).toBeUndefined();
    expect(MEDIA_MODELS[KLING].contract.returnsDuration).toBe(true);
    expect(estimateMediaCredits(KLING, { durationSec: 60 })).toBe(360);
    // And a source measurement, if one ever reached it, is inert rather than a
    // second pricing path: nothing about this model is billed off a file.
    expect(meteredUnits(MEDIA_MODELS[KLING], { sourceDurationSec: 600 })).toBeNull();
  });
});

describe('source metering — a flat rate that only covers so much', () => {
  it('keeps a lipsync inside the flat window at the flat price', () => {
    // $0.20 covers anything up to 40s, which is nearly every ad. The common case
    // must not move.
    expect(estimateMediaCredits(LATENTSYNC, { sourceDurationSec: 30 })).toBe(20);
    expect(estimateMediaCredits(LATENTSYNC, { sourceDurationSec: 40 })).toBe(20);
  });

  it('bills the overage past the flat window', () => {
    // $0.20 + 80s x $0.005 = $0.60 on a two-minute lipsync, against the flat
    // $0.20 an unmeasured source used to be charged.
    expect(estimateMediaCredits(LATENTSYNC, { sourceDurationSec: 120 })).toBe(60);
    expect(estimateMediaUsd(LATENTSYNC, { sourceDurationSec: 120 })).toBeCloseTo(0.6, 6);
  });

  it('charges the credits the dollars come to, not a per-second rate rounded up', () => {
    // $0.005/s is HALF a credit. Rounding it up per second and multiplying
    // booked a 5-minute lipsync at 280 credits ($2.80) on the same row whose
    // costUsd said $1.50 — the customer's meter and the ledger disagreeing
    // about the same generation by 87%.
    const opts = { sourceDurationSec: 300 };
    expect(estimateMediaUsd(LATENTSYNC, opts)).toBeCloseTo(1.5, 6);
    expect(estimateMediaCredits(LATENTSYNC, opts)).toBe(150);
    // And a single second past the flat window still costs a whole credit — the
    // fix rounds the TOTAL up, it does not round anything away.
    expect(estimateMediaCredits(LATENTSYNC, { sourceDurationSec: 41 })).toBe(21);
  });
});

describe('source metering — megapixels that come from the source image', () => {
  it('charges the published BAND for the output Topaz will actually produce', () => {
    // upscale_factor 2 makes the output 4x the source's pixels. A 9000x9000
    // source is 81MP in and 324MP out: the $1.36 band, billed as $0.32 while the
    // meter assumed every source came from this catalogue.
    expect(meteredUnits(MEDIA_MODELS[TOPAZ_IMAGE], { sourceWidth: 9000, sourceHeight: 9000 }))
      .toBeCloseTo(324, 6);
    expect(estimateMediaCredits(TOPAZ_IMAGE, { sourceWidth: 9000, sourceHeight: 9000 })).toBe(136);
    expect(estimateMediaUsd(TOPAZ_IMAGE, { sourceWidth: 9000, sourceHeight: 9000 })).toBeCloseTo(1.36, 6);
  });

  it('stops an ordinary photo paying the 96-megapixel rate', () => {
    // 1000x1000 in is 4MP out — the cheapest band. Metering the worst case here
    // was over-charging the common case 4x.
    expect(estimateMediaCredits(TOPAZ_IMAGE, { sourceWidth: 1000, sourceHeight: 1000 })).toBe(8);
  });

  it('takes the cheapest band whose ceiling covers the output', () => {
    // Exactly on a rung stays on it; a hair over moves up. An off-by-one here is
    // a whole band of margin.
    expect(estimateMediaCredits(TOPAZ_IMAGE, { sourceWidth: 2000, sourceHeight: 3000 })).toBe(8);   // 24MP
    expect(estimateMediaCredits(TOPAZ_IMAGE, { sourceWidth: 2000, sourceHeight: 3001 })).toBe(16);  // 24.008MP
  });

  it('bills an inpaint per megapixel of the image it is given', () => {
    // $0.03/MP against an output that matches the input (image_size is not sent,
    // because resizing would break mask alignment).
    expect(estimateMediaCredits(INPAINT, { sourceWidth: 1000, sourceHeight: 1000 })).toBe(3);
    expect(estimateMediaCredits(INPAINT, { sourceWidth: 2000, sourceHeight: 2000 })).toBe(12);
    expect(estimateMediaUsd(INPAINT, { sourceWidth: 2000, sourceHeight: 2000 })).toBeCloseTo(0.12, 6);
  });

  it('caps what an inpaint can cost at the flat figure it was always priced at', () => {
    // outputFactor 1 rests on an INFERENCE: this endpoint takes an image_size and
    // does not publish its default, so whether the output really matches the
    // source is unread. If it resizes to a fixed preset, a 24 MP phone photo
    // would be billed 72 credits for a $0.03 render. The published ceiling is
    // what makes that impossible — the request is refused above 4 MP instead —
    // so the model's worst bill stays the 12 credits it has always shown.
    const sm = MEDIA_MODELS[INPAINT].contract.sourceMetering!;
    expect(sm.maxUnits).toBe(4);
    expect(estimateMediaCredits(INPAINT, { sourceWidth: 2000, sourceHeight: 2000 }))
      .toBe(MEDIA_MODELS[INPAINT].credits);
  });
});

describe('source metering — the measurement is the whole point', () => {
  it('reports no metered quantity at all when the measurement is missing', () => {
    // null is the signal the service refuses on. A number here — any number —
    // would be the guess this whole mechanism exists to remove.
    expect(meteredUnits(MEDIA_MODELS[TOPAZ_VIDEO], { durationSec: 5 })).toBeNull();
    expect(meteredUnits(MEDIA_MODELS[TOPAZ_IMAGE], {})).toBeNull();
    expect(meteredUnits(MEDIA_MODELS[VEED], { textLength: 0 })).toBeNull();
    expect(meteredUnits(MEDIA_MODELS[LATENTSYNC], {})).toBeNull();
  });

  it('leaves models that are not source-metered alone', () => {
    // A stray measurement on an ordinary model must be inert, not a second
    // pricing path nobody asked for.
    const withMeasurement = estimateMediaCredits('fal-ai/veo3.1', {
      durationSec: 8, sourceDurationSec: 600, sourceWidth: 9000, sourceHeight: 9000,
    });
    expect(withMeasurement).toBe(estimateMediaCredits('fal-ai/veo3.1', { durationSec: 8 }));
    expect(meteredUnits(MEDIA_MODELS['fal-ai/veo3.1'], { sourceDurationSec: 600 })).toBeNull();
  });
});
