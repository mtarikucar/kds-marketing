import { HardwareQuoteConsumer } from './hardware-quote.consumer';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';

describe('HardwareQuoteConsumer', () => {
  let prisma: MockPrismaClient;
  let bus: { on: jest.Mock };
  let autoAssigner: { pickAssignee: jest.Mock };
  let consumer: HardwareQuoteConsumer;

  const WS = 'ws-1';

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
    // Core-originated event — the consumer resolves the single
    // core-integrated workspace via the helper (workspace.findFirst).
    prisma.workspace.findFirst.mockResolvedValue({ id: WS } as any);
    bus = { on: jest.fn() };
    autoAssigner = { pickAssignee: jest.fn().mockResolvedValue(null) };
    consumer = new HardwareQuoteConsumer(prisma as any, bus as any, autoAssigner as any);
  });

  it('subscribes to marketing.lead.hardware_quote.v1 on init', () => {
    consumer.onModuleInit();
    expect(bus.on).toHaveBeenCalledWith('marketing.lead.hardware_quote.v1', expect.any(Function));
  });

  it('upserts a HARDWARE_QUOTE lead on the per-workspace dedup ref', async () => {
    await handle(payload());
    const arg = prisma.lead.upsert.mock.calls[0][0];
    expect(arg.where.workspaceId_externalRef).toEqual({
      workspaceId: WS,
      externalRef: 'hwq:t1:yk-x',
    });
    expect(arg.create.workspaceId).toBe(WS);
    expect(arg.create.source).toBe('HARDWARE_QUOTE');
    expect(arg.create.businessName).toBe('Acme Cafe');
    expect(arg.create.originTenantId).toBe('t1');
    expect(arg.create.externalRef).toBe('hwq:t1:yk-x');
    // No owner forced when the assigner returns null.
    expect(arg.create.assignedToId).toBeUndefined();
  });

  it('auto-assigns the new lead within the workspace when the strategy picks an owner', async () => {
    autoAssigner.pickAssignee.mockResolvedValue('rep-9');
    await handle(payload());
    expect(autoAssigner.pickAssignee).toHaveBeenCalledWith(WS);
    const arg = prisma.lead.upsert.mock.calls[0][0];
    expect(arg.create.assignedToId).toBe('rep-9');
    // Resubmits (update path) must not reassign/overwrite ownership.
    expect(arg.update.assignedToId).toBeUndefined();
  });

  it('does NOT advance the round-robin cursor on a resubmit (existing lead → update only)', async () => {
    // A resubmitted quote (lead already exists for the dedup ref) must refresh
    // the lead WITHOUT calling pickAssignee — which, under ROUND_ROBIN, would
    // advance the distribution cursor and skew assignment without a new lead.
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as any);
    await handle(payload());
    expect(autoAssigner.pickAssignee).not.toHaveBeenCalled();
    expect(prisma.lead.upsert).not.toHaveBeenCalled();
    expect(prisma.lead.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'lead-1' }, data: expect.objectContaining({ contactPerson: 'Ali', phone: '5551112233' }) }),
    );
  });

  it('skips (warn) when no core-integrated workspace exists', async () => {
    prisma.workspace.findFirst.mockResolvedValue(null);
    await expect(handle(payload())).resolves.toBeUndefined();
    expect(autoAssigner.pickAssignee).not.toHaveBeenCalled();
    expect(prisma.lead.upsert).not.toHaveBeenCalled();
  });

  it('swallows errors so a bad lead write never aborts the event bus', async () => {
    prisma.lead.upsert.mockRejectedValue(new Error('db down'));
    await expect(handle(payload())).resolves.toBeUndefined();
  });
});
