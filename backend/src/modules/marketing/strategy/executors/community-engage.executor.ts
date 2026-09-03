import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ContentAiService } from '../../ai/content-ai.service';
import { BrandSafetyService } from '../../ai/brand-safety.service';
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
 * BRAND SAFETY: nothing reaches a live community until `BrandSafetyService` has
 * read it — the same screen, the same instance and the same credit cost as the
 * social-campaign publisher, because a rule that holds on one publish path and
 * not another is not a rule. `tryLivePost` owns the fail policy and justifies it.
 */
@Injectable()
export class CommunityEngageExecutor implements Executor {
  readonly kind = 'COMMUNITY_ENGAGE' as const;
  private readonly logger = new Logger(CommunityEngageExecutor.name);

  constructor(
    private readonly content: ContentAiService,
    private readonly planner: SocialPlannerService,
    private readonly channels: CommunityChannelService,
    private readonly brandSafety: BrandSafetyService,
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

    // P5 — try a live post to an OWNED, configured channel. Every "cannot post"
    // degrades to the staged draft below; the ONE case that throws is a
    // brand-safety refusal, which must not become a draft (see `tryLivePost`).
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
   * channel, an unreadable brand-safety verdict, or a post failure). Throws only
   * when the screen REFUSED the copy.
   *
   * THE SCREEN RUNS ONLY ONCE A LIVE TARGET EXISTS. It costs a credit and a
   * provider call, and the draft path publishes nothing — it puts the copy in
   * front of a person, which is a strictly stronger review than this one. So the
   * order is: is there a live target at all → screen → post. That is also where
   * the rest of the product screens: `SocialCampaignsService.confirmItem` checks
   * immediately before `schedulePost`, not when the draft is written.
   *
   * FAIL-CLOSED, and it is the opposite of what the social-campaign path does.
   * That path fails OPEN on an unreadable verdict because a person built the
   * campaign, can see the item, and a provider outage should not strand a chain
   * they started. Nobody is watching this one: the AUTONOMOUS lane exists so the
   * owner never has to look, the copy was written by an LLM minutes ago, and the
   * destination is someone else's community where a bad post is not retractable
   * and costs the customer their standing, not a retry. So when the reviewer did
   * not run, we do not publish — we fall back to the SAME staged draft this
   * executor already uses for every other "cannot safely post" case, and a human
   * decides. Nothing is lost and no action fails.
   *
   * A REFUSAL IS NOT A DRAFT. On BLOCK we throw, which the orchestrator records
   * as FAILED with the reason and the daily brief reports verbatim. Staging it
   * instead would put copy a reviewer just called hate/harassment/explicit one
   * click from publishing in the customer's own planner — and, worse, the action
   * would come back DONE with a `resultRef`, so the brief would report the
   * refusal as work applied.
   */
  private async tryLivePost(
    workspaceId: string,
    p: CommunityPayload,
    body: string,
  ): Promise<{ resultRef: string } | null> {
    const target = await this.resolveLiveTarget(workspaceId, p);
    if (!target) return null; // not connected / other channel → stage a draft

    const verdict = await this.brandSafety.screen(workspaceId, this.publishedText(p, body));
    if (verdict === 'BLOCK') {
      throw new BadRequestException(
        `marka güvenliği kontrolü bu metni engelledi — ${p.community} (${p.channelKey}) için hiçbir şey yayınlanmadı`,
      );
    }
    if (verdict === 'UNAVAILABLE') {
      this.logger.warn(
        `community-engage: brand-safety screen could not run for ws ${workspaceId} ("${p.title}" → ${p.community}) — staging a draft instead of posting live`,
      );
      return null;
    }

    if (target.kind === 'discord') {
      const r = await postToDiscord(target.webhookUrl, { content: body });
      if (r.ok) return { resultRef: `discord:${r.id ?? ''}` };
      this.logger.warn(
        `community-engage: Discord post failed for ws ${workspaceId} ("${p.title}"): ${r.error} — staging draft instead`,
      );
      return null;
    }
    // The subreddit MUST be one you own/are authorized to post in — the caller
    // (strategy synthesis) is responsible for only targeting such communities.
    const r = await postToReddit(workspaceId, this.channels, { subreddit: p.community, title: p.title, text: body });
    if (r.ok) return { resultRef: `reddit:${r.id ?? ''}` };
    this.logger.warn(
      `community-engage: Reddit submit failed for ws ${workspaceId} ("${p.title}" → ${p.community}): ${r.error} — staging draft instead`,
    );
    return null;
  }

  /**
   * Which live channel, if any, this action can actually post to. Resolved
   * BEFORE the screen so an unconfigured workspace never pays for one, and
   * separated from the posting so there is exactly one place a live target is
   * decided and exactly one screen between that decision and the post.
   */
  private async resolveLiveTarget(
    workspaceId: string,
    p: CommunityPayload,
  ): Promise<{ kind: 'discord'; webhookUrl: string } | { kind: 'reddit' } | null> {
    if (p.channelKey === 'discord') {
      // Resolve THIS workspace's own connected Discord webhook (sealed).
      const webhookUrl = await resolveDiscordWebhookUrl(workspaceId, this.channels);
      return webhookUrl ? { kind: 'discord', webhookUrl } : null;
    }
    if (p.channelKey === 'reddit') {
      // Inert unless this workspace connected its OWN Reddit account AND env creds exist.
      return (await isRedditConfigured(workspaceId, this.channels)) ? { kind: 'reddit' } : null;
    }
    return null; // other channel (forum/etc.) → stage a draft (P5 covers discord+reddit)
  }

  /**
   * Exactly the text that would reach the community — screening less than what
   * gets published is not screening what gets published. Reddit sends a title
   * as well as a body, and a title is the part everyone in the subreddit reads.
   */
  private publishedText(p: CommunityPayload, body: string): string {
    return p.channelKey === 'reddit' ? `${p.title}\n\n${body}` : body;
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
