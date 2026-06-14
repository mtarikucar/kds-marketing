import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { DomainEventBus } from '../outbox/domain-event-bus.service';
import { MarketingEventTypes } from '../marketing/events/marketing-event-types';
import { RoutineTriggerService } from './routine-trigger.service';
import { withAdvisoryXactLock } from '../../common/scheduling/advisory-lock';

/**
 * Subscribes to domain events that should reactively trigger routines.
 *
 * - `marketing.review.received.v1` with status PRIVATE_FEEDBACK
 *   → triggers 'review-draft' (draft a reply to private feedback).
 * - `marketing.lead.created.v1`
 *   → triggers 'lead-scoring' (score the new lead).
 *
 * Handlers are wrapped in withAdvisoryXactLock for multi-replica safety:
 * only one replica will fire the trigger per event, preventing duplicate
 * API calls when all replicas receive the same domain event.
 *
 * Handlers never throw — they catch and log errors. The enabled/cooldown
 * gating lives in RoutineTriggerService.trigger(), so this service just
 * calls trigger and lets the service decide whether to fire.
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
    this.logger.log('Subscribed to review.received and lead.created events');
  }

  // ── handlers ───────────────────────────────────────────────────────────────

  private async onReviewReceived(event: { payload: { status?: string } }): Promise<void> {
    try {
      const status = (event.payload as { status?: string })?.status;
      if (status !== 'PRIVATE_FEEDBACK') return;

      this.logger.debug('Review PRIVATE_FEEDBACK received — triggering review-draft');
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
}
