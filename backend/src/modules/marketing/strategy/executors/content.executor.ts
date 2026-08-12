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

  async run(
    workspaceId: string,
    payload: unknown,
    action?: { title: string; rationale: string },
  ): Promise<{ resultRef?: string }> {
    const p = this.parse(payload, action);

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

  private parse(payload: unknown, action?: { title: string; rationale: string }): ContentPayload {
    if (!payload || typeof payload !== 'object') {
      throw new BadRequestException('CONTENT payload must be an object with a title');
    }
    const p = payload as Record<string, unknown>;
    // The strategist writes the human-facing title on the ACTION (that is what
    // the submit schema asks of it); payload.title is an optional override.
    // Demanding a duplicate inside the payload failed real actions whose
    // titles were perfectly good — likewise the action's rationale is the
    // natural angle when the payload doesn't carry one.
    const title =
      (typeof p.title === 'string' ? p.title.trim() : '') || action?.title?.trim() || '';
    if (!title) {
      throw new BadRequestException('CONTENT payload requires a non-empty title');
    }
    const rawAngle = typeof p.angle === 'string' && p.angle.trim() ? p.angle.trim() : undefined;
    return {
      title,
      angle: rawAngle ?? (action?.rationale?.trim() || undefined),
      formats: Array.isArray(p.formats) ? p.formats.filter((f): f is string => typeof f === 'string') : undefined,
      tone: typeof p.tone === 'string' && p.tone.trim() ? p.tone.trim() : undefined,
      channelKey: typeof p.channelKey === 'string' && p.channelKey.trim() ? p.channelKey.trim() : undefined,
    };
  }
}
