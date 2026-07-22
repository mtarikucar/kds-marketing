import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ContentAiService } from '../../ai/content-ai.service';
import { SocialPlannerService } from '../../social-planner/social-planner.service';
import { Executor } from '../strategy.types';

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
 * into a community-native staged DRAFT `SocialPost`. The copy is composed by the
 * Brand-Brain-grounded Content AI, steered toward the target community and its
 * native format (meme/tutorial/clip); the draft records the target community in
 * its options meta so a human can review it. ACTUAL Reddit/Discord/forum POSTING
 * is P5 — for now we only stage the idea. The `resultRef` is `community:<postId>`.
 * When AI is unconfigured the composer raises ServiceUnavailable; we degrade to
 * `resultRef: undefined` rather than failing the action.
 */
@Injectable()
export class CommunityEngageExecutor implements Executor {
  readonly kind = 'COMMUNITY_ENGAGE' as const;
  private readonly logger = new Logger(CommunityEngageExecutor.name);

  constructor(
    private readonly content: ContentAiService,
    private readonly planner: SocialPlannerService,
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

    const post = await this.planner.createPost(workspaceId, {
      content: body,
      // Posting to Reddit/Discord/forums is P5 — stage the idea with the target
      // community recorded in options so a human can review/route it.
      options: { channelKey: p.channelKey, community: p.community, ...(p.format ? { format: p.format } : {}) },
    });
    return { resultRef: `community:${post.id}` };
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
