import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { ScheduledJobService } from '../scheduling/scheduled-job.service';
import { ScheduledJobRunnerService, ClaimedJob } from '../scheduling/scheduled-job-runner.service';
import {
  sealSecret,
  openSecret,
  isSecretBoxConfigured,
  maskSecret,
} from '../../../common/crypto/secret-box.helper';
import {
  publishToNetwork,
  isNetworkConfigured,
  selectMediaForTarget,
  MediaItem,
  PostFormat,
} from './network-adapters';
import { queryCreatorInfo } from './tiktok-creator-info.util';
import { R2StorageService, UploadedMedia, UploadInput } from '../../../common/storage/r2-storage.service';
import { AiCreditsService } from '../ai/ai-credits.service';
import { creditCost } from '../ai/ai-credit-costs';

/** X (Twitter) is the only publish network with a real per-post API cost. A tweet
 *  carrying a URL is billed by X at ~13× a plain one, so it maps to a pricier
 *  credit action. Returns null for every other (free-to-publish) network. */
function twitterPublishAction(
  network: string,
  content: string,
): 'social.publish.x' | 'social.publish.x_link' | null {
  if (network !== 'TWITTER') return null;
  return /https?:\/\//i.test(content ?? '') ? 'social.publish.x_link' : 'social.publish.x';
}

export const SOCIAL_PUBLISH_KIND = 'social.publish';
/** Delete a published post's uploaded R2 media this long after success. */
export const SOCIAL_MEDIA_CLEANUP_KIND = 'social.media.cleanup';
const MEDIA_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const POST_FORMATS: PostFormat[] = ['FEED', 'REEL', 'STORY'];

/**
 * The ceiling on one `listPosts` page — and it is BOTH the default and the
 * maximum, deliberately.
 *
 * `listPosts` used to be a bare `findMany` with no `take` at all, so every
 * caller downloaded every post the workspace had ever written, each one with
 * its `targets` relation attached. That was survivable while the only reader
 * was the planner screen of a workspace three weeks old; it stops being
 * survivable the moment a customer has been posting daily for a year, and the
 * MCP tool already worked around it by slicing the result client-side (see the
 * `MAX_POSTS` cap in `mcp/tools/social.tools.ts`) — which still paid for the
 * whole transfer, it just threw most of it away after the fact.
 *
 * A caller that supplies no `limit` is not asking for "every row ever", it is
 * asking for "the list", so the absent case gets the cap rather than
 * unbounded reads. 500 is chosen to sit far above any real screenful while
 * still bounding the worst case; anything genuinely paginated should ask for a
 * window (`from`/`to`) instead of a bigger page.
 */
export const SOCIAL_POSTS_MAX_PAGE = 500;

/**
 * How long a post must sit in PUBLISHING before a human is allowed to reset it.
 *
 * PUBLISHING means "a publish run holds this row right now", and resetting it
 * under a live run is how a post gets sent twice. But a run that DIED mid-fan-
 * out (container restart, OOM, a network call that never returned) leaves the
 * same status behind with nobody holding it, and the post is then permanently
 * unreachable: not editable (DRAFT only), not schedulable, not publishable.
 *
 * On the QUEUE path the number means something precise. `ScheduledJobRunner
 * Service` reaps RUNNING rows whose lock is older than 15 minutes back to
 * PENDING and re-dispatches them, so 30 minutes is deliberately DOUBLE the
 * reaper window: by the time a human is offered the reset, the automatic
 * recovery has had a full cycle to finish the publish properly.
 *
 * That argument does NOT extend to `publishNow`, and this comment used to claim
 * it did. "Publish now" is a synchronous HTTP handler — it flips the row to
 * PUBLISHING and fans out inline, with no ScheduledJob row anywhere. Nothing
 * reaps it, and `scheduledJobs.cancel` in `unschedulePost` is a permanent no-op
 * for it, so a request that dies mid-fan-out leaves a row that only a human
 * ever unsticks, and the reset races the ORIGINAL REQUEST rather than a runner
 * that has already given up on it.
 *
 * On that path 30 minutes is therefore a heuristic idle bound, not a proof: it
 * is far longer than any synchronous fan-out (a handful of HTTP calls, each
 * with its own timeout, inside a request its own gateway would have killed long
 * before). What actually makes a mistaken reset survivable is per-TARGET state
 * rather than this number — a target that already went out stays PUBLISHED,
 * `unschedulePost` never revives it, and `attachTargets` refuses to re-attach
 * its account — so the worst case is a post re-sent to the networks it had not
 * reached yet, not a duplicate on a feed that already has it.
 */
export const PUBLISHING_STUCK_MS = 30 * 60 * 1000;

/**
 * Optional server-side narrowing for `listPosts`. Every field is optional and
 * omitting all of them reproduces the historical behaviour exactly (newest
 * first by creation time), because existing callers — the planner screen, the
 * MCP `list_scheduled_posts` tool, social campaigns — must not shift under a
 * feature added for a different screen.
 */
export interface ListPostsFilter {
  /** Inclusive lower bound on `scheduledAt`. */
  from?: Date;
  /** Inclusive upper bound on `scheduledAt`. */
  to?: Date;
  /** DRAFT | SCHEDULED | PUBLISHING | PUBLISHED | FAILED. */
  status?: string;
  /** Page size; silently clamped to `SOCIAL_POSTS_MAX_PAGE`. */
  limit?: number;
}

interface MediaDescriptor {
  url: string;
  /** R2 object key — present only for uploaded (not pasted) media. */
  key?: string;
  mime?: string;
}
interface PostOptions {
  formats?: Record<string, PostFormat>;
  media?: MediaDescriptor[];
  mediaDeletedAt?: string;
  /** Per-network publish options (e.g. LinkedIn visibility). Forwarded to publishToNetwork. */
  linkedin?: { visibility?: 'PUBLIC' | 'CONNECTIONS' };
  /** TikTok per-post privacy/interaction/photo controls. */
  tiktok?: Record<string, unknown>;
}

const NETWORKS = ['FACEBOOK', 'INSTAGRAM', 'LINKEDIN', 'TIKTOK', 'TWITTER', 'PINTEREST', 'GMB'] as const;
type Network = (typeof NETWORKS)[number];

function assertNetwork(network: string): asserts network is Network {
  if (!NETWORKS.includes(network as Network)) {
    throw new BadRequestException(`network must be one of: ${NETWORKS.join(', ')}`);
  }
}

/** Mask EVERY sealed credential in a SocialAccount row before returning it to API
 *  callers — both accessToken and the (long-lived, LinkedIn/TikTok) refreshToken,
 *  which the schema marks "SEALED — never returned raw". Masking, not spreading
 *  raw, so a future sealed column can't silently leak through this list DTO. */
function maskAccount(row: any) {
  return {
    ...row,
    accessToken: maskSecret(row.accessToken, 4),
    refreshToken: row.refreshToken ? maskSecret(row.refreshToken, 4) : null,
  };
}

@Injectable()
export class SocialPlannerService implements OnModuleInit {
  private readonly logger = new Logger(SocialPlannerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduledJobs: ScheduledJobService,
    private readonly runner: ScheduledJobRunnerService,
    private readonly r2: R2StorageService,
    private readonly credits: AiCreditsService,
  ) {}

  onModuleInit(): void {
    this.runner.registerHandler(SOCIAL_PUBLISH_KIND, (job: ClaimedJob) =>
      this.publishDuePost(job.payload.postId, job.payload.workspaceId),
    );
    this.runner.registerHandler(SOCIAL_MEDIA_CLEANUP_KIND, (job: ClaimedJob) =>
      this.cleanupPostMedia(job.payload.postId, job.payload.workspaceId),
    );
  }

  // ──────────────────────────────────────────────────────────────── Media

  /** Upload a media file to R2 and return its public URL + key + mime. */
  async uploadMedia(workspaceId: string, file?: UploadInput): Promise<UploadedMedia> {
    if (!file) throw new BadRequestException('No file uploaded');
    if (!this.r2.isConfigured()) {
      throw new BadRequestException(
        'Media upload is not configured (set R2_* env). Paste a public media URL instead.',
      );
    }
    return this.r2.upload(workspaceId, file);
  }

  /** Sanitize a caller-supplied per-account format map to known formats only. */
  private cleanFormats(formats?: Record<string, string>): Record<string, PostFormat> | undefined {
    if (!formats || typeof formats !== 'object') return undefined;
    const out: Record<string, PostFormat> = {};
    for (const [accId, fmt] of Object.entries(formats)) {
      if (POST_FORMATS.includes(fmt as PostFormat)) out[accId] = fmt as PostFormat;
    }
    return Object.keys(out).length ? out : undefined;
  }

  /** Merge new formats/media/options into an existing post's options JSON. The
   *  optional `options` patch carries network-specific controls (e.g. TikTok
   *  privacy/photo settings under `options.tiktok`). */
  private mergeOptions(
    existing: PostOptions | null | undefined,
    patch: {
      formats?: Record<string, string>;
      media?: MediaDescriptor[];
      options?: Record<string, unknown>;
    },
  ): PostOptions | undefined {
    const base: PostOptions = { ...(existing ?? {}) };
    const formats = this.cleanFormats(patch.formats);
    if (formats) base.formats = { ...(base.formats ?? {}), ...formats };
    if (patch.media !== undefined) base.media = patch.media;
    if (patch.options !== undefined) {
      // Fold caller-supplied network-specific options into the same JSON. Known
      // keys (formats/media/mediaDeletedAt) are managed above; pass the rest
      // (notably `tiktok` and `linkedin` visibility) through so publish-time can read them.
      const { formats: _f, media: _m, ...rest } = patch.options as Record<string, unknown>;
      Object.assign(base, rest);
    }
    return Object.keys(base).length ? base : undefined;
  }

  // ────────────────────────────────────────────────────────────── Accounts

  async connectAccount(
    workspaceId: string,
    dto: {
      network: string;
      externalId: string;
      displayName: string;
      accessToken: string;
      tokenExpiresAt?: Date;
    },
  ) {
    assertNetwork(dto.network);
    if (!isSecretBoxConfigured()) {
      throw new BadRequestException(
        'Social accounts cannot be connected: MARKETING_SECRET_KEY is not configured',
      );
    }
    const sealed = sealSecret(dto.accessToken);
    const row = await this.prisma.socialAccount.upsert({
      where: {
        workspaceId_network_externalId: {
          workspaceId,
          network: dto.network,
          externalId: dto.externalId,
        },
      },
      create: {
        workspaceId,
        network: dto.network,
        externalId: dto.externalId,
        displayName: dto.displayName,
        accessToken: sealed,
        tokenExpiresAt: dto.tokenExpiresAt ?? null,
        enabled: true,
        lastError: null,
      },
      update: {
        displayName: dto.displayName,
        accessToken: sealed,
        enabled: true,
        // A successful connect IS the repair, so the failure that prompted it
        // has to be cleared. `needsReconnect` folds Boolean(lastError)
        // (social.tools.ts:67), so leaving it behind meant an account you had
        // just reconnected kept reporting "reconnect needed" forever — and
        // disconnectAccount writes lastError='disconnected', so every
        // disconnect/reconnect round trip landed in exactly that state.
        lastError: null,
        // Only overwrite the expiry when the caller actually knows one.
        // `?? null` wiped it on every token rotation that did not carry a
        // date, and the refresh cron's due query requires
        // `tokenExpiresAt: { not: null }` — so a reconnected account silently
        // left the refresh queue for good and died when its token ran out.
        //
        // Keeping a stale date is the recoverable choice: a past date matches
        // `lt: dueBefore`, so the next tick refreshes it and writes the
        // correct expiry back. Null is the only value nothing recovers from.
        ...(dto.tokenExpiresAt !== undefined ? { tokenExpiresAt: dto.tokenExpiresAt } : {}),
      },
    });
    return maskAccount(row);
  }

  async listAccounts(workspaceId: string) {
    const rows = await this.prisma.socialAccount.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(maskAccount);
  }

  /**
   * Disconnect an account — which is not the same as erasing what it did.
   *
   * This used to be a bare `socialAccount.delete`. SocialPostTarget references
   * the account with `onDelete: Restrict` (correctly — publish history and its
   * metrics must survive a disconnect), so the database refused the delete for
   * any account that had ever been a publish target, and the raw foreign-key
   * error surfaced to the user as an opaque failure. The practical effect was
   * that an account could be disconnected only until its first post, and never
   * again.
   *
   * So the two cases are separated. An account that never published is deleted
   * outright — nothing references it and leaving a husk behind is just
   * clutter. An account with history is REVOKED instead: its sealed tokens are
   * dropped, so nothing can ever publish as it again (which is what
   * "disconnect" means), while the posts it sent stay attached and reportable.
   */
  async disconnectAccount(workspaceId: string, accountId: string) {
    const existing = await this.prisma.socialAccount.findFirst({
      where: { id: accountId, workspaceId },
      select: { id: true, network: true },
    });
    if (!existing) throw new NotFoundException('Social account not found');

    const publishedWith = await this.prisma.socialPostTarget.count({
      // The account is already workspace-scoped above, so this filter is
      // belt-and-braces — but an unscoped count is exactly the shape that
      // becomes a cross-tenant read the day someone reuses this method.
      where: { socialAccountId: accountId, workspaceId },
    });

    if (publishedWith === 0) {
      try {
        await this.prisma.socialAccount.delete({ where: { id: accountId } });
        return { disconnected: true, deleted: true, postsKept: 0 };
      } catch (e) {
        // A target could be created between the count and the delete. Fall
        // through to revoke rather than handing the user the FK error that
        // started all this.
        if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2003') throw e;
      }
    }

    await this.prisma.socialAccount.update({
      where: { id: accountId },
      data: {
        // Emptying the sealed tokens is the actual disconnect: every publish
        // path opens accessToken, so there is nothing left to post with.
        accessToken: '',
        refreshToken: null,
        tokenExpiresAt: null,
        enabled: false,
        lastError: 'disconnected',
      },
    });
    return { disconnected: true, deleted: false, postsKept: publishedWith };
  }

  async networkStatus(workspaceId: string) {
    return {
      FACEBOOK: isNetworkConfigured('FACEBOOK'),
      INSTAGRAM: isNetworkConfigured('INSTAGRAM'),
      INSTAGRAM_LOGIN: isNetworkConfigured('INSTAGRAM_LOGIN'),
      LINKEDIN: isNetworkConfigured('LINKEDIN'),
      TIKTOK: isNetworkConfigured('TIKTOK'),
      // Epic 12 (needs-external, inert until creds).
      TWITTER: isNetworkConfigured('TWITTER'),
      PINTEREST: isNetworkConfigured('PINTEREST'),
      GMB: isNetworkConfigured('GMB'),
      secretBoxConfigured: isSecretBoxConfigured(),
    };
  }

  // ────────────────────────────────────────────────────────────── TikTok enrichment

  async tiktokCreatorInfo(workspaceId: string, accountId: string) {
    const account = await this.prisma.socialAccount.findFirst({
      where: { id: accountId, workspaceId, network: 'TIKTOK' },
    });
    if (!account) throw new NotFoundException('TikTok account not found');
    const token = openSecret(account.accessToken);
    return queryCreatorInfo(token);
  }

  // ────────────────────────────────────────────────────────────── Posts CRUD

  async createPost(
    workspaceId: string,
    dto: {
      content: string;
      mediaUrls?: string[];
      targetAccountIds?: string[];
      formats?: Record<string, string>;
      media?: MediaDescriptor[];
      options?: Record<string, unknown>;
    },
  ) {
    const mediaUrls = dto.media?.length ? dto.media.map((m) => m.url) : dto.mediaUrls ?? [];
    const options = this.mergeOptions(null, {
      formats: dto.formats,
      media: dto.media,
      options: dto.options,
    });
    const post = await this.prisma.socialPost.create({
      data: {
        workspaceId,
        content: dto.content,
        mediaUrls,
        ...(options ? { options: options as Prisma.InputJsonValue } : {}),
        status: 'DRAFT',
      },
    });

    if (dto.targetAccountIds?.length) {
      await this.attachTargets(workspaceId, post.id, dto.targetAccountIds);
    }

    return this.getPost(workspaceId, post.id);
  }

  /**
   * List the workspace's posts, optionally narrowed to a scheduling window, a
   * status, and a page size.
   *
   * The filter exists because "what is going out today?" is the question the
   * planner and the Growth Studio one-screen actually ask, and the only way to
   * answer it before was to fetch the entire history and filter it in the
   * browser. Everything here is optional and additive: with no arguments the
   * query is the one this method has always issued, minus the missing `take`
   * (see SOCIAL_POSTS_MAX_PAGE for why the unbounded read was the bug).
   *
   * Two details that are easy to get wrong:
   *
   * 1. The ORDER flips with the window. A time window is a calendar read, and a
   *    calendar reads forwards — "the next thing to go out" must be the first
   *    row, not the last. Without a window there is no scheduled time to sort
   *    by at all (drafts carry `scheduledAt: null`), so it falls back to the
   *    historical newest-first-by-creation ordering rather than sorting a
   *    column that is mostly NULL.
   *
   * 2. Both orderings carry an `id` tiebreak, because neither sort column is
   *    unique — a bulk campaign schedules a dozen posts at the same instant,
   *    and `createdAt` collides just as easily on a seeded or imported batch.
   *    Postgres is free to return equal rows in any order it likes, so at the
   *    `take` boundary two identical requests could disagree about which of the
   *    tied rows made the page: a post appearing twice across two reads, or
   *    vanishing from both.
   *
   * 3. A window EXCLUDES posts with no `scheduledAt`. Prisma compiles
   *    `scheduledAt: { gte }` to a SQL comparison, and a comparison against
   *    NULL is never true, so unscheduled drafts drop out — which is the
   *    correct semantic and matches what the MCP tool already documents: a
   *    draft with no send time is not "scheduled for today", it is not
   *    scheduled at all. Ask for `status: 'DRAFT'` without a window to see it.
   *
   * The bounds are validated here rather than only in the controller DTO
   * because this method is also reachable from MCP and from other services,
   * and an inverted range that silently returns nothing reads to a model as
   * "there are no posts" — a wrong answer is worse than a refusal.
   */
  async listPosts(workspaceId: string, filter: ListPostsFilter = {}) {
    const { from, to, status, limit } = filter;

    if (from && Number.isNaN(from.getTime())) {
      throw new BadRequestException('`from` is not a valid date');
    }
    if (to && Number.isNaN(to.getTime())) {
      throw new BadRequestException('`to` is not a valid date');
    }
    if (from && to && to.getTime() < from.getTime()) {
      throw new BadRequestException('`to` must not be earlier than `from`');
    }

    const windowed = Boolean(from || to);
    const scheduledAt: Prisma.DateTimeNullableFilter | undefined = windowed
      ? { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) }
      : undefined;

    // Clamp rather than reject an over-large `limit`: the controller DTO already
    // refuses anything outside 1..200, so a bigger number can only arrive from
    // an internal caller, and quietly serving it a bounded page is friendlier
    // than a 400 nobody sees. `Math.floor` guards the internal caller that
    // passes a computed float.
    const take =
      limit !== undefined && Number.isFinite(limit) && limit > 0
        ? Math.min(Math.floor(limit), SOCIAL_POSTS_MAX_PAGE)
        : SOCIAL_POSTS_MAX_PAGE;

    return this.prisma.socialPost.findMany({
      // The `where` is built INLINE, not assembled into a variable first, so the
      // workspace-scoping architecture fitness test can see the tenant filter at
      // this call site — it reads the argument object literally, and a hoisted
      // `where` object reads to it (correctly) as an unscoped multi-row query.
      // The optional predicates are spread rather than assigned as `undefined`,
      // which keeps the query free of keys nobody asked to filter on.
      where: {
        workspaceId,
        ...(status ? { status } : {}),
        ...(scheduledAt ? { scheduledAt } : {}),
      },
      include: { targets: true },
      // The `id` tiebreak makes the page boundary deterministic (see 2. above);
      // it follows the primary column's direction so the two never disagree
      // about which end of a tie is "first".
      orderBy: windowed
        ? [{ scheduledAt: 'asc' }, { id: 'asc' }]
        : [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
    });
  }

  async getPost(workspaceId: string, postId: string) {
    const post = await this.prisma.socialPost.findFirst({
      where: { id: postId, workspaceId },
      include: { targets: true },
    });
    if (!post) throw new NotFoundException('Social post not found');
    return post;
  }

  async updatePost(
    workspaceId: string,
    postId: string,
    dto: {
      content?: string;
      mediaUrls?: string[];
      formats?: Record<string, string>;
      media?: MediaDescriptor[];
      targetAccountIds?: string[];
      options?: Record<string, unknown>;
    },
  ) {
    const existing = await this.assertDraftPost(workspaceId, postId);
    const mediaUrls =
      dto.media !== undefined ? dto.media.map((m) => m.url) : dto.mediaUrls;
    const options = this.mergeOptions(existing.options as PostOptions, {
      formats: dto.formats,
      media: dto.media,
      options: dto.options,
    });
    // Replace the draft's PENDING targets when the editor changed them — mirrors
    // schedulePost, so a target edit persists WITHOUT also requiring a schedule.
    if (dto.targetAccountIds?.length) {
      await this.prisma.socialPostTarget.deleteMany({
        where: { workspaceId, postId, status: 'PENDING' },
      });
      await this.attachTargets(workspaceId, postId, dto.targetAccountIds);
    }
    return this.prisma.socialPost.update({
      where: { id: postId },
      data: {
        ...(dto.content !== undefined ? { content: dto.content } : {}),
        ...(mediaUrls !== undefined ? { mediaUrls } : {}),
        ...(options ? { options: options as Prisma.InputJsonValue } : {}),
      },
      include: { targets: true },
    });
  }

  async deletePost(workspaceId: string, postId: string) {
    const post = await this.prisma.socialPost.findFirst({
      where: { id: postId, workspaceId },
      select: { id: true },
    });
    if (!post) throw new NotFoundException('Social post not found');
    await this.prisma.socialPost.delete({ where: { id: postId } });
    return { deleted: true };
  }

  // ────────────────────────────────────────────────────────────── Schedule

  async schedulePost(
    workspaceId: string,
    postId: string,
    scheduledAt: Date,
    targetAccountIds?: string[],
    formats?: Record<string, string>,
  ) {
    const post = await this.prisma.socialPost.findFirst({
      where: { id: postId, workspaceId },
      include: { targets: true },
    });
    if (!post) throw new NotFoundException('Social post not found');
    if (!['DRAFT', 'SCHEDULED'].includes(post.status)) {
      throw new BadRequestException(`Cannot schedule a post in status: ${post.status}`);
    }

    const mergedOptions = this.mergeOptions(post.options as PostOptions, { formats });
    if (mergedOptions) {
      await this.prisma.socialPost.update({
        where: { id: postId },
        data: { options: mergedOptions as any },
      });
    }

    if (targetAccountIds?.length) {
      // Remove existing PENDING targets first, then re-attach
      await this.prisma.socialPostTarget.deleteMany({
        where: { workspaceId, postId, status: 'PENDING' },
      });
      await this.attachTargets(workspaceId, postId, targetAccountIds);
    }

    // Ensure there are targets
    const targets = await this.prisma.socialPostTarget.findMany({
      where: { workspaceId, postId },
    });
    if (targets.length === 0) {
      throw new BadRequestException(
        'Post has no targets. Add at least one social account target before scheduling.',
      );
    }

    await this.prisma.socialPost.update({
      where: { id: postId },
      data: { status: 'SCHEDULED', scheduledAt },
    });

    const jobId = await this.scheduledJobs.schedule({
      workspaceId,
      kind: SOCIAL_PUBLISH_KIND,
      runAt: scheduledAt,
      payload: { postId, workspaceId },
      dedupKey: `social-post-${postId}`,
    });

    this.logger.log(`Scheduled post ${postId} (job ${jobId}) at ${scheduledAt.toISOString()}`);

    return this.getPost(workspaceId, postId);
  }

  /**
   * Pull a post out of the publish queue and back to DRAFT so it can be
   * corrected — and, for a post that already tried and failed, sent again.
   *
   * Editing refuses anything but a DRAFT, which is right: a post sitting in the
   * publish queue must not change under the job that is about to send it. But
   * that left no way back at all — the only escape was `deletePost`, which is
   * DESTRUCTIVE, approval-gated, and throws away the copy, the media and the
   * target accounts to fix a typo in a URL. This is the reversible alternative
   * and it moves in the SAFE direction: the post leaves the publish queue
   * rather than entering it, so it is ungated on purpose — the risky verb is
   * scheduling, not unscheduling.
   *
   * ## Why FAILED is accepted here
   *
   * A FAILED post used to be TERMINAL. `publishNow` and `schedulePost` both
   * refuse anything outside DRAFT/SCHEDULED, `updatePost` is DRAFT-only, and
   * this method was SCHEDULED-only — so a post that failed for an entirely
   * transient reason (an expired page token, a 500 from the network, a blip)
   * could never be retried. The operator's only move was to delete it and
   * retype the caption, re-upload the media and re-pick the accounts, which is
   * both hostile and lossy. Nothing about the FAILURE justified destroying the
   * CONTENT, so FAILED now resets to DRAFT like any other correctable state.
   *
   * ## Why only SOME targets are reset
   *
   * This is the part that would double-post if it were done carelessly. A post
   * whose status is FAILED can still have targets that PUBLISHED — the status
   * is per-post, the outcome is per-network, and a fan-out that reached
   * Instagram but not Facebook is entirely normal (the post lands PUBLISHED in
   * that specific case, but a crash-and-retry sequence can produce a FAILED
   * post with a live target too). `publishDuePost` republishes every PENDING
   * target it finds, so resetting ALL targets to PENDING would re-send content
   * that is already live on that network — a duplicate post on the customer's
   * own feed, which is the single worst thing this feature could do.
   *
   * So the reset is filtered to `PENDING | FAILED`: the networks that never
   * received the post. PUBLISHED targets keep their status and their
   * `externalPostId`, so the next publish skips them and the metrics puller
   * keeps reporting on the post that actually went out. `error` is cleared on
   * the revived ones because a stale error string next to a PENDING target
   * describes an attempt that is no longer the current one.
   *
   * ## Why a long-stuck PUBLISHING post is also accepted
   *
   * PUBLISHING means "a run holds this row right now", and resetting it under a
   * live run is exactly how a post gets sent twice — so a fresh PUBLISHING post
   * is refused. A run that DIED mid-fan-out leaves the identical status behind
   * with nobody holding it, and the post is then unreachable by every route.
   * `PUBLISHING_STUCK_MS` is the line between the two, and its doc block is
   * honest about what that threshold does and does not prove — it is a reaper-
   * derived guarantee for a queued publish and a heuristic for `publishNow`.
   * An unreadable `updatedAt` fails CLOSED (NaN comparisons are false → not
   * stuck), because the failure mode of guessing wrong here is a duplicate
   * publish.
   *
   * Because it IS partly a heuristic, the status flip below is a compare-and-
   * set rather than a blind write, and the two writes share a transaction: a
   * "stuck" run that turns out to be alive can finish in the gap between the
   * read and the write, and clobbering its genuinely PUBLISHED post back to
   * DRAFT would show the operator a draft for content that is already live.
   */
  async unschedulePost(workspaceId: string, postId: string) {
    const post = await this.prisma.socialPost.findFirst({
      where: { id: postId, workspaceId },
      select: { id: true, status: true, updatedAt: true },
    });
    if (!post) throw new NotFoundException('Social post not found');
    if (post.status === 'DRAFT') return this.getPost(workspaceId, postId);

    const idleMs = Date.now() - new Date(post.updatedAt as Date).getTime();
    const stuckPublishing = post.status === 'PUBLISHING' && idleMs >= PUBLISHING_STUCK_MS;

    if (!['SCHEDULED', 'FAILED'].includes(post.status) && !stuckPublishing) {
      throw new BadRequestException(
        post.status === 'PUBLISHING'
          ? 'This post is publishing right now — wait for the run to finish. If it is still stuck in 30 minutes you can reset it here.'
          : `Only a SCHEDULED or FAILED post can be pulled back to draft (this one is ${post.status})`,
      );
    }

    // Cancel the job FIRST. If the status write failed after the job was
    // already gone, the post would sit SCHEDULED forever and never publish —
    // silently. This order leaves only the opposite partial state: a DRAFT
    // whose job is still queued, which is harmless BECAUSE publishDuePost now
    // refuses to publish a DRAFT. It did not before this change; without that
    // guard neither ordering was actually safe.
    //
    // `cancel` only touches PENDING rows. For a post stuck by a QUEUED publish
    // that means it is a no-op unless the reaper has already revived the job —
    // by 30 minutes it has, so the cancel can actually catch the re-queued work
    // rather than racing a RUNNING row it cannot stop. For a post stuck by
    // `publishNow` there is no ScheduledJob row at all and this call can never
    // do anything; that path's only protection is the compare-and-set below and
    // the per-target PUBLISHED state.
    await this.scheduledJobs.cancel(SOCIAL_PUBLISH_KIND, `social-post-${postId}`);

    // One transaction, and the status flip goes first inside it.
    //
    // This used to be a read at the top of the method and a bare `update` by id
    // here, with no predicate and nothing serializing the two — so a run that
    // looked stuck but was alive could complete in between and have its
    // genuinely PUBLISHED post dragged back to DRAFT. The operator then sees a
    // draft for a post that is live on the customer's feed, and the obvious
    // next move is to publish it again.
    //
    // `publishNow` already carries the right shape for this: an updateMany
    // whose WHERE repeats the status that was read, plus a `count === 0` check
    // that turns a lost race into a refusal rather than a silent overwrite.
    // Same here. The flip runs before the target revive so that losing costs
    // nothing, and the throw rolls back the whole transaction — the pair can
    // never be observed (or crash) half-applied, which matters more now that
    // `attachTargets` will not re-create a target row the post still has.
    let revived = 0;
    await this.prisma.$transaction(async (tx) => {
      const flipped = await tx.socialPost.updateMany({
        where: { id: postId, workspaceId, status: post.status },
        data: { status: 'DRAFT', scheduledAt: null },
      });
      if (flipped.count === 0) {
        throw new BadRequestException(
          'This post changed while you were looking at it — reload and try again',
        );
      }

      // Never the PUBLISHED ones (see the doc block): those networks already
      // have the post, and `publishDuePost` re-sends every PENDING target it
      // finds.
      const reset = await tx.socialPostTarget.updateMany({
        where: { workspaceId, postId, status: { in: ['PENDING', 'FAILED'] } },
        data: { status: 'PENDING', error: null },
      });
      revived = reset?.count ?? 0;
    });

    this.logger.log(
      `Unscheduled post ${postId} (was ${post.status}) — back to DRAFT, ${revived} target(s) reset to PENDING`,
    );
    return this.getPost(workspaceId, postId);
  }

  // ────────────────────────────────────────────────────────────── Publish

  async publishDuePost(postId: string, workspaceId: string): Promise<void> {
    const post = await this.prisma.socialPost.findFirst({
      where: { id: postId, workspaceId },
      include: { targets: { include: { account: true } } },
    });
    if (!post) {
      this.logger.warn(`publishDuePost: post ${postId} not found`);
      return;
    }
    if (post.status === 'PUBLISHED') return; // idempotent
    // A DRAFT is by definition not cleared to go out. The queue used to
    // publish whatever the job pointed at, so a post pulled back to draft
    // (unschedulePost) would still have gone live if its job outlived the
    // cancel — and so would any post moved to DRAFT by any other route.
    if (post.status === 'DRAFT') {
      this.logger.warn(`publishDuePost: post ${postId} is a DRAFT — not publishing`);
      return;
    }

    await this.prisma.socialPost.update({
      where: { id: postId },
      data: { status: 'PUBLISHING' },
    });

    const options = (post.options as PostOptions) ?? {};
    const formats = options.formats ?? {};
    const mimeByUrl: Record<string, string> = {};
    for (const m of options.media ?? []) {
      if (m?.url) mimeByUrl[m.url] = m.mime;
    }
    const mediaUrls = post.mediaUrls as string[];
    // The post's media, once, in the post's own order. Each target takes its
    // own share of this below — the list itself is never reordered.
    const postMedia: MediaItem[] = (mediaUrls ?? []).map((url) => ({ url, mime: mimeByUrl[url] }));

    // WAS THIS POST'S MEDIA GENERATED FOR IT?
    //
    // `campaignItemId` is the signal, and it is a fact the row already carries.
    // It is set at creation by exactly the two producers that BUY media for a
    // post — `SocialCampaignsService.generateItem` and
    // `ConceptPromotionService` — and the only writer of `mediaUrls` on such a
    // post is `attachAssetsToPost`, which copies the item's `generatedAssetIds`
    // in beat order. A post with this id set and media on it is a post whose
    // media was rendered, paid for and approved AS the post.
    //
    // What it misses, both ways round and both by design:
    //  - an operator who REPLACES the media on a campaign post by hand still
    //    counts as generated. That errs toward refusing to publish a caption
    //    alone, which is the safe direction.
    //  - a hand-composed post to which somebody attached a file they had made
    //    in the AI studio does NOT count: nothing links that upload back to a
    //    campaign item, and `options.media` descriptors carry only {url,key,mime}
    //    — no asset id — so there is no fact here to read. The post still
    //    publishes text-only, and the row still says what was left behind.
    const mediaWasGeneratedForPost = post.campaignItemId != null;

    const pendingTargets = post.targets.filter((t) => t.status === 'PENDING');
    let publishedCount = 0;
    let failedCount = 0;

    for (const target of pendingTargets) {
      const format: PostFormat = formats[target.socialAccountId] ?? 'FEED';

      // WHAT THIS DESTINATION TAKES, decided before anything is spent or sent.
      //
      // Not all-or-nothing: the same approved post is a ten-clip carousel on
      // Instagram and one hero clip on TikTok, and both are real publishes. The
      // selector hands each target the first N its network carries, in the
      // post's order, and names what it left behind.
      const selection = selectMediaForTarget(postMedia, target.account.network, format);

      // A POST WHOSE MEDIA WAS GENERATED FOR IT NEVER GOES OUT AS A BARE
      // CAPTION — per TARGET.
      //
      // The post-level version of this invariant lives in
      // `SocialCampaignsService.confirmItem`, and it was never enough: it asks
      // whether the POST has media and then fans out to every target without
      // asking what any of them can carry. X carries no video at all, so a
      // five-clip concept reached `publishTwitter`, uploaded nothing, tweeted
      // the caption on its own and recorded the target PUBLISHED. That is a
      // post nobody approved, published under the name of one that was.
      //
      // CONDITIONAL on `mediaWasGeneratedForPost`, because the same shape means
      // two different things. A campaign item's clips ARE the post: the caption
      // alone is a post the reviewer never saw, published while the renders they
      // paid for sit unused, so this target FAILS and nothing is sent. A
      // hand-composed post is words with a picture attached: if the picture has
      // nowhere to go on this network, the words are still worth sending, and
      // that is the older rule the X adapter has always followed (see
      // `publishTwitter`). Such a post falls through and publishes text-only,
      // with `selection.dropped` written onto the row so the loss is on the
      // record either way.
      //
      // Checked HERE, ahead of the credit reserve and the vendor call, so the
      // refusal costs nothing and the row says why. FAILED rather than skipped:
      // a target that did not publish what it was given did not succeed, and
      // `unschedulePost` can put it back after somebody fixes the destination.
      if (selection.carriesNothing && mediaWasGeneratedForPost) {
        const why =
          `not published: this post carries ${postMedia.length} media file(s) and ` +
          `${selection.dropped?.reason ?? `${target.account.network} can carry none of them`}. ` +
          `Publishing here would have put the caption out with no media, which is not the post that was approved. ` +
          `Point this campaign at a destination that can carry video, or remove this account from its targets.`;
        await this.prisma.socialPostTarget.update({
          where: { id: target.id },
          data: { status: 'FAILED', error: why.slice(0, 500) },
        });
        failedCount++;
        this.logger.warn(`Post ${postId} target ${target.id} (${target.network}) ${why}`);
        continue;
      }

      // X (Twitter) is the only network that charges per post — meter it into AI
      // credits BEFORE the vendor call (a link tweet costs more). Every other
      // network publishes for free, so `xAction` is null and nothing is reserved.
      const xAction = twitterPublishAction(target.account.network, post.content);
      if (xAction) {
        try {
          await this.credits.reserve(workspaceId, creditCost(xAction));
        } catch (e: any) {
          // AI_CREDITS_EXHAUSTED (or any metering error) → fail THIS Twitter target
          // gracefully like any other publish error; do NOT crash the fan-out so
          // other (free) targets in the same post still publish.
          const resp = typeof e?.getResponse === 'function' ? e.getResponse() : e?.response;
          const code = resp?.code ?? e?.code;
          const reason = code
            ? `${code}: ${resp?.message ?? e?.message ?? ''}`.trim()
            : e?.message ?? 'AI credit reservation failed';
          await this.prisma.socialPostTarget.update({
            where: { id: target.id },
            data: { status: 'FAILED', error: reason.slice(0, 500) },
          });
          failedCount++;
          this.logger.warn(
            `Post ${postId} target ${target.id} (TWITTER) credit reserve failed: ${reason}`,
          );
          continue;
        }
      }

      let result;
      try {
        result = await publishToNetwork(
          target.account,
          post.content,
          selection.media.map((m) => m.url),
          {
            format,
            mediaMime: selection.media.map((m) => m.mime),
            linkedin: options.linkedin,
            tiktok: options.tiktok as any,
            // The same fact the gate above used. X is the one adapter that can
            // publish without the media it was handed (an upload it refuses is
            // swallowed to a text-only tweet), so it is the one adapter that has
            // to know whose post this is.
            mediaGeneratedForPost: mediaWasGeneratedForPost,
          },
        );
      } catch (err) {
        // An UNEXPECTED throw (not a returned {ok:false}) must also refund the
        // reserved X credits before propagating — otherwise the charge leaks. This
        // path re-throws (preserving today's behavior), so it can NEVER also reach
        // the returned-error refund below → no double-refund.
        if (xAction) await this.credits.refund(workspaceId, creditCost(xAction));
        throw err;
      }

      if (result.ok) {
        // A publish that went out but left media behind is a SUCCESS with a
        // caveat, and the caveat is the point: `videos[0]` / `mediaUrls[0]` used
        // to discard the rest with no error, no warning and no record, so a
        // five-clip concept that was CHARGED for five published one and nothing
        // anywhere said so. The row now carries the sentence. It stays PUBLISHED
        // — the post is live — and the note rides in `error`, which is the only
        // free-text column on the target and is read as "what happened here".
        //
        // TWO sources, both counted against the denominator they are true of:
        // what the SELECTOR left behind out of the whole post, and what the
        // ADAPTER left behind out of what it was handed. Folding them into one
        // number would report a fraction that is true of neither.
        const notes: string[] = [];
        if (selection.dropped) {
          notes.push(
            `${selection.dropped.count} of ${postMedia.length} media file(s) were not sent: ${selection.dropped.reason}`,
          );
        }
        if (result.droppedMedia) {
          notes.push(
            `${result.droppedMedia.count} of ${selection.media.length} media file(s) were not sent: ${result.droppedMedia.reason}`,
          );
        }
        const note = notes.length ? `published, but ${notes.join('; ')}` : null;
        if (note) {
          this.logger.warn(`Post ${postId} target ${target.id} (${target.network}) ${note}`);
        }
        await this.prisma.socialPostTarget.update({
          where: { id: target.id },
          data: {
            status: 'PUBLISHED',
            externalPostId: result.externalPostId ?? null,
            error: note?.slice(0, 500) ?? null,
          },
        });
        publishedCount++;
      } else {
        // A failed publish must not be charged — refund the reserved X credits.
        if (xAction) await this.credits.refund(workspaceId, creditCost(xAction));
        await this.prisma.socialPostTarget.update({
          where: { id: target.id },
          data: { status: 'FAILED', error: result.error?.slice(0, 500) ?? 'unknown error' },
        });
        failedCount++;
        this.logger.warn(
          `Post ${postId} target ${target.id} (${target.network}) failed: ${result.error}`,
        );
      }
    }

    // Compute the final status from the OVERALL target outcomes (targets that
    // published in a PRIOR run + those published this run) — NOT just this run's
    // count. On a crash/retry after some targets published but before the post
    // status was updated, the reaper re-runs this handler with `pendingTargets`
    // empty; a this-run-only count would then be 0 and wrongly mark an already
    // -live post FAILED (publishedAt null) — the user sees a failure for content
    // that actually went out, and may re-publish it (duplicate social posts).
    const alreadyPublished = post.targets.filter((t) => t.status === 'PUBLISHED').length;
    const totalPublished = alreadyPublished + publishedCount;
    const finalStatus = totalPublished > 0 ? 'PUBLISHED' : 'FAILED';
    await this.prisma.socialPost.update({
      where: { id: postId },
      data: {
        status: finalStatus,
        publishedAt: totalPublished > 0 ? new Date() : null,
      },
    });

    // Schedule deletion of the uploaded R2 media 7 days after a successful
    // publish (Meta has already pulled it; the objects are no longer needed).
    // Keyed on `totalPublished` too, so the retry that FINALIZES a crashed
    // publish still schedules cleanup (dedupKey makes a re-schedule a no-op).
    const hasUploads = (options.media ?? []).some((m) => m?.key);
    if (totalPublished > 0 && hasUploads && !options.mediaDeletedAt) {
      await this.scheduledJobs.schedule({
        workspaceId,
        kind: SOCIAL_MEDIA_CLEANUP_KIND,
        runAt: new Date(Date.now() + MEDIA_TTL_MS),
        payload: { postId, workspaceId },
        dedupKey: `social-media-cleanup-${postId}`,
      });
    }
  }

  /** Delete a published post's uploaded R2 objects, then mark them gone. */
  async cleanupPostMedia(postId: string, workspaceId: string): Promise<void> {
    const post = await this.prisma.socialPost.findFirst({
      where: { id: postId, workspaceId },
      select: { id: true, options: true },
    });
    if (!post) return;
    const options = (post.options as PostOptions) ?? {};
    if (options.mediaDeletedAt) return;
    const keys = (options.media ?? []).map((m) => m?.key).filter(Boolean) as string[];
    if (keys.length) {
      await this.r2.deleteKeys(keys);
      this.logger.log(`Deleted ${keys.length} R2 media object(s) for post ${postId}`);
    }
    await this.prisma.socialPost.update({
      where: { id: postId },
      data: { options: { ...options, mediaDeletedAt: new Date().toISOString() } as any },
    });
  }

  async publishNow(workspaceId: string, postId: string) {
    const post = await this.prisma.socialPost.findFirst({
      where: { id: postId, workspaceId },
      select: { id: true, status: true },
    });
    if (!post) throw new NotFoundException('Social post not found');
    if (!['DRAFT', 'SCHEDULED'].includes(post.status)) {
      throw new BadRequestException(`Cannot publish a post in status: ${post.status}`);
    }

    // publishDuePost refuses a DRAFT, and that guard has to stay: it is what
    // stops a stale queue job from publishing a post someone pulled back.
    // But "Publish now" is a person saying this IS cleared to go out, and
    // delegating without first moving the post out of DRAFT meant the endpoint
    // returned 200, the UI said "Publishing started", and nothing was ever
    // sent. Same silent success through MCP, where `jeeta.publish_social_post`
    // is approval-gated — a human approved a publish that could not happen.
    //
    // Clear it here, so the decision is recorded in the data, rather than
    // teaching the queue to ignore its own guard.
    if (post.status === 'DRAFT') {
      const cleared = await this.prisma.socialPost.updateMany({
        // Compound WHERE: two concurrent "publish now" clicks must not both
        // believe they cleared it.
        where: { id: postId, workspaceId, status: 'DRAFT' },
        data: { status: 'SCHEDULED', scheduledAt: new Date() },
      });
      if (cleared.count === 0) {
        throw new BadRequestException('This post is no longer a draft — reload and try again');
      }
    }

    await this.publishDuePost(postId, workspaceId);
    return this.getPost(workspaceId, postId);
  }

  // ────────────────────────────────────────────────────────────── Helpers

  private async assertDraftPost(workspaceId: string, postId: string) {
    const post = await this.prisma.socialPost.findFirst({
      where: { id: postId, workspaceId },
      select: { id: true, status: true, options: true },
    });
    if (!post) throw new NotFoundException('Social post not found');
    if (post.status !== 'DRAFT') {
      throw new BadRequestException('Only DRAFT posts can be edited');
    }
    return post;
  }

  private async attachTargets(
    workspaceId: string,
    postId: string,
    accountIds: string[],
  ) {
    // `enabled: false` is what disconnectAccount leaves behind when the account
    // has publish history — token blanked, row kept so the history stays
    // readable (v2.199.0). Attaching one as a target produced a post that could
    // never go out: the adapter is handed an empty access token and the target
    // lands FAILED at publish time, long after the user was told it was queued.
    const accounts = await this.prisma.socialAccount.findMany({
      where: { workspaceId, id: { in: accountIds }, enabled: true },
      select: { id: true, network: true },
    });

    // Skipping the unusable ones silently would be its own trap: a campaign
    // whose stored targetAccountIds go stale should keep publishing to the
    // accounts that still work. But landing on ZERO usable targets means the
    // post is guaranteed to publish nothing, so say so here rather than at
    // publish time.
    if (accounts.length === 0) {
      throw new BadRequestException(
        'None of the selected accounts are connected — reconnect one before publishing.',
      );
    }

    // Never re-attach an account this post ALREADY holds a target row for.
    //
    // Both callers (updatePost, schedulePost) delete the post's PENDING targets
    // and then hand this method the editor's full account list. That was safe
    // only while a post holding a PUBLISHED target could not be edited at all:
    // such a post was itself PUBLISHED or PUBLISHING, and both are refused.
    // `unschedulePost` ended that. A run that dies after publishing to
    // Instagram but before finishing Facebook strands the post in PUBLISHING
    // with one live target; thirty minutes later the operator resets it and the
    // result is a DRAFT that still carries a PUBLISHED target. The composer
    // prefills its account picker from EVERY target of the post, so the next
    // save sends that account straight back here — the deleteMany removes only
    // PENDING rows, the PUBLISHED one survives it, and a second PENDING row for
    // the same account lands beside it. `publishDuePost` fans out over every
    // PENDING target, so the customer's own feed gets the post twice.
    //
    // `skipDuplicates` below looks like it already covered this and did not: it
    // skips rows that would violate a UNIQUE constraint, and this table had
    // none — only two plain indexes. There is one now
    // (@@unique([postId, socialAccountId])) and it is the real backstop, but
    // the filter stays in front of it. A deliberate exclusion and a silently
    // skipped insert read very differently to whoever edits this next, and only
    // one of them still holds against a database whose migration has not run.
    const attached = await this.prisma.socialPostTarget.findMany({
      where: { workspaceId, postId },
      select: { socialAccountId: true },
    });
    const already = new Set(attached.map((t) => t.socialAccountId));
    const fresh = accounts.filter((a) => !already.has(a.id));

    // Everything the caller asked for is already a target — the re-selected
    // published account above is exactly this case. Nothing to create, and NOT
    // an error: the post's target set is what was requested.
    if (fresh.length === 0) return;

    await this.prisma.socialPostTarget.createMany({
      data: fresh.map((a) => ({
        workspaceId,
        postId,
        socialAccountId: a.id,
        network: a.network,
        status: 'PENDING',
      })),
      skipDuplicates: true,
    });
  }
}
