import { BadRequestException, HttpException } from '@nestjs/common';
import { randomInt } from 'crypto';
import { mediaModelAcceptsReferenceImages, resolveMediaModelId } from '../ai/media/media-models.config';
import type { MediaGenService } from '../ai/media/media-gen.service';
import type { PrismaService } from '../../../prisma/prisma.service';
import {
  DEFAULT_SHOT_ASPECT,
  type Keyframe,
  type Shot,
  type ShotPlan,
  type Storyboard,
} from '../video/video-pipeline.service';

/**
 * THE STORYBOARD'S FRAMES — one still per beat, made before the clips.
 *
 * Pure-ish functions over a plan plus the two services that already exist, so
 * the same code runs from two places without a third copy: `StoryboardService`
 * (a human asked for the frames while the concept is still PROPOSED) and
 * `ConceptPromotionService.produce` (the concept was approved; whatever frames
 * are missing are made now, then animated).
 *
 * HOW THE PLAN IS WRITTEN. Never whole. Every keyframe goes onto the row on its
 * own, through {@link writeKeyframe}: one `jsonb_set` on that beat's path,
 * compare-and-set against the keyframe the writer read. Two consequences, both
 * load-bearing:
 *
 *  - A bought frame is on the row the moment the vendor accepts it, not at the
 *    end of the pass. A crash between two beats loses at most the one in
 *    flight — and not even that, because {@link adoptableFrame} finds it again
 *    off its asset row on the next pass. The clip loop writes its cursor per
 *    clip for the same reason; the frames had to match it.
 *  - Two writers of one plan — the storyboard job syncing beat 3, a reviewer
 *    redrawing beat 1, `produce` taking over — never erase each other's beats,
 *    and the SAME beat is never written from a stale read: the redraw a human
 *    asked for cannot be undone by a job that read the plan a second earlier.
 *
 * The frame's asset id lives ON THE PLAN, never in
 * `SocialCampaignItem.generatedAssetIds`: that array is the beat-ordered list
 * of CLIPS, the producer's resume cursor and the publisher's carousel order, and
 * an image id inside it would shift every beat by one.
 */

export const CONCEPT_STORYBOARD_KIND = 'content.concept.storyboard';
export const storyboardDedup = (conceptId: string) => `content-concept-storyboard-${conceptId}`;

/** How long a job waits between looks at frames that are still rendering. A
 *  still takes tens of seconds, so the producer's two-minute beat-wait would
 *  add minutes to every concept for nothing. */
export const STORYBOARD_WAIT_MS = Number(process.env.CONCEPT_STORYBOARD_WAIT_MS ?? 30_000);

/**
 * How many looks a frame pass gets before it gives up — its OWN counter, never
 * the clip phase's. At {@link STORYBOARD_WAIT_MS} this is about an hour: the
 * same ceiling `produce` gives a full clip queue, and longer than
 * `MEDIA_GEN_MAX_AGE_MS` (1h), the age at which the media sweep reaps an
 * abandoned generation and frees its slot — so a workspace whose four slots are
 * pinned by dead generations always gets to draw its frames once they clear.
 */
export const STORYBOARD_MAX_WAITS = Number(process.env.CONCEPT_STORYBOARD_MAX_WAITS ?? 120);

/** Automatic re-requests of one beat's frame before it fails BY NAME. A vendor
 *  that refuses the same still twice is telling us something about the prompt,
 *  not about the weather; the human gets the reason and a regenerate button —
 *  and a human's renewed intent (regenerate, approve, regenerate the item)
 *  resets the count through {@link resetExhaustedFrames}. */
export const MAX_FRAME_ATTEMPTS = 2;

/** A seed for a frame a human wants drawn AGAIN — genuinely another take. */
export const freshSeed = () => randomInt(1, 2 ** 31 - 1);

export type StoryboardedPlan = ShotPlan & { storyboard: Storyboard };

/** A plan made since storyboards: it carries the frame record and every beat
 *  has a prompt a still can be drawn from. Legacy plans return false and are
 *  produced exactly as before. */
export function supportsStoryboard(plan: ShotPlan | null | undefined): plan is StoryboardedPlan {
  return Boolean(
    plan?.storyboard &&
      Array.isArray(plan.shots) &&
      plan.shots.length > 0 &&
      plan.shots.every((sh) => typeof sh.keyframePrompt === 'string' && sh.keyframePrompt.length > 0),
  );
}

/** A keyframe with no asset behind it: REQUESTED (a human or a reset asked,
 *  nothing bought yet) when QUEUED, or refused before any request landed. */
export const isRequested = (kf: Keyframe | undefined): boolean =>
  Boolean(kf && !kf.assetId && kf.status === 'QUEUED');

/**
 * Does this beat still need a frame requested? One with no frame, one merely
 * requested, or one the vendor refused fewer than {@link MAX_FRAME_ATTEMPTS}
 * times. A frame in flight or READY is not wanted; an exhausted one waits for a
 * human.
 */
export function frameWanted(kf: Keyframe | undefined): boolean {
  if (!kf) return true;
  if (kf.attempts >= MAX_FRAME_ATTEMPTS) return false;
  if (!kf.assetId) return true;
  return kf.status === 'FAILED' || kf.status === 'BLOCKED';
}

/**
 * The seed one beat's frame is drawn with. The FIRST draw uses the seed as
 * given — the plan's shared one, or the fresh one a human's regenerate put on
 * the keyframe. Every automatic re-request nudges it, so a retry is another
 * picture rather than the identical request resubmitted to the same refusal.
 */
export function frameSeed(storyboard: Storyboard, kf: Keyframe | undefined): number {
  const base = kf?.seed ?? storyboard.seed;
  const attempts = kf?.attempts ?? 0;
  return attempts === 0 ? base : (base + attempts * 104729) % 2147483647;
}

/** `MediaGenService` throws this as a BadRequest carrying a `code`. */
export function isQueueFull(e: unknown): boolean {
  if (!(e instanceof HttpException)) return false;
  const body = e.getResponse();
  return typeof body === 'object' && body !== null && (body as { code?: string }).code === 'MEDIA_GEN_TOO_MANY';
}

/**
 * A refusal OF THE REQUEST — the prompt, the ratio, the model, the campaign —
 * as opposed to the weather: a provider outage, a configuration gap, a database
 * error. Only the former is the beat's own fault and spends one of its
 * attempts; the latter is recorded and waited out without touching the count,
 * or a credit-dry afternoon would exhaust every beat of every concept.
 */
export function isRefusal(e: unknown): boolean {
  return e instanceof BadRequestException && !isQueueFull(e);
}

function reason(e: unknown): string {
  return String((e as Error)?.message ?? e).slice(0, 300);
}

export interface FrameLinkage {
  /** The asset's campaign, when the concept has one — without it the image is
   *  on `sweepOrphanAssets`' 30-day delete list until `promote` links it. */
  socialCampaignId: string | null | undefined;
  /** Set when frames are made inside production: puts the image on the engine
   *  budget's pre-debit path, like the clips. */
  campaignItemId?: string;
  createdById: string;
  /** The concept's own birth. An asset older than the concept cannot be one
   *  of its frames — the bound {@link adoptableFrame} searches within. */
  since: Date;
}

export interface FrameStore {
  prisma: Pick<PrismaService, '$executeRaw'>;
}

/**
 * Write ONE beat's keyframe — and nothing else on the plan.
 *
 * `jsonb_set` on that beat's path, compare-and-set on the keyframe the caller
 * read (`expect`; null when the beat had none): its asset, its status AND its
 * seed. The seed is part of it because a human's redraw is a REQUESTED marker
 * with a fresh seed, and a job that read the beat before the redraw holds the
 * same marker with the old one — without the seed the two are identical and
 * the job's frame, drawn from the old words, would land over the human's
 * request. Returns false when the beat changed under the caller — a redraw
 * landed, another pass wrote first — in which case the caller's picture of it
 * is stale and must not win. The row is
 * scoped by workspace like every other write on it, and the beat's `ord` is
 * checked at the index so a plan whose shots were reordered is never written
 * at the wrong position.
 */
export async function writeKeyframe(
  deps: FrameStore,
  workspaceId: string,
  conceptId: string,
  idx: number,
  ord: number,
  keyframe: Keyframe,
  expect: Keyframe | null | undefined,
): Promise<boolean> {
  const count = await deps.prisma.$executeRaw`
    UPDATE "content_concepts"
    SET "shotPlan" = jsonb_set("shotPlan", ARRAY['shots', ${String(idx)}, 'keyframe']::text[], ${JSON.stringify(keyframe)}::jsonb, true),
        "updatedAt" = NOW()
    WHERE "id" = ${conceptId} AND "workspaceId" = ${workspaceId}
      AND ("shotPlan" -> 'shots' -> ${idx}::int ->> 'ord')::int = ${ord}::int
      AND COALESCE("shotPlan" -> 'shots' -> ${idx}::int -> 'keyframe' ->> 'assetId', '') = ${expect?.assetId ?? ''}
      AND COALESCE("shotPlan" -> 'shots' -> ${idx}::int -> 'keyframe' ->> 'status', '') = ${expect?.status ?? ''}
      AND COALESCE("shotPlan" -> 'shots' -> ${idx}::int -> 'keyframe' ->> 'seed', '') = ${expect?.seed !== undefined ? String(expect.seed) : ''}
  `;
  return count > 0;
}

/** The most a human may put in one beat's text — frame, motion or
 *  description. Well above what any image or video model reads, well below
 *  what a pasted document would do to the plan column. */
export const MAX_SHOT_TEXT = 2000;

/** The words of one beat a human may rewrite: what the FRAME shows (the raw
 *  prompt the still is drawn from), what HAPPENS next (the prompt the clip is
 *  animated from), and the planner's own scene description. */
export interface ShotTextPatch {
  keyframePrompt?: string;
  prompt?: string;
  description?: string;
}

/**
 * Write ONE beat's text — and nothing else on the plan, not even the rest of
 * that beat.
 *
 * A merge (`||`) onto the beat at its index, never a whole-plan write and never
 * a whole-beat write: the storyboard job may be putting this very beat's
 * keyframe on the row at the same moment, and a write that carried the beat
 * the human read a second earlier would erase the frame the job just bought.
 * The merge reads the beat as it is when the statement runs, so only the keys
 * in `patch` change hands. The row is scoped by workspace like every other
 * write on it and the beat's `ord` is checked at the index, so a plan whose
 * shots were reordered is never written at the wrong position. Returns false
 * when no row matched — the beat moved, or the concept is not the caller's.
 */
export async function writeShotText(
  deps: FrameStore,
  workspaceId: string,
  conceptId: string,
  idx: number,
  ord: number,
  patch: ShotTextPatch,
): Promise<boolean> {
  const count = await deps.prisma.$executeRaw`
    UPDATE "content_concepts"
    SET "shotPlan" = jsonb_set("shotPlan", ARRAY['shots', ${String(idx)}]::text[], ("shotPlan" -> 'shots' -> ${idx}::int) || ${JSON.stringify(patch)}::jsonb, false),
        "updatedAt" = NOW()
    WHERE "id" = ${conceptId} AND "workspaceId" = ${workspaceId}
      AND ("shotPlan" -> 'shots' -> ${idx}::int ->> 'ord')::int = ${ord}::int
  `;
  return count > 0;
}

/** Write the plan's `storyboard` record (who asked, when) — that path only. */
export async function stampStoryboard(
  deps: FrameStore,
  workspaceId: string,
  conceptId: string,
  storyboard: Storyboard,
): Promise<void> {
  await deps.prisma.$executeRaw`
    UPDATE "content_concepts"
    SET "shotPlan" = jsonb_set("shotPlan", '{storyboard}', ${JSON.stringify(storyboard)}::jsonb, true),
        "updatedAt" = NOW()
    WHERE "id" = ${conceptId} AND "workspaceId" = ${workspaceId}
  `;
}

/**
 * Stamp every beat a pass will draw as REQUESTED — QUEUED with no asset yet —
 * so the plan, and the hub polling it, say a frame is coming before the job
 * has even been claimed. Exhausted beats are left alone: they wait for a
 * per-beat regenerate, which is the only thing that resets them.
 */
export async function markRequested(
  deps: FrameStore,
  workspaceId: string,
  conceptId: string,
  plan: StoryboardedPlan,
): Promise<number> {
  let marked = 0;
  for (let idx = 0; idx < plan.shots.length; idx++) {
    const sh = plan.shots[idx];
    const kf = sh.keyframe;
    if (!frameWanted(kf) || isRequested(kf)) continue;
    const next: Keyframe = {
      assetId: '',
      status: 'QUEUED',
      model: plan.storyboard.imageModel,
      ...(kf?.seed !== undefined ? { seed: kf.seed } : {}),
      attempts: kf?.attempts ?? 0,
    };
    if (await writeKeyframe(deps, workspaceId, conceptId, idx, sh.ord, next, kf ?? null)) marked++;
  }
  return marked;
}

/**
 * Give every beat whose frame failed for good a fresh start: a new seed, zero
 * attempts, nothing bought. Called on a HUMAN'S renewed intent — approving the
 * concept, regenerating the item — never automatically, which is what keeps
 * {@link MAX_FRAME_ATTEMPTS} a cap rather than a suggestion.
 */
export async function resetExhaustedFrames(
  deps: FrameStore,
  workspaceId: string,
  conceptId: string,
  plan: StoryboardedPlan,
): Promise<number> {
  let reset = 0;
  for (let idx = 0; idx < plan.shots.length; idx++) {
    const sh = plan.shots[idx];
    const kf = sh.keyframe;
    if (!kf || !(kf.status === 'FAILED' || kf.status === 'BLOCKED') || kf.attempts < MAX_FRAME_ATTEMPTS) continue;
    const next: Keyframe = { assetId: '', status: 'QUEUED', model: plan.storyboard.imageModel, seed: freshSeed(), attempts: 0 };
    if (await writeKeyframe(deps, workspaceId, conceptId, idx, sh.ord, next, kf)) reset++;
  }
  return reset;
}

/**
 * Every beat still merely REQUESTED is told why it will not be drawn: the
 * request is abandoned as FAILED with the reason and its attempts untouched,
 * so the hub shows the reason instead of a spinner and a later request tries
 * again from where it was.
 */
export async function abandonRequested(
  deps: FrameStore,
  workspaceId: string,
  conceptId: string,
  plan: StoryboardedPlan,
  why: string,
): Promise<number> {
  let abandoned = 0;
  for (let idx = 0; idx < plan.shots.length; idx++) {
    const sh = plan.shots[idx];
    const kf = sh.keyframe;
    if (!isRequested(kf) || !kf) continue;
    const next: Keyframe = { ...kf, status: 'FAILED', error: why.slice(0, 300) };
    if (await writeKeyframe(deps, workspaceId, conceptId, idx, sh.ord, next, kf)) abandoned++;
  }
  return abandoned;
}

/**
 * A frame this beat already bought but never recorded — the process died, or
 * the plan write failed, between the vendor accepting the request and the
 * keyframe landing on the plan. The asset row is the record of record: same
 * model, same prompt, same seed, born after the concept, referenced by no other
 * beat. Adopting it instead of buying again is what makes "buys nothing twice"
 * true across a crash, not only across a clean pass.
 */
async function adoptableFrame(
  deps: { prisma: Pick<PrismaService, 'generatedAsset'> },
  workspaceId: string,
  shots: Shot[],
  sh: Shot,
  model: string,
  seed: number,
  since: Date,
): Promise<{ id: string; status: string; url: string | null } | null> {
  const taken = new Set(shots.map((s) => s.keyframe?.assetId).filter(Boolean));
  const rows = await deps.prisma.generatedAsset.findMany({
    where: {
      workspaceId,
      type: 'IMAGE',
      model: { in: [model, resolveMediaModelId(model)] },
      prompt: sh.keyframePrompt ?? sh.prompt,
      status: { in: ['QUEUED', 'GENERATING', 'READY'] },
      createdAt: { gte: since },
    },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { id: true, status: true, url: true, params: true },
  });
  const row = rows.find((r) => !taken.has(r.id) && (r.params as { seed?: unknown } | null)?.seed === seed);
  return row ? { id: row.id, status: row.status, url: row.url } : null;
}

export interface SubmitResult {
  plan: StoryboardedPlan;
  /** Frames bought on this pass. */
  submitted: number;
  /** Frames found already bought (see {@link adoptableFrame}) — not bought again. */
  adopted: number;
  /** The workspace queue refused a frame; the rest of the beats were not tried. */
  queueFull: boolean;
  /** The pass hit a wall that was not the prompt's fault (see {@link isRefusal})
   *  — the reason, and the beat it stopped at. Nothing behind it was tried, and
   *  no attempt was spent. */
  halted?: { ord: number; why: string };
  /** A beat changed under this pass (a redraw landed meanwhile); its write was
   *  dropped rather than overwriting the newer state. Re-read before deciding. */
  conflicted: boolean;
}

/**
 * Request every frame the plan still wants, in beat order, WRITING EACH NEW
 * KEYFRAME ONTO THE ROW as it is accepted. Stops at the first queue-full
 * refusal (the caller waits and comes back). A beat whose request is refused
 * (see {@link isRefusal}) is recorded FAILED with the reason and counts as an
 * attempt, so the same bad prompt is not retried forever; any other failure is
 * the weather — recorded on the beat without spending an attempt, and the pass
 * stops there, because the next beat would only hit the same wall.
 */
export async function submitMissingFrames(
  deps: {
    mediaGen: Pick<MediaGenService, 'requestGeneration'>;
    prisma: Pick<PrismaService, '$executeRaw' | 'generatedAsset'>;
  },
  workspaceId: string,
  conceptId: string,
  plan: StoryboardedPlan,
  linkage: FrameLinkage,
  opts: {
    /** `'all'` (the producer): every beat the plan wants, a never-asked-for
     *  beat included — the concept is approved and every clip needs its frame.
     *  `'requested'` (the storyboard job): only beats a human asked for — a
     *  REQUESTED marker, or a frame that failed under the cap after being
     *  asked — so redrawing ONE beat draws one frame, not the whole board. */
    scope?: 'all' | 'requested';
  } = {},
): Promise<SubmitResult> {
  const shots: Shot[] = plan.shots.map((sh) => ({ ...sh }));
  const model = plan.storyboard.imageModel;
  const scope = opts.scope ?? 'all';
  // Persona photos reach the frame generator only where its contract takes an
  // array of them; on a model with no such slot they would be recorded on the
  // row as sent and dropped on the wire, which is the lie this line exists to
  // stop telling.
  const passRefs = mediaModelAcceptsReferenceImages(model);
  let submitted = 0;
  let adopted = 0;
  let queueFull = false;
  let conflicted = false;
  let halted: SubmitResult['halted'];

  const write = async (idx: number, next: Keyframe): Promise<boolean> => {
    const landed = await writeKeyframe(deps, workspaceId, conceptId, idx, shots[idx].ord, next, shots[idx].keyframe ?? null);
    if (landed) shots[idx].keyframe = next;
    else conflicted = true;
    return landed;
  };

  for (let idx = 0; idx < shots.length; idx++) {
    const sh = shots[idx];
    const prev = sh.keyframe;
    if (!frameWanted(prev)) continue;
    if (scope === 'requested' && !prev) continue;
    const attempts = (prev?.attempts ?? 0) + 1;
    const seed = frameSeed(plan.storyboard, prev);

    const orphan = await adoptableFrame(deps, workspaceId, shots, sh, model, seed, linkage.since);
    if (orphan) {
      await write(idx, {
        assetId: orphan.id,
        status: orphan.status === 'READY' ? 'READY' : 'QUEUED',
        ...(orphan.status === 'READY' && orphan.url ? { url: orphan.url } : {}),
        model,
        seed,
        attempts,
      });
      adopted++;
      continue;
    }

    const refs = passRefs ? (sh.reference?.images ?? []) : [];
    try {
      const { assetId } = await deps.mediaGen.requestGeneration(workspaceId, {
        type: 'IMAGE',
        model,
        prompt: sh.keyframePrompt ?? sh.prompt,
        aspectRatio: plan.aspectRatio ?? DEFAULT_SHOT_ASPECT,
        seed,
        ...(refs.length ? { referenceImageUrls: refs } : {}),
        socialCampaignId: linkage.socialCampaignId ?? undefined,
        ...(linkage.campaignItemId ? { campaignItemId: linkage.campaignItemId } : {}),
        createdById: linkage.createdById,
      });
      // Bought. On the row NOW — and if this write throws, the asset row itself
      // is the record: the next pass adopts it rather than buying again.
      await write(idx, { assetId, status: 'QUEUED', model, seed, attempts });
      submitted++;
    } catch (e) {
      if (isQueueFull(e)) {
        queueFull = true;
        break;
      }
      if (isRefusal(e)) {
        await write(idx, { assetId: prev?.assetId ?? '', status: 'FAILED', model, seed, attempts, error: reason(e) });
        continue;
      }
      const why = reason(e);
      halted = { ord: sh.ord, why };
      await write(idx, {
        assetId: prev?.assetId ?? '',
        status: 'FAILED',
        model,
        ...(prev?.seed !== undefined ? { seed: prev.seed } : {}),
        attempts: prev?.attempts ?? 0,
        error: why,
      }).catch(() => undefined);
      break;
    }
  }

  if (halted) {
    // The wall is the same for every beat behind it: a request left QUEUED
    // with nothing coming would spin in the hub forever.
    const rest: StoryboardedPlan = { ...plan, shots };
    await abandonRequested(deps, workspaceId, conceptId, rest, halted.why).catch(() => undefined);
    for (const sh of shots) {
      if (isRequested(sh.keyframe) && sh.keyframe) sh.keyframe = { ...sh.keyframe, status: 'FAILED', error: halted.why };
    }
  }
  return { plan: { ...plan, shots }, submitted, adopted, queueFull, halted, conflicted };
}

export interface SyncResult {
  plan: StoryboardedPlan;
  /** Beats whose frame is still rendering, or merely requested. */
  pending: number;
  /** Beats whose frame failed for good — attempts exhausted. */
  failed: Array<{ ord: number; keyframe: Keyframe }>;
  /** Any keyframe changed state on this pass (and was written). */
  changed: boolean;
}

/**
 * Read the truth about every frame off its asset row and write it onto the
 * plan, beat by beat: READY brings the URL the animator is handed, FAILED and
 * BLOCKED bring the reason, and a READY frame whose row is gone (swept, or
 * deleted by a user) is put back to wanting so it is redrawn rather than
 * animated from a dead URL. A frame the vendor refused fewer than
 * {@link MAX_FRAME_ATTEMPTS} times is left FAILED for `submitMissingFrames` to
 * re-request; one refused that many times is reported in `failed`.
 */
export async function syncFrames(
  deps: { prisma: Pick<PrismaService, 'generatedAsset' | '$executeRaw'> },
  workspaceId: string,
  conceptId: string,
  plan: StoryboardedPlan,
): Promise<SyncResult> {
  const live = (kf: Keyframe | undefined): kf is Keyframe =>
    Boolean(kf && kf.assetId && (kf.status === 'QUEUED' || kf.status === 'GENERATING' || kf.status === 'READY'));
  const ids = plan.shots.map((sh) => sh.keyframe).filter(live).map((kf) => kf.assetId);
  const rows = ids.length
    ? await deps.prisma.generatedAsset.findMany({
        where: { id: { in: ids }, workspaceId },
        select: { id: true, status: true, url: true, error: true },
      })
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));

  let changed = false;
  let pending = 0;
  const failed: SyncResult['failed'] = [];
  const shots: Shot[] = plan.shots.map((sh) => ({ ...sh }));

  for (let idx = 0; idx < shots.length; idx++) {
    const sh = shots[idx];
    const kf = sh.keyframe;
    if (!kf) continue;
    const exhausted = (next: Keyframe) => next.attempts >= MAX_FRAME_ATTEMPTS && (next.status === 'FAILED' || next.status === 'BLOCKED');
    if (!kf.assetId) {
      if (isRequested(kf)) pending++;
      else if (exhausted(kf)) failed.push({ ord: sh.ord, keyframe: kf });
      continue;
    }
    if (kf.status === 'FAILED' || kf.status === 'BLOCKED') {
      if (exhausted(kf)) failed.push({ ord: sh.ord, keyframe: kf });
      continue;
    }

    const row = byId.get(kf.assetId);
    let next: Keyframe | null = null;
    if (!row) {
      // Gone. A READY frame that vanished was swept or deleted, not refused:
      // it goes back to wanting at no cost to its attempts. One that vanished
      // mid-flight is treated as a refusal so the beat is re-requested rather
      // than waited on forever.
      next =
        kf.status === 'READY'
          ? { ...kf, status: 'FAILED', url: undefined, attempts: 0, error: 'the frame asset no longer exists' }
          : { ...kf, status: 'FAILED', error: 'the frame asset no longer exists' };
    } else if (row.status === 'READY' && row.url) {
      if (kf.status !== 'READY' || kf.url !== row.url) next = { ...kf, status: 'READY', url: row.url, error: undefined };
    } else if (row.status === 'FAILED' || row.status === 'BLOCKED') {
      next = { ...kf, status: row.status, url: undefined, error: row.error ?? undefined };
    } else {
      pending++;
      if (row.status === 'GENERATING' && kf.status !== 'GENERATING') next = { ...kf, status: 'GENERATING' };
    }

    if (next) {
      // Compare-and-set on what this pass read: a redraw that landed meanwhile
      // keeps its beat, and this pass simply reports what it saw.
      if (await writeKeyframe(deps, workspaceId, conceptId, idx, sh.ord, next, kf)) {
        changed = true;
        sh.keyframe = next;
      }
    }
    if (sh.keyframe && exhausted(sh.keyframe)) failed.push({ ord: sh.ord, keyframe: sh.keyframe });
  }
  return { plan: { ...plan, shots }, pending, failed, changed };
}

/** Every beat opens on a READY frame with a URL. */
export function framesReady(plan: StoryboardedPlan): boolean {
  return plan.shots.every((sh) => sh.keyframe?.status === 'READY' && Boolean(sh.keyframe.url));
}
