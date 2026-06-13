import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { PrismaClient } from '@prisma/client';
import { OutboxWorkerService } from './outbox-worker.service';
import { PrismaService } from '../../prisma/prisma.service';
import { DomainEventBus } from './domain-event-bus.service';

/**
 * Drains the durable outbox onto the in-process bus. The claim itself is raw
 * SQL (FOR UPDATE SKIP LOCKED) and belongs to a DB-backed test; what these unit
 * tests pin is the per-row decision logic around it — the success flip, the
 * backoff requeue, and the terminal DLQ transition — driven through the mocked
 * Prisma seam by stubbing the claim query's return.
 */
describe('OutboxWorkerService.drainOnce', () => {
  let prisma: DeepMockProxy<PrismaClient>;
  let bus: { dispatch: jest.Mock };
  let worker: OutboxWorkerService;

  const row = (over: Partial<Record<string, unknown>> = {}) => ({
    id: 'evt-1',
    type: 'lead.converted.v1',
    tenantId: 'tenant-1',
    payload: { leadId: 'l1' },
    idempotencyKey: 'lead-converted:l1',
    attempts: 1, // already incremented by the claim UPDATE
    createdAt: new Date(),
    ...over,
  });

  // The private drainOnce is the unit under test.
  const drain = () => (worker as unknown as { drainOnce(): Promise<number> }).drainOnce();

  beforeEach(() => {
    prisma = mockDeep<PrismaClient>();
    bus = { dispatch: jest.fn() };
    worker = new OutboxWorkerService(
      prisma as unknown as PrismaService,
      bus as unknown as DomainEventBus,
    );
  });

  it('dispatches a claimed row onto the bus and flips it to dispatched', async () => {
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([row()]);

    const count = await drain();

    expect(count).toBe(1);
    expect(bus.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'evt-1', type: 'lead.converted.v1' }),
    );
    expect(prisma.outboxEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'evt-1' },
        data: expect.objectContaining({ status: 'dispatched', lastError: null }),
      }),
    );
  });

  it('requeues with backoff (not DLQ) when dispatch fails below the attempt cap', async () => {
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([row({ attempts: 2 })]);
    bus.dispatch.mockRejectedValue(new Error('consumer exploded'));

    await drain();

    const call = (prisma.outboxEvent.update as jest.Mock).mock.calls[0][0];
    expect(call.data.status).toBe('queued');
    expect(call.data.lastError).toContain('consumer exploded');
    expect(call.data.nextAttemptAt).toBeInstanceOf(Date);
    // Backoff is in the future.
    expect(call.data.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('lands a row in the DLQ (status=failed, no further retry) once attempts hit the cap', async () => {
    // MAX_ATTEMPTS = 8; a row claimed at attempts=8 that fails is terminal.
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([row({ attempts: 8 })]);
    bus.dispatch.mockRejectedValue(new Error('still broken'));

    await drain();

    const call = (prisma.outboxEvent.update as jest.Mock).mock.calls[0][0];
    expect(call.data.status).toBe('failed');
    expect(call.data.nextAttemptAt).toBeNull();
  });

  it('truncates an over-long error message to keep the lastError column bounded', async () => {
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([row()]);
    bus.dispatch.mockRejectedValue(new Error('x'.repeat(2000)));

    await drain();

    const call = (prisma.outboxEvent.update as jest.Mock).mock.calls[0][0];
    expect(call.data.lastError.length).toBeLessThanOrEqual(500);
  });

  it('returns 0 and dispatches nothing when the claim finds no rows', async () => {
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);
    expect(await drain()).toBe(0);
    expect(bus.dispatch).not.toHaveBeenCalled();
  });
});
