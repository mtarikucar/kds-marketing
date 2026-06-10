import { HardwareQuoteConsumer } from './hardware-quote.consumer';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';

describe('HardwareQuoteConsumer', () => {
  let prisma: MockPrismaClient;
  let bus: { on: jest.Mock };
  let autoAssigner: { pickAssignee: jest.Mock };
  let consumer: HardwareQuoteConsumer;

  const handle = (e: any) => (consumer as any).handle(e);

  const payload = (overrides: any = {}) => ({
    payload: {
      tenantId: 't1',
      dedupRef: 'hwq:t1:yk-x',
      businessName: 'Acme Cafe',
      contactPerson: 'Ali',
      phone: '5551112233',
      email: 'a@b.co',
      notes: '[Donanım teklif talebi] Yazarkasa (SKU: yk-x) × 1',
      productSnapshot: { product: { sku: 'yk-x' } },
      occurredAt: '2026-06-03T00:00:00.000Z',
      ...overrides,
    },
  });

  beforeEach(() => {
    prisma = mockPrismaClient();
    bus = { on: jest.fn() };
    autoAssigner = { pickAssignee: jest.fn().mockResolvedValue(null) };
    consumer = new HardwareQuoteConsumer(prisma as any, bus as any, autoAssigner as any);
  });

  it('subscribes to marketing.lead.hardware_quote.v1 on init', () => {
    consumer.onModuleInit();
    expect(bus.on).toHaveBeenCalledWith('marketing.lead.hardware_quote.v1', expect.any(Function));
  });

  it('upserts a HARDWARE_QUOTE lead on the dedup ref', async () => {
    await handle(payload());
    const arg = prisma.lead.upsert.mock.calls[0][0];
    expect(arg.where.externalRef).toBe('hwq:t1:yk-x');
    expect(arg.create.source).toBe('HARDWARE_QUOTE');
    expect(arg.create.businessName).toBe('Acme Cafe');
    expect(arg.create.originTenantId).toBe('t1');
    expect(arg.create.externalRef).toBe('hwq:t1:yk-x');
    // No owner forced when the assigner returns null.
    expect(arg.create.assignedToId).toBeUndefined();
  });

  it('auto-assigns the new lead when the distribution strategy picks an owner', async () => {
    autoAssigner.pickAssignee.mockResolvedValue('rep-9');
    await handle(payload());
    const arg = prisma.lead.upsert.mock.calls[0][0];
    expect(arg.create.assignedToId).toBe('rep-9');
    // Resubmits (update path) must not reassign/overwrite ownership.
    expect(arg.update.assignedToId).toBeUndefined();
  });

  it('swallows errors so a bad lead write never aborts the event bus', async () => {
    prisma.lead.upsert.mockRejectedValue(new Error('db down'));
    await expect(handle(payload())).resolves.toBeUndefined();
  });
});
