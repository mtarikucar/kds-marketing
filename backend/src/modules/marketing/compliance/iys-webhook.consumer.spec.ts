import { IysWebhookConsumer } from './iys-webhook.consumer';
import { ComplianceService } from './compliance.service';
import { IysSyncService } from './iys-sync.service';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';
import { DomainEvent } from '../../outbox/domain-event-bus.service';
import { MarketingEventTypes, MarketingIysConsentPayload } from '../events/marketing-event-types';

function makeEvent(id: string, overrides: Partial<MarketingIysConsentPayload> = {}): DomainEvent<MarketingIysConsentPayload> {
  const payload: MarketingIysConsentPayload = {
    workspaceId: 'ws-1',
    recipient: '05551112233',
    type: 'MESAJ',
    status: 'ONAY',
    source: 'HS_MESAJ',
    transactionId: 'tx-1',
    ...overrides,
  };
  return {
    id,
    type: MarketingEventTypes.IysConsentReceived,
    tenantId: null,
    idempotencyKey: id,
    createdAt: new Date('2026-07-09T10:00:00.000Z'),
    payload,
  };
}

/**
 * IysWebhookConsumer applies İYS-originated ONAY/RET back onto the matching
 * lead's MARKETING_SMS consent. The two things that matter most here:
 *  - it finds the lead by NORMALIZED phone, scoped to the event's workspace;
 *  - the anti-feedback-loop guard (IysSyncService.enqueueConsent skipping any
 *    IYS_-sourced consent) is exercised end-to-end using the REAL
 *    ComplianceService + IysSyncService wiring, not a mock that would hide a
 *    regression.
 */
describe('IysWebhookConsumer', () => {
  let prisma: MockPrismaClient;
  let bus: { on: jest.Mock; off: jest.Mock };
  let compliance: { recordConsent: jest.Mock };
  let svc: IysWebhookConsumer;

  const handle = (e: DomainEvent<MarketingIysConsentPayload>) => (svc as any).handle(e);

  beforeEach(() => {
    prisma = mockPrismaClient();
    bus = { on: jest.fn(), off: jest.fn() };
    compliance = { recordConsent: jest.fn().mockResolvedValue({ id: 'cr-1' }) };
    svc = new IysWebhookConsumer(prisma as any, bus as any, compliance as any);

    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as any);
    prisma.consentRecord.findFirst.mockResolvedValue(null);
  });

  it('subscribes to marketing.iys.consent.v1 on module init, and detaches on destroy', () => {
    svc.onModuleInit();
    expect(bus.on).toHaveBeenCalledWith(MarketingEventTypes.IysConsentReceived, expect.any(Function));
    svc.onModuleDestroy();
    expect(bus.off).toHaveBeenCalledWith(MarketingEventTypes.IysConsentReceived, expect.any(Function));
  });

  it('applies an ONAY as granted=true, tagging the source IYS_<originalSource>', async () => {
    await handle(makeEvent('evt-1', { status: 'ONAY', source: 'HS_MESAJ' }));

    expect(prisma.lead.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: 'ws-1', phoneNormalized: '05551112233', mergedIntoId: null, deletedAt: null },
      }),
    );
    expect(compliance.recordConsent).toHaveBeenCalledWith('ws-1', 'lead-1', 'MARKETING_SMS', true, {
      source: 'IYS_HS_MESAJ',
    });
  });

  it('applies a RET as granted=false', async () => {
    await handle(makeEvent('evt-2', { status: 'RET', source: 'HS_WEB' }));

    expect(compliance.recordConsent).toHaveBeenCalledWith('ws-1', 'lead-1', 'MARKETING_SMS', false, {
      source: 'IYS_HS_WEB',
    });
  });

  it('normalizes a formatted recipient before the lead lookup', async () => {
    await handle(makeEvent('evt-3', { recipient: '+90 555 111 22 33' }));

    expect(prisma.lead.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ phoneNormalized: '905551112233' }) }),
    );
  });

  it('dedupes a replayed event id — the same id is only processed once', async () => {
    const event = makeEvent('evt-dup');
    await handle(event);
    await handle(event);
    expect(compliance.recordConsent).toHaveBeenCalledTimes(1);
  });

  it('idempotency guard: skips (no write) when the lead\'s latest MARKETING_SMS consent already matches the incoming status', async () => {
    prisma.consentRecord.findFirst.mockResolvedValue({ granted: true } as any);

    await handle(makeEvent('evt-4', { status: 'ONAY' }));

    expect(compliance.recordConsent).not.toHaveBeenCalled();
  });

  it('does NOT skip when the latest consent is the OPPOSITE of the incoming status', async () => {
    prisma.consentRecord.findFirst.mockResolvedValue({ granted: false } as any);

    await handle(makeEvent('evt-5', { status: 'ONAY' }));

    expect(compliance.recordConsent).toHaveBeenCalledWith('ws-1', 'lead-1', 'MARKETING_SMS', true, expect.anything());
  });

  it('logs and skips when no lead matches the recipient phone in that workspace (unknown phone)', async () => {
    prisma.lead.findFirst.mockResolvedValue(null);

    await expect(handle(makeEvent('evt-6'))).resolves.toBeUndefined();

    expect(compliance.recordConsent).not.toHaveBeenCalled();
  });

  it('logs and skips when the recipient is empty (no usable phone)', async () => {
    await expect(handle(makeEvent('evt-7', { recipient: '' }))).resolves.toBeUndefined();

    expect(prisma.lead.findFirst).not.toHaveBeenCalled();
    expect(compliance.recordConsent).not.toHaveBeenCalled();
  });

  it('logs and skips ARAMA/EPOSTA types — only MESAJ is applied this phase', async () => {
    await handle(makeEvent('evt-8', { type: 'ARAMA' }));
    await handle(makeEvent('evt-9', { type: 'EPOSTA' }));

    expect(prisma.lead.findFirst).not.toHaveBeenCalled();
    expect(compliance.recordConsent).not.toHaveBeenCalled();
  });

  it('never throws when workspaceId is missing from the payload', async () => {
    await expect(
      handle(makeEvent('evt-10', { workspaceId: undefined as unknown as string })),
    ).resolves.toBeUndefined();
    expect(compliance.recordConsent).not.toHaveBeenCalled();
  });
});

/**
 * ANTI-FEEDBACK-LOOP — end-to-end through the REAL ComplianceService +
 * IysSyncService (not mocked away), so a regression in either the source
 * pass-through (compliance.service.ts) or the IYS_ guard
 * (iys-sync.service.ts) would fail THIS test even if the unit tests above
 * only assert against a mocked ComplianceService.
 */
describe('IysWebhookConsumer — anti-feedback-loop (real ComplianceService + IysSyncService)', () => {
  it('applying an İYS-originated consent change does NOT enqueue a push back to İYS', async () => {
    const prisma = mockPrismaClient();
    (prisma.$transaction as unknown as jest.Mock) = jest.fn((fn: any) => fn(prisma));
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as any);
    prisma.consentRecord.findFirst.mockResolvedValue(null);
    (prisma.consentRecord.create as jest.Mock).mockResolvedValue({ id: 'cr-1' });
    (prisma.lead.update as jest.Mock).mockResolvedValue({});
    (prisma.lead.findUnique as jest.Mock).mockResolvedValue({ phone: '05551112233' });

    const outbox = { append: jest.fn().mockResolvedValue('evt-1') };
    const iysSyncCreate = jest.fn().mockResolvedValue({});
    (prisma.iysSyncJob.create as jest.Mock) = iysSyncCreate;

    const registry = { resolveConfig: jest.fn() };
    const budgeter = { tryTake: jest.fn().mockReturnValue(true) };
    const iysClient = { add: jest.fn() };
    const iysSync = new IysSyncService(prisma as any, registry as any, budgeter as any, iysClient as any);
    const compliance = new ComplianceService(prisma as any, outbox as any, iysSync as any);

    const bus = { on: jest.fn(), off: jest.fn() };
    const consumer = new IysWebhookConsumer(prisma as any, bus as any, compliance as any);

    const event = {
      id: 'evt-loop',
      type: MarketingEventTypes.IysConsentReceived,
      tenantId: null,
      idempotencyKey: 'evt-loop',
      createdAt: new Date('2026-07-09T10:00:00.000Z'),
      payload: {
        workspaceId: 'ws-1',
        recipient: '05551112233',
        type: 'MESAJ',
        status: 'ONAY',
        source: 'HS_MESAJ',
        transactionId: 'tx-loop',
      } satisfies MarketingIysConsentPayload,
    };

    await (consumer as any).handle(event);

    // The consent record + lead flip DID happen…
    expect(prisma.consentRecord.create).toHaveBeenCalled();
    expect(prisma.lead.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'lead-1' }, data: { smsOptOut: false } }),
    );
    // …but the İYS-originated change was NEVER re-enqueued for push-back.
    expect(iysSyncCreate).not.toHaveBeenCalled();
  });
});
