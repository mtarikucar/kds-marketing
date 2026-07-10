import { Logger } from '@nestjs/common';
import { NetgsmBlacklistSyncService } from './netgsm-blacklist-sync.service';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';
import { DomainEvent } from '../../outbox/domain-event-bus.service';
import { MarketingEventTypes, MarketingSmsOptStatusPayload } from '../events/marketing-event-types';

function makeEvent(id: string, overrides: Partial<MarketingSmsOptStatusPayload> = {}): DomainEvent<MarketingSmsOptStatusPayload> {
  const payload: MarketingSmsOptStatusPayload = {
    workspaceId: 'ws-1',
    leadId: 'lead-1',
    phone: '05551112233',
    ...overrides,
  };
  return {
    id,
    type: 'marketing.sms.optout.v1',
    tenantId: null,
    idempotencyKey: id,
    createdAt: new Date('2026-07-08T10:00:00.000Z'),
    payload,
  };
}

describe('NetgsmBlacklistSyncService', () => {
  let prisma: MockPrismaClient;
  let bus: { on: jest.Mock; off: jest.Mock };
  let registry: { resolveConfig: jest.Mock };
  let budgeter: { tryTake: jest.Mock };
  let client: { add: jest.Mock; remove: jest.Mock };
  let svc: NetgsmBlacklistSyncService;

  const handle = (e: DomainEvent<MarketingSmsOptStatusPayload>, action: 'add' | 'remove') =>
    (svc as any).handle(e, action);

  beforeEach(() => {
    prisma = mockPrismaClient();
    bus = { on: jest.fn(), off: jest.fn() };
    registry = { resolveConfig: jest.fn() };
    budgeter = { tryTake: jest.fn().mockReturnValue(true) };
    client = { add: jest.fn().mockResolvedValue({ ok: true, code: '00', message: null }), remove: jest.fn().mockResolvedValue({ ok: true, code: '00', message: null }) };
    svc = new NetgsmBlacklistSyncService(prisma as any, bus as any, registry as any, budgeter as any, client as any);

    prisma.channel.findMany.mockResolvedValue([
      { id: 'ch-1', workspaceId: 'ws-1', type: 'SMS', status: 'ACTIVE' } as any,
    ]);
    registry.resolveConfig.mockReturnValue({ secrets: { usercode: 'u1', password: 'p1' }, public: {} });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('subscribes to both optout and optin on module init, and detaches on destroy', () => {
    svc.onModuleInit();
    expect(bus.on).toHaveBeenCalledWith(MarketingEventTypes.SmsOptedOut, expect.any(Function));
    expect(bus.on).toHaveBeenCalledWith(MarketingEventTypes.SmsOptedIn, expect.any(Function));
    svc.onModuleDestroy();
    expect(bus.off).toHaveBeenCalledWith(MarketingEventTypes.SmsOptedOut, expect.any(Function));
    expect(bus.off).toHaveBeenCalledWith(MarketingEventTypes.SmsOptedIn, expect.any(Function));
  });

  it('optout event calls blacklist add (tip 1)', async () => {
    await handle(makeEvent('evt-1'), 'add');
    expect(client.add).toHaveBeenCalledWith({ usercode: 'u1', password: 'p1' }, '05551112233');
    expect(client.remove).not.toHaveBeenCalled();
  });

  it('optin event calls blacklist remove (tip 2)', async () => {
    await handle(makeEvent('evt-2'), 'remove');
    expect(client.remove).toHaveBeenCalledWith({ usercode: 'u1', password: 'p1' }, '05551112233');
    expect(client.add).not.toHaveBeenCalled();
  });

  it('dedupes a replayed event id — the same id is only processed once', async () => {
    const event = makeEvent('evt-dup');
    await handle(event, 'add');
    await handle(event, 'add');
    expect(client.add).toHaveBeenCalledTimes(1);
  });

  it('skips (no throw) when the workspace has no ACTIVE SMS channel credentials', async () => {
    prisma.channel.findMany.mockResolvedValue([]);
    await expect(handle(makeEvent('evt-3'), 'add')).resolves.toBeUndefined();
    expect(client.add).not.toHaveBeenCalled();
  });

  it('skips (no throw) when the payload is missing a phone', async () => {
    await expect(handle(makeEvent('evt-4', { phone: '' }), 'add')).resolves.toBeUndefined();
    expect(client.add).not.toHaveBeenCalled();
  });

  describe('budget-denial retry path', () => {
    it('retries on setTimeout (1s/5s/15s) after a budget denial, then succeeds', async () => {
      jest.useFakeTimers();
      budgeter.tryTake
        .mockReturnValueOnce(false) // first attempt denied
        .mockReturnValueOnce(false) // 1st retry denied
        .mockReturnValueOnce(true); // 2nd retry succeeds

      await handle(makeEvent('evt-5'), 'add');
      expect(client.add).not.toHaveBeenCalled(); // denied synchronously, nothing sent yet

      await jest.advanceTimersByTimeAsync(1_000); // 1st retry (denied)
      expect(client.add).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(5_000); // 2nd retry (succeeds)
      expect(client.add).toHaveBeenCalledWith({ usercode: 'u1', password: 'p1' }, '05551112233');
    });

    it('gives up after 3 retries and logs a warn including the lead id — never throws', async () => {
      jest.useFakeTimers();
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      budgeter.tryTake.mockReturnValue(false); // always denied

      await handle(makeEvent('evt-6', { leadId: 'lead-drop' }), 'add');
      await jest.advanceTimersByTimeAsync(1_000);
      await jest.advanceTimersByTimeAsync(5_000);
      await jest.advanceTimersByTimeAsync(15_000);

      expect(client.add).not.toHaveBeenCalled();
      expect(warnSpy.mock.calls.some(([msg]) => String(msg).includes('lead-drop'))).toBe(true);
      warnSpy.mockRestore();
    });
  });

  it('never logs plaintext credentials', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    client.add.mockResolvedValue({ ok: false, code: '30', message: 'auth failed' });
    await handle(makeEvent('evt-7'), 'add');
    for (const call of [...logSpy.mock.calls, ...warnSpy.mock.calls]) {
      expect(JSON.stringify(call)).not.toContain('p1');
    }
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
