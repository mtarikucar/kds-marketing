import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { OutboxService } from '../../outbox/outbox.service';
import { AnthropicService } from '../ai/anthropic.service';
import { AiCreditsService } from '../ai/ai-credits.service';
import { creditCost, tierFor } from '../ai/ai-credit-costs';
import { MarketingEventTypes } from '../events/marketing-event-types';

/** Rating at/above which we route to the public review site; below, private. */
const PUBLIC_THRESHOLD = 4;

/**
 * Reviews / reputation. A review request mints a Review (REQUESTED + token) and
 * the lead gets the rating-gate link: ≥4 stars routes to the public source
 * (Google) for a real review; <4 captures private feedback instead (so unhappy
 * customers vent to you, not publicly). The team can AI-draft replies.
 */
@Injectable()
export class ReviewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly outbox: OutboxService,
    private readonly anthropic: AnthropicService,
    private readonly credits: AiCreditsService,
  ) {}

  // ---- sources ----
  listSources(workspaceId: string) {
    return this.prisma.reviewSource.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } });
  }
  createSource(workspaceId: string, dto: { name: string; placeUrl: string; type?: string }) {
    return this.prisma.reviewSource.create({ data: { workspaceId, name: dto.name, placeUrl: dto.placeUrl, type: dto.type ?? 'GOOGLE' } });
  }
  async updateSource(workspaceId: string, id: string, dto: any) {
    const existing = await this.prisma.reviewSource.findFirst({ where: { id, workspaceId } });
    if (!existing) throw new NotFoundException('Source not found');
    const data: any = {};
    for (const k of ['name', 'placeUrl', 'type'] as const) if (dto[k] !== undefined) data[k] = dto[k];
    return this.prisma.reviewSource.update({ where: { id: existing.id }, data });
  }
  async removeSource(workspaceId: string, id: string) {
    const res = await this.prisma.reviewSource.deleteMany({ where: { id, workspaceId } });
    if (res.count === 0) throw new NotFoundException('Source not found');
    return { message: 'Source deleted' };
  }

  // ---- reviews ----
  list(workspaceId: string) {
    return this.prisma.review.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  /** Create a review request for a lead and return the rating-gate link. */
  async requestReview(workspaceId: string, leadId: string | null): Promise<{ reviewId: string; gateUrl: string }> {
    const source = await this.prisma.reviewSource.findFirst({ where: { workspaceId }, orderBy: { createdAt: 'asc' }, select: { id: true } });
    const review = await this.prisma.review.create({
      data: { workspaceId, leadId: leadId ?? null, sourceId: source?.id ?? null, status: 'REQUESTED', token: `rv_${randomBytes(16).toString('hex')}` },
    });
    const base = this.config.get<string>('PUBLIC_BASE_URL') ?? '';
    return { reviewId: review.id, gateUrl: `${base}/api/public/r/${review.token}` };
  }

  /** Public gate: a submitted rating routes public (≥4) or captures private (<4). */
  async submitRating(token: string, rating: number, text?: string, authorName?: string): Promise<{ redirectUrl: string | null }> {
    const review = await this.prisma.review.findUnique({ where: { token } });
    if (!review) throw new NotFoundException('Review link not found');
    const clamped = Math.max(1, Math.min(5, Math.round(rating)));
    let redirectUrl: string | null = null;
    let status = 'PRIVATE_FEEDBACK';
    if (clamped >= PUBLIC_THRESHOLD) {
      status = 'PUBLIC_ROUTED';
      if (review.sourceId) {
        const source = await this.prisma.reviewSource.findFirst({ where: { id: review.sourceId, workspaceId: review.workspaceId }, select: { placeUrl: true } });
        redirectUrl = source?.placeUrl ?? null;
      }
    }
    await this.prisma.review.update({
      where: { id: review.id },
      data: { rating: clamped, text: text?.slice(0, 4000) ?? null, authorName: authorName?.slice(0, 200) ?? null, status },
    });
    await this.outbox.append({
      type: MarketingEventTypes.ReviewReceived,
      idempotencyKey: `review-received:${review.id}`,
      payload: { workspaceId: review.workspaceId, reviewId: review.id, leadId: review.leadId, rating: clamped, public: clamped >= PUBLIC_THRESHOLD, occurredAt: new Date().toISOString() },
    });
    return { redirectUrl };
  }

  async draftReply(workspaceId: string, reviewId: string): Promise<{ replyDraft: string }> {
    if (!this.anthropic.isEnabled()) throw new ServiceUnavailableException('AI is not configured');
    const review = await this.prisma.review.findFirst({ where: { id: reviewId, workspaceId } });
    if (!review) throw new NotFoundException('Review not found');
    await this.credits.reserve(workspaceId, creditCost('review.reply_draft'));
    try {
      const res = await this.anthropic.complete({
        system: 'You are a business owner replying to a customer review. Write a short, warm, professional reply. If the review is negative, acknowledge + offer to make it right, never argue.',
        messages: [{ role: 'user', content: `Rating: ${review.rating ?? '?'}/5\nReview: ${review.text ?? '(no text)'}` }],
        maxTokens: 400,
        tier: tierFor('review.reply_draft'),
      });
      const draft = res.text.trim();
      await this.prisma.review.update({ where: { id: review.id }, data: { replyDraft: draft } });
      return { replyDraft: draft };
    } catch (e) {
      await this.credits.refund(workspaceId, creditCost('review.reply_draft'));
      throw e;
    }
  }

  async saveReply(workspaceId: string, reviewId: string, text: string) {
    const review = await this.prisma.review.findFirst({ where: { id: reviewId, workspaceId }, select: { id: true } });
    if (!review) throw new NotFoundException('Review not found');
    return this.prisma.review.update({ where: { id: review.id }, data: { replyText: text, status: 'REPLIED' } });
  }
}
