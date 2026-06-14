/**
 * RoutineEventListener — plain-instantiation spec.
 *
 * Covers:
 *   - review event with public:false (private feedback) → trigger('review-draft', 'event')
 *   - review event with public:true → no trigger call
 *   - lead.created event → trigger('lead-scoring', 'event')
 *   - handler errors do not propagate (catch+log)
 *   - subscriptions are registered on onModuleInit
 *
 * Uses the REAL payload shape from reviews.service.ts submitRating:
 *   { workspaceId, reviewId, leadId, rating, public, occurredAt }
 */

// ── mock withAdvisoryXactLock — pass-through so trigger() is called ──────────
const mockWithAdvisoryXactLock = jest.fn().mockImplementation(
  async (_prisma: unknown, _jobName: string, run: () => Promise<void>) => {
    await run();
  },
);
jest.mock('../../common/scheduling/advisory-lock', () => ({
  withAdvisoryXactLock: (...args: unknown[]) => mockWithAdvisoryXactLock(...args),
}));

import { DomainEvent } from '../outbox/domain-event-bus.service';
import { RoutineEventListener } from './routine-event-listener.service';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeDomainEventBus() {
  const handlers = new Map<string, (event: DomainEvent) => void | Promise<void>>();
  return {
    on: jest.fn().mockImplementation((type: string, handler: (event: DomainEvent) => void) => {
      handlers.set(type, handler);
    }),
    _handlers: handlers,
    /** Dispatch an event directly to the registered handler (test helper). */
    async dispatch(type: string, event: Partial<DomainEvent>) {
      const h = handlers.get(type);
      if (h) await h(event as DomainEvent);
    },
  };
}

function makeTriggerService() {
  return {
    trigger: jest.fn().mockResolvedValue({ ok: true }),
  };
}

function makePrismaService() {
  return {
    $transaction: jest.fn().mockResolvedValue(undefined),
  };
}

/**
 * Builds a review event with the REAL payload shape from reviews.service.ts.
 * private=true → public:false (rating < 4, private feedback).
 * private=false → public:true (rating >= 4, publicly routed).
 */
function makeReviewEvent(isPrivate: boolean, rating = isPrivate ? 2 : 5): Partial<DomainEvent> {
  return {
    id: 'evt-1',
    type: 'marketing.review.received.v1',
    tenantId: 'ws-1',
    payload: {
      workspaceId: 'ws-1',
      reviewId: 'rev-1',
      leadId: 'lead-1',
      rating,
      public: !isPrivate,
      occurredAt: new Date().toISOString(),
    },
    idempotencyKey: 'evt-1',
    createdAt: new Date(),
  };
}

function makeLeadEvent(): Partial<DomainEvent> {
  return {
    id: 'evt-2',
    type: 'marketing.lead.created.v1',
    tenantId: 'ws-1',
    payload: { leadId: 'lead-1' },
    idempotencyKey: 'evt-2',
    createdAt: new Date(),
  };
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('RoutineEventListener', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: lock is acquired (pass-through)
    mockWithAdvisoryXactLock.mockImplementation(
      async (_prisma: unknown, _jobName: string, run: () => Promise<void>) => {
        await run();
      },
    );
  });

  // ── subscription registration ─────────────────────────────────────────────

  describe('onModuleInit', () => {
    it('subscribes to review.received and lead.created events', () => {
      const bus = makeDomainEventBus();
      const triggerSvc = makeTriggerService();
      const prisma = makePrismaService();

      const listener = new RoutineEventListener(bus as any, triggerSvc as any, prisma as any);
      listener.onModuleInit();

      expect(bus.on).toHaveBeenCalledWith(
        'marketing.review.received.v1',
        expect.any(Function),
      );
      expect(bus.on).toHaveBeenCalledWith(
        'marketing.lead.created.v1',
        expect.any(Function),
      );
    });
  });

  // ── review handler ────────────────────────────────────────────────────────

  describe('review.received handler', () => {
    it('triggers review-draft when public:false (private feedback)', async () => {
      const bus = makeDomainEventBus();
      const triggerSvc = makeTriggerService();
      const prisma = makePrismaService();

      const listener = new RoutineEventListener(bus as any, triggerSvc as any, prisma as any);
      listener.onModuleInit();

      // private feedback: rating=2, public:false
      await bus.dispatch('marketing.review.received.v1', makeReviewEvent(true));

      expect(triggerSvc.trigger).toHaveBeenCalledWith('review-draft', 'event');
      expect(triggerSvc.trigger).toHaveBeenCalledTimes(1);
    });

    it('does NOT trigger when public:true (publicly routed review)', async () => {
      const bus = makeDomainEventBus();
      const triggerSvc = makeTriggerService();
      const prisma = makePrismaService();

      const listener = new RoutineEventListener(bus as any, triggerSvc as any, prisma as any);
      listener.onModuleInit();

      // public review: rating=5, public:true
      await bus.dispatch('marketing.review.received.v1', makeReviewEvent(false));

      expect(triggerSvc.trigger).not.toHaveBeenCalled();
    });

    it('does NOT trigger when public field is missing/undefined', async () => {
      const bus = makeDomainEventBus();
      const triggerSvc = makeTriggerService();
      const prisma = makePrismaService();

      const listener = new RoutineEventListener(bus as any, triggerSvc as any, prisma as any);
      listener.onModuleInit();

      // malformed payload (no public field) — should not trigger
      const event: Partial<DomainEvent> = {
        id: 'evt-bad',
        type: 'marketing.review.received.v1',
        tenantId: 'ws-1',
        payload: { workspaceId: 'ws-1', reviewId: 'rev-1' },
        idempotencyKey: 'evt-bad',
        createdAt: new Date(),
      };
      await bus.dispatch('marketing.review.received.v1', event);

      expect(triggerSvc.trigger).not.toHaveBeenCalled();
    });

    it('catches and suppresses errors thrown by trigger service', async () => {
      const bus = makeDomainEventBus();
      const triggerSvc = makeTriggerService();
      const prisma = makePrismaService();
      triggerSvc.trigger.mockRejectedValueOnce(new Error('network failure'));

      const listener = new RoutineEventListener(bus as any, triggerSvc as any, prisma as any);
      listener.onModuleInit();

      // Should not throw — private feedback event (public:false)
      await expect(
        bus.dispatch('marketing.review.received.v1', makeReviewEvent(true)),
      ).resolves.toBeUndefined();
    });

    it('skips trigger when advisory lock is held elsewhere', async () => {
      // Simulate lock not acquired (skip run)
      mockWithAdvisoryXactLock.mockImplementationOnce(async () => {
        // lock skipped — do not call run()
      });

      const bus = makeDomainEventBus();
      const triggerSvc = makeTriggerService();
      const prisma = makePrismaService();

      const listener = new RoutineEventListener(bus as any, triggerSvc as any, prisma as any);
      listener.onModuleInit();

      await bus.dispatch('marketing.review.received.v1', makeReviewEvent(true));

      expect(triggerSvc.trigger).not.toHaveBeenCalled();
    });
  });

  // ── lead handler ──────────────────────────────────────────────────────────

  describe('lead.created handler', () => {
    it('triggers lead-scoring for any lead.created event', async () => {
      const bus = makeDomainEventBus();
      const triggerSvc = makeTriggerService();
      const prisma = makePrismaService();

      const listener = new RoutineEventListener(bus as any, triggerSvc as any, prisma as any);
      listener.onModuleInit();

      await bus.dispatch('marketing.lead.created.v1', makeLeadEvent());

      expect(triggerSvc.trigger).toHaveBeenCalledWith('lead-scoring', 'event');
      expect(triggerSvc.trigger).toHaveBeenCalledTimes(1);
    });

    it('catches and suppresses errors thrown by trigger service', async () => {
      const bus = makeDomainEventBus();
      const triggerSvc = makeTriggerService();
      const prisma = makePrismaService();
      triggerSvc.trigger.mockRejectedValueOnce(new Error('trigger down'));

      const listener = new RoutineEventListener(bus as any, triggerSvc as any, prisma as any);
      listener.onModuleInit();

      await expect(
        bus.dispatch('marketing.lead.created.v1', makeLeadEvent()),
      ).resolves.toBeUndefined();
    });
  });
});
