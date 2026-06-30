import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../../prisma/prisma.service';
import { withAdvisoryLock } from '../../../common/scheduling/advisory-lock';
import { ChannelAdapterRegistry } from './channel-adapter.registry';
import { ConversationIngressService } from './conversation-ingress.service';
import { InboundMessage } from './channel-adapter.interface';
import { linkedinRest } from '../../../common/util/linkedin-api.util';

/**
 * Polls comments on the workspace's OWN LinkedIn organization posts and routes
 * third-party comments into the SAME conversation ingress every other channel
 * uses — the inbound half of LinkedIn's "engagement DM substitute". LinkedIn has
 * NO comment webhook, so we re-read /rest/socialActions/{postUrn}/comments on a
 * schedule; ingest()'s externalMessageId dedup (the comment id) makes re-polling
 * idempotent, so no cursor is needed.
 *
 * Workspace-scoped selection + advisory-locked single-replica tick (mirrors
 * NetgsmDlrPollService). DORMANT by default: only channels whose
 * configPublic.linkedinEngagement === 'granted' are polled, so the feature does
 * nothing until LinkedIn Community Management access is approved.
 */
@Injectable()
export class LinkedinEngagementPollService {
  private readonly logger = new Logger(LinkedinEngagementPollService.name);

  /** Only read comments on recently-published posts; older ones age out. */
  private static readonly WINDOW_DAYS = 14;
  /** Bound the post fan-out per channel per tick (rate-limit friendly). */
  private static readonly MAX_POSTS_PER_CHANNEL = 25;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ChannelAdapterRegistry,
    private readonly ingress: ConversationIngressService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'linkedin-engagement-poll' })
  async pollDue(): Promise<void> {
    await withAdvisoryLock(
      this.prisma,
      'linkedin-engagement-poll',
      async () => {
        await this.poll();
      },
      this.logger,
    );
  }

  async poll(): Promise<{ ingested: number }> {
    const since = new Date(Date.now() - LinkedinEngagementPollService.WINDOW_DAYS * 86_400_000);
    let ingested = 0;

    const workspaces = await this.prisma.workspace.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true },
    });

    for (const ws of workspaces) {
      // ACTIVE LINKEDIN channels in THIS workspace; gate filtered in code so a
      // non-granted channel never touches the post query or LinkedIn at all.
      const channels = await this.prisma.channel.findMany({
        where: { workspaceId: ws.id, type: 'LINKEDIN', status: 'ACTIVE' },
      });
      const granted = channels.filter(
        (c: any) =>
          c.configPublic &&
          typeof c.configPublic === 'object' &&
          (c.configPublic as any).linkedinEngagement === 'granted',
      );
      if (granted.length === 0) continue;

      // Recent LinkedIn org post urns published from this workspace (the posts
      // whose comment threads we own). Distinct by externalPostId.
      const targets = await this.prisma.socialPostTarget.findMany({
        where: {
          workspaceId: ws.id,
          network: 'LINKEDIN',
          status: 'PUBLISHED',
          externalPostId: { not: null },
          post: { is: { publishedAt: { gte: since } } },
        },
        select: { externalPostId: true },
        take: LinkedinEngagementPollService.MAX_POSTS_PER_CHANNEL,
      });
      const postUrns = Array.from(
        new Set(targets.map((t: any) => t.externalPostId).filter(Boolean) as string[]),
      );
      if (postUrns.length === 0) continue;

      for (const channel of granted) {
        const config = this.registry.resolveConfig(channel as any);
        const token = config.secrets.accessToken;
        const actorUrn = config.externalId != null ? String(config.externalId) : '';
        if (!token) continue;

        for (const postUrn of postUrns) {
          const res = await linkedinRest(
            `/rest/socialActions/${encodeURIComponent(postUrn)}/comments`,
            { accessToken: token, method: 'GET' },
          );
          if (!res.ok) {
            // 404 = a post with zero comments; not an error worth logging loudly.
            if (res.status !== 404) {
              this.logger.warn(
                `linkedin comments ${postUrn} failed: ${res.error?.message ?? res.status}`,
              );
            }
            continue;
          }
          const elements: any[] = res.data?.elements ?? [];
          for (const comment of elements) {
            const actor = comment?.actor != null ? String(comment.actor) : '';
            // Skip our OWN replies (echo) — same loop-guard as the DM adapter.
            if (!actor || actor === actorUrn) continue;
            const text = comment?.message?.text;
            if (typeof text !== 'string' || !text) continue;
            const inbound: InboundMessage = {
              externalUserId: actor,
              kind: 'LINKEDIN',
              externalMessageId: comment?.id != null ? String(comment.id) : null,
              text,
              displayName: null,
              raw: comment,
            };
            const out = await this.ingress.ingest(
              { id: channel.id, workspaceId: ws.id, type: 'LINKEDIN' },
              inbound,
            );
            if (out && !out.deduped) ingested += 1;
          }
        }
      }
    }

    if (ingested > 0) this.logger.log(`linkedin engagement poll: ingested ${ingested} comment(s)`);
    return { ingested };
  }
}
