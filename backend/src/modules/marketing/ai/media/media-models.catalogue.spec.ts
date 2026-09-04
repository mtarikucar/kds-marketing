import {
  MEDIA_MODELS, MEDIA_TECHNIQUES, MediaModel, MediaEstimateOpts,
  estimateMediaCredits, estimateMediaUsd, allMediaModels, listMediaModels,
  DEFAULT_IMAGE_MODEL, DEFAULT_VIDEO_MODEL, DEFAULT_AUDIO_MODEL,
} from './media-models.config';
import { GENERATED_ASSET_TYPES } from './media-asset.constants';
import { buildFalInput } from '../providers/fal.provider';
import { urlForSlot } from './media-gen.service';

/**
 * CATALOGUE FITNESS.
 *
 * This repo has already shipped an endpoint id derived by pattern from a sibling
 * (`fal-ai/bytedance/seedream/v4`, missing its `/text-to-image` suffix) and paid
 * for it with 7 failed production generations. fal's prefix scheme is genuinely
 * inconsistent — it differs INSIDE one model family — so no rule can be checked
 * offline. What CAN be checked offline is that the catalogue is internally
 * coherent, and that is the always-on half below.
 *
 * The other half asks fal itself. `https://fal.ai/api/openapi/queue/openapi.json
 * ?endpoint_id=<id>` returns a real OpenAPI body for a live id and a literal
 * `null` for a dead one, which makes it an exact existence check. It needs
 * network egress, so it is opt-in:
 *
 *     FAL_CATALOGUE_PROBE=1 npx jest media-models.catalogue
 *
 * CI without egress runs the structural half and stays green; a human (or a
 * nightly job with egress) runs the probe and turns a silent production 404 into
 * a red test.
 */

// Every entry, WITHHELD ones included. Structural fitness and the live
// existence probe both apply to the whole catalogue: a withheld model is still
// a real endpoint with a real published contract, and we want to hear about it
// if it dies or if its entry rots. What may be SOLD is a narrower list, and the
// rules that are about selling say so explicitly.
const models = allMediaModels();
const PROBE_ENABLED = process.env.FAL_CATALOGUE_PROBE === '1';
const SCHEMA_URL = 'https://fal.ai/api/openapi/queue/openapi.json';

describe('media catalogue — structural fitness (no network)', () => {
  it('keys every entry by its own id', () => {
    for (const [key, m] of Object.entries(MEDIA_MODELS)) expect(m.id).toBe(key);
  });

  it('has no empty, whitespace-padded or duplicated endpoint id', () => {
    const ids = models.map((m) => m.id);
    for (const id of ids) {
      expect(id).toBeTruthy();
      expect(id).toBe(id.trim());
      // Every fal id is a path; a bare word is the shape a truncated/derived id
      // takes, which is exactly the class of mistake that 404s.
      expect(id).toContain('/');
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every model a known technique and a known asset type', () => {
    for (const m of models) {
      expect(MEDIA_TECHNIQUES).toContain(m.technique);
      expect(GENERATED_ASSET_TYPES).toContain(m.type);
    }
  });

  it('covers all 14 techniques', () => {
    const covered = new Set(models.map((m) => m.technique));
    expect([...MEDIA_TECHNIQUES].filter((t) => !covered.has(t))).toEqual([]);
  });

  it('prices every model on exactly one rate basis', () => {
    for (const m of models) {
      const bases = [m.credits, m.creditsPerSec, m.creditsPerKChar, m.creditsPerMinute]
        .filter((v) => v !== undefined);
      expect({ id: m.id, bases: bases.length }).toEqual({ id: m.id, bases: 1 });
      // Credits are the customer meter and USD is the vendor ledger; a model
      // carrying one without the other silently reports $0 of spend.
      const usd = [m.priceUsd, m.pricePerSecUsd, m.pricePerKCharUsd, m.pricePerMinuteUsd]
        .filter((v) => v !== undefined);
      expect({ id: m.id, usd: usd.length }).toEqual({ id: m.id, usd: 1 });
    }
  });

  it('never prices a tier below the ~1 credit ≈ $0.01 anchor', () => {
    // Rounding UP is the whole point of the anchor: an under-charged tier is a
    // margin leak that no other test would notice.
    const rates: Array<[string, MediaModel['tiers'] extends undefined ? never : any]> = [];
    for (const m of models) {
      rates.push([`${m.id}@base`, m]);
      for (const [tier, r] of Object.entries(m.tiers ?? {})) rates.push([`${m.id}@${tier}`, r]);
    }
    for (const [label, r] of rates) {
      const pairs: Array<[number | undefined, number | undefined]> = [
        [r.priceUsd, r.credits], [r.pricePerSecUsd, r.creditsPerSec],
        [r.pricePerKCharUsd, r.creditsPerKChar], [r.pricePerMinuteUsd, r.creditsPerMinute],
      ];
      for (const [usd, credits] of pairs) {
        if (usd === undefined || credits === undefined) continue;
        expect({ label, ok: credits >= Math.ceil(usd * 100) }).toEqual({ label, ok: true });
      }
    }
  });

  it('keys every tier to a resolution the model actually offers', () => {
    for (const m of models) {
      for (const tier of Object.keys(m.tiers ?? {})) {
        expect({ id: m.id, tier, offered: m.contract.resolution?.values.includes(tier) })
          .toEqual({ id: m.id, tier, offered: true });
      }
    }
  });

  it('names a resolution default that is one of its own values', () => {
    for (const m of models) {
      const r = m.contract.resolution;
      if (!r) continue;
      expect({ id: m.id, ok: r.values.includes(r.default) }).toEqual({ id: m.id, ok: true });
    }
  });

  it('lets the provider build every declared source param', () => {
    // The spec's requirement: a model that declares a source requirement must
    // name a param the provider can actually fill. Feeding one of everything
    // proves the slot→param wiring exists for each declared requirement.
    const everything = {
      images: ['https://cdn/a.png', 'https://cdn/b.png'],
      lastImage: 'https://cdn/last.png',
      video: 'https://cdn/in.mp4',
      audio: 'https://cdn/vo.mp3',
      mask: 'https://cdn/mask.png',
    };
    for (const m of models) {
      const input = buildFalInput({
        type: m.type, model: m.id, prompt: 'a product on a marble table', sources: everything,
      });
      for (const req of m.contract.sources ?? []) {
        expect({ id: m.id, param: req.param, filled: input[req.param] !== undefined })
          .toEqual({ id: m.id, param: req.param, filled: true });
      }
    }
  });

  it('never sends a parameter the model does not accept', () => {
    // The regression this whole contract exists to prevent: one flat parameter
    // set posted at every endpoint.
    for (const m of models) {
      const input = buildFalInput({
        type: m.type, model: m.id, prompt: 'x', negativePrompt: 'blurry',
        aspectRatio: '9:16', resolution: 'nonsense-tier', durationSec: 7, seed: 42,
        sources: { images: ['https://cdn/a.png'], lastImage: 'https://cdn/b.png', video: 'https://cdn/v.mp4', audio: 'https://cdn/a.mp3', mask: 'https://cdn/m.png' },
      });
      const c = m.contract;
      if (!c.negativePrompt) expect({ id: m.id, k: 'negative_prompt' in input }).toEqual({ id: m.id, k: false });
      if (!c.seedInput) expect({ id: m.id, k: 'seed' in input }).toEqual({ id: m.id, k: false });
      if (!c.duration) expect({ id: m.id, k: 'duration' in input }).toEqual({ id: m.id, k: false });
      if (!c.audio) {
        expect({ id: m.id, k: 'generate_audio' in input }).toEqual({ id: m.id, k: false });
      }
      if (!c.aspect) {
        // A ratio the CALLER asked for. A catalogue-PINNED image_size is a
        // different thing — a price dial, like Ideogram's rendering_speed — and
        // Seedream v5 Pro edit pins one precisely so fal's auto_2K default (at
        // double the tier we bill) is not what an unsent parameter selects.
        const fixed = c.fixed ?? {};
        const fromCaller = (['aspect_ratio', 'image_size'] as const)
          .some((k) => k in input && !(k in fixed));
        expect({ id: m.id, k: fromCaller }).toEqual({ id: m.id, k: false });
      }
      // An unknown resolution must fall back to the model's own default, never
      // reach the wire — several fal models 422 on an unlisted enum value.
      if (c.resolution) {
        expect({ id: m.id, r: input[c.resolution.param] })
          .toEqual({ id: m.id, r: c.resolution.default });
      }
    }
  });
});

/**
 * Live existence probe. `describe` is always declared so the file's intent is
 * visible in the run output; the body is skipped unless FAL_CATALOGUE_PROBE=1.
 */
(PROBE_ENABLED ? describe : describe.skip)('media catalogue — live fal probe', () => {
  jest.setTimeout(120_000);

  it.each(models.map((m) => [m.id]))('%s resolves on fal', async (id) => {
    const res = await fetch(`${SCHEMA_URL}?endpoint_id=${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(20_000),
    });
    expect({ id, status: res.status }).toEqual({ id, status: 200 });
    // A dead id answers 200 with a literal `null` body, so the status alone is
    // not the check — the OpenAPI document has to actually be there.
    const body = await res.json();
    expect({ id, hasSchema: Boolean(body && body.paths) }).toEqual({ id, hasSchema: true });
  });
});

/**
 * The invariant behind SOURCE METERING, as a fitness rule rather than a list.
 *
 * A per-second rate is only a price if the seconds are knowable. Three models
 * carried one with no duration input, no duration in the response and nothing
 * declaring where the length came from, so the estimate quietly multiplied the
 * rate by a five-second default. Naming the offenders would have fixed those
 * three; asserting the rule stops the fourth.
 */
describe('media catalogue — a rate is only a price if its quantity is knowable', () => {
  it('gives every per-second model a way to know its seconds', () => {
    for (const m of models) {
      if (m.creditsPerSec === undefined) continue;
      const knowable = Boolean(m.contract.duration)
        // The length is a property of the source, declared so the estimate can
        // be built from a measurement rather than a default.
        || m.contract.sourceMetering?.quantity === 'durationSec'
        // Or it comes back in the response, so the reserve is provisional and
        // finalize settles it exactly (the Kling avatar).
        || m.contract.returnsDuration === true;
      // If this fails, the model bills per second against DEFAULT_DURATION_SEC:
      // give it a duration contract, declare where the length comes from, or
      // declare that fal reports it back.
      expect({ id: m.id, knowable }).toEqual({ id: m.id, knowable: true });
    }
  });

  it('measures a source-metered model from a slot it actually declares', () => {
    for (const m of models) {
      const sm = m.contract.sourceMetering;
      if (!sm || sm.from === 'script') continue;
      const declared = new Set((m.contract.sources ?? []).map((s) => s.slot));
      for (const slot of sm.from) {
        // A slot nothing fills is a measurement that can never arrive, which is
        // a model no one can ever generate.
        expect({ id: m.id, slot, declared: declared.has(slot) })
          .toEqual({ id: m.id, slot, declared: true });
      }
    }
  });

  it('only meters a script on a model that takes one', () => {
    for (const m of models) {
      if (m.contract.sourceMetering?.from !== 'script') continue;
      expect({ id: m.id, prompt: m.contract.promptParam }).not.toEqual({ id: m.id, prompt: null });
    }
  });

  it('keeps the output factor in step with the upscale factor it is derived from', () => {
    // Topaz bills OUTPUT pixels, so upscale_factor 2 means 4x the source's. The
    // catalogue has already under-charged once by pinning a factor and metering
    // as if it were 1; raising the factor without raising this would do it again.
    for (const m of models) {
      const sm = m.contract.sourceMetering;
      if (sm?.quantity !== 'megapixels') continue;
      const factor = Number(m.contract.fixed?.upscale_factor ?? 1);
      expect({ id: m.id, outputFactor: sm.outputFactor ?? 1 })
        .toEqual({ id: m.id, outputFactor: factor * factor });
    }
  });

  it('states every metered rate ONCE, in USD, and derives the credits from it', () => {
    // The credit meter and the USD ledger are documented to mirror each other,
    // and a hand-written per-unit credit rate is how they stopped doing so: at
    // $0.005/s LatentSync's "1 credit per second" rounded HALF a credit up on
    // every second past its flat window, so a 300-second lipsync booked 280
    // credits ($2.80) and $1.50 on the same row. There is now one rate, and the
    // credit figure is ceil(usd * 100) of the exact amount.
    for (const m of models) {
      const sm = m.contract.sourceMetering;
      if (!sm) continue;
      let previous = 0;
      for (const step of sm.ladder ?? []) {
        const label = `${m.id}@${step.maxUnits}`;
        // Rungs ascend, so `find` picks the cheapest band that covers the output.
        expect({ label, ascending: step.maxUnits > previous }).toEqual({ label, ascending: true });
        previous = step.maxUnits;
      }
      // A banded rate and a per-unit rate are two different meters; carrying
      // both would make the price depend on which branch was read first.
      expect({ id: m.id, both: Boolean(sm.ladder && sm.pricePerUnitUsd !== undefined) })
        .toEqual({ id: m.id, both: false });
    }
  });

  it('derives every metered credit figure from the metered dollar figure', () => {
    // The mirror as an executable rule rather than a docstring: wherever the
    // metered rate itself decides the charge, the credit figure is ceil(usd*100)
    // of what the same call books in dollars. (The models with no metered rate —
    // the upscaler's and the avatars' per-SECOND rates, where the measurement
    // only supplies the seconds — keep the catalogue's deliberately rounded-up
    // per-second credit rate, which is a margin decision, not a drift.)
    const cases: Array<[string, MediaEstimateOpts]> = [
      ['fal-ai/latentsync', { sourceDurationSec: 300 }],
      ['fal-ai/latentsync', { sourceDurationSec: 41 }],
      ['fal-ai/latentsync', { sourceDurationSec: 30 }],
      ['fal-ai/topaz/upscale/image', { sourceWidth: 3000, sourceHeight: 3000 }],
      ['fal-ai/qwen-image-edit/inpaint', { sourceWidth: 1500, sourceHeight: 1200 }],
    ];
    for (const [id, opts] of cases) {
      const usd = estimateMediaUsd(id, opts);
      expect({ id, credits: estimateMediaCredits(id, opts) })
        .toEqual({ id, credits: Math.max(1, Math.ceil(Number((usd * 100).toFixed(6)))) });
    }
  });

  it('backs a free allowance with the flat rate it is an allowance of', () => {
    for (const m of models) {
      const sm = m.contract.sourceMetering;
      if (!sm?.freeUnits) continue;
      // freeUnits means "the flat rate already covers this much", so a model
      // without a flat rate would bill the allowance as if it were free.
      expect({ id: m.id, flat: m.credits !== undefined && m.priceUsd !== undefined })
        .toEqual({ id: m.id, flat: true });
    }
  });

  /**
   * THE WITHDRAWAL, AS A RULE RATHER THAN A LIST.
   *
   * These models are priced on a property of a file the customer supplies. That
   * used to mean "never sold", because nothing here could measure the file. A
   * real server-side probe (ffprobe) now can, so the rule is no longer "don't
   * sell them" — it is that a sold one must be MEASURABLE.
   *
   * The rule is asserted rather than the list, because listing ids fixes the
   * ids and asserting the rule stops the next one — which is what happened
   * before, when a per-second rate with unknowable seconds was added three
   * separate times before anyone noticed.
   */
  it('only SELLS a file-metered model whose source the service can actually reach', () => {
    // Every field a request can carry a source in, all populated. A slot that
    // does not resolve here measures nothing, forever: `usable` is false on
    // every call, so the model is not withheld — it is broken, and it fails in
    // front of a customer instead of in this file.
    const everySource = {
      images: ['https://x/i.png'],
      lastImage: 'https://x/l.png',
      video: 'https://x/v.mp4',
      audio: 'https://x/a.mp3',
      mask: 'https://x/m.png',
    } as any;

    for (const m of listMediaModels()) {
      const sm = m.contract.sourceMetering;
      if (!sm) continue;
      // `script` is the one metered quantity that is not a file at all: the
      // script IS the prompt, and the prompt is already ours to read.
      if (sm.from === 'script') continue;

      const slots = Array.isArray(sm.from) ? sm.from : [];
      expect({ id: m.id, slots: slots.length > 0 }).toEqual({ id: m.id, slots: true });
      for (const slot of slots) {
        expect({ id: m.id, slot, reachable: Boolean(urlForSlot(slot, everySource)) })
          .toEqual({ id: m.id, slot, reachable: true });
      }
    }
  });

  it('never withholds a model the service falls back to when none is named', () => {
    // A withheld model is unreachable only if nothing reaches it BY DEFAULT.
    // The per-type fallbacks are what a request with no `model` generates —
    // the ordinary MCP and campaign-engine call — so withholding one of them
    // would be a withdrawal the picker honours and the API does not.
    for (const id of [DEFAULT_IMAGE_MODEL, DEFAULT_VIDEO_MODEL, DEFAULT_AUDIO_MODEL]) {
      expect({ id, withheld: Boolean(MEDIA_MODELS[id]?.withheld) })
        .toEqual({ id, withheld: false });
    }
  });

  it('gives every withheld model a reason and keeps its verified contract', () => {
    for (const m of models) {
      if (!m.withheld) continue;
      // A flag with no paragraph behind it becomes folklore in a month.
      expect({ id: m.id, reasoned: m.withheld.trim().length > 200 })
        .toEqual({ id: m.id, reasoned: true });
      // Withdrawn, not deleted: the research is the point, and un-withholding
      // must be deleting one line rather than re-doing the endpoint pass.
      expect({ id: m.id, contract: Boolean(m.contract) }).toEqual({ id: m.id, contract: true });
    }
  });

  it('never pins target_fps on the Topaz video upscaler', () => {
    // fal attaches the 60fps multiplier to SETTING the parameter ("set it and
    // you also pay the 60fps multiplier"), so pinning target_fps to 30 in order
    // to avoid the doubling guarantees the 2x it was meant to avoid. Left unset
    // the entry costs what its published pricing describes.
    const fixed = MEDIA_MODELS['fal-ai/topaz/upscale/video'].contract.fixed ?? {};
    expect('target_fps' in fixed).toBe(false);
  });

  it('does not publish a ceiling below its own top band', () => {
    for (const m of models) {
      const sm = m.contract.sourceMetering;
      if (!sm?.maxUnits || !sm.ladder?.length) continue;
      const top = sm.ladder[sm.ladder.length - 1].maxUnits;
      // A ceiling under the top rung would refuse requests the catalogue has a
      // published rate for.
      expect({ id: m.id, ok: sm.maxUnits >= top }).toEqual({ id: m.id, ok: true });
    }
  });
});
