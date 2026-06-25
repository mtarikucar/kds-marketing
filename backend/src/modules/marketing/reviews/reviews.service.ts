import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { sealSecret } from '../../../common/crypto/secret-box.helper';
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
  /** Sources with the sealed sync token masked out (only a `tokenSet` flag). */
  async listSources(workspaceId: string) {
    const rows = await this.prisma.reviewSource.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } });
    return rows.map(({ accessToken, ...r }: any) => ({ ...r, tokenSet: !!accessToken }));
  }
  createSource(workspaceId: string, dto: { name: string; placeUrl: string; type?: string }) {
    return this.prisma.reviewSource.create({ data: { workspaceId, name: dto.name, placeUrl: dto.placeUrl, type: dto.type ?? 'GOOGLE' } });
  }
  async updateSource(workspaceId: string, id: string, dto: any) {
    const existing = await this.prisma.reviewSource.findFirst({ where: { id, workspaceId } });
    if (!existing) throw new NotFoundException('Source not found');
    const data: any = {};
    for (const k of ['name', 'placeUrl', 'type', 'placeId', 'externalRef', 'syncStatus'] as const) {
      if (dto[k] !== undefined) data[k] = dto[k];
    }
    // A raw sync token (Epic 13 review-sync) is sealed at rest; never stored
    // plaintext, never echoed (listSources masks it).
    if (typeof dto.accessToken === 'string' && dto.accessToken.length > 0) {
      data.accessToken = sealSecret(dto.accessToken);
    } else if (dto.accessToken === null) {
      data.accessToken = null; // explicit disconnect
    }
    const { accessToken, ...row }: any = await this.prisma.reviewSource.update({ where: { id: existing.id }, data });
    return { ...row, tokenSet: !!accessToken };
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

  /** Re-derive the public redirect for an already-routed review (no write). */
  private async routedUrl(review: { status: string; sourceId: string | null; workspaceId: string }): Promise<string | null> {
    if (review.status !== 'PUBLIC_ROUTED' || !review.sourceId) return null;
    const source = await this.prisma.reviewSource.findFirst({ where: { id: review.sourceId, workspaceId: review.workspaceId }, select: { placeUrl: true } });
    return source?.placeUrl ?? null;
  }

  /** Public gate: a submitted rating routes public (≥4) or captures private (<4). */
  async submitRating(token: string, rating: number, text?: string, authorName?: string): Promise<{ redirectUrl: string | null }> {
    // The gate is public and the token is the only credential — validate the
    // rating strictly (the old Math.round/clamp turned 0/-3/999/NaN into a valid
    // star instead of rejecting them).
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new BadRequestException('Rating must be an integer from 1 to 5');
    }
    const review = await this.prisma.review.findUnique({ where: { token } });
    if (!review) throw new NotFoundException('Review link not found');

    // First submission wins. A review link can be forwarded, re-opened, or
    // shared via QR, so anyone with it could otherwise overwrite a submitted
    // rating/text (e.g. flip a 5★ to 1★ + abuse). Only a REQUESTED review is
    // writable; a re-submit is a safe no-op that re-derives the redirect.
    if (review.status !== 'REQUESTED') {
      return { redirectUrl: await this.routedUrl(review) };
    }

    let redirectUrl: string | null = null;
    let status = 'PRIVATE_FEEDBACK';
    if (rating >= PUBLIC_THRESHOLD) {
      status = 'PUBLIC_ROUTED';
      if (review.sourceId) {
        const source = await this.prisma.reviewSource.findFirst({ where: { id: review.sourceId, workspaceId: review.workspaceId }, select: { placeUrl: true } });
        redirectUrl = source?.placeUrl ?? null;
      }
    }
    await this.prisma.review.update({
      where: { id: review.id },
      data: { rating, text: text?.slice(0, 4000) ?? null, authorName: authorName?.slice(0, 200) ?? null, status },
    });
    await this.outbox.append({
      type: MarketingEventTypes.ReviewReceived,
      idempotencyKey: `review-received:${review.id}`,
      payload: { workspaceId: review.workspaceId, reviewId: review.id, leadId: review.leadId, rating, public: rating >= PUBLIC_THRESHOLD, occurredAt: new Date().toISOString() },
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
