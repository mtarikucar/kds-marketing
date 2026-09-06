import { HttpException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { mediaModelAcceptsReferenceImages } from '../ai/media/media-models.config';
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
 * Pure functions over a plan plus the two services that already exist, so the
 * same code runs from two places without a third copy: `StoryboardService`
 * (a human asked for the frames while the concept is still PROPOSED) and
 * `ConceptPromotionService.produce` (the concept was approved; whatever frames
 * are missing are made now, then animated). Both read a fresh plan, mutate only
 * `shots[i].keyframe` / `storyboard`, and write it back through
 * {@link savePlan}.
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

/** Automatic re-requests of one beat's frame before it fails BY NAME. A vendor
 *  that refuses the same still twice is telling us something about the prompt,
 *  not about the weather; the human gets the reason and a regenerate button. */
export const MAX_FRAME_ATTEMPTS = 2;

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

/** Does this beat still need a frame requested? Never one, or one the vendor
 *  refused fewer than {@link MAX_FRAME_ATTEMPTS} times. */
export function frameWanted(kf: Keyframe | undefined): boolean {
  if (!kf) return true;
  return (kf.status === 'FAILED' || kf.status === 'BLOCKED') && kf.attempts < MAX_FRAME_ATTEMPTS;
}

/** The seed one beat's frame is drawn with: the plan's shared seed, nudged per
 *  re-request so a retry is not the identical picture. A keyframe carrying its
 *  own seed (a human's regenerate) wins outright. */
export function frameSeed(storyboard: Storyboard, kf: Keyframe | undefined): number {
  if (kf?.seed !== undefined) return kf.seed;
  const attempts = kf?.attempts ?? 0;
  return (storyboard.seed + attempts * 104729) % 2147483647;
}

/** `MediaGenService` throws this as a BadRequest carrying a `code`. */
export function isQueueFull(e: unknown): boolean {
  if (!(e instanceof HttpException)) return false;
  const body = e.getResponse();
  return typeof body === 'object' && body !== null && (body as { code?: string }).code === 'MEDIA_GEN_TOO_MANY';
}

function reason(e: unknown): string {
  return String((e as Error)?.message ?? e).slice(0, 300);
}

export interface FrameLinkage {
  /** The asset's campaign, when the concept has one — without it the image is
   *  on `sweepOrphanAssets`' 30-day delete list. */
  socialCampaignId: string | null | undefined;
  /** Set when frames are made inside production: puts the image on the engine
   *  budget's pre-debit path, like the clips. */
  campaignItemId?: string;
  createdById: string;
}

export interface SubmitResult {
  plan: StoryboardedPlan;
  /** Frames requested on this pass. */
  submitted: number;
  /** The workspace queue refused a frame; the rest of the beats were not tried. */
  queueFull: boolean;
}

/**
 * Request every frame the plan still wants, in beat order, writing each new
 * keyframe onto the plan as it is accepted. Stops at the first queue-full
 * refusal (the caller waits and comes back); a beat whose request is refused
 * for any other reason is recorded FAILED with the reason and counts as an
 * attempt, so the same bad prompt is not retried forever.
 */
export async function submitMissingFrames(
  deps: { mediaGen: Pick<MediaGenService, 'requestGeneration'> },
  workspaceId: string,
  plan: StoryboardedPlan,
  linkage: FrameLinkage,
): Promise<SubmitResult> {
  const shots: Shot[] = plan.shots.map((sh) => ({ ...sh }));
  const model = plan.storyboard.imageModel;
  // Persona photos reach the frame generator only where its contract takes an
  // array of them; on a model with no such slot they would be recorded on the
  // row as sent and dropped on the wire, which is the lie this line exists to
  // stop telling.
  const passRefs = mediaModelAcceptsReferenceImages(model);
  let submitted = 0;
  let queueFull = false;

  for (const sh of shots) {
    if (!frameWanted(sh.keyframe)) continue;
    const attempts = (sh.keyframe?.attempts ?? 0) + 1;
    const seed = frameSeed(plan.storyboard, sh.keyframe);
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
      sh.keyframe = { assetId, status: 'QUEUED', model, seed, attempts };
      submitted++;
    } catch (e) {
      if (isQueueFull(e)) {
        queueFull = true;
        break;
      }
      sh.keyframe = {
        assetId: sh.keyframe?.assetId ?? '',
        status: 'FAILED',
        model,
        seed,
        attempts,
        error: reason(e),
      };
    }
  }
  return { plan: { ...plan, shots }, submitted, queueFull };
}

export interface SyncResult {
  plan: StoryboardedPlan;
  /** Beats whose frame is still rendering. */
  pending: number;
  /** Beats whose frame failed for good — attempts exhausted. */
  failed: Array<{ ord: number; keyframe: Keyframe }>;
  /** Any keyframe changed state on this pass (the caller decides to save). */
  changed: boolean;
}

/**
 * Read the truth about every requested frame off its asset row and write it
 * onto the plan: READY brings the URL the animator is handed, FAILED/BLOCKED
 * bring the reason. A frame the vendor refused fewer than
 * {@link MAX_FRAME_ATTEMPTS} times is left FAILED for `submitMissingFrames` to
 * re-request; one refused that many times is reported in `failed`.
 */
export async function syncFrames(
  deps: { prisma: Pick<PrismaService, 'generatedAsset'> },
  workspaceId: string,
  plan: StoryboardedPlan,
): Promise<SyncResult> {
  // Only the frames still in flight are read: READY is final, and a FAILED or
  // BLOCKED frame is either re-requested by `submitMissingFrames` or reported
  // below from what the plan already knows.
  const ids = plan.shots
    .map((sh) => sh.keyframe)
    .filter((kf): kf is Keyframe => Boolean(kf && (kf.status === 'QUEUED' || kf.status === 'GENERATING') && kf.assetId))
    .map((kf) => kf.assetId);
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
  const shots = plan.shots.map((sh) => {
    const kf = sh.keyframe;
    if (!kf) return sh;
    if (kf.status === 'FAILED' || kf.status === 'BLOCKED') {
      if (kf.attempts >= MAX_FRAME_ATTEMPTS) failed.push({ ord: sh.ord, keyframe: kf });
      return sh;
    }
    if (kf.status === 'READY') return sh;
    const row = kf.assetId ? byId.get(kf.assetId) : undefined;
    if (!row) {
      // The row is gone (swept, or deleted by a user): treat it as a refusal so
      // the beat is re-requested rather than waited on forever.
      changed = true;
      const next: Keyframe = { ...kf, status: 'FAILED', error: 'the frame asset no longer exists' };
      if (next.attempts >= MAX_FRAME_ATTEMPTS) failed.push({ ord: sh.ord, keyframe: next });
      return { ...sh, keyframe: next };
    }
    if (row.status === 'READY' && row.url) {
      changed = true;
      return { ...sh, keyframe: { ...kf, status: 'READY' as const, url: row.url, error: undefined } };
    }
    if (row.status === 'FAILED' || row.status === 'BLOCKED') {
      changed = true;
      const next: Keyframe = { ...kf, status: row.status, error: row.error ?? undefined };
      if (next.attempts >= MAX_FRAME_ATTEMPTS) failed.push({ ord: sh.ord, keyframe: next });
      return { ...sh, keyframe: next };
    }
    pending++;
    if (row.status === 'GENERATING' && kf.status !== 'GENERATING') {
      changed = true;
      return { ...sh, keyframe: { ...kf, status: 'GENERATING' as const } };
    }
    return sh;
  });
  return { plan: { ...plan, shots }, pending, failed, changed };
}

/** Every beat opens on a READY frame with a URL. */
export function framesReady(plan: StoryboardedPlan): boolean {
  return plan.shots.every((sh) => sh.keyframe?.status === 'READY' && Boolean(sh.keyframe.url));
}

/**
 * Write a plan back onto its concept. Scoped by workspace like every other
 * write on the row. Best-effort by the caller's choice: the frames are bought
 * either way, and a failed write must not fail an approved item — but the
 * caller that is only recording frames for a human to look at should let the
 * error surface.
 */
export async function savePlan(
  deps: { prisma: Pick<PrismaService, 'contentConcept'> },
  workspaceId: string,
  conceptId: string,
  plan: ShotPlan,
): Promise<void> {
  await deps.prisma.contentConcept.updateMany({
    where: { id: conceptId, workspaceId },
    data: { shotPlan: plan as unknown as Prisma.InputJsonValue },
  });
}
