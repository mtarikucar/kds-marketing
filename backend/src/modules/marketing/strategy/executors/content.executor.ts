import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ContentAiService } from '../../ai/content-ai.service';
import { SocialPlannerService } from '../../social-planner/social-planner.service';
import { Executor } from '../strategy.types';

/** The executor-ready config a CONTENT action carries — one content pillar the
 *  synthesis wants drafted into a staged post. */
interface ContentPayload {
  title: string;
  angle?: string;
  formats?: string[];
  tone?: string;
  channelKey?: string;
}

/**
 * CONTENT executor — turns a content-pillar action into a staged DRAFT
 * `SocialPost`. It composes the copy with the Brand-Brain-grounded Content AI,
 * then stages it (no target, no schedule) so it lands in the Social Planner
 * queue for human review/scheduling. The `resultRef` is `post:<postId>`. When
 * AI is unconfigured the composer raises ServiceUnavailable; we degrade to
 * `resultRef: undefined` rather than failing the action.
 */
@Injectable()
export class ContentExecutor implements Executor {
  readonly kind = 'CONTENT' as const;
  private readonly logger = new Logger(ContentExecutor.name);

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
        this.logger.warn(`content executor: AI unconfigured for ws ${workspaceId} — skipping draft for "${p.title}"`);
        return { resultRef: undefined };
      }
      throw e;
    }

    const post = await this.planner.createPost(workspaceId, { content: body });
    return { resultRef: `post:${post.id}` };
  }

  private contextLine(p: ContentPayload): string | undefined {
    const parts = [
      p.channelKey ? `Channel: ${p.channelKey}` : '',
      p.formats?.length ? `Formats: ${p.formats.join(', ')}` : '',
    ].filter(Boolean);
    return parts.length ? parts.join('\n') : undefined;
  }

  private parse(payload: unknown): ContentPayload {
    if (!payload || typeof payload !== 'object') {
      throw new BadRequestException('CONTENT payload must be an object with a title');
    }
    const p = payload as Record<string, unknown>;
    const title = typeof p.title === 'string' ? p.title.trim() : '';
    if (!title) {
      throw new BadRequestException('CONTENT payload requires a non-empty title');
    }
    return {
      title,
      angle: typeof p.angle === 'string' && p.angle.trim() ? p.angle.trim() : undefined,
      formats: Array.isArray(p.formats) ? p.formats.filter((f): f is string => typeof f === 'string') : undefined,
      tone: typeof p.tone === 'string' && p.tone.trim() ? p.tone.trim() : undefined,
      channelKey: typeof p.channelKey === 'string' && p.channelKey.trim() ? p.channelKey.trim() : undefined,
    };
  }
}
