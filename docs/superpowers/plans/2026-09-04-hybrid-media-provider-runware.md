# Hybrid media provider (fal.ai + Runware) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route five catalogue models to Runware when `RUNWARE_API_KEY` is set (everything else stays on fal), and retire the two fal endpoints that fal itself has deprecated, without changing customer credit prices.

**Architecture:** A `RoutingMediaProvider` sits behind the existing `MEDIA_PROVIDER` token and dispatches per model to `FalProvider` or a new `RunwareProvider`; Runware request ids are prefixed `runware:` so polling routes by id, and the asset row records the real provider name. The catalogue gains an optional `runware` binding (Runware model id + Runware list price) and a `replacedBy` alias for retired ids; vendor cost is settled per vendor (`FAL_CREDIT` vs a new `RUNWARE_CENT` tariff) while the customer credit meter is untouched.

**Tech Stack:** NestJS 11 (backend), Prisma/PostgreSQL, Jest (`npx jest <path>` from `backend/`), fetch-based HTTP providers, GitHub Actions deploy (`.github/workflows/deploy.yml`).

**Spec:** `docs/superpowers/specs/2026-09-04-hybrid-media-provider-runware-design.md` (design) and `docs/superpowers/specs/2026-09-04-runware-api-notes.md` (Runware wire contract, verified 2026-09-04).

## Global Constraints

- Customer credits (`credits`, `creditsPerSec`, …) on every catalogue row stay as they are today; only vendor USD bookkeeping learns about Runware.
- `RUNWARE_API_KEY` unset ⇒ behaviour identical to today except: default video model becomes Seedance 1.0 Pro Fast pinned to 720p, and the two retired ids alias to their successors.
- No fallback from a failed Runware submit to fal (double-charge risk); operators turn Runware off by unsetting the key.
- Runware v1 is poll-only (no webhook endpoint).
- Migrations ship as `migration.sql` + `down.sql`; the down deletes exactly the seeded platform row and is a no-op if already gone.
- Commits: plain conventional messages, no AI trailers or co-author lines (user's global rule).
- Run tests from `backend/`: `npx jest <path>`; whole suite `npm test`; lint `npm run lint`; build `npm run build`.

---

## File map

| File | Responsibility |
|---|---|
| `backend/src/modules/marketing/ai/media/media-models.config.ts` | catalogue: `RunwareBinding`, `replacedBy`, `resolveMediaModelId`, `estimateVendorUsd`, new default video entry, aliases, runware bindings |
| `backend/src/modules/marketing/ai/providers/media-provider.interface.ts` | `resolveName?`, `MediaGenResult.costUsd?` |
| `backend/src/modules/marketing/ai/providers/runware.provider.ts` (new) | Runware wire shape per model, submit/poll, result mapping, error → BLOCKED/FAILED |
| `backend/src/modules/marketing/ai/providers/routing.provider.ts` (new) | per-model dispatch fal ↔ runware, `runware:` id prefix |
| `backend/src/modules/marketing/ai/media/media-gen.service.ts` | alias resolution at request, provider name on the row, vendor cost at finalize |
| `backend/src/modules/marketing/budget/media-spend.service.ts` | settle under `FAL_CREDIT` or `RUNWARE_CENT` |
| `backend/src/modules/marketing/wallet/channel-tariff.service.ts`, `vendor-spend-report.service.ts` | `RUNWARE_CENT` unit + Runware vendor row |
| `backend/prisma/migrations/20260904120000_seed_runware_cent_tariff/{migration,down}.sql` | platform tariff seed, reversible |
| `backend/src/modules/marketing/ai/media/media-model-defaults.service.ts` | alias-transparent projection |
| `backend/src/modules/marketing/marketing.module.ts` | wiring |
| `.github/workflows/deploy.yml`, `backend/.env.example` | `RUNWARE_API_KEY`, `RUNWARE_TIMEOUT_MS` |

---

### Task 1: Catalogue — aliases, Runware bindings, new default video model

**Files:**
- Modify: `backend/src/modules/marketing/ai/media/media-models.config.ts`
- Test: `backend/src/modules/marketing/ai/media/media-models.config.spec.ts`

**Interfaces:**
- Produces: `type MediaVendor = 'fal' | 'runware'`; `interface RunwareBinding extends MediaRate { model: string; tiers?: Readonly<Record<string, MediaRate>>; note?: string }`; `MediaModel.runware?: RunwareBinding`; `MediaModel.replacedBy?: string`; `resolveMediaModelId(id: string): string`; `isMediaModelReplaced(id: string): boolean`; `estimateVendorUsd(modelId: string, arg: EstimateArg, vendor: MediaVendor): number`; `DEFAULT_VIDEO_MODEL = 'fal-ai/bytedance/seedance/v1/pro/fast/text-to-video'`; `RETIRED_SEEDANCE_LITE_MODEL = 'fal-ai/bytedance/seedance/v1/lite/text-to-video'`.
- `listMediaModels()` drops `replacedBy` entries; `assertCataloguedModel()` refuses them; `isCataloguedModel()` still accepts them (stored values keep validating).

- [ ] **Step 1: Write the failing tests** — append to `media-models.config.spec.ts`:

```ts
import {
  RETIRED_SEEDANCE_LITE_MODEL, resolveMediaModelId, isMediaModelReplaced,
  assertCataloguedModel, estimateVendorUsd,
} from './media-models.config';

describe('retired ids (replacedBy)', () => {
  it('names Seedance 1.0 Pro Fast as the platform default, pinned to 720p', () => {
    expect(DEFAULT_VIDEO_MODEL).toBe('fal-ai/bytedance/seedance/v1/pro/fast/text-to-video');
    const m = MEDIA_MODELS[DEFAULT_VIDEO_MODEL];
    expect(m.contract.resolution).toEqual({ param: 'resolution', values: ['480p', '720p', '1080p'], default: '720p' });
    expect(m.contract.duration?.encoding).toBe('digitStringSeconds');
    expect(m.contract.aspect?.values['4:5']).toBeUndefined();
    expect(m.contract.negativePrompt).toBe(false);
    // $1/M tokens: 720p 21,600 tok/s → $0.0216/s → 3 credits; 1080p → 5; 480p → 1.
    expect(m.creditsPerSec).toBe(3);
    expect(estimateMediaCredits(DEFAULT_VIDEO_MODEL, { durationSec: 5, resolution: '1080p' })).toBe(25);
    expect(estimateMediaCredits(DEFAULT_VIDEO_MODEL, { durationSec: 5, resolution: '480p' })).toBe(5);
    expect(buildFalInput({ type: 'VIDEO', model: DEFAULT_VIDEO_MODEL, prompt: 'x', durationSec: 8 })).toMatchObject({ resolution: '720p', duration: '8' });
  });

  it('resolves the two fal-retired ids to their successors and stops on a live id', () => {
    expect(resolveMediaModelId(RETIRED_SEEDANCE_LITE_MODEL)).toBe(DEFAULT_VIDEO_MODEL);
    expect(resolveMediaModelId('fal-ai/veo3/fast')).toBe('fal-ai/veo3.1/fast');
    expect(resolveMediaModelId(DEFAULT_VIDEO_MODEL)).toBe(DEFAULT_VIDEO_MODEL);
    expect(resolveMediaModelId('not-a-model')).toBe('not-a-model');
    expect(isMediaModelReplaced(RETIRED_SEEDANCE_LITE_MODEL)).toBe(true);
    expect(isMediaModelReplaced(DEFAULT_VIDEO_MODEL)).toBe(false);
  });

  it('keeps retired ids priced and typed (old rows reference them) but off the menu and off the write gate', () => {
    expect(isCataloguedModel(RETIRED_SEEDANCE_LITE_MODEL, 'VIDEO')).toBe(true);
    expect(MEDIA_MODELS[RETIRED_SEEDANCE_LITE_MODEL].creditsPerSec).toBe(3);
    expect(listMediaModels().map((m) => m.id)).not.toContain(RETIRED_SEEDANCE_LITE_MODEL);
    expect(listMediaModels().map((m) => m.id)).not.toContain('fal-ai/veo3/fast');
    expect(() => assertCataloguedModel('fal-ai/veo3/fast', 'VIDEO')).toThrow(/retired.*fal-ai\/veo3\.1\/fast/);
    expect(assertCataloguedModel('fal-ai/veo3.1/fast', 'VIDEO')).toBe('fal-ai/veo3.1/fast');
  });
});

describe('runware bindings', () => {
  const BOUND = [
    ['bytedance/seedance-2.5/text-to-video', 'bytedance:seedance@2.5'],
    ['bytedance/seedance-2.5/image-to-video', 'bytedance:seedance@2.5'],
    [DEFAULT_VIDEO_MODEL, 'bytedance:2@2'],
    ['fal-ai/qwen-image', 'runware:108@1'],
    ['fal-ai/birefnet/v2', 'runware:112@5'],
  ] as const;

  it('binds exactly the five v1 models', () => {
    const bound = allMediaModels().filter((m) => m.runware).map((m) => [m.id, m.runware!.model]);
    expect(bound.sort()).toEqual([...BOUND].map((b) => [...b]).sort());
  });

  it('prices vendor USD from the Runware rate without touching the credit meter', () => {
    // Seedance 2.5, 5s at 720p: fal $0.473/s, Runware $0.2304/s; credits stay 48/s.
    const opts = { durationSec: 5, resolution: '720p' };
    expect(estimateVendorUsd('bytedance/seedance-2.5/text-to-video', opts, 'fal')).toBeCloseTo(2.365, 6);
    expect(estimateVendorUsd('bytedance/seedance-2.5/text-to-video', opts, 'runware')).toBeCloseTo(1.152, 6);
    expect(estimateMediaCredits('bytedance/seedance-2.5/text-to-video', opts)).toBe(240);
    // Tiered Runware rate: 1080p.
    expect(estimateVendorUsd('bytedance/seedance-2.5/text-to-video', { durationSec: 5, resolution: '1080p' }, 'runware')).toBeCloseTo(3.0677, 4);
    // Flat image rate; a model with no binding falls back to the fal figure.
    expect(estimateVendorUsd('fal-ai/qwen-image', {}, 'runware')).toBeCloseTo(0.0058, 6);
    expect(estimateVendorUsd(DEFAULT_IMAGE_MODEL, {}, 'runware')).toBeCloseTo(0.03, 6);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx jest src/modules/marketing/ai/media/media-models.config.spec.ts` → FAIL (`RETIRED_SEEDANCE_LITE_MODEL` is not exported; default id mismatch).

- [ ] **Step 3: Implement** in `media-models.config.ts`:

Types (next to `MediaRate`/`MediaModel`):

```ts
export type MediaVendor = 'fal' | 'runware';

/** A second source for the same model. The rate fields are Runware's LIST
 *  price and feed ONLY the vendor-cost ledger; the customer credit meter stays
 *  derived from the fal rate on the model itself (see §2.3 of the design). */
export interface RunwareBinding extends MediaRate {
  /** AIR id, e.g. `bytedance:seedance@2.5`. The wire recipe lives in runware.provider.ts. */
  model: string;
  tiers?: Readonly<Record<string, MediaRate>>;
  note?: string;
}

export interface MediaModel extends MediaRate {
  // ...existing fields...
  runware?: RunwareBinding;
  /** fal retired this endpoint. The entry stays (old rows, stored defaults and
   *  campaign overrides reference it) but a generation naming it runs on the
   *  successor, the menu hides it, and the write gate refuses it. */
  replacedBy?: string;
}
```

Constants:

```ts
export const DEFAULT_VIDEO_MODEL = 'fal-ai/bytedance/seedance/v1/pro/fast/text-to-video';
/** fal retired this on 2026-09 and silently re-routes it to Pro Fast at 1080p. */
export const RETIRED_SEEDANCE_LITE_MODEL = 'fal-ai/bytedance/seedance/v1/lite/text-to-video';

const SEEDANCE_1_FAST_ASPECT: MediaAspectContract = {
  param: 'aspect_ratio',
  values: { '21:9': '21:9', '16:9': '16:9', '4:3': '4:3', '1:1': '1:1', '3:4': '3:4', '9:16': '9:16' },
};
const SEEDANCE_1_FAST_RESOLUTION: MediaResolutionContract = {
  param: 'resolution', values: ['480p', '720p', '1080p'], default: '720p',
};
/** Digit-string enum "2".."12" (schema-read 2026-09-04). */
const SEEDANCE_1_FAST_DURATION: MediaDurationContract = {
  param: 'duration', encoding: 'digitStringSeconds', minSec: 2, maxSec: 12,
};
/** $1.00 per million video tokens, tokens = h·w·24·s/1024: 480p (864×480)
 *  9,720 tok/s ≈ $0.0097/s, 720p (1248×704) 20,592 ≈ $0.0206/s — billed at the
 *  1280×720 figure $0.0216 the page quotes — and 1080p (1920×1088) 48,960 ≈ $0.049. */
const SEEDANCE_1_FAST_TIERS: Record<string, MediaRate> = {
  '480p': { pricePerSecUsd: 0.0097, creditsPerSec: 1 },
  '1080p': { pricePerSecUsd: 0.049, creditsPerSec: 5 },
};
```

New default entry (replace the old `[DEFAULT_VIDEO_MODEL]` block; keep the old Lite block under `[RETIRED_SEEDANCE_LITE_MODEL]` with `replacedBy: DEFAULT_VIDEO_MODEL` added and its note rewritten):

```ts
  [DEFAULT_VIDEO_MODEL]: {
    id: DEFAULT_VIDEO_MODEL,
    technique: 'VIDEO_CREATE', type: 'VIDEO', label: 'Short video',
    pricePerSecUsd: 0.0216, creditsPerSec: 3, tiers: SEEDANCE_1_FAST_TIERS,
    runware: {
      model: 'bytedance:2@2', pricePerSecUsd: 0.01336,
      tiers: { '480p': { pricePerSecUsd: 0.00629 }, '1080p': { pricePerSecUsd: 0.03177 } },
    },
    note: 'The platform default. fal retired Seedance 1.0 Lite and re-routes it here, '
      + 'and this endpoint DEFAULTS TO 1080p ($0.049/s) — so resolution is always sent, '
      + 'and 720p is the tier the 3-credit meter was set against. No negative_prompt, '
      + 'no audio; seed is accepted. Duration is a digit-string "2".."12".',
    contract: {
      promptParam: 'prompt', negativePrompt: false, seedInput: true,
      duration: SEEDANCE_1_FAST_DURATION, resolution: SEEDANCE_1_FAST_RESOLUTION,
      aspect: SEEDANCE_1_FAST_ASPECT,
    },
  },
  [RETIRED_SEEDANCE_LITE_MODEL]: {
    id: RETIRED_SEEDANCE_LITE_MODEL,
    technique: 'VIDEO_CREATE', type: 'VIDEO', label: 'Short video (retired)',
    pricePerSecUsd: 0.025, creditsPerSec: 3,
    replacedBy: DEFAULT_VIDEO_MODEL,
    note: 'RETIRED BY FAL (page: "deprecated … re-routed to Seedance 1.0 Pro Fast"). '
      + 'Kept so rows, stored defaults and campaign overrides that name it still '
      + 'resolve; every generation runs on the successor at its own price.',
    contract: { /* unchanged legacy contract */ },
  },
```

`fal-ai/veo3/fast`: add `replacedBy: 'fal-ai/veo3.1/fast'` and prepend to its note `'RETIRED BY FAL (Google shut Veo 3 down 2026-06-30). '`.

Runware bindings on existing entries:

```ts
  // fal-ai/qwen-image
  runware: { model: 'runware:108@1', priceUsd: 0.0058, note: 'compute-billed "from" price at 1024x1024, 20 steps; the real figure is read back per request' },
  // fal-ai/birefnet/v2
  runware: { model: 'runware:112@5', priceUsd: 0.0006, note: 'BiRefNet General; compute-billed, every published run $0.0006' },
  // bytedance/seedance-2.5/text-to-video AND bytedance/seedance-2.5/image-to-video
  runware: { model: 'bytedance:seedance@2.5', pricePerSecUsd: 0.2304, tiers: { '480p': { pricePerSecUsd: 0.1025 }, '1080p': { pricePerSecUsd: 0.61354 } } },
```

Helpers (after `getMediaModel`):

```ts
/** Follow `replacedBy` (bounded) to the id that actually runs today. */
export function resolveMediaModelId(id: string): string {
  let current = id;
  for (let hop = 0; hop < 3; hop++) {
    const next = MEDIA_MODELS[current]?.replacedBy;
    if (!next || next === current || !MEDIA_MODELS[next]) return current;
    current = next;
  }
  return current;
}

export function isMediaModelReplaced(id: string): boolean {
  return Boolean(MEDIA_MODELS[id]?.replacedBy);
}
```

`listMediaModels`: `const served = allMediaModels().filter((m) => !m.withheld && !m.replacedBy);`

`assertCataloguedModel`: before the existing check add

```ts
  const replaced = MEDIA_MODELS[id]?.replacedBy;
  if (replaced && MEDIA_MODELS[id].type === type) {
    throw new BadRequestException(
      `"${id}" has been retired by its provider and can no longer be chosen; its successor is "${resolveMediaModelId(id)}". Choose one of: ${menuIds(type)}.`,
    );
  }
```

and extract `menuIds(type)` = `Object.values(MEDIA_MODELS).filter((m) => m.type === type && !m.withheld && !m.replacedBy).map((m) => m.id).join(', ')` used by both messages.

Vendor USD — refactor the tail of `estimateMediaUsd` into a shared helper:

```ts
/** The USD a rate produces for `opts` — the non-metered branches, shared by the
 *  fal figure and the Runware figure so the two can never disagree on units. */
function rateUsd(m: MediaModel, rate: MediaRate, opts: MediaEstimateOpts): number {
  if (rate.pricePerKCharUsd !== undefined) {
    const chars = Math.max(1, opts.textLength ?? DEFAULT_TEXT_LENGTH);
    return (rate.pricePerKCharUsd * chars) / 1000;
  }
  if (rate.pricePerMinuteUsd !== undefined) {
    return rate.pricePerMinuteUsd * Math.max(1, Math.ceil(durationOrDefault(m, opts) / 60));
  }
  if (rate.pricePerSecUsd !== undefined) return rate.pricePerSecUsd * durationOrDefault(m, opts);
  return rate.priceUsd ?? 0;
}

export function estimateMediaUsd(modelId: string, arg?: EstimateArg): number {
  const m = MEDIA_MODELS[modelId];
  if (!m) return 0;
  const opts = toOpts(arg);
  const rate = rateFor(m, opts.resolution);
  const meteredUsd = sourceMeteredUsd(m, rate, meteredUnits(m, opts));
  if (meteredUsd !== null) return meteredUsd;
  return rateUsd(m, rate, opts);
}

/** What the generation costs US at `vendor`. 'fal' is `estimateMediaUsd`; 'runware'
 *  reads the binding's rate (its own tiers, else its base) and falls back to the
 *  fal figure for a model with no binding — never to zero. */
export function estimateVendorUsd(modelId: string, arg: EstimateArg, vendor: MediaVendor): number {
  const m = MEDIA_MODELS[modelId];
  if (!m || vendor !== 'runware' || !m.runware) return estimateMediaUsd(modelId, arg);
  const opts = toOpts(arg);
  const b = m.runware;
  const rate: MediaRate = (opts.resolution && b.tiers?.[opts.resolution]) || b;
  return rateUsd(m, rate, opts);
}
```

- [ ] **Step 4: Run** — `npx jest src/modules/marketing/ai/media/media-models.config.spec.ts src/modules/marketing/ai/providers/fal.provider.contract.spec.ts` → PASS. (The contract spec's Lite integer-duration test still passes: the retired entry keeps its legacy contract.)

- [ ] **Step 5: Commit** — `git add backend/src/modules/marketing/ai/media/media-models.config.ts backend/src/modules/marketing/ai/media/media-models.config.spec.ts && git commit -m "feat(media): catalogue aliases for fal-retired ids, Runware bindings, Pro Fast default pinned to 720p"`

---

### Task 2: Provider interface + RunwareProvider

**Files:**
- Modify: `backend/src/modules/marketing/ai/providers/media-provider.interface.ts`
- Create: `backend/src/modules/marketing/ai/providers/runware.provider.ts`
- Test: `backend/src/modules/marketing/ai/providers/runware.provider.contract.spec.ts` (no network), `backend/src/modules/marketing/ai/providers/runware.provider.spec.ts` (fetch mocked)

**Interfaces:**
- Produces: `MediaGenResult.costUsd?: number`; `MediaProvider.resolveName?(model: string): string`; `class RunwareProvider implements MediaProvider` (`name = 'runware'`, `isConfigured()` ⇔ `RUNWARE_API_KEY`); `buildRunwareTask(opts: MediaGenSubmit, taskUUID: string): Record<string, unknown>`; `mapRunwareItem(item: any): MediaGenOutput[]`; `RUNWARE_RECIPES: Record<string, RunwareRecipe>`.

- [ ] **Step 1: Interface change** in `media-provider.interface.ts`:

```ts
export interface MediaGenResult {
  status: MediaGenStatus;
  outputs?: MediaGenOutput[];
  error?: string;
  /** The vendor's OWN reported cost in USD, where it reports one (Runware
   *  returns `cost` per task; fal never does). Beats any catalogue estimate. */
  costUsd?: number;
}

export interface MediaProvider {
  readonly name: string;
  isConfigured(): boolean;
  /** Which concrete vendor `submit` would use for this model ('fal' | 'runware').
   *  A single-vendor provider omits it and `name` is the answer. */
  resolveName?(model: string): string;
  submit(opts: MediaGenSubmit): Promise<{ providerRequestId: string }>;
  getResult(requestId: string, model: string): Promise<MediaGenResult>;
}
```

- [ ] **Step 2: Failing contract tests** — `runware.provider.contract.spec.ts`:

```ts
import { buildRunwareTask, mapRunwareItem, RUNWARE_RECIPES } from './runware.provider';
import { MediaGenSubmit } from './media-provider.interface';
import { allMediaModels, DEFAULT_VIDEO_MODEL } from '../media/media-models.config';

const UUID = '11111111-2222-4333-8444-555555555555';
function build(over: Partial<MediaGenSubmit> & Pick<MediaGenSubmit, 'model'>) {
  return buildRunwareTask({ type: 'VIDEO', prompt: 'a hero shot of the bottle', ...over }, UUID);
}

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

  it('Seedance 2.5 text-to-video: width/height from the aspect table, integer duration, audio on by default, no seed', () => {
    const t = build({ model: 'bytedance/seedance-2.5/text-to-video', aspectRatio: '9:16', resolution: '720p', durationSec: 8, seed: 7 });
    expect(t).toMatchObject({ taskType: 'videoInference', model: 'bytedance:seedance@2.5', positivePrompt: 'a hero shot of the bottle', width: 720, height: 1280, duration: 8, settings: { audio: true } });
    expect(t).not.toHaveProperty('seed');
    expect(t).not.toHaveProperty('resolution');
    expect(t).not.toHaveProperty('negativePrompt');
  });

  it('Seedance 2.5 image-to-video: frameImages + resolution, never width/height, last frame optional', () => {
    const t = build({ model: 'bytedance/seedance-2.5/image-to-video', resolution: '480p', durationSec: 5, sources: { images: ['https://cdn/a.png'], lastImage: 'https://cdn/b.png' }, generateAudio: false });
    expect(t).toMatchObject({ resolution: '480p', inputs: { frameImages: [{ image: 'https://cdn/a.png', frame: 'first' }, { image: 'https://cdn/b.png', frame: 'last' }] }, settings: { audio: false } });
    expect(t).not.toHaveProperty('width');
    const single = build({ model: 'bytedance/seedance-2.5/image-to-video', sources: { images: ['https://cdn/a.png'] } });
    expect((single.inputs as any).frameImages).toHaveLength(1);
  });

  it('bills and buys the same length: duration goes through the catalogue contract (Seedance 2.5 floor is 4s)', () => {
    expect(build({ model: 'bytedance/seedance-2.5/text-to-video', durationSec: 2 }).duration).toBe(4);
    expect(build({ model: DEFAULT_VIDEO_MODEL, durationSec: 30 }).duration).toBe(12);
  });

  it('Seedance 1.0 Pro Fast: 720p default dims for 16:9, seed accepted, no audio setting', () => {
    const t = build({ model: DEFAULT_VIDEO_MODEL, seed: 42, durationSec: 5 });
    expect(t).toMatchObject({ model: 'bytedance:2@2', width: 1248, height: 704, duration: 5, seed: 42 });
    expect(t).not.toHaveProperty('settings');
    expect(build({ model: DEFAULT_VIDEO_MODEL, aspectRatio: '1:1', resolution: '1080p' })).toMatchObject({ width: 1440, height: 1440 });
  });

  it('Qwen-Image: 1024x1024, 20 steps, PNG, negative prompt and seed pass through', () => {
    const t = build({ model: 'fal-ai/qwen-image', type: 'IMAGE', negativePrompt: 'blurry', seed: 3 });
    expect(t).toMatchObject({ taskType: 'imageInference', model: 'runware:108@1', width: 1024, height: 1024, steps: 20, outputFormat: 'PNG', negativePrompt: 'blurry', seed: 3 });
  });

  it('BiRefNet: removeBackground on inputs.image as PNG, and refuses to run without a source', () => {
    const t = build({ model: 'fal-ai/birefnet/v2', type: 'IMAGE', prompt: '', sources: { images: ['https://cdn/p.jpg'] } });
    expect(t).toMatchObject({ taskType: 'removeBackground', model: 'runware:112@5', inputs: { image: 'https://cdn/p.jpg' }, outputFormat: 'PNG' });
    expect(t).not.toHaveProperty('positivePrompt');
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
```

- [ ] **Step 3: Failing provider tests** — `runware.provider.spec.ts`:

```ts
import { RunwareProvider } from './runware.provider';

const OLD = process.env.RUNWARE_API_KEY;
let provider: RunwareProvider;
const fetchMock = jest.fn();

function json(body: unknown, status = 200) {
  return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) } as any);
}

beforeEach(() => {
  process.env.RUNWARE_API_KEY = 'rw-test';
  provider = new RunwareProvider();
  (global as any).fetch = fetchMock;
  fetchMock.mockReset();
});
afterEach(() => { process.env.RUNWARE_API_KEY = OLD; });

describe('RunwareProvider', () => {
  it('is inert without RUNWARE_API_KEY', async () => {
    delete process.env.RUNWARE_API_KEY;
    expect(provider.isConfigured()).toBe(false);
    await expect(provider.submit({ type: 'IMAGE', model: 'fal-ai/qwen-image', prompt: 'x' })).rejects.toThrow(/not configured/);
  });

  it('submits one task with a bearer key and returns the client uuid', async () => {
    fetchMock.mockReturnValueOnce(json({ data: [{ taskType: 'imageInference', taskUUID: 'echo' }] }));
    const { providerRequestId } = await provider.submit({ type: 'IMAGE', model: 'fal-ai/qwen-image', prompt: 'x' });
    expect(providerRequestId).toMatch(/^[0-9a-f-]{36}$/);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.runware.ai/v1');
    expect(init.headers.Authorization).toBe('Bearer rw-test');
    const body = JSON.parse(init.body);
    expect(body).toHaveLength(1);
    expect(body[0].taskUUID).toBe(providerRequestId);
  });

  it('surfaces a rejected submit (HTTP ok, errors[] present) as a thrown error', async () => {
    fetchMock.mockReturnValueOnce(json({ errors: [{ code: 'invalidModel', message: 'Unknown model', taskUUID: 'x' }] }));
    await expect(provider.submit({ type: 'IMAGE', model: 'fal-ai/qwen-image', prompt: 'x' })).rejects.toThrow(/invalidModel: Unknown model/);
  });

  it('polls with getResponse and reports processing as IN_PROGRESS', async () => {
    fetchMock.mockReturnValueOnce(json({ data: [{ taskType: 'videoInference', taskUUID: 'u1', status: 'processing', progress: 12 }] }));
    const r = await provider.getResult('u1', 'bytedance/seedance-2.5/text-to-video');
    expect(r.status).toBe('IN_PROGRESS');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual([{ taskType: 'getResponse', taskUUID: 'u1' }]);
  });

  it('treats an empty poll (no item, no error) as still running', async () => {
    fetchMock.mockReturnValueOnce(json({ data: [] }));
    expect((await provider.getResult('u1', 'fal-ai/qwen-image')).status).toBe('IN_PROGRESS');
  });

  it('completes with the media URL and the reported cost', async () => {
    fetchMock.mockReturnValueOnce(json({ data: [{ taskType: 'videoInference', taskUUID: 'u1', status: 'success', videoURL: 'https://vm.runware.ai/v.mp4', cost: 1.152 }] }));
    const r = await provider.getResult('u1', 'bytedance/seedance-2.5/text-to-video');
    expect(r).toEqual({ status: 'COMPLETED', outputs: [expect.objectContaining({ url: 'https://vm.runware.ai/v.mp4' })], costUsd: 1.152 });
  });

  it('maps a safety code to BLOCKED and any other error to FAILED', async () => {
    fetchMock.mockReturnValueOnce(json({ errors: [{ code: 'contentPolicyViolation', message: 'blocked', taskUUID: 'u1' }] }));
    expect((await provider.getResult('u1', 'fal-ai/qwen-image')).status).toBe('BLOCKED');
    fetchMock.mockReturnValueOnce(json({ data: [{ taskUUID: 'u1', status: 'error', error: { code: 'timeoutProvider', message: 'slow' } }] }));
    expect(await provider.getResult('u1', 'fal-ai/qwen-image')).toEqual({ status: 'FAILED', error: 'timeoutProvider: slow' });
    fetchMock.mockReturnValueOnce(json({ data: [{ taskUUID: 'u1', status: 'success', imageURL: 'https://im/x.png', NSFWContent: true }] }));
    expect((await provider.getResult('u1', 'fal-ai/qwen-image')).status).toBe('BLOCKED');
  });

  it('ignores errors that belong to another task', async () => {
    fetchMock.mockReturnValueOnce(json({ data: [{ taskUUID: 'u1', status: 'processing' }], errors: [{ code: 'x', message: 'y', taskUUID: 'other' }] }));
    expect((await provider.getResult('u1', 'fal-ai/qwen-image')).status).toBe('IN_PROGRESS');
  });

  it('reports a non-2xx poll as FAILED with the HTTP detail', async () => {
    fetchMock.mockReturnValueOnce(json({ errors: [{ code: 'invalidApiKey', message: 'nope' }] }, 401));
    expect(await provider.getResult('u1', 'fal-ai/qwen-image')).toEqual({ status: 'FAILED', error: 'invalidApiKey: nope' });
  });
});
```

- [ ] **Step 4: Run both** → FAIL (module missing).

- [ ] **Step 5: Implement** `runware.provider.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  MediaProvider, MediaGenSubmit, MediaGenResult, MediaGenOutput,
} from './media-provider.interface';
import { billableDurationSec, getMediaModel } from '../media/media-models.config';

const RUNWARE_API = 'https://api.runware.ai/v1';
const RUNWARE_TIMEOUT_MS = Number(process.env.RUNWARE_TIMEOUT_MS ?? 30_000);
/** Codes the official SDK normalises to "safety" — a moderation refusal, refunded. */
const SAFETY_CODES = new Set([
  'contentPolicyViolation', 'providerContentPolicyViolation', 'sensitiveContentDetected',
  'unsafeContentDetected', 'nsfwContentDetected', 'promptBlocked', 'imageBlocked', 'moderationFailed',
]);
const BLOCK_RE = /nsfw|moderat|content polic|safety|flagged|prohibited/i;

type Dims = readonly [number, number];
/** resolution → aspect → [width, height], copied from each model page's table. */
type DimsTable = Readonly<Record<string, Readonly<Record<string, Dims>>>>;

const SEEDANCE_25_DIMS: DimsTable = {
  '480p': { '16:9': [854, 480], '4:3': [752, 560], '1:1': [640, 640], '3:4': [560, 752], '9:16': [480, 854], '21:9': [992, 432] },
  '720p': { '16:9': [1280, 720], '4:3': [1112, 834], '1:1': [960, 960], '3:4': [834, 1112], '9:16': [720, 1280], '21:9': [1470, 630] },
  '1080p': { '16:9': [1920, 1080], '4:3': [1664, 1248], '1:1': [1440, 1440], '3:4': [1248, 1664], '9:16': [1080, 1920], '21:9': [2206, 946] },
};
const SEEDANCE_1_FAST_DIMS: DimsTable = {
  '480p': { '16:9': [864, 480], '4:3': [736, 544], '1:1': [640, 640], '3:4': [544, 736], '9:16': [480, 864], '21:9': [960, 416] },
  '720p': { '16:9': [1248, 704], '4:3': [1120, 832], '1:1': [960, 960], '3:4': [832, 1120], '9:16': [704, 1248], '21:9': [1504, 640] },
  '1080p': { '16:9': [1920, 1088], '4:3': [1664, 1248], '1:1': [1440, 1440], '3:4': [1248, 1664], '9:16': [1088, 1920], '21:9': [2176, 928] },
};

/** The Runware wire recipe for one AIR model id. Runware normalises most of
 *  fal's per-endpoint parameter names away; what is left is which task type,
 *  which sizing table, and which optional fields the model accepts. */
export interface RunwareRecipe {
  task: 'imageInference' | 'videoInference' | 'removeBackground';
  dims?: DimsTable;
  /** Seedance 2.5 wants an integer; Pro Fast takes a float. */
  duration?: 'integer' | 'float';
  seed: boolean;
  negativePrompt: boolean;
  /** `settings.audio` exists on this model. */
  audioSetting: boolean;
  /** Image models: fixed output size and step count. */
  imageDims?: Dims;
  steps?: number;
  /** Video models: how many frame images the model takes. */
  frameImages?: 'first' | 'firstLast';
}

export const RUNWARE_RECIPES: Readonly<Record<string, RunwareRecipe>> = {
  'bytedance:seedance@2.5': { task: 'videoInference', dims: SEEDANCE_25_DIMS, duration: 'integer', seed: false, negativePrompt: false, audioSetting: true, frameImages: 'firstLast' },
  'bytedance:2@2': { task: 'videoInference', dims: SEEDANCE_1_FAST_DIMS, duration: 'float', seed: true, negativePrompt: false, audioSetting: false, frameImages: 'first' },
  'runware:108@1': { task: 'imageInference', seed: true, negativePrompt: true, audioSetting: false, imageDims: [1024, 1024], steps: 20 },
  'runware:112@5': { task: 'removeBackground', seed: false, negativePrompt: false, audioSetting: false },
};

export function buildRunwareTask(opts: MediaGenSubmit, taskUUID: string): Record<string, unknown> {
  const catalogued = getMediaModel(opts.model);
  const binding = catalogued?.runware;
  if (!catalogued || !binding) throw new Error(`no Runware binding for ${opts.model}`);
  const recipe = RUNWARE_RECIPES[binding.model];
  if (!recipe) throw new Error(`no Runware recipe for ${binding.model}`);

  const task: Record<string, unknown> = {
    taskType: recipe.task, taskUUID, model: binding.model,
    deliveryMethod: 'async', outputType: 'URL', includeCost: true, numberResults: 1,
  };
  const first = opts.sources?.images?.[0];

  if (recipe.task === 'removeBackground') {
    if (!first) throw new Error(`${opts.model} requires a source image`);
    task.inputs = { image: first };
    task.outputFormat = 'PNG';
    return task;
  }

  task.positivePrompt = opts.prompt;
  if (recipe.negativePrompt && opts.negativePrompt) task.negativePrompt = opts.negativePrompt;
  if (recipe.seed && opts.seed !== undefined) task.seed = opts.seed;

  if (recipe.task === 'imageInference') {
    const [w, h] = recipe.imageDims ?? [1024, 1024];
    task.width = w; task.height = h;
    if (recipe.steps) task.steps = recipe.steps;
    task.outputFormat = 'PNG';
    return task;
  }

  // videoInference
  const c = catalogued.contract;
  const resolution = (opts.resolution && c.resolution?.values.includes(opts.resolution))
    ? opts.resolution : (c.resolution?.default ?? '720p');
  const requested = opts.durationSec ?? 5;
  const secs = c.duration ? billableDurationSec(c.duration, requested) : requested;
  task.duration = recipe.duration === 'integer' ? Math.round(secs) : secs;

  if (recipe.frameImages && first) {
    const frames: Array<{ image: string; frame: 'first' | 'last' }> = [{ image: first, frame: 'first' }];
    if (recipe.frameImages === 'firstLast' && opts.sources?.lastImage) frames.push({ image: opts.sources.lastImage, frame: 'last' });
    task.inputs = { frameImages: frames };
    task.resolution = resolution; // width/height cannot be combined with frameImages
  } else {
    const aspect = opts.aspectRatio && recipe.dims?.[resolution]?.[opts.aspectRatio] ? opts.aspectRatio : '16:9';
    const [w, h] = recipe.dims![resolution][aspect];
    task.width = w; task.height = h;
  }
  if (recipe.audioSetting) task.settings = { audio: opts.generateAudio ?? true };
  return task;
}

function mimeFromUrl(url: string, fallback: string): string {
  const ext = url.split('?')[0].split('.').pop()?.toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'mp4') return 'video/mp4';
  if (ext === 'webm') return 'video/webm';
  return fallback;
}

export function mapRunwareItem(item: any): MediaGenOutput[] {
  const out: MediaGenOutput[] = [];
  if (typeof item?.videoURL === 'string') {
    out.push({ url: item.videoURL, mime: mimeFromUrl(item.videoURL, 'video/mp4'), width: undefined, height: undefined, durationSec: undefined });
  }
  if (typeof item?.imageURL === 'string') {
    out.push({ url: item.imageURL, mime: mimeFromUrl(item.imageURL, 'image/png'), width: undefined, height: undefined, durationSec: undefined });
  }
  return out;
}

interface RunwareError { code?: string; message?: string; taskUUID?: string }

/**
 * Runware task-array REST provider. Inert until RUNWARE_API_KEY is set. Every
 * task is async; results are polled with getResponse. Only models with a
 * catalogue `runware` binding can be built — the router never sends others.
 */
@Injectable()
export class RunwareProvider implements MediaProvider {
  readonly name = 'runware';
  private readonly logger = new Logger(RunwareProvider.name);

  isConfigured(): boolean {
    return !!process.env.RUNWARE_API_KEY;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${process.env.RUNWARE_API_KEY}`, 'Content-Type': 'application/json' };
  }

  private async post(tasks: unknown[]): Promise<{ ok: boolean; status: number; body: any }> {
    const res = await fetch(RUNWARE_API, {
      method: 'POST', headers: this.headers(), body: JSON.stringify(tasks),
      signal: AbortSignal.timeout(RUNWARE_TIMEOUT_MS),
    });
    let body: any = null;
    try { body = await res.json(); } catch { body = null; }
    return { ok: res.ok, status: res.status, body };
  }

  async submit(opts: MediaGenSubmit): Promise<{ providerRequestId: string }> {
    if (!this.isConfigured()) throw new Error('runware provider is not configured');
    const taskUUID = randomUUID();
    const task = buildRunwareTask(opts, taskUUID);
    const { ok, status, body } = await this.post([task]);
    const err = this.errorFor(body, taskUUID);
    if (!ok || err) throw new Error(`runware submit failed (${status}): ${err ? `${err.code}: ${err.message}` : 'HTTP error'}`);
    return { providerRequestId: taskUUID };
  }

  async getResult(requestId: string, _model: string): Promise<MediaGenResult> {
    const { ok, body } = await this.post([{ taskType: 'getResponse', taskUUID: requestId }]);
    const err = this.errorFor(body, requestId);
    if (err) return this.errorResult(err);
    if (!ok) return { status: 'FAILED', error: 'runware poll failed' };
    const item = (body?.data ?? []).find((d: any) => d?.taskUUID === requestId);
    if (!item) return { status: 'IN_PROGRESS' };
    if (item.status === 'error' || item.error) return this.errorResult(item.error ?? { code: 'taskFailed', message: 'runware task failed' });
    if (item.status === 'processing' || item.status === 'queued') return { status: 'IN_PROGRESS' };
    if (item.NSFWContent === true) return { status: 'BLOCKED', error: 'runware flagged the output as NSFW' };
    const outputs = mapRunwareItem(item);
    if (!outputs.length) return item.status === 'success'
      ? { status: 'FAILED', error: 'runware returned no output' }
      : { status: 'IN_PROGRESS' };
    return { status: 'COMPLETED', outputs, costUsd: typeof item.cost === 'number' ? item.cost : undefined };
  }

  /** The error addressed to THIS task, or one with no address (auth, malformed body). */
  private errorFor(body: any, taskUUID: string): RunwareError | undefined {
    const errors: RunwareError[] = Array.isArray(body?.errors) ? body.errors : [];
    return errors.find((e) => !e?.taskUUID || e.taskUUID === taskUUID);
  }

  private errorResult(e: RunwareError): MediaGenResult {
    const message = `${e.code ?? 'error'}: ${e.message ?? 'unknown runware error'}`;
    const blocked = (e.code && SAFETY_CODES.has(e.code)) || BLOCK_RE.test(e.message ?? '');
    return { status: blocked ? 'BLOCKED' : 'FAILED', error: message };
  }
}
```

- [ ] **Step 6: Run** — `npx jest src/modules/marketing/ai/providers` → PASS.

- [ ] **Step 7: Commit** — `git add backend/src/modules/marketing/ai/providers && git commit -m "feat(media): Runware provider (async task API, per-model wire recipes)"`

---

### Task 3: RoutingMediaProvider + module wiring

**Files:**
- Create: `backend/src/modules/marketing/ai/providers/routing.provider.ts`
- Test: `backend/src/modules/marketing/ai/providers/routing.provider.spec.ts`
- Modify: `backend/src/modules/marketing/marketing.module.ts:1155-1157`

**Interfaces:**
- Produces: `RUNWARE_REQUEST_PREFIX = 'runware:'`; `class RoutingMediaProvider implements MediaProvider` with `name = 'router'`, `resolveName(model)`, `isConfigured()` = fal's.

- [ ] **Step 1: Failing tests** — `routing.provider.spec.ts`:

```ts
import { RoutingMediaProvider, RUNWARE_REQUEST_PREFIX } from './routing.provider';
import { DEFAULT_IMAGE_MODEL } from '../media/media-models.config';

function makeRouter(runwareOn: boolean, falOn = true) {
  const fal: any = { name: 'fal', isConfigured: jest.fn().mockReturnValue(falOn), submit: jest.fn().mockResolvedValue({ providerRequestId: 'fal-1' }), getResult: jest.fn().mockResolvedValue({ status: 'IN_PROGRESS' }) };
  const runware: any = { name: 'runware', isConfigured: jest.fn().mockReturnValue(runwareOn), submit: jest.fn().mockResolvedValue({ providerRequestId: 'uuid-1' }), getResult: jest.fn().mockResolvedValue({ status: 'COMPLETED', outputs: [] }) };
  return { router: new RoutingMediaProvider(fal, runware), fal, runware };
}
const BOUND = 'bytedance/seedance-2.5/text-to-video';
const SUBMIT = { type: 'VIDEO' as const, prompt: 'x' };

describe('RoutingMediaProvider', () => {
  it('is configured exactly when fal is (fal is the base every model can run on)', () => {
    expect(makeRouter(true, false).router.isConfigured()).toBe(false);
    expect(makeRouter(false, true).router.isConfigured()).toBe(true);
  });

  it('names runware for a bound model only while runware is configured', () => {
    expect(makeRouter(true).router.resolveName(BOUND)).toBe('runware');
    expect(makeRouter(false).router.resolveName(BOUND)).toBe('fal');
    expect(makeRouter(true).router.resolveName(DEFAULT_IMAGE_MODEL)).toBe('fal');
  });

  it('submits a bound model to runware and prefixes the request id', async () => {
    const { router, runware, fal } = makeRouter(true);
    await expect(router.submit({ ...SUBMIT, model: BOUND })).resolves.toEqual({ providerRequestId: `${RUNWARE_REQUEST_PREFIX}uuid-1` });
    expect(runware.submit).toHaveBeenCalledTimes(1);
    expect(fal.submit).not.toHaveBeenCalled();
  });

  it('submits everything else to fal with a bare id', async () => {
    const { router, fal } = makeRouter(true);
    await expect(router.submit({ ...SUBMIT, type: 'IMAGE', model: DEFAULT_IMAGE_MODEL })).resolves.toEqual({ providerRequestId: 'fal-1' });
    expect(fal.submit).toHaveBeenCalledTimes(1);
  });

  it('polls by request-id prefix, not by model — an in-flight fal job stays on fal after the key appears', async () => {
    const { router, fal, runware } = makeRouter(true);
    await router.getResult('fal-abc', BOUND);
    expect(fal.getResult).toHaveBeenCalledWith('fal-abc', BOUND);
    await router.getResult(`${RUNWARE_REQUEST_PREFIX}uuid-9`, BOUND);
    expect(runware.getResult).toHaveBeenCalledWith('uuid-9', BOUND);
  });
});
```

- [ ] **Step 2: Run** → FAIL (module missing).

- [ ] **Step 3: Implement** `routing.provider.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { MediaProvider, MediaGenSubmit, MediaGenResult } from './media-provider.interface';
import { FalProvider } from './fal.provider';
import { RunwareProvider } from './runware.provider';
import { getMediaModel } from '../media/media-models.config';

/** Runware request ids are prefixed on the row so polling routes by ID, never
 *  by model: a job submitted to fal before the Runware key existed keeps being
 *  polled at fal after it does. fal ids stay bare, so old rows and the fal
 *  webhook's request_id lookup are untouched. */
export const RUNWARE_REQUEST_PREFIX = 'runware:';

/**
 * Per-model dispatch behind MEDIA_PROVIDER. fal is the base: every model can
 * run there, so "configured" means fal is. A model with a catalogue `runware`
 * binding goes to Runware while RUNWARE_API_KEY is set; there is deliberately
 * no fallback from a failed Runware submit to fal (different price, and the
 * reservation path already refunds a failed submit).
 */
@Injectable()
export class RoutingMediaProvider implements MediaProvider {
  readonly name = 'router';

  constructor(private readonly fal: FalProvider, private readonly runware: RunwareProvider) {}

  isConfigured(): boolean {
    return this.fal.isConfigured();
  }

  resolveName(model: string): string {
    return this.runware.isConfigured() && getMediaModel(model)?.runware ? 'runware' : 'fal';
  }

  async submit(opts: MediaGenSubmit): Promise<{ providerRequestId: string }> {
    if (this.resolveName(opts.model) === 'runware') {
      const r = await this.runware.submit(opts);
      return { providerRequestId: `${RUNWARE_REQUEST_PREFIX}${r.providerRequestId}` };
    }
    return this.fal.submit(opts);
  }

  getResult(requestId: string, model: string): Promise<MediaGenResult> {
    if (requestId.startsWith(RUNWARE_REQUEST_PREFIX)) {
      return this.runware.getResult(requestId.slice(RUNWARE_REQUEST_PREFIX.length), model);
    }
    return this.fal.getResult(requestId, model);
  }
}
```

Module wiring in `marketing.module.ts` (imports near line 408, providers near 1155):

```ts
import { RunwareProvider } from './ai/providers/runware.provider';
import { RoutingMediaProvider } from './ai/providers/routing.provider';
// ...
    // AI Social Content Studio — fal.ai + Runware behind one MediaProvider,
    // dispatched per model (media-models.config `runware` bindings).
    FalProvider,
    RunwareProvider,
    RoutingMediaProvider,
    { provide: MEDIA_PROVIDER, useExisting: RoutingMediaProvider },
```

- [ ] **Step 4: Run** — `npx jest src/modules/marketing/ai/providers` → PASS; `npm run build` → compiles.

- [ ] **Step 5: Commit** — `git commit -am "feat(media): route generation per model between fal and Runware"` (add the new file first).

---

### Task 4: MediaGenService — alias at request, provider on the row, vendor cost at finalize

**Files:**
- Modify: `backend/src/modules/marketing/ai/media/media-gen.service.ts:330-334, 418, 549-576`
- Test: `backend/src/modules/marketing/ai/media/media-gen.service.request.spec.ts`, `media-gen.service.finalize.spec.ts`

**Interfaces:**
- Consumes: `resolveMediaModelId`, `estimateVendorUsd`, `MediaVendor` (Task 1); `MediaGenResult.costUsd`, `resolveName?` (Task 2).
- Produces: `mediaSpend.settle(ws, { assetId, credits, vendor, vendorUsd })` call shape (Task 5 implements it).

- [ ] **Step 1: Failing tests** — add to `media-gen.service.request.spec.ts`:

```ts
import { RETIRED_SEEDANCE_LITE_MODEL, DEFAULT_VIDEO_MODEL } from './media-models.config';

it('runs a fal-retired model on its successor and records which vendor took it', async () => {
  const { svc, prisma, provider } = makeSvc();
  provider.resolveName = jest.fn().mockReturnValue('runware');
  await svc.requestGeneration(WS, { type: 'VIDEO', model: RETIRED_SEEDANCE_LITE_MODEL, prompt: 'x', createdById: 'u1' });
  const data = prisma.generatedAsset.create.mock.calls[0][0].data;
  expect(data.model).toBe(DEFAULT_VIDEO_MODEL);
  expect(data.provider).toBe('runware');
  expect(provider.submit).toHaveBeenCalledWith(expect.objectContaining({ model: DEFAULT_VIDEO_MODEL }));
});

it('falls back to provider.name when the provider cannot name a vendor per model', async () => {
  const { svc, prisma } = makeSvc();
  await svc.requestGeneration(WS, { type: 'IMAGE', prompt: 'x', createdById: 'u1' });
  expect(prisma.generatedAsset.create.mock.calls[0][0].data.provider).toBe('fal');
});
```

and to `media-gen.service.finalize.spec.ts` (read its `makeSvc` first and reuse it; the asset fixture must carry `provider`):

```ts
it('settles a Runware asset at the vendor-reported cost and writes it to costUsd', async () => {
  const { svc, prisma, mediaSpend } = makeSvc({ asset: { ...ASSET, provider: 'runware', model: 'bytedance/seedance-2.5/text-to-video', durationSec: 5, params: { resolution: '720p' }, costCreditsReserved: 240 } });
  await svc.finalizeAsset('asset-1', { status: 'COMPLETED', outputs: [OUTPUT], costUsd: 1.17 });
  const data = prisma.generatedAsset.updateMany.mock.calls[0][0].data;
  expect(Number(data.costUsd)).toBeCloseTo(1.17, 6);
  expect(data.costCredits).toBe(240); // customer meter unchanged
  expect(mediaSpend.settle).toHaveBeenCalledWith(WS, expect.objectContaining({ assetId: 'asset-1', credits: 240, vendor: 'runware', vendorUsd: 1.17 }));
});

it('estimates the Runware cost from the catalogue binding when the vendor reported none', async () => {
  const { svc, mediaSpend } = makeSvc({ asset: { ...ASSET, provider: 'runware', model: 'fal-ai/qwen-image', costCreditsReserved: 2 } });
  await svc.finalizeAsset('asset-1', { status: 'COMPLETED', outputs: [OUTPUT] });
  expect(mediaSpend.settle).toHaveBeenCalledWith(WS, expect.objectContaining({ vendor: 'runware', vendorUsd: expect.closeTo(0.0058, 6) }));
});

it('settles a fal asset under vendor fal at the catalogue figure', async () => {
  const { svc, mediaSpend } = makeSvc({ asset: { ...ASSET, provider: 'fal', model: 'fal-ai/qwen-image', costCreditsReserved: 2 } });
  await svc.finalizeAsset('asset-1', { status: 'COMPLETED', outputs: [OUTPUT] });
  expect(mediaSpend.settle).toHaveBeenCalledWith(WS, expect.objectContaining({ vendor: 'fal', vendorUsd: expect.closeTo(0.02, 6) }));
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** in `media-gen.service.ts`:

Imports: add `resolveMediaModelId, estimateVendorUsd, MediaVendor` to the config import.

Request (replace `const model = dto.model ?? (await this.workspaceDefaultModel(...))`):

```ts
    const requested = dto.model ?? (await this.workspaceDefaultModel(workspaceId, dto.type));
    // A fal-retired id (stored default, campaign override, or a regenerate of an
    // old row) runs on its successor. The row records the successor, so history
    // and regenerate converge on the live model; the log line is the only trace.
    const model = resolveMediaModelId(requested);
    if (model !== requested) {
      this.logger.warn(`${requested} was retired by its provider; generating on ${model} instead (workspace ${workspaceId})`);
    }
```

Create: `provider: this.provider.resolveName?.(model) ?? this.provider.name,`

Finalize (inside the `COMPLETED` branch, after `const actual = estimateMediaCredits(asset.model, trueUp);`):

```ts
      // What the generation cost US, at the vendor that actually rendered it.
      // Runware reports its own figure per task; fal never does, so the
      // catalogue's fal rate stands there. The credit meter above is untouched
      // by this: the customer's price is the catalogue's, whichever vendor ran.
      const vendor: MediaVendor = asset.provider === 'runware' ? 'runware' : 'fal';
      const vendorUsd = result.costUsd ?? estimateVendorUsd(asset.model, trueUp, vendor);
```

add `costUsd: new Prisma.Decimal(vendorUsd),` to the `updateMany` data; replace `const actualUsd = estimateMediaUsd(asset.model, trueUp); await this.reconcileEngineWallet(..., actualUsd);` with `await this.reconcileEngineWallet(asset.workspaceId, assetId, asset.params, vendorUsd);` and the settle call with `await this.mediaSpend.settle(asset.workspaceId, { assetId, credits: actual, vendor, vendorUsd });`. Remove the now-unused `estimateMediaUsd` import if nothing else uses it (it is still used at request time — keep).

- [ ] **Step 4: Run** — `npx jest src/modules/marketing/ai/media` → PASS (fix any fixture in `finalize.spec` that lacked `provider`).

- [ ] **Step 5: Commit** — `git commit -am "feat(media): resolve retired ids at request, record the vendor on the row, settle finalize at vendor cost"`

---

### Task 5: Vendor-cost settlement — `RUNWARE_CENT`

**Files:**
- Modify: `backend/src/modules/marketing/budget/media-spend.service.ts`, `backend/src/modules/marketing/wallet/channel-tariff.service.ts:6-15`, `backend/src/modules/marketing/wallet/vendor-spend-report.service.ts:27`
- Create: `backend/prisma/migrations/20260904120000_seed_runware_cent_tariff/migration.sql`, `.../down.sql`
- Test: `backend/src/modules/marketing/budget/media-spend.service.spec.ts`

- [ ] **Step 1: Failing test** — add to `media-spend.service.spec.ts` (mirror its existing `makeSvc`):

```ts
it('settles a Runware asset in USD cents under RUNWARE_CENT, not in fal credits', async () => {
  const { svc, tariffs, ledger } = makeSvc();
  tariffs.price.mockResolvedValue({ amount: new Prisma.Decimal('46.80'), unitCost: new Prisma.Decimal('0.4'), currency: 'TRY', tariffId: 't2', quantity: new Prisma.Decimal(117) });
  await svc.settle('ws-1', { assetId: 'a-2', credits: 240, vendor: 'runware', vendorUsd: 1.1652 });
  expect(tariffs.price).toHaveBeenCalledWith('ws-1', 'CONTENT', 'RUNWARE_CENT', 117);
  expect(ledger.debitOnce).toHaveBeenCalledWith('ws-1', expect.objectContaining({ ref: 'mediagen:a-2', quantity: 117 }));
});

it('still settles fal assets in credits when no vendor is named', async () => {
  const { svc, tariffs } = makeSvc();
  await svc.settle('ws-1', { assetId: 'a-3', credits: 3 });
  expect(tariffs.price).toHaveBeenCalledWith('ws-1', 'CONTENT', 'FAL_CREDIT', 3);
});
```

- [ ] **Step 2: Run** → FAIL (`RUNWARE_CENT` not a `TariffUnitType`).

- [ ] **Step 3: Implement**

`channel-tariff.service.ts`: add `| 'RUNWARE_CENT'` to the union.

`vendor-spend-report.service.ts` `VENDOR_UNITS`: after the fal row add
`{ channel: 'CONTENT', unitType: 'RUNWARE_CENT', vendor: 'Runware', what: 'Görsel/video üretimi (USD cent)' },`.

`media-spend.service.ts`:

```ts
  async settle(
    workspaceId: string,
    opts: { assetId: string; credits: number; budgetId?: string | null; vendor?: 'fal' | 'runware'; vendorUsd?: number },
  ): Promise<{ amount: Prisma.Decimal; quantity: number } | null> {
    // fal is metered in the catalogue's credits (1 ≈ $0.01); Runware reports its
    // own USD per task, so it is metered in cents of that figure under its own
    // tariff row. Same currency assumption on both rows, two vendors on the report.
    const runware = opts.vendor === 'runware';
    const unitType = runware ? 'RUNWARE_CENT' : 'FAL_CREDIT';
    const qty = runware
      ? Math.max(0, Math.round((opts.vendorUsd ?? 0) * 100))
      : Math.max(0, Math.round(opts.credits ?? 0));
    if (qty === 0) return null;
    try {
      const priced = await this.tariffs.price(workspaceId, 'CONTENT', unitType, qty);
      if (!priced) {
        this.unpriced.warn(workspaceId, unitType, `no CONTENT tariff for ${unitType} (ws ${workspaceId}, ${qty} units)`);
        return null;
      }
      // ...debitOnce unchanged, quantity: qty
```

Migration `migration.sql`:

```sql
-- Give Runware media generation a price so the second media vendor lands in the
-- spend ledger beside fal. Runware reports its own USD cost per task, so the
-- unit is a US CENT of that figure — not a catalogue credit — and the rate is the
-- same ~40 TRY/USD assumption the FAL_CREDIT row carries (0.40 TRY per cent).
-- Platform default (workspaceId NULL); guarded so a re-run cannot overwrite a
-- rate set in the panel. country NULL: Runware bills in USD everywhere.
INSERT INTO "channel_tariffs" ("id", "workspaceId", "channel", "provider", "unitType", "unitCost", "currency", "country", "effectiveFrom", "active", "createdAt", "updatedAt")
SELECT gen_random_uuid(), NULL, 'CONTENT', 'runware', 'RUNWARE_CENT', 0.4000, 'TRY', NULL, now(), true, now(), now()
WHERE NOT EXISTS (
  SELECT 1 FROM "channel_tariffs"
  WHERE "workspaceId" IS NULL AND "channel" = 'CONTENT' AND "unitType" = 'RUNWARE_CENT'
);
```

`down.sql`:

```sql
-- Reverts the platform RUNWARE_CENT seed only. Workspace overrides (workspaceId
-- NOT NULL) are operator data and are left alone. No-op if already gone.
DELETE FROM "channel_tariffs"
WHERE "workspaceId" IS NULL AND "channel" = 'CONTENT' AND "unitType" = 'RUNWARE_CENT' AND "provider" = 'runware';
```

- [ ] **Step 4: Round-trip the migration** on the local postgres (container `postgres`, user `tarik`):

```bash
docker exec postgres psql -U tarik -d default_db -c 'CREATE DATABASE kds_migtest;'
DATABASE_URL='postgresql://tarik:<pw>@localhost:5432/kds_migtest?schema=public' npx prisma migrate deploy
docker exec postgres psql -U tarik -d kds_migtest -tAc "select count(*) from channel_tariffs where \"unitType\"='RUNWARE_CENT'"   # 1
docker exec -i postgres psql -U tarik -d kds_migtest < prisma/migrations/20260904120000_seed_runware_cent_tariff/down.sql
docker exec postgres psql -U tarik -d kds_migtest -tAc "select count(*) from channel_tariffs where \"unitType\"='RUNWARE_CENT'"   # 0
docker exec -i postgres psql -U tarik -d kds_migtest < prisma/migrations/20260904120000_seed_runware_cent_tariff/migration.sql     # 1 again
docker exec postgres psql -U tarik -d default_db -c 'DROP DATABASE kds_migtest;'
```

(The password comes from `docker exec postgres env | grep POSTGRES_PASSWORD`.)

- [ ] **Step 5: Run** — `npx jest src/modules/marketing/budget src/modules/marketing/wallet` → PASS (update any spec that pins the `VENDOR_UNITS` length).

- [ ] **Step 6: Commit** — `git add -A backend/prisma/migrations/20260904120000_seed_runware_cent_tariff backend/src/modules/marketing/budget backend/src/modules/marketing/wallet && git commit -m "feat(spend): meter Runware generation cost under a RUNWARE_CENT tariff"`

---

### Task 6: Defaults projection + neighbour-model test migration

**Files:**
- Modify: `backend/src/modules/marketing/ai/media/media-model-defaults.service.ts:20-30, 140-155`
- Modify tests that use `'fal-ai/veo3/fast'` as a live neighbour: `media-model-defaults.service.spec.ts`, `media-gen.service.model-resolution.spec.ts`, `media-gen.service.engine.spec.ts`, `mcp/tools/content.tools.spec.ts`, `controllers/marketing-workspaces.controller.spec.ts`, `social-campaigns/social-campaigns.service.spec.ts`, `test/e2e/media-model-defaults.realdb.e2e-spec.ts`

- [ ] **Step 1: Failing test** — add to `media-model-defaults.service.spec.ts`:

```ts
import { RETIRED_SEEDANCE_LITE_MODEL } from './media-models.config';

it('reports a fal-retired stored choice as its successor: it still runs, under the new id', async () => {
  const { svc } = makeSvc({ defaultImageModel: null, defaultVideoModel: RETIRED_SEEDANCE_LITE_MODEL });
  const res = await svc.get(WS);
  expect(res.defaultVideoModel).toBe(DEFAULT_VIDEO_MODEL);
  expect(res.effectiveVideoModel).toBe(DEFAULT_VIDEO_MODEL);
  expect(res.retiredVideoModel).toBeNull();
  expect(res.models.map((m) => m.id)).not.toContain(RETIRED_SEEDANCE_LITE_MODEL);
});

it('refuses to store a fal-retired id and names the successor', async () => {
  const { svc } = makeSvc();
  await expect(svc.set(WS, { defaultVideoModel: 'fal-ai/veo3/fast' })).rejects.toThrow(/retired.*veo3\.1\/fast/);
});
```

- [ ] **Step 2: Implement** in `project()`:

```ts
  private project(imageStored: string | null, videoStored: string | null): MediaModelDefaults {
    // A choice fal has retired is honoured under its successor's id — reported
    // as that id too, so the card selects the row that actually runs.
    const image = imageStored === null ? null : resolveMediaModelId(imageStored);
    const video = videoStored === null ? null : resolveMediaModelId(videoStored);
    const platform = new Set([defaultModelFor('IMAGE'), defaultModelFor('VIDEO')]);
    const imageLive = image !== null && isCataloguedModel(image, 'IMAGE');
    const videoLive = video !== null && isCataloguedModel(video, 'VIDEO');
    return {
      defaultImageModel: image,
      defaultVideoModel: video,
      effectiveImageModel: imageLive ? (image as string) : defaultModelFor('IMAGE'),
      effectiveVideoModel: videoLive ? (video as string) : defaultModelFor('VIDEO'),
      retiredImageModel: image !== null && !imageLive ? image : null,
      retiredVideoModel: video !== null && !videoLive ? video : null,
      models: Object.values(MEDIA_MODELS)
        .filter((m) => !m.replacedBy)
        .map((m) => ({ ...m, isPlatformDefault: platform.has(m.id) })),
    };
  }
```

and update the `defaultImageModel`/`defaultVideoModel` doc comment: "verbatim, except that an id fal has retired is reported as its successor".

- [ ] **Step 3: Migrate the neighbour model in the listed specs** — replace every `'fal-ai/veo3/fast'` used as a *choosable* model with `'fal-ai/veo3.1/fast'`. In `media-gen.service.engine.spec.ts` the wallet arithmetic comments read `$0.25/sec`; Veo 3.1 Fast is `$0.15/sec` — recompute the expected USD in those assertions (5 s → 0.75, 8 s → 1.20). In `social-campaigns.service.spec.ts:217` the fixture stores the Lite id as an *image* default — leave it (it tests the wrong-kind refusal). In the realdb e2e set `NEIGHBOUR_VIDEO_MODEL = 'fal-ai/veo3.1/fast'`.

- [ ] **Step 4: Run** — `npx jest src/modules/marketing` → PASS; `npm run typecheck:e2e` → PASS.

- [ ] **Step 5: Commit** — `git commit -am "feat(media): alias-transparent model defaults; tests move off the retired Veo 3 Fast id"`

---

### Task 7: Environment, deploy, docs, full verification

**Files:**
- Modify: `.github/workflows/deploy.yml:182-187, 313-315`, `backend/.env.example`

- [ ] **Step 1: deploy.yml** — after the `FAL_WEBHOOK_SECRET` secret line add

```yaml
          # Runware — second media vendor for the catalogue models that carry a
          # `runware` binding (Seedance 2.5, Seedance 1.0 Pro Fast, Qwen-Image,
          # BiRefNet). OPTIONAL — unset = every model stays on fal.
          RUNWARE_API_KEY: ${{ secrets.RUNWARE_API_KEY }}
```

and after the `FAL_WEBHOOK_SECRET=${FAL_WEBHOOK_SECRET}` .env line add

```
          # Runware media vendor (per-model routing); empty = all on fal.
          RUNWARE_API_KEY=${RUNWARE_API_KEY}
```

- [ ] **Step 2: `.env.example`** — next to `FAL_KEY` (add a FAL block if absent):

```
# Runware — second media-generation vendor, per-model routing. Empty = all on fal.
RUNWARE_API_KEY=
RUNWARE_TIMEOUT_MS=30000
```

- [ ] **Step 3: Full verification** from `backend/`: `npm run lint && npm test && npm run build && npm run typecheck:e2e`. From `frontend/`: `npm test -- --run src/pages/marketing/settings/aiModels` (mocked API; must still pass).

- [ ] **Step 4: Commit** — `git commit -am "ci(deploy): pass RUNWARE_API_KEY through to the marketing stack"`

---

### Task 8: Ship

- [ ] **Step 1:** push the branch, open the PR (plain description, no AI footer), wait for CI green.
- [ ] **Step 2:** merge to `main`; the release deploy runs on the tag push per `deploy.yml` (see memory `production-deploy`).
- [ ] **Step 3:** after deploy, `GET /api/marketing/ai/media/models` must list `fal-ai/bytedance/seedance/v1/pro/fast/text-to-video` and neither retired id.
- [ ] **Step 4:** hand-off note to the user: add the `RUNWARE_API_KEY` GitHub secret and redeploy to switch the five models over; first Seedance 2.5 generation afterwards should show `provider = runware`, a `costUsd` near $0.23 × seconds, and a Runware row on the vendor spend report.

---

## Self-review

- Spec coverage: §2.1 bindings → T1/T2; §2.3 credits untouched → T1 test + T4; §3.1 router/prefix/resolveName → T3/T4; §3.2 provider/async/BLOCKED → T2; §3.3 aliases/default/menu/write-gate → T1/T6; §3.4 ledger/tariff/migration → T5; §3.5 env/deploy → T7; §4 no fallback → T3; §6 rollout → T8.
- Placeholders: none; every step carries code or an exact command.
- Type consistency: `RunwareBinding.model` (T1) is what `buildRunwareTask` keys `RUNWARE_RECIPES` on (T2); `resolveName` (T2 interface, T3 impl, T4 caller); `settle` shape (T4 caller, T5 impl); `costUsd` (T2 result, T4 consumer).
