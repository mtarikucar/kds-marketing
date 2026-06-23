import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { ScheduledJobService } from '../scheduling/scheduled-job.service';
import { ScheduledJobRunnerService, ClaimedJob } from '../scheduling/scheduled-job-runner.service';
import {
  sealSecret,
  openSecret,
  isSecretBoxConfigured,
  maskSecret,
} from '../../../common/crypto/secret-box.helper';
import { publishToNetwork, isNetworkConfigured } from './network-adapters';
import { queryCreatorInfo } from './tiktok-creator-info.util';

export const SOCIAL_PUBLISH_KIND = 'social.publish';

const NETWORKS = ['FACEBOOK', 'INSTAGRAM', 'LINKEDIN', 'TIKTOK', 'TWITTER', 'PINTEREST', 'GMB'] as const;
type Network = (typeof NETWORKS)[number];

function assertNetwork(network: string): asserts network is Network {
  if (!NETWORKS.includes(network as Network)) {
    throw new BadRequestException(`network must be one of: ${NETWORKS.join(', ')}`);
  }
}

/** Mask the access token in a SocialAccount row before returning to API callers. */
function maskAccount(row: any) {
  return { ...row, accessToken: maskSecret(row.accessToken, 4) };
}

@Injectable()
export class SocialPlannerService implements OnModuleInit {
  private readonly logger = new Logger(SocialPlannerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduledJobs: ScheduledJobService,
    private readonly runner: ScheduledJobRunnerService,
  ) {}

  onModuleInit(): void {
    this.runner.registerHandler(SOCIAL_PUBLISH_KIND, (job: ClaimedJob) =>
      this.publishDuePost(job.payload.postId, job.payload.workspaceId),
    );
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
      },
      update: {
        displayName: dto.displayName,
        accessToken: sealed,
        tokenExpiresAt: dto.tokenExpiresAt ?? null,
        enabled: true,
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

  async disconnectAccount(workspaceId: string, accountId: string) {
    const existing = await this.prisma.socialAccount.findFirst({
      where: { id: accountId, workspaceId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Social account not found');
    await this.prisma.socialAccount.delete({ where: { id: accountId } });
    return { deleted: true };
  }

  async networkStatus(workspaceId: string) {
    return {
      FACEBOOK: isNetworkConfigured('FACEBOOK'),
      INSTAGRAM: isNetworkConfigured('INSTAGRAM'),
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
    },
  ) {
    const post = await this.prisma.socialPost.create({
      data: {
        workspaceId,
        content: dto.content,
        mediaUrls: dto.mediaUrls ?? [],
        status: 'DRAFT',
      },
    });

    if (dto.targetAccountIds?.length) {
      await this.attachTargets(workspaceId, post.id, dto.targetAccountIds);
    }

    return this.getPost(workspaceId, post.id);
  }

  async listPosts(workspaceId: string) {
    return this.prisma.socialPost.findMany({
      where: { workspaceId },
      include: { targets: true },
      orderBy: { createdAt: 'desc' },
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
    dto: { content?: string; mediaUrls?: string[] },
  ) {
    await this.assertDraftPost(workspaceId, postId);
    return this.prisma.socialPost.update({
      where: { id: postId },
      data: {
        ...(dto.content !== undefined ? { content: dto.content } : {}),
        ...(dto.mediaUrls !== undefined ? { mediaUrls: dto.mediaUrls } : {}),
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
  ) {
    const post = await this.prisma.socialPost.findFirst({
      where: { id: postId, workspaceId },
      include: { targets: true },
    });
    if (!post) throw new NotFoundException('Social post not found');
    if (!['DRAFT', 'SCHEDULED'].includes(post.status)) {
      throw new BadRequestException(`Cannot schedule a post in status: ${post.status}`);
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

    await this.prisma.socialPost.update({
      where: { id: postId },
      data: { status: 'PUBLISHING' },
    });

    const pendingTargets = post.targets.filter((t) => t.status === 'PENDING');
    let publishedCount = 0;
    let failedCount = 0;

    for (const target of pendingTargets) {
      const result = await publishToNetwork(
        target.account,
        post.content,
        post.mediaUrls as string[],
        (post.options as any) ?? undefined,
      );

      if (result.ok) {
        await this.prisma.socialPostTarget.update({
          where: { id: target.id },
          data: { status: 'PUBLISHED', externalPostId: result.externalPostId ?? null, error: null },
        });
        publishedCount++;
      } else {
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

    const finalStatus =
      publishedCount > 0 ? 'PUBLISHED' : 'FAILED';
    await this.prisma.socialPost.update({
      where: { id: postId },
      data: {
        status: finalStatus,
        publishedAt: publishedCount > 0 ? new Date() : null,
      },
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

    await this.publishDuePost(postId, workspaceId);
    return this.getPost(workspaceId, postId);
  }

  // ────────────────────────────────────────────────────────────── Helpers

  private async assertDraftPost(workspaceId: string, postId: string) {
    const post = await this.prisma.socialPost.findFirst({
      where: { id: postId, workspaceId },
      select: { id: true, status: true },
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
    const accounts = await this.prisma.socialAccount.findMany({
      where: { workspaceId, id: { in: accountIds } },
      select: { id: true, network: true },
    });
    if (accounts.length === 0) return;

    await this.prisma.socialPostTarget.createMany({
      data: accounts.map((a) => ({
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
