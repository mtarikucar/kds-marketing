import { Logger } from '@nestjs/common';
import { OutboxService } from './outbox.service';

function mockPrisma() {
  return { outboxEvent: { create: jest.fn().mockResolvedValue(undefined) } } as any;
}

describe('OutboxService.append', () => {
  let prisma: any;
  let service: OutboxService;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    prisma = mockPrisma();
    service = new OutboxService(prisma);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('writes a queued row and returns the id; honors a supplied idempotencyKey', async () => {
    const id = await service.append({
      type: 'payment.succeeded.v1',
      payload: { a: 1 },
      tenantId: 't-1',
      idempotencyKey: 'k1',
    });
    expect(typeof id).toBe('string');
    const data = prisma.outboxEvent.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      id,
      type: 'payment.succeeded.v1',
      tenantId: 't-1',
      status: 'queued',
      idempotencyKey: 'k1',
    });
    expect(data.nextAttemptAt).toBeInstanceOf(Date);
  });

  it('falls back idempotencyKey to the generated id when none is supplied', async () => {
    const id = await service.append({ type: 'metric.emit.v1', payload: {} });
    expect(prisma.outboxEvent.create.mock.calls[0][0].data.idempotencyKey).toBe(id);
  });

  it('warns when a dedup-required type is emitted without an idempotencyKey', async () => {
    await service.append({ type: 'payment.succeeded.v1', payload: {} });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('without an idempotencyKey'),
    );
  });

  it('does NOT raise the dedup warning for fire-and-forget types', async () => {
    await service.append({ type: 'metric.emit.v1', payload: {} });
    const dedupWarn = warnSpy.mock.calls.find((c) =>
      String(c[0]).includes('without an idempotencyKey'),
    );
    expect(dedupWarn).toBeUndefined();
  });

  it('warns on an unregistered event type (typo guard)', async () => {
    await service.append({ type: 'totally.bogus.type', payload: {}, idempotencyKey: 'k' });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('unregistered event type'),
    );
  });

  it('writes through a provided tx client, not the base prisma', async () => {
    const tx = { outboxEvent: { create: jest.fn().mockResolvedValue(undefined) } } as any;
    await service.append(
      { type: 'payment.succeeded.v1', payload: {}, idempotencyKey: 'k' },
      tx,
    );
    expect(tx.outboxEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.outboxEvent.create).not.toHaveBeenCalled();
  });
});
