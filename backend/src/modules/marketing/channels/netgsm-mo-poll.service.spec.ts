import { Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { NetgsmMoPollService } from './netgsm-mo-poll.service';
import { NetgsmSmsAdapter } from './adapters/netgsm-sms.adapter';

/**
 * The MO poll is a BACKUP for the push webhook (NetgsmPublicController.mo):
 * hourly, per NetGSM account, it re-fetches the last 2h of inbox() replies
 * (date-ranged form ONLY — the parameterless form marks messages seen and
 * would race the webhook) and ingests anything the webhook missed, through
 * the SAME `adapter.parseInbound` namespacing (`netgsm-mo:<id>`) and
 * `ConversationIngressService` path the webhook uses. It must: never call
 * inbox() without both dates, skip an account whose budget is denied, skip an
 * account backing more than one channel (no per-channel identity in the
 * response), rely on ConversationIngressService's own dedupe rather than a
 * second hand-rolled check, fall back to a digest key when NetGSM supplies no
 * id, and stamp `configPublic.lastMoPollRecovery` + warn only when a tick
 * actually recovers something.
 */
describe('NetgsmMoPollService.poll', () => {
  let prisma: any;
  let registry: any;
  let smsV2: any;
  let budgeter: any;
  let ingress: any;
  let service: NetgsmMoPollService;
  // A real adapter instance for genuine (not re-implemented) parseInbound
  // behavior — the constructor deps (registry/balance/smsV2) aren't touched by
  // parseInbound, so dummies are fine.
  const realAdapter = new NetgsmSmsAdapter({} as any, {} as any, {} as any);

  const activeSmsChannel = (overrides: Record<string, unknown> = {}) => ({
    id: 'ch-1',
    workspaceId: 'w1',
    type: 'SMS',
    externalId: '08508407303',
    configSealed: 'sealed',
    configPublic: null,
    ...overrides,
  });

  const resolvedConfig = (overrides: Record<string, unknown> = {}) => ({
    channelId: 'ch-1',
    workspaceId: 'w1',
    type: 'SMS',
    externalId: null,
    secrets: { usercode: 'u1', password: 'p1', msgheader: 'HDR' },
    public: {},
    ...overrides,
  });

  beforeEach(() => {
    jest.useFakeTimers();
    prisma = {
      channel: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue({ configPublic: null }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    registry = {
      has: jest.fn().mockReturnValue(true),
      get: jest.fn().mockReturnValue(realAdapter),
      resolveConfig: jest.fn().mockReturnValue(resolvedConfig()),
    };
    smsV2 = { inbox: jest.fn().mockResolvedValue({ ok: true, messages: [] }) };
    budgeter = { tryTake: jest.fn().mockReturnValue(true) };
    ingress = { ingest: jest.fn().mockResolvedValue({ conversationId: 'cv1', messageId: 'm1', leadId: 'l1', isNewConversation: false, deduped: false }) };
    service = new NetgsmMoPollService(prisma, registry, smsV2, budgeter, ingress);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('does nothing when there is no ACTIVE SMS channel', async () => {
    const out = await service.poll();
    expect(out).toEqual({ polled: 0, ingested: 0 });
    expect(smsV2.inbox).not.toHaveBeenCalled();
  });

  it('skips a channel whose resolved config secrets are incomplete (no account group formed)', async () => {
    prisma.channel.findMany.mockResolvedValue([activeSmsChannel()]);
    registry.resolveConfig.mockReturnValue(resolvedConfig({ secrets: {} }));

    const out = await service.poll();

    expect(out).toEqual({ polled: 0, ingested: 0 });
    expect(smsV2.inbox).not.toHaveBeenCalled();
  });

  it('skips an account backing more than one ACTIVE SMS channel (ambiguous MO attribution)', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    prisma.channel.findMany.mockResolvedValue([
      activeSmsChannel({ id: 'ch-1' }),
      activeSmsChannel({ id: 'ch-2' }),
    ]);
    // Both channels resolve to the SAME NetGSM account (usercode u1) — an
    // agency sharing one contract across two workspaces/channels.
    registry.resolveConfig.mockReturnValue(resolvedConfig());

    const out = await service.poll();

    expect(out).toEqual({ polled: 0, ingested: 0 });
    expect(smsV2.inbox).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('backs 2 ACTIVE SMS channels'));
  });

  describe('window computation', () => {
    beforeEach(() => {
      prisma.channel.findMany.mockResolvedValue([activeSmsChannel()]);
    });

    it('calls inbox with the exact ddMMyyyyHHmm TR-local window from a mocked clock', async () => {
      // 2026-01-15T10:00:00.000Z UTC == 13:00 TR-local (UTC+3, no DST).
      jest.setSystemTime(new Date('2026-01-15T10:00:00.000Z'));

      await service.poll();

      expect(smsV2.inbox).toHaveBeenCalledWith(
        { usercode: 'u1', password: 'p1' },
        '150120261100', // stopdate - 2h
        '150120261300', // now, TR-local
      );
    });

    it('never calls inbox without both dates', async () => {
      jest.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));

      await service.poll();

      expect(smsV2.inbox).toHaveBeenCalledTimes(1);
      const [, startdate, stopdate] = smsV2.inbox.mock.calls[0];
      expect(startdate).toMatch(/^\d{12}$/);
      expect(stopdate).toMatch(/^\d{12}$/);
    });
  });

  describe('budget', () => {
    it('skips the account (never calls inbox) when the rate budget denies', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      prisma.channel.findMany.mockResolvedValue([activeSmsChannel()]);
      budgeter.tryTake.mockReturnValue(false);

      const out = await service.poll();

      expect(budgeter.tryTake).toHaveBeenCalledWith('u1', 'inbox', 2, 60_000);
      expect(smsV2.inbox).not.toHaveBeenCalled();
      expect(out).toEqual({ polled: 0, ingested: 0 });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('budget denied'));
    });
  });

  describe('ingestion + dedupe', () => {
    beforeEach(() => {
      prisma.channel.findMany.mockResolvedValue([activeSmsChannel()]);
    });

    it('skips a message whose id already resolved to an existing Message row (ConversationIngress reports deduped)', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      smsV2.inbox.mockResolvedValue({
        ok: true,
        messages: [{ msg: 'merhaba', no: '5551112233', date: '150120261245', id: '42' }],
      });
      ingress.ingest.mockResolvedValue({ conversationId: 'cv1', messageId: 'm1', leadId: 'l1', isNewConversation: false, deduped: true });

      const out = await service.poll();

      expect(ingress.ingest).toHaveBeenCalledWith(
        { id: 'ch-1', workspaceId: 'w1', type: 'SMS' },
        expect.objectContaining({ externalMessageId: 'netgsm-mo:42' }),
      );
      expect(out.ingested).toBe(0);
      expect(prisma.channel.update).not.toHaveBeenCalled();
      // No recovery for this tick — dedupe warn (if any) must not be the
      // recovery warn; assert no "recovered" log was emitted.
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('recovered'));
    });

    it('ingests a message the webhook missed, using the SAME netgsm-mo:<id> namespacing the push path uses', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      smsV2.inbox.mockResolvedValue({
        ok: true,
        messages: [{ msg: 'merhaba', no: '5551112233', date: '150120261245', id: '42' }],
      });
      prisma.channel.findFirst.mockResolvedValue({ configPublic: { useLegacySend: false } });

      const out = await service.poll();

      expect(ingress.ingest).toHaveBeenCalledWith(
        { id: 'ch-1', workspaceId: 'w1', type: 'SMS' },
        expect.objectContaining({
          externalUserId: '+905551112233',
          kind: 'PHONE',
          externalMessageId: 'netgsm-mo:42',
          text: 'merhaba',
        }),
      );
      expect(out.ingested).toBe(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('recovered 1 message(s)'));
      // configPublic write MERGES — the pre-existing useLegacySend key survives.
      expect(prisma.channel.update).toHaveBeenCalledWith({
        where: { id: 'ch-1' },
        data: {
          configPublic: {
            useLegacySend: false,
            lastMoPollRecovery: expect.any(String),
          },
        },
      });
      const stamped = new Date(prisma.channel.update.mock.calls[0][0].data.configPublic.lastMoPollRecovery);
      expect(Number.isNaN(stamped.getTime())).toBe(false);
    });

    it('falls back to a digest dedupe key (netgsm-mo-digest:<sha256>) when NetGSM supplies no id', async () => {
      const row = { msg: 'merhaba', no: '5551112233', date: '150120261245', id: null as string | null };
      smsV2.inbox.mockResolvedValue({ ok: true, messages: [row] });

      await service.poll();

      const expectedHash = createHash('sha256').update(`${row.no}\0${row.msg}\0${row.date}`).digest('hex');
      expect(ingress.ingest).toHaveBeenCalledWith(
        { id: 'ch-1', workspaceId: 'w1', type: 'SMS' },
        expect.objectContaining({ externalMessageId: `netgsm-mo-digest:${expectedHash}` }),
      );
    });

    it('does not call ingress.ingest for a row with no resolvable sender', async () => {
      smsV2.inbox.mockResolvedValue({ ok: true, messages: [{ msg: 'x', no: '', date: null, id: '1' }] });

      await service.poll();

      expect(ingress.ingest).not.toHaveBeenCalled();
    });
  });
});
