import { Logger } from '@nestjs/common';

// ── safeFetch mock (document download) ──────────────────────────────────────
const mockSafeFetch = jest.fn();
jest.mock('../../../common/util/safe-fetch', () => ({
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

import { NetgsmFaxPollService } from './netgsm-fax-poll.service';
import { NetgsmSmsAdapter } from './adapters/netgsm-sms.adapter';
import { FaxRow } from '../../netgsm/fax/fax.client';

/**
 * The fax poll is the ONLY path an inbound fax reaches the inbox through
 * (there is no push webhook for fax) — hourly, per NetGSM account, it
 * re-fetches the last 2h of `/fax/receive` rows (date-ranged form ONLY) and,
 * for every genuinely new row, best-effort downloads the document into R2
 * and ingests it as an inbound Message through `ConversationIngressService` —
 * the SAME path NetgsmSmsAdapter's push/poll SMS ingestion and the voicemail
 * poll use, tagged `meta.raw.kind === 'FAX'` and namespaced `netgsm-fax:<id>`
 * (distinct from the SMS poller's `netgsm-mo:<id>` and the voicemail poller's
 * `netgsm-vm:<id>`). It must: never call receive() without both dates, skip
 * an account whose budget is denied, skip an account backing more than one
 * channel (no per-channel identity in the response), skip a workspace
 * lacking the `fax` or `conversationAi` entitlement (never even calling
 * receive()), pre-check dedupe BEFORE downloading (so an already-ingested row
 * is never re-downloaded), never throw out of a download/ingest failure, and
 * fall back to the provider's own document URL when R2 isn't configured or
 * the download fails.
 */
describe('NetgsmFaxPollService.poll', () => {
  let prisma: any;
  let registry: any;
  let fax: any;
  let budgeter: any;
  let ingress: any;
  let r2: any;
  let entitlements: any;
  let service: NetgsmFaxPollService;
  // A real adapter instance for genuine (not re-implemented) parseInbound
  // behavior — the constructor deps (registry/balance/smsV2) aren't touched by
  // parseInbound, so dummies are fine (mirrors the voicemail poll's spec).
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

  const faxRow = (overrides: Partial<FaxRow> = {}): FaxRow => ({
    id: '42',
    from: '5551112233',
    date: '150120261245',
    documentUrl: 'https://sesdosya.netgsm.com.tr/fax/abc.pdf',
    ...overrides,
  });

  const entitled = (overrides: Record<string, boolean> = {}) => ({
    features: { fax: true, conversationAi: true, ...overrides },
    limits: {},
  });

  beforeEach(() => {
    jest.useFakeTimers();
    prisma = {
      channel: { findMany: jest.fn().mockResolvedValue([]) },
      message: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    registry = {
      has: jest.fn().mockReturnValue(true),
      get: jest.fn().mockReturnValue(realAdapter),
      resolveConfig: jest.fn().mockReturnValue(resolvedConfig()),
    };
    fax = { receive: jest.fn().mockResolvedValue({ ok: true, rows: [] }) };
    budgeter = { tryTake: jest.fn().mockReturnValue(true) };
    ingress = {
      ingest: jest.fn().mockResolvedValue({
        conversationId: 'cv1', messageId: 'm1', leadId: 'l1', isNewConversation: false, deduped: false,
      }),
    };
    r2 = { isConfigured: jest.fn().mockReturnValue(false), uploadToKey: jest.fn().mockResolvedValue({ url: 'https://r2/x', key: 'k', mime: 'application/pdf' }) };
    entitlements = { getEffective: jest.fn().mockResolvedValue(entitled()) };
    mockSafeFetch.mockReset();
    service = new NetgsmFaxPollService(prisma, registry, fax, budgeter, ingress, r2, entitlements);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('does nothing when there is no ACTIVE SMS channel', async () => {
    const out = await service.poll();
    expect(out).toEqual({ polled: 0, ingested: 0 });
    expect(fax.receive).not.toHaveBeenCalled();
  });

  it('skips an account backing more than one ACTIVE SMS channel (ambiguous fax attribution)', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    prisma.channel.findMany.mockResolvedValue([
      activeSmsChannel({ id: 'ch-1' }),
      activeSmsChannel({ id: 'ch-2' }),
    ]);
    registry.resolveConfig.mockReturnValue(resolvedConfig());

    const out = await service.poll();

    expect(out).toEqual({ polled: 0, ingested: 0 });
    expect(fax.receive).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('backs 2 ACTIVE SMS channels'));
  });

  describe('entitlement gating', () => {
    beforeEach(() => {
      prisma.channel.findMany.mockResolvedValue([activeSmsChannel()]);
    });

    it('skips (never calls receive) a workspace lacking the fax feature', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      entitlements.getEffective.mockResolvedValue(entitled({ fax: false }));

      const out = await service.poll();

      expect(entitlements.getEffective).toHaveBeenCalledWith('w1');
      expect(fax.receive).not.toHaveBeenCalled();
      expect(out).toEqual({ polled: 0, ingested: 0 });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('lacks the fax/conversationAi entitlement'));
    });

    it('skips (never calls receive) a workspace lacking the conversationAi (inbox) feature', async () => {
      entitlements.getEffective.mockResolvedValue(entitled({ conversationAi: false }));

      const out = await service.poll();

      expect(fax.receive).not.toHaveBeenCalled();
      expect(out).toEqual({ polled: 0, ingested: 0 });
    });

    it('calls receive when both fax and conversationAi are entitled', async () => {
      await service.poll();

      expect(fax.receive).toHaveBeenCalledTimes(1);
    });
  });

  describe('window computation', () => {
    beforeEach(() => {
      prisma.channel.findMany.mockResolvedValue([activeSmsChannel()]);
    });

    it('calls receive with the exact ddMMyyyyHHmm TR-local ≤24h window from a mocked clock', async () => {
      // 2026-01-15T10:00:00.000Z UTC == 13:00 TR-local (UTC+3, no DST).
      jest.setSystemTime(new Date('2026-01-15T10:00:00.000Z'));

      await service.poll();

      expect(fax.receive).toHaveBeenCalledWith(
        { usercode: 'u1', password: 'p1' },
        '150120261100', // stopdate - 2h
        '150120261300', // now, TR-local
      );
    });

    it('never calls receive without both dates', async () => {
      jest.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));

      await service.poll();

      expect(fax.receive).toHaveBeenCalledTimes(1);
      const [, startdate, stopdate] = fax.receive.mock.calls[0];
      expect(startdate).toMatch(/^\d{12}$/);
      expect(stopdate).toMatch(/^\d{12}$/);
    });
  });

  describe('budget', () => {
    it('skips the account (never calls receive) when the rate budget denies', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      prisma.channel.findMany.mockResolvedValue([activeSmsChannel()]);
      budgeter.tryTake.mockReturnValue(false);

      const out = await service.poll();

      expect(budgeter.tryTake).toHaveBeenCalledWith('u1', 'fax', 2, 60_000);
      expect(fax.receive).not.toHaveBeenCalled();
      expect(out).toEqual({ polled: 0, ingested: 0 });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('budget denied'));
    });
  });

  describe('ingestion + dedupe', () => {
    beforeEach(() => {
      prisma.channel.findMany.mockResolvedValue([activeSmsChannel()]);
    });

    it('skips (never fetches the document) a fax whose externalMessageId already resolved to a Message row', async () => {
      fax.receive.mockResolvedValue({ ok: true, rows: [faxRow()] });
      prisma.message.findFirst.mockResolvedValue({ id: 'existing-msg' });

      const out = await service.poll();

      expect(prisma.message.findFirst).toHaveBeenCalledWith({
        where: { externalMessageId: 'netgsm-fax:42', workspaceId: 'w1' },
        select: { id: true },
      });
      expect(mockSafeFetch).not.toHaveBeenCalled();
      expect(ingress.ingest).not.toHaveBeenCalled();
      expect(out.ingested).toBe(0);
      expect(out.polled).toBe(1);
    });

    it('ingests a NEW fax as a FAX message, namespaced netgsm-fax:<id>, and stores the document in R2 under a randomized key', async () => {
      fax.receive.mockResolvedValue({ ok: true, rows: [faxRow()] });
      r2.isConfigured.mockReturnValue(true);
      mockSafeFetch.mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode('%PDF-fax-bytes').buffer,
      });

      const out = await service.poll();

      expect(mockSafeFetch).toHaveBeenCalledWith('https://sesdosya.netgsm.com.tr/fax/abc.pdf', expect.objectContaining({ timeoutMs: 30_000 }));
      expect(r2.uploadToKey).toHaveBeenCalledTimes(1);
      const uploadedKey = r2.uploadToKey.mock.calls[0][0];
      expect(uploadedKey).toMatch(/^netgsm-fax\/w1\/42-[0-9a-f-]+\.pdf$/);
      expect(r2.uploadToKey).toHaveBeenCalledWith(uploadedKey, expect.objectContaining({ mimetype: 'application/pdf' }));
      expect(ingress.ingest).toHaveBeenCalledWith(
        { id: 'ch-1', workspaceId: 'w1', type: 'SMS' },
        expect.objectContaining({
          externalUserId: '+905551112233',
          kind: 'PHONE',
          externalMessageId: 'netgsm-fax:42',
          text: 'Faks alındı',
          raw: expect.objectContaining({
            kind: 'FAX',
            documentUrl: 'https://sesdosya.netgsm.com.tr/fax/abc.pdf',
            storedInR2: true,
          }),
        }),
      );
      expect(out.ingested).toBe(1);
    });

    it('does not count a row ConversationIngress reports as deduped (concurrent double-ingest)', async () => {
      fax.receive.mockResolvedValue({ ok: true, rows: [faxRow()] });
      ingress.ingest.mockResolvedValue({ conversationId: 'cv1', messageId: 'm1', leadId: 'l1', isNewConversation: false, deduped: true });

      const out = await service.poll();

      expect(out.ingested).toBe(0);
    });

    it('skips a fax row with no id (no reliable dedupe key), never calling ingress', async () => {
      fax.receive.mockResolvedValue({ ok: true, rows: [faxRow({ id: null })] });

      const out = await service.poll();

      expect(ingress.ingest).not.toHaveBeenCalled();
      expect(out.ingested).toBe(0);
    });
  });

  describe('document download + R2', () => {
    beforeEach(() => {
      prisma.channel.findMany.mockResolvedValue([activeSmsChannel()]);
    });

    it('R2-unconfigured: never attempts a download, keeps the provider url on the message, still ingests', async () => {
      fax.receive.mockResolvedValue({ ok: true, rows: [faxRow()] });
      r2.isConfigured.mockReturnValue(false);

      const out = await service.poll();

      expect(mockSafeFetch).not.toHaveBeenCalled();
      expect(r2.uploadToKey).not.toHaveBeenCalled();
      expect(ingress.ingest).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          raw: expect.objectContaining({ documentUrl: 'https://sesdosya.netgsm.com.tr/fax/abc.pdf', storedInR2: false }),
        }),
      );
      expect(out.ingested).toBe(1);
    });

    it('download failure never throws — the tick completes and still ingests the fax (provider url kept)', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      fax.receive.mockResolvedValue({ ok: true, rows: [faxRow()] });
      r2.isConfigured.mockReturnValue(true);
      mockSafeFetch.mockRejectedValue(new Error(`fetch failed for https://sesdosya.netgsm.com.tr/fax/abc.pdf?token=secret`));

      const out = await expect(service.poll()).resolves.toEqual({ polled: 1, ingested: 1 });
      void out;

      expect(r2.uploadToKey).not.toHaveBeenCalled();
      expect(ingress.ingest).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ raw: expect.objectContaining({ storedInR2: false }) }),
      );
      // The bearer-token-bearing document URL must never reach a log line raw.
      const leaked = warnSpy.mock.calls.some(([msg]) => typeof msg === 'string' && msg.includes('token=secret'));
      expect(leaked).toBe(false);
    });

    it('an empty download body is treated as a failure (no R2 store, provider url kept)', async () => {
      fax.receive.mockResolvedValue({ ok: true, rows: [faxRow()] });
      r2.isConfigured.mockReturnValue(true);
      mockSafeFetch.mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) });

      await service.poll();

      expect(r2.uploadToKey).not.toHaveBeenCalled();
    });

    it('a non-ok download response is treated as a failure (no R2 store, provider url kept)', async () => {
      fax.receive.mockResolvedValue({ ok: true, rows: [faxRow()] });
      r2.isConfigured.mockReturnValue(true);
      mockSafeFetch.mockResolvedValue({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });

      await service.poll();

      expect(r2.uploadToKey).not.toHaveBeenCalled();
    });
  });
});
