import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ContentAiService } from '../../ai/content-ai.service';
import { SocialPlannerService } from '../../social-planner/social-planner.service';
import { Executor } from '../strategy.types';
import { postToDiscord, resolveDiscordWebhookUrl } from '../channels/discord.adapter';
import { isRedditConfigured, postToReddit } from '../channels/reddit.adapter';
import { CommunityChannelService } from '../channels/community-channel.service';

/** The executor-ready config a COMMUNITY_ENGAGE action carries — one native
 *  post idea aimed at a specific community the audience gathers in. */
interface CommunityPayload {
  channelKey: string;
  community: string;
  title: string;
  angle?: string;
  tone?: string;
  format?: string;
}

/**
 * COMMUNITY_ENGAGE executor — the B2C/community counterpart to the CONTENT
 * executor. It turns a "post an idea into r/<sub> / a Discord / a forum" action
 * into community-native copy composed by the Brand-Brain-grounded Content AI,
 * steered toward the target community and its native format (meme/tutorial/clip).
 *
 * P5 — LIVE POSTING (opt-in, OWNED channels only): when the target channel is
 * configured for this workspace we POST the composed copy to it directly:
 *   - `discord` → a Discord Incoming Webhook for a server you OWN.
 *   - `reddit`  → an owned/authorized subreddit via a refresh-token OAuth app.
 * SAFETY / ToS: auto-posting marketing into communities you do NOT own violates
 * Reddit/Discord ToS + subreddit/server rules, so live posting is INERT until the
 * per-workspace creds exist (see channels/*.adapter.ts for the env + framing).
 * SAFE DEFAULT: when the channel is unconfigured, is some other channel, OR the
 * live post fails for any reason, we FALL BACK to staging a human-review DRAFT
 * `SocialPost` (the target community recorded in its options meta) — the action
 * always succeeds. The `resultRef` is `discord:<id>` / `reddit:<id>` on a live
 * post, else `community:<postId>` for the staged draft. When AI is unconfigured
 * the composer raises ServiceUnavailable; we degrade to `resultRef: undefined`.
 */
@Injectable()
export class CommunityEngageExecutor implements Executor {
  readonly kind = 'COMMUNITY_ENGAGE' as const;
  private readonly logger = new Logger(CommunityEngageExecutor.name);

  constructor(
    private readonly content: ContentAiService,
    private readonly planner: SocialPlannerService,
    private readonly channels: CommunityChannelService,
  ) {}

  async run(workspaceId: string, payload: unknown): Promise<{ resultRef?: string }> {
    const p = this.parse(payload);

    let body: string;
    try {
      const composed = await this.content.compose(workspaceId, {
        kind: 'social',
        goal: p.angle ? `${p.title} — ${p.angle}` : p.title,
        tone: p.tone,
        context: this.contextLine(p),
      });
      body = composed.body;
    } catch (e) {
      if (e instanceof ServiceUnavailableException) {
        this.logger.warn(
          `community-engage executor: AI unconfigured for ws ${workspaceId} — skipping draft for "${p.title}" in ${p.community}`,
        );
        return { resultRef: undefined };
      }
      throw e;
    }

    // P5 — try a live post to an OWNED, configured channel. Any failure degrades
    // to the staged draft below (never throws), so the action always succeeds.
    const live = await this.tryLivePost(workspaceId, p, body);
    if (live) return live;

    const post = await this.planner.createPost(workspaceId, {
      content: body,
      // Unconfigured / other channel / live-post failure → stage the idea with the
      // target community recorded in options so a human can review/route/post it.
      options: { channelKey: p.channelKey, community: p.community, ...(p.format ? { format: p.format } : {}) },
    });
    return { resultRef: `community:${post.id}` };
  }

  /**
   * Attempt to publish `body` to the payload's channel when that channel is
   * configured for OWNED-channel posting. Returns the live `resultRef` on success,
   * or `null` to signal "fall back to staging a draft" (unconfigured, other
   * channel, or a post failure). Never throws.
   */
  private async tryLivePost(
    workspaceId: string,
    p: CommunityPayload,
    body: string,
  ): Promise<{ resultRef: string } | null> {
    if (p.channelKey === 'discord') {
      // Resolve THIS workspace's own connected Discord webhook (sealed); global env
      // is only a last-resort fallback inside the adapter.
      const webhookUrl = await resolveDiscordWebhookUrl(workspaceId, this.channels);
      if (!webhookUrl) return null; // not connected → stage a draft
      const r = await postToDiscord(webhookUrl, { content: body });
      if (r.ok) return { resultRef: `discord:${r.id ?? ''}` };
      this.logger.warn(
        `community-engage: Discord post failed for ws ${workspaceId} ("${p.title}"): ${r.error} — staging draft instead`,
      );
      return null;
    }
    if (p.channelKey === 'reddit') {
      // Inert unless this workspace connected its OWN Reddit account AND env creds exist.
      if (!(await isRedditConfigured(workspaceId, this.channels))) return null; // → stage a draft
      // The subreddit MUST be one you own/are authorized to post in — the caller
      // (strategy synthesis) is responsible for only targeting such communities.
      const r = await postToReddit(workspaceId, this.channels, { subreddit: p.community, title: p.title, text: body });
      if (r.ok) return { resultRef: `reddit:${r.id ?? ''}` };
      this.logger.warn(
        `community-engage: Reddit submit failed for ws ${workspaceId} ("${p.title}" → ${p.community}): ${r.error} — staging draft instead`,
      );
      return null;
    }
    return null; // other channel (forum/etc.) → stage a draft (P5 covers discord+reddit)
  }

  private contextLine(p: CommunityPayload): string {
    return [
      `Community: ${p.community} (${p.channelKey})`,
      p.format ? `Native format: ${p.format}` : '',
      'Write copy that reads as a native member of this community, not an ad.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private parse(payload: unknown): CommunityPayload {
    if (!payload || typeof payload !== 'object') {
      throw new BadRequestException('COMMUNITY_ENGAGE payload must be an object with a community and title');
    }
    const p = payload as Record<string, unknown>;
    const community = typeof p.community === 'string' ? p.community.trim() : '';
    if (!community) {
      throw new BadRequestException('COMMUNITY_ENGAGE payload requires a non-empty community');
    }
    const title = typeof p.title === 'string' ? p.title.trim() : '';
    if (!title) {
      throw new BadRequestException('COMMUNITY_ENGAGE payload requires a non-empty title');
    }
    const channelKey = typeof p.channelKey === 'string' && p.channelKey.trim() ? p.channelKey.trim() : 'community';
    return {
      channelKey,
      community,
      title,
      angle: typeof p.angle === 'string' && p.angle.trim() ? p.angle.trim() : undefined,
      tone: typeof p.tone === 'string' && p.tone.trim() ? p.tone.trim() : undefined,
      format: typeof p.format === 'string' && p.format.trim() ? p.format.trim() : undefined,
    };
  }
}
