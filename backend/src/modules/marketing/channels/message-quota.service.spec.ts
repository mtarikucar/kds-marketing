import { ForbiddenException } from '@nestjs/common';
import { MessageQuotaService, MESSAGES_METRIC } from './message-quota.service';

/**
 * Outbound-message metering. Same advisory-locked reserve/refund contract as
 * AiCredits, with one extra rule: web-chat is free + unmetered, so it never
 * touches the counter or the limit.
 */
describe('MessageQuotaService', () => {
  const WS = 'ws-1';
  let prisma: any;
  let entitlements: { getEffective: jest.Mock };
  let svc: MessageQuotaService;
  let counterValue: number;

  const withLimit = (messagesMonthly: number) =>
    entitlements.getEffective.mockResolvedValue({ limits: { messagesMonthly } });

  beforeEach(() => {
    counterValue = 0;
    prisma = {
      usageCounter: {
        findUnique: jest.fn().mockImplementation(async () =>
          counterValue > 0 ? { value: counterValue } : null,
        ),
        upsert: jest.fn().mockImplementation(async (args: any) => {
          if (args.update?.value?.increment !== undefined) counterValue += args.update.value.increment;
          else if (args.create?.value !== undefined && counterValue === 0) counterValue = args.create.value;
          return { value: counterValue };
        }),
      },
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ locked: 'x' }]),
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    entitlements = { getEffective: jest.fn() };
    svc = new MessageQuotaService(prisma as any, entitlements as any);
  });

  it('web-chat is free: never reserves, never consults entitlements', async () => {
    await svc.reserve(WS, 'WEBCHAT');
    expect(entitlements.getEffective).not.toHaveBeenCalled();
    expect(counterValue).toBe(0);
    expect(svc.isMetered('WEBCHAT')).toBe(false);
    expect(svc.isMetered('WHATSAPP')).toBe(true);
  });

  it('meters a WhatsApp send under the cap, on a per-workspace advisory lock', async () => {
    withLimit(100);
    await svc.reserve(WS, 'WHATSAPP');
    expect(counterValue).toBe(1);
    const lockCalls = prisma.$queryRawUnsafe.mock.calls.filter(([s]: [string]) =>
      s.includes('pg_advisory_xact_lock'),
    );
    expect(lockCalls).toHaveLength(1);
    expect(lockCalls[0][0]).toContain(`messages:${WS}`);
  });

  it('throws MESSAGES_EXHAUSTED at the cap without over-spending', async () => {
    withLimit(2);
    await svc.reserve(WS, 'SMS'); // 1
    await svc.reserve(WS, 'SMS'); // 2
    await expect(svc.reserve(WS, 'SMS')).rejects.toBeInstanceOf(ForbiddenException);
    expect(counterValue).toBe(2);
  });

  it('refunds a failed send', async () => {
    withLimit(100);
    await svc.reserve(WS, 'INSTAGRAM');
    await svc.refund(WS, 'INSTAGRAM');
    expect(counterValue).toBe(0);
  });

  it('unlimited (-1) admits sends and reports remaining -1', async () => {
    withLimit(-1);
    await svc.reserve(WS, 'WHATSAPP');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    const u = await svc.usage(WS);
    expect(u.remaining).toBe(-1);
  });

  it('meters under the canonical metric name', () => {
    expect(MESSAGES_METRIC).toBe('messages.sent');
  });
});
