import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { DomainEventBus } from '../outbox/domain-event-bus.service';
import { MarketingEventTypes } from '../marketing/events/marketing-event-types';
import { RoutineTriggerService } from './routine-trigger.service';
import { withAdvisoryXactLock } from '../../common/scheduling/advisory-lock';

/**
 * Subscribes to domain events that should reactively trigger routines.
 *
 * - `marketing.review.received.v1` with public===false (private feedback)
 *   → triggers 'review-draft' (draft a reply to private feedback).
 * - `marketing.lead.created.v1`
 *   → triggers 'lead-scoring' (score the new lead).
 * - `marketing.conversation.message.received.v1`
 *   → triggers 'inbox-reply' (a customer is waiting on an answer).
 *
 * Handlers are wrapped in withAdvisoryXactLock for multi-replica safety:
 * only one replica will fire the trigger per event, preventing duplicate
 * API calls when all replicas receive the same domain event.
 *
 * Handlers never throw — they catch and log errors. The enabled/cooldown
 * gating lives in RoutineTriggerService.trigger(), so this service just
 * calls trigger and lets the service decide whether to fire.
 *
 * Event payload shape (marketing.review.received.v1):
 *   { workspaceId, reviewId, leadId, rating, public, occurredAt }
 * private = public:false (rating < 4); public = public:true (rating >= 4).
 */
@Injectable()
export class RoutineEventListener implements OnModuleInit {
  private readonly logger = new Logger(RoutineEventListener.name);

  constructor(
    private readonly domainEventBus: DomainEventBus,
    private readonly routineTriggerService: RoutineTriggerService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.domainEventBus.on(MarketingEventTypes.ReviewReceived, this.onReviewReceived.bind(this));
    this.domainEventBus.on(MarketingEventTypes.LeadCreated, this.onLeadCreated.bind(this));
    this.domainEventBus.on(
      MarketingEventTypes.ConversationMessageReceived,
      this.onCustomerWrote.bind(this),
    );
    this.logger.log(
      'Subscribed to review.received, lead.created and conversation.message.received events',
    );
  }

  // ── handlers ───────────────────────────────────────────────────────────────

  private async onReviewReceived(event: { payload: { public?: boolean } }): Promise<void> {
    try {
      // Gate on the real payload field: public===false means private feedback.
      // The emitter (reviews.service.ts submitRating) sends { workspaceId, reviewId,
      // leadId, rating, public, occurredAt } — there is no 'status' field.
      if ((event.payload as { public?: boolean })?.public !== false) return;

      this.logger.debug('Review private feedback received (public:false) — triggering review-draft');
      await withAdvisoryXactLock(
        this.prisma,
        'routine-event:review-draft',
        () => this.routineTriggerService.trigger('review-draft', 'event').then(() => undefined),
        { logger: this.logger },
      );
    } catch (err) {
      this.logger.error(
        `review.received handler error: ${(err as Error)?.message ?? err}`,
        (err as Error)?.stack,
      );
    }
  }

  private async onLeadCreated(_event: unknown): Promise<void> {
    try {
      this.logger.debug('lead.created event received — triggering lead-scoring');
      await withAdvisoryXactLock(
        this.prisma,
        'routine-event:lead-scoring',
        () => this.routineTriggerService.trigger('lead-scoring', 'event').then(() => undefined),
        { logger: this.logger },
      );
    } catch (err) {
      this.logger.error(
        `lead.created handler error: ${(err as Error)?.message ?? err}`,
        (err as Error)?.stack,
      );
    }
  }

  /**
   * A customer wrote in. Wake whoever answers.
   *
   * This is the one handler here that replaces a POLL rather than adding a
   * behaviour. The connector lane queues a reply and MCP cannot wake the
   * connector — it is client-to-server only — so the only alternative was a
   * Claude that asked "anything for me?" every few minutes and found an empty
   * queue almost every time. `triggerUrl` is a different mechanism entirely: an
   * HTTPS call to a claude.ai task endpoint, and it is push.
   *
   * Fired on the message rather than on the enqueue, deliberately. The enqueue
   * is a decision made per workspace (aiExecution, aiPaused, whether an agent
   * is attached) and a trigger keyed to it would have to reach across into that
   * decision to know it happened. An inbound message is the plain fact, the
   * cooldown in `RoutineTriggerService` bounds the rate, and a trigger that
   * wakes a Claude which then finds nothing queued costs one empty check —
   * which is exactly what the poll was doing every few minutes anyway, only
   * now it happens when somebody actually wrote.
   */
  private async onCustomerWrote(_event: unknown): Promise<void> {
    try {
      await withAdvisoryXactLock(
        this.prisma,
        'routine-event:inbox-reply',
        () => this.routineTriggerService.trigger('inbox-reply', 'event').then(() => undefined),
        { logger: this.logger },
      );
    } catch (err) {
      this.logger.error(
        `conversation.message.received handler error: ${(err as Error)?.message ?? err}`,
        (err as Error)?.stack,
      );
    }
  }
}
