# Storyboard-first Production Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every newly planned concept is produced from a storyboard: one keyframe still per beat, then each beat animated from its keyframe (image-to-video), with frames requestable and regenerable before approval and generated automatically at production otherwise.

**Architecture:** The catalogue gains the cheap image-to-video endpoint and an `animateModelFor` mapping; the shot plan carries `description`, `keyframePrompt`, per-shot `keyframe` and a plan-level `storyboard` block; the quote prices frames + animation; a `StoryboardService` (+ `content.concept.storyboard` job) generates and syncs frames; `produce` becomes two-phase (frames READY → animate with the keyframe as first frame). Hub renders frames and offers storyboard/regenerate; MCP gets `jeeta.storyboard_content_concept`.

**Tech Stack:** NestJS 11, Prisma (JSONB plan, no migration), Jest, React + react-query + vitest, Playwright e2e in CI.

**Spec:** `docs/superpowers/specs/2026-09-06-storyboard-first-production-design.md`

## Global Constraints

- Legacy plans (no `plan.storyboard`) keep today's text-to-video path unchanged.
- Keyframe asset ids never enter `SocialCampaignItem.generatedAssetIds`.
- Money on the plan before approval: `production.keyframes` + animate model quoted at planning; `assertQuoteHolds` compares both.
- No fallback from a failed frame to text-to-video; fail by beat number.
- Commits: plain conventional messages, no AI trailers. Tests from `backend/`: `npx jest <path>`; frontend from `frontend/`: `npx vitest run <path>`.

---

## File map

| File | Responsibility |
|---|---|
| `backend/src/modules/marketing/ai/media/media-models.config.ts` | i2v entry, `DEFAULT_VIDEO_ANIMATE_MODEL`, `DEFAULT_KEYFRAME_MODEL`, `DEFAULT_KEYFRAME_REFERENCE_MODEL`, `animateSibling`, `mediaModelAcceptsFirstImage`, `animateModelFor` |
| `backend/src/modules/marketing/video/video-pipeline.service.ts` | `Shot.description/keyframePrompt/keyframe`, `ShotPlan.storyboard`, `ShotProduction.keyframes`, `buildKeyframePrompt`, `planShots` writes them |
| `backend/src/modules/marketing/content-concepts/shot-production.ts` | quote with keyframes |
| `backend/src/modules/marketing/content-concepts/concept-promotion.service.ts` | `resolveVideoModel({storyboard})`, `assertQuoteHolds`, two-phase `produce` |
| `backend/src/modules/marketing/content-concepts/storyboard.service.ts` (new) | request / regenerate / job run / sync |
| `backend/src/modules/marketing/content-concepts/content-concepts.service.ts` | planning passes `storyboard: true`, sets `plan.storyboard` |
| `backend/src/modules/marketing/controllers/marketing-content-line.controller.ts` | two POST routes |
| `backend/src/modules/marketing/mcp/tools/content-concepts.tools.ts` | `jeeta.storyboard_content_concept`, description updates |
| `backend/src/modules/marketing/marketing.module.ts` | provider + tool deps |
| `frontend/src/features/marketing/api/contentLine.service.ts`, `frontend/src/pages/marketing/studio/BatchDetail.tsx`, i18n tr/en | frames strip + actions |

---

### Task 1: Catalogue — image-to-video default, siblings, helpers

**Files:** modify `media-models.config.ts`; test `media-models.config.spec.ts`, `runware.provider.contract.spec.ts`.

**Produces:** `DEFAULT_VIDEO_ANIMATE_MODEL = 'fal-ai/bytedance/seedance/v1/pro/fast/image-to-video'`, `DEFAULT_KEYFRAME_MODEL = DEFAULT_IMAGE_MODEL`, `DEFAULT_KEYFRAME_REFERENCE_MODEL = 'fal-ai/nano-banana-pro/edit'`, `MediaModel.animateSibling?: string`, `mediaModelAcceptsFirstImage(id): boolean`, `animateModelFor(id): string`.

- [ ] Tests (append to `media-models.config.spec.ts`):

```ts
describe('storyboard animation', () => {
  it('serves the Pro Fast image-to-video endpoint at the text-to-video price, pinned to 720p', () => {
    const m = MEDIA_MODELS[DEFAULT_VIDEO_ANIMATE_MODEL];
    expect(m.technique).toBe('VIDEO_ANIMATE');
    expect(m.creditsPerSec).toBe(3);
    expect(m.contract.resolution?.default).toBe('720p');
    expect(m.contract.duration?.encoding).toBe('digitStringSeconds');
    expect(m.contract.sources).toEqual([{ slot: 'firstImage', param: 'image_url', arity: 'single', required: true }]);
    expect(m.contract.aspect?.values['9:16']).toBe('9:16');
    expect(m.runware?.model).toBe('bytedance:2@2');
    expect(buildFalInput({ type: 'VIDEO', model: DEFAULT_VIDEO_ANIMATE_MODEL, prompt: 'x', durationSec: 5, aspectRatio: '9:16', sources: { images: ['https://cdn/k.png'] } }))
      .toMatchObject({ image_url: 'https://cdn/k.png', resolution: '720p', duration: '5', aspect_ratio: '9:16' });
  });

  it('maps a text-to-video choice to the model that animates a keyframe', () => {
    expect(mediaModelAcceptsFirstImage(DEFAULT_VIDEO_ANIMATE_MODEL)).toBe(true);
    expect(mediaModelAcceptsFirstImage(DEFAULT_VIDEO_MODEL)).toBe(false);
    expect(animateModelFor(DEFAULT_VIDEO_MODEL)).toBe(DEFAULT_VIDEO_ANIMATE_MODEL);
    expect(animateModelFor('bytedance/seedance-2.5/text-to-video')).toBe('bytedance/seedance-2.5/image-to-video');
    expect(animateModelFor('fal-ai/veo3.1')).toBe('fal-ai/veo3.1/image-to-video');
    expect(animateModelFor('fal-ai/veo3.1/fast')).toBe(DEFAULT_VIDEO_ANIMATE_MODEL);
    expect(animateModelFor('bytedance/seedance-2.5/image-to-video')).toBe('bytedance/seedance-2.5/image-to-video');
    expect(animateModelFor(RETIRED_SEEDANCE_LITE_MODEL)).toBe(DEFAULT_VIDEO_ANIMATE_MODEL);
  });
});
```

Runware contract spec: `build({ model: DEFAULT_VIDEO_ANIMATE_MODEL, resolution: '720p', durationSec: 5, sources: { images: ['https://cdn/k.png'] } })` → `inputs.frameImages: [{image, frame:'first'}]`, `resolution: '720p'`, no width/height.

- [ ] Implement: entry after `[DEFAULT_VIDEO_MODEL]` block:

```ts
  [DEFAULT_VIDEO_ANIMATE_MODEL]: {
    id: DEFAULT_VIDEO_ANIMATE_MODEL,
    technique: 'VIDEO_ANIMATE', type: 'VIDEO', label: 'Short video from a keyframe',
    pricePerSecUsd: 0.0216, creditsPerSec: 3, tiers: SEEDANCE_1_FAST_TIERS,
    runware: { model: 'bytedance:2@2', pricePerSecUsd: 0.01336, tiers: { '480p': { pricePerSecUsd: 0.00629 }, '1080p': { pricePerSecUsd: 0.03177 } } },
    note: 'The storyboard animator: the same $1/M-token Pro Fast family as the platform default, so animating a keyframe costs what a text-to-video beat did. DEFAULTS TO 1080p on fal, so resolution is always sent. fal also offers aspect_ratio "auto"; the plan\'s own ratio is sent instead.',
    contract: {
      promptParam: 'prompt', negativePrompt: false, seedInput: true,
      duration: SEEDANCE_1_FAST_DURATION, resolution: SEEDANCE_1_FAST_RESOLUTION, aspect: SEEDANCE_1_FAST_ASPECT,
      sources: [{ slot: 'firstImage', param: 'image_url', arity: 'single', required: true }],
    },
  },
```

Constants near `DEFAULT_VIDEO_REFERENCE_MODEL`; `animateSibling: 'bytedance/seedance-2.5/image-to-video'` on the 2.5 t2v entry, `animateSibling: 'fal-ai/veo3.1/image-to-video'` on `fal-ai/veo3.1`; helpers:

```ts
export function mediaModelAcceptsFirstImage(id: string): boolean {
  return Boolean(MEDIA_MODELS[resolveMediaModelId(id)]?.contract.sources?.some((s) => s.slot === 'firstImage'));
}
/** The endpoint that animates a keyframe for a plan whose chosen model is `id`: itself when it already takes a first frame, its own family's image-to-video sibling when it names one, else the platform animator. */
export function animateModelFor(id: string): string {
  const live = resolveMediaModelId(id);
  if (mediaModelAcceptsFirstImage(live)) return live;
  const sibling = MEDIA_MODELS[live]?.animateSibling;
  return sibling && MEDIA_MODELS[sibling] ? sibling : DEFAULT_VIDEO_ANIMATE_MODEL;
}
```

Also update the controller spec count (25 → 26 served) and `listMediaModels('VIDEO_ANIMATE')` expectations if pinned.

- [ ] Commit: `feat(media): storyboard animator — Pro Fast image-to-video at the text-to-video price`

---

### Task 2: Plan shape and keyframe prompts

**Files:** `video-pipeline.service.ts`; test `video-pipeline.service.spec.ts` (create if absent).

**Produces:** `Shot.description?`, `Shot.keyframePrompt?`, `Shot.keyframe?: Keyframe`, `Keyframe` type, `ShotPlan.storyboard?: { imageModel: string; seed: number; requestedAt?: string; requestedById?: string }`, `ShotProduction.keyframes?: { model: string; perFrameCredits: number; credits: number; usd: number }`, `modelSource` adds `'storyboard'`, `VideoPipelineService.buildKeyframePrompt(sceneDesc, cameraNote, persona, aspectRatio)`, `planShots(..., opts?: { storyboard?: { imageModel: string; seed: number } })`.

- [ ] Tests:

```ts
it('writes the raw description, a still-frame prompt without motion or audio, and the storyboard seed', () => {
  const plan = svc.planShots({ product: 'X', hook: 'H' }, 'seedance', undefined,
    [{ scene: '0-2s', cameraNote: 'wide', voiceover: '', description: 'a strandbeest on a beach', durationSec: 2 }],
    '9:16', { storyboard: { imageModel: 'fal-ai/bytedance/seedream/v4/text-to-image', seed: 42 } });
  expect(plan.storyboard).toEqual({ imageModel: 'fal-ai/bytedance/seedream/v4/text-to-image', seed: 42 });
  expect(plan.shots[0].description).toBe('a strandbeest on a beach');
  expect(plan.shots[0].keyframePrompt).toMatch(/^a strandbeest on a beach, wide, single still frame, vertical 9:16/);
  expect(plan.shots[0].keyframePrompt).not.toMatch(/audio|reference-to-video|motion/);
  expect(plan.shots[0].prompt).toMatch(/native synchronized audio/); // the animation prompt is unchanged
});
it('puts the persona identity clause on the keyframe prompt too', () => { ... expect(keyframePrompt).toMatch(/^consistent identity/) });
it('leaves legacy callers (no storyboard option) without keyframe fields', () => { expect(plan.storyboard).toBeUndefined(); expect(plan.shots[0].keyframePrompt).toBeUndefined(); });
```

- [ ] Implement `buildKeyframePrompt`:

```ts
  buildKeyframePrompt(sceneDesc: string, cameraNote: string, persona?: PersonaLock, aspectRatio: ShotAspectRatio = DEFAULT_SHOT_ASPECT): string {
    const identity = persona ? `consistent identity (same face, hair, outfit as reference), ` : '';
    const camera = cameraNote.trim() ? `, ${cameraNote.trim()}` : '';
    return `${identity}${sceneDesc}${camera}, single still frame, ${aspectOrientation(aspectRatio)} ${aspectRatio}, photorealistic, sharp focus, cinematic lighting`;
  }
```

In `planShots`, when `opts?.storyboard` and the scene is a `ConceptScene`: `shot.description = desc; shot.keyframePrompt = this.buildKeyframePrompt(desc, cameraNote, persona, aspectRatio)`; return `storyboard: opts.storyboard` on the plan.

- [ ] Commit: `feat(video): shot plans carry a keyframe prompt and a storyboard seed`

---

### Task 3: Quote and model resolution for storyboards

**Files:** `shot-production.ts`, `concept-promotion.service.ts` (`resolveVideoModel`, `assertQuoteHolds`), `content-concepts.service.ts` (`run`/`finalize`); tests `shot-production.spec.ts` (create), `concept-promotion.service.spec.ts`, `content-concepts.service.spec.ts`.

**Produces:** `VideoModelChoice.keyframeModel?: string`; `resolveVideoModel(ws, campaignModel, opts: { wantsReference: boolean; storyboard: boolean })` (old boolean third arg still accepted = `{ wantsReference }`); `quoteProduction(plan, choice)` adds `keyframes` when `plan.storyboard` (frame model = `choice.keyframeModel ?? plan.storyboard.imageModel`); planning: `storyboard: true`, `imageModel = persona ? DEFAULT_KEYFRAME_REFERENCE_MODEL : DEFAULT_KEYFRAME_MODEL`, `seed = persona?.lockedSeed ?? randomInt(1, 2**31-1)`.

- [ ] Tests:

```ts
// shot-production.spec.ts
it('quotes frames and animation per beat for a storyboarded plan', () => {
  const plan = { ...PLAN, storyboard: { imageModel: DEFAULT_KEYFRAME_MODEL, seed: 7 } };
  const q = quoteProduction(plan, { model: DEFAULT_VIDEO_ANIMATE_MODEL, modelSource: 'storyboard', replacedModel: DEFAULT_VIDEO_MODEL });
  expect(q.keyframes).toEqual({ model: DEFAULT_KEYFRAME_MODEL, perFrameCredits: 3, credits: 9, usd: expect.closeTo(0.09, 6) });
  expect(q.credits).toBe(9 + 3 * 9); // 3 frames + 9 billed seconds at 3/s
});
// resolveVideoModel
it('animates on the sibling of a premium choice and on the platform animator otherwise', async () => {
  expect(await svc.resolveVideoModel(WS, 'bytedance/seedance-2.5/text-to-video', { wantsReference: false, storyboard: true }))
    .toEqual({ model: 'bytedance/seedance-2.5/image-to-video', modelSource: 'storyboard', replacedModel: 'bytedance/seedance-2.5/text-to-video', keyframeModel: DEFAULT_KEYFRAME_MODEL });
  expect(await svc.resolveVideoModel(WS, null, { wantsReference: true, storyboard: true }))
    .toEqual({ model: DEFAULT_VIDEO_ANIMATE_MODEL, modelSource: 'storyboard', replacedModel: DEFAULT_VIDEO_MODEL, keyframeModel: DEFAULT_KEYFRAME_REFERENCE_MODEL });
  // legacy behaviour untouched
  expect(await svc.resolveVideoModel(WS, null, { wantsReference: true, storyboard: false })).toMatchObject({ model: DEFAULT_VIDEO_REFERENCE_MODEL, modelSource: 'persona' });
});
```

`assertQuoteHolds`: pass `{ wantsReference, storyboard: Boolean(plan.storyboard) }` and refuse when `choice.model !== quoted.model || (quoted.keyframes && choice.keyframeModel !== quoted.keyframes.model)`.

- [ ] Commit: `feat(content): quote keyframes and the animator before approval`

---

### Task 4: StoryboardService + job + two-phase produce

**Files:** new `storyboard.service.ts` (+ spec), `concept-promotion.service.ts` produce, `marketing.module.ts`.

**Produces:** `CONCEPT_STORYBOARD_KIND = 'content.concept.storyboard'`, `storyboardDedup(conceptId)`, `STORYBOARD_WAIT_MS` (30 s), `MAX_FRAME_ATTEMPTS = 2`; class `StoryboardService { request(ws, conceptId, requestedById); regenerateFrame(ws, conceptId, ord, requestedById); run(conceptId, ws, waits); submitMissingFrames(ws, concept, plan, linkage): Promise<{ plan; queued: number; queueFull: boolean }>; syncFrames(ws, concept, plan): Promise<{ plan; pending: number; failed: Array<{ord, keyframe}> }>; supportsStoryboard(plan): boolean }`.

Frame request DTO: `{ type:'IMAGE', model: plan.storyboard.imageModel, prompt: shot.keyframePrompt, aspectRatio: plan.aspectRatio ?? '9:16', seed, referenceImageUrls: mediaModelAcceptsReferenceImages(imageModel) ? shot.reference?.images : undefined, socialCampaignId, campaignItemId?, createdById }` — `resolution: '1K'` for Nano Banana Pro (contract default already '1K').

`produce` (storyboard plans): before the clip loop,
```ts
if (this.storyboard.supportsStoryboard(plan)) {
  const linkage = { socialCampaignId: item.socialCampaignId, campaignItemId: item.id, createdById: item.campaign.createdById };
  const sub = await this.storyboard.submitMissingFrames(workspaceId, concept.id, plan, linkage);
  const sync = await this.storyboard.syncFrames(workspaceId, concept.id, sub.plan);
  if (sync.failed.length) { await this.fail(itemId, `frame ${sync.failed[0].ord + 1}/${shots.length} could not be generated: ${sync.failed[0].keyframe.error ?? 'unknown'}`); return; }
  if (sub.queueFull || sync.pending > 0) return waitOrFail(STORYBOARD_WAIT_MS, 'frames');
  plan = sync.plan; // every keyframe READY with a url
}
```
and in the clip loop for storyboard plans: `referenceImageUrls: [shots[i].keyframe.url]`, `seed: plan.storyboard.seed` when `mediaModelTakesSeed(model)`, no persona refs.

- [ ] Tests (storyboard.service.spec.ts): submits one IMAGE per frameless shot with the keyframe prompt, seed and linkage; stops at queue-full and reports it; sync maps READY→url, FAILED→retry once then failed; regenerateFrame clears one keyframe and bumps the seed; request refuses legacy plan and DISCARDED concept. Produce spec: frames pending → reschedule; failed frame → item FAILED by beat; all READY → animate with `referenceImageUrls: [url]` and `model` = animate model; `generatedAssetIds` has only clip ids; legacy plan → old path (no IMAGE requests).

- [ ] Commit: `feat(content): storyboard frames before clips — request, regenerate, sync, two-phase production`

---

### Task 5: REST + MCP

- Controller: `POST concepts/:id/storyboard` (audit `content.line.storyboard`), `POST concepts/:id/storyboard/:ord/regenerate` (audit `content.line.storyboard.regenerate`), both `campaigns.write`, return `concepts.list(ws, { conceptId })`'s single row (add `conceptId` filter to `list`).
- MCP `jeeta.storyboard_content_concept` `{ conceptId, regenerateShot?: number }` WRITE, deferred, `campaigns.write`; description text; update plan/submit/review/list descriptions (frames + animation, quote includes frames, approval buys frames if missing).
- Module: `StoryboardService` provider; tools deps `storyboard`.
- Tests: controller spec (routes call the service), tools spec (registers, forwards, refuses unknown regenerateShot).
- Commit: `feat(content): storyboard endpoints and MCP tool`

---

### Task 6: Hub — frames in BatchDetail

- `contentLine.service.ts`: types `Keyframe`, `Shot`, `ShotProduction`, `ShotPlan`, `ConceptRow` (id, angle, hook, title, rationale, status, selectionReason, shotPlan, promotedItemId); `getBatch(): Promise<ConceptRow[]>`; `requestStoryboard(conceptId)`, `regenerateKeyframe(conceptId, ord)`.
- `BatchDetail.tsx`: per concept — quote line (`production.credits` credits · `production.model` · frames model), beats strip (`shots.map`: keyframe `<img>` when READY, spinner when QUEUED/GENERATING, warning when FAILED/BLOCKED, placeholder when none; caption `scene · durationSec s`, `onScreenText`), buttons "Storyboard oluştur" (when `!shots.some(keyframe)` and status PROPOSED/APPROVED-without-item) and per-frame "Yeniden üret"; `refetchInterval: 10_000` while any keyframe pending; mutations invalidate `['marketing','content-line','batch',batchId]`.
- i18n tr + en: `contentLine.detail.quote`, `.frames.make`, `.frames.regenerate`, `.frames.pending`, `.frames.failed`, `.frames.none`, `.frames.legacy`.
- Test `BatchDetail.test.tsx`: renders frames, storyboard button calls API, regenerate per frame.
- Commit: `feat(studio): the batch detail shows each concept's storyboard`

---

### Task 7: e2e + full verification

- `test/e2e/concept-promotion.realdb.e2e-spec.ts`: plans now carry storyboard; the produce assertions expect N IMAGE requests then N VIDEO requests with `referenceImageUrls` = frame urls (the harness's fake mediaGen must mark frames READY — see how it stubs `requestGeneration`/assets); keep the legacy-plan test if one exists.
- `npm test`, real-DB e2e for content-concepts/concept-promotion/media, build, frontend vitest for studio, Playwright `ai-models`/studio specs unaffected.
- Commit as needed.

### Task 8: Ship

PR → CI → merge → tag `v2.313.0` (check latest) → deploy → note to user (storyboard shows in the hub; approval buys frames + clips).

## Self-review

Spec §5.1→T1, §5.2→T2, §5.3→T3, §5.4/§5.5→T4, §5.6→T5, §5.7→T6, §7→T7. Types: `Keyframe`, `VideoModelChoice.keyframeModel`, `ShotProduction.keyframes`, `resolveVideoModel` opts object, `StoryboardService` method names as listed are the cross-task contract.
