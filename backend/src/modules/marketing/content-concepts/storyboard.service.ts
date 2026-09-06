import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { MediaGenService } from '../ai/media/media-gen.service';
import { ScheduledJobService } from '../scheduling/scheduled-job.service';
import {
  ClaimedJob,
  JobHandlerResult,
  ScheduledJobRunnerService,
} from '../scheduling/scheduled-job-runner.service';
import type { Keyframe, ShotPlan } from '../video/video-pipeline.service';
import {
  CONCEPT_STORYBOARD_KIND,
  STORYBOARD_MAX_WAITS,
  STORYBOARD_WAIT_MS,
  abandonRequested,
  freshSeed,
  isRequested,
  markRequested,
  stampStoryboard,
  storyboardDedup,
  submitMissingFrames,
  supportsStoryboard,
  syncFrames,
  writeKeyframe,
  type StoryboardedPlan,
} from './storyboard-frames';

/**
 * THE STORYBOARD A HUMAN CAN LOOK AT — before they approve.
 *
 * Approval is the spend trigger and the single human gate on a concept, and it
 * stays so. What this adds is the option to see the frames FIRST: a reviewer
 * asks for a concept's storyboard while it is still PROPOSED, one still per
 * beat is drawn (a few credits), any frame can be redrawn on its own, and the
 * approval then buys the clips animated FROM those frames. A concept nobody
 * storyboards is still produced from a storyboard — `produce` draws the missing
 * frames itself — so the choice here is only whether a person looks.
 *
 * Discarding stays free for a concept nobody asked frames for: nothing is drawn
 * until someone asks, and a PROPOSED batch is still mostly meant to be thrown
 * away.
 *
 * The frames are asynchronous (a poll job finalizes each asset), so this
 * service is a scheduled-job handler like the producer: it requests what is
 * missing, then comes back every {@link STORYBOARD_WAIT_MS} to copy each
 * frame's outcome onto the plan until nothing is in flight. It stops the moment
 * the concept is decided — an APPROVED-and-promoted concept belongs to
 * `produce`, which draws whatever frames are still missing as its own first
 * phase, and a DISCARDED one only has what was already in flight settled.
 *
 * Every write here is per beat (see `storyboard-frames.ts`): a request that
 * lands while the job is mid-pass, or two reviewers on one batch, cannot erase
 * a frame the other just bought.
 */
@Injectable()
export class StoryboardService implements OnModuleInit {
  private readonly logger = new Logger(StoryboardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mediaGen: MediaGenService,
    private readonly scheduledJobs: ScheduledJobService,
    private readonly runner: ScheduledJobRunnerService,
  ) {}

  onModuleInit(): void {
    this.runner.registerHandler(CONCEPT_STORYBOARD_KIND, (job: ClaimedJob) =>
      this.run(String(job.payload.conceptId), String(job.payload.workspaceId), Number(job.payload.waits ?? 0)),
    );
  }

  /**
   * Draw the frames of one concept. Idempotent: beats that already have a
   * frame (or one in flight) are left alone; the ones that will be drawn are
   * stamped REQUESTED at once, so the hub sees them coming before the job runs.
   */
  async request(workspaceId: string, conceptId: string, requestedById: string) {
    const { concept, plan } = await this.eligible(workspaceId, conceptId);
    const storyboard = { ...plan.storyboard, requestedAt: new Date().toISOString(), requestedById };
    await stampStoryboard({ prisma: this.prisma }, workspaceId, conceptId, storyboard);
    const requested = await markRequested({ prisma: this.prisma }, workspaceId, conceptId, plan);
    await this.enqueue(workspaceId, conceptId);
    return { conceptId: concept.id, shots: plan.shots.length, requested, storyboard };
  }

  /**
   * Redraw ONE beat's frame. The old frame is dropped from the plan (the asset
   * row stays; the sweep reaps it if unattached) and the beat gets a fresh seed
   * so the new picture is genuinely another take rather than the same one. A
   * frame still rendering is refused: a second request now would buy the same
   * frame twice, and the reviewer has not seen the first yet.
   */
  async regenerateFrame(workspaceId: string, conceptId: string, ord: number, requestedById: string) {
    const { plan } = await this.eligible(workspaceId, conceptId);
    const idx = plan.shots.findIndex((sh) => sh.ord === ord);
    if (idx < 0) {
      throw new BadRequestException(
        `This concept has no beat ${ord}; its beats are ${plan.shots.map((sh) => sh.ord).join(', ')}.`,
      );
    }
    const prev = plan.shots[idx].keyframe;
    if (prev?.assetId && (prev.status === 'QUEUED' || prev.status === 'GENERATING')) {
      throw new BadRequestException(
        `Beat ${ord}'s frame is still rendering; wait for it to land (or fail) before asking for another — a second request now would buy the same frame twice.`,
      );
    }
    if (isRequested(prev)) {
      throw new BadRequestException(`Beat ${ord}'s frame is already requested and will be drawn shortly.`);
    }
    const reset: Keyframe = {
      assetId: '',
      status: 'QUEUED',
      model: plan.storyboard.imageModel,
      seed: freshSeed(),
      attempts: 0,
    };
    const landed = await writeKeyframe({ prisma: this.prisma }, workspaceId, conceptId, idx, ord, reset, prev ?? null);
    if (!landed) {
      throw new BadRequestException(
        `Beat ${ord}'s frame changed while you were looking at it; read the concept again before redrawing.`,
      );
    }
    await stampStoryboard({ prisma: this.prisma }, workspaceId, conceptId, {
      ...plan.storyboard,
      requestedAt: new Date().toISOString(),
      requestedById,
    });
    await this.enqueue(workspaceId, conceptId);
    return { conceptId, ord, seed: reset.seed };
  }

  /**
   * The job. Requests what is missing, copies outcomes onto the plan, and
   * comes back while anything is in flight — bounded by
   * {@link STORYBOARD_MAX_WAITS}. When the bound is hit, beats merely requested
   * are told why (FAILED, attempts untouched) so the hub stops waiting; frames
   * genuinely rendering are left to the media poll, and the next request or
   * the producer itself picks them up.
   */
  async run(conceptId: string, workspaceId: string, waits = 0): Promise<JobHandlerResult> {
    const concept = await this.prisma.contentConcept.findFirst({ where: { id: conceptId, workspaceId } });
    if (!concept) return;
    const plan = concept.shotPlan as unknown as ShotPlan | null;
    if (!supportsStoryboard(plan)) return;
    // An APPROVED concept that has been promoted is `produce`'s: it draws
    // whatever frames are still missing as its own first phase.
    if (concept.status === 'APPROVED' && concept.promotedItemId) return;
    // DISCARDED is finished: nothing more is drawn, but what was already in
    // flight is settled onto the plan so it does not read as rendering forever.
    if (concept.status === 'DISCARDED') {
      const settled = await syncFrames({ prisma: this.prisma }, workspaceId, conceptId, plan);
      await abandonRequested(
        { prisma: this.prisma },
        workspaceId,
        conceptId,
        settled.plan,
        'the concept was discarded before this frame was drawn',
      );
      return;
    }

    const sub = await submitMissingFrames({ mediaGen: this.mediaGen, prisma: this.prisma }, workspaceId, conceptId, plan, {
      socialCampaignId: concept.socialCampaignId,
      createdById: concept.createdById,
      since: concept.createdAt,
    });
    const sync = await syncFrames({ prisma: this.prisma }, workspaceId, conceptId, sub.plan);
    if (sync.failed.length) {
      this.logger.warn(
        `storyboard for concept ${conceptId}: frame ${sync.failed.map((f) => f.ord + 1).join(', ')} failed for good`,
      );
    }
    if (sub.halted) {
      // Not the prompts' fault and not waited out: the reason is on every
      // beat it stopped, and the next request retries from where it was.
      this.logger.warn(`storyboard for concept ${conceptId} halted at beat ${sub.halted.ord + 1}: ${sub.halted.why}`);
      return;
    }
    if (sub.queueFull || sub.conflicted || sync.pending > 0) {
      if (waits < STORYBOARD_MAX_WAITS) {
        return {
          reschedule: {
            runAt: new Date(Date.now() + STORYBOARD_WAIT_MS),
            payload: { conceptId, workspaceId, waits: waits + 1 },
          },
        };
      }
      const minutes = Math.round((STORYBOARD_MAX_WAITS * STORYBOARD_WAIT_MS) / 60000);
      await abandonRequested(
        { prisma: this.prisma },
        workspaceId,
        conceptId,
        sync.plan,
        `the workspace generation queue stayed full for ${minutes} minutes, so this frame was never requested`,
      );
    }
    return;
  }

  /**
   * The concept a human may still ask frames for: theirs, undecided or approved
   * but not yet in production, and planned since storyboards exist.
   */
  private async eligible(workspaceId: string, conceptId: string) {
    const concept = await this.prisma.contentConcept.findFirst({ where: { id: conceptId, workspaceId } });
    if (!concept) throw new NotFoundException('Concept not found');
    if (concept.status === 'DISCARDED') {
      throw new BadRequestException('This concept was discarded; there is nothing to storyboard.');
    }
    if (concept.status === 'APPROVED' && concept.promotedItemId) {
      throw new BadRequestException(
        'This concept is already in production, which draws its own frames; watch the campaign item instead, and regenerate the item if a frame failed for good.',
      );
    }
    const plan = concept.shotPlan as unknown as ShotPlan | null;
    if (!supportsStoryboard(plan)) {
      throw new BadRequestException(
        'This concept was planned before storyboards existed, so its beats carry no frame prompts. Plan the idea again to get a storyboarded batch.',
      );
    }
    return { concept, plan: plan as StoryboardedPlan };
  }

  private async enqueue(workspaceId: string, conceptId: string): Promise<void> {
    await this.scheduledJobs.schedule({
      workspaceId,
      kind: CONCEPT_STORYBOARD_KIND,
      runAt: new Date(),
      payload: { conceptId, workspaceId, waits: 0 },
      dedupKey: storyboardDedup(conceptId),
    });
  }
}
