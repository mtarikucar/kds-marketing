import { Logger } from '@nestjs/common';

// ── safeFetch mock (audio download) ─────────────────────────────────────────
const mockSafeFetch = jest.fn();
jest.mock('../../../common/util/safe-fetch', () => ({
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

import { NetgsmVoicemailPollService } from './netgsm-voicemail-poll.service';
import { NetgsmSmsAdapter } from './adapters/netgsm-sms.adapter';
import { VoicemailRow } from '../../netgsm/voice/voicesms.client';

/**
 * The voicemail poll is the ONLY path voicemail reaches the inbox through
 * (unlike the MO poll, which backs up a push webhook) — hourly, per NetGSM
 * account, it re-fetches the last 2h of `/voicesms/receive` rows (date-ranged
 * form ONLY) and, for every genuinely new row, best-effort downloads the
 * `sesdosya` audio into R2, best-effort transcribes it, and ingests it as an
 * inbound Message through `ConversationIngressService` — the SAME path
 * NetgsmSmsAdapter's push/poll SMS ingestion uses, tagged
 * `meta.raw.kind === 'VOICEMAIL'` and namespaced `netgsm-vm:<id>` (distinct
 * from the SMS poller's `netgsm-mo:<id>`). It must: never call
 * receiveVoicemails without both dates, skip an account whose budget is
 * denied, skip an account backing more than one channel (no per-channel
 * identity in the response), pre-check dedupe BEFORE downloading (so an
 * already-ingested row is never re-downloaded), never throw out of a
 * download/STT/ingest failure, and fall back to the provider's own audio URL
 * when R2 isn't configured or the download fails.
 */
describe('NetgsmVoicemailPollService.poll', () => {
  let prisma: any;
  let registry: any;
  let voicesms: any;
  let budgeter: any;
  let ingress: any;
  let r2: any;
  let stt: any;
  let service: NetgsmVoicemailPollService;
  // A real adapter instance for genuine (not re-implemented) parseInbound
  // behavior — the constructor deps (registry/balance/smsV2) aren't touched by
  // parseInbound, so dummies are fine (mirrors NetgsmMoPollService's spec).
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

  const voicemailRow = (overrides: Partial<VoicemailRow> = {}): VoicemailRow => ({
    id: '42',
    from: '5551112233',
    date: '150120261245',
    audioUrl: 'https://sesdosya.netgsm.com.tr/abc.wav',
    durationSec: 12,
    ...overrides,
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
    voicesms = { receiveVoicemails: jest.fn().mockResolvedValue({ ok: true, voicemails: [] }) };
    budgeter = { tryTake: jest.fn().mockReturnValue(true) };
    ingress = {
      ingest: jest.fn().mockResolvedValue({
        conversationId: 'cv1', messageId: 'm1', leadId: 'l1', isNewConversation: false, deduped: false,
      }),
    };
    r2 = { isConfigured: jest.fn().mockReturnValue(false), uploadToKey: jest.fn().mockResolvedValue({ url: 'https://r2/x', key: 'k', mime: 'audio/mpeg' }) };
    stt = { transcribeUrl: jest.fn().mockResolvedValue(null) };
    mockSafeFetch.mockReset();
    service = new NetgsmVoicemailPollService(prisma, registry, voicesms, budgeter, ingress, r2, stt);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('does nothing when there is no ACTIVE SMS channel', async () => {
    const out = await service.poll();
    expect(out).toEqual({ polled: 0, ingested: 0 });
    expect(voicesms.receiveVoicemails).not.toHaveBeenCalled();
  });

  it('skips an account backing more than one ACTIVE SMS channel (ambiguous voicemail attribution)', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    prisma.channel.findMany.mockResolvedValue([
      activeSmsChannel({ id: 'ch-1' }),
      activeSmsChannel({ id: 'ch-2' }),
    ]);
    registry.resolveConfig.mockReturnValue(resolvedConfig());

    const out = await service.poll();

    expect(out).toEqual({ polled: 0, ingested: 0 });
    expect(voicesms.receiveVoicemails).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('backs 2 ACTIVE SMS channels'));
  });

  describe('window computation', () => {
    beforeEach(() => {
      prisma.channel.findMany.mockResolvedValue([activeSmsChannel()]);
    });

    it('calls receiveVoicemails with the exact ddMMyyyyHHmm TR-local ≤24h window from a mocked clock', async () => {
      // 2026-01-15T10:00:00.000Z UTC == 13:00 TR-local (UTC+3, no DST).
      jest.setSystemTime(new Date('2026-01-15T10:00:00.000Z'));

      await service.poll();

      expect(voicesms.receiveVoicemails).toHaveBeenCalledWith(
        { usercode: 'u1', password: 'p1' },
        '150120261100', // stopdate - 2h
        '150120261300', // now, TR-local
      );
    });

    it('never calls receiveVoicemails without both dates', async () => {
      jest.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));

      await service.poll();

      expect(voicesms.receiveVoicemails).toHaveBeenCalledTimes(1);
      const [, startdate, stopdate] = voicesms.receiveVoicemails.mock.calls[0];
      expect(startdate).toMatch(/^\d{12}$/);
      expect(stopdate).toMatch(/^\d{12}$/);
    });
  });

  describe('budget', () => {
    it('skips the account (never calls receiveVoicemails) when the rate budget denies', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      prisma.channel.findMany.mockResolvedValue([activeSmsChannel()]);
      budgeter.tryTake.mockReturnValue(false);

      const out = await service.poll();

      expect(budgeter.tryTake).toHaveBeenCalledWith('u1', 'voicemail', 2, 60_000);
      expect(voicesms.receiveVoicemails).not.toHaveBeenCalled();
      expect(out).toEqual({ polled: 0, ingested: 0 });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('budget denied'));
    });
  });

  describe('ingestion + dedupe', () => {
    beforeEach(() => {
      prisma.channel.findMany.mockResolvedValue([activeSmsChannel()]);
    });

    it('skips (never fetches audio) a voicemail whose externalMessageId already resolved to a Message row', async () => {
      voicesms.receiveVoicemails.mockResolvedValue({ ok: true, voicemails: [voicemailRow()] });
      prisma.message.findFirst.mockResolvedValue({ id: 'existing-msg' });

      const out = await service.poll();

      expect(prisma.message.findFirst).toHaveBeenCalledWith({
        where: { externalMessageId: 'netgsm-vm:42', workspaceId: 'w1' },
        select: { id: true },
      });
      expect(mockSafeFetch).not.toHaveBeenCalled();
      expect(ingress.ingest).not.toHaveBeenCalled();
      expect(out.ingested).toBe(0);
      expect(out.polled).toBe(1);
    });

    it('ingests a new voicemail as a VOICEMAIL message, namespaced netgsm-vm:<id>, and stores the recording in R2 under a randomized key (HIGH-2 fix)', async () => {
      voicesms.receiveVoicemails.mockResolvedValue({ ok: true, voicemails: [voicemailRow()] });
      r2.isConfigured.mockReturnValue(true);
      mockSafeFetch.mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode('audio-bytes').buffer,
      });
      stt.transcribeUrl.mockResolvedValue({ text: 'Merhaba, lütfen beni arayın', provider: 'deepgram' });

      const out = await service.poll();

      expect(mockSafeFetch).toHaveBeenCalledWith('https://sesdosya.netgsm.com.tr/abc.wav', expect.objectContaining({ timeoutMs: 30_000 }));
      expect(r2.uploadToKey).toHaveBeenCalledTimes(1);
      const uploadedKey = r2.uploadToKey.mock.calls[0][0];
      // HIGH-2 fix: not derivable from workspaceId+voicemailId alone.
      expect(uploadedKey).toMatch(/^netgsm-voicemail\/w1\/42-[0-9a-f-]+\.mp3$/);
      expect(r2.uploadToKey).toHaveBeenCalledWith(uploadedKey, expect.objectContaining({ mimetype: 'audio/mpeg' }));
      expect(ingress.ingest).toHaveBeenCalledWith(
        { id: 'ch-1', workspaceId: 'w1', type: 'SMS' },
        expect.objectContaining({
          externalUserId: '+905551112233',
          kind: 'PHONE',
          externalMessageId: 'netgsm-vm:42',
          text: 'Merhaba, lütfen beni arayın',
          raw: expect.objectContaining({
            kind: 'VOICEMAIL',
            audioUrl: 'https://sesdosya.netgsm.com.tr/abc.wav',
            durationSec: 12,
            storedInR2: true,
          }),
        }),
      );
      expect(out.ingested).toBe(1);
    });

    it('falls back to the literal "Sesli mesaj" body when STT yields no preview', async () => {
      voicesms.receiveVoicemails.mockResolvedValue({ ok: true, voicemails: [voicemailRow()] });
      stt.transcribeUrl.mockResolvedValue(null);

      await service.poll();

      expect(ingress.ingest).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ text: 'Sesli mesaj' }),
      );
    });

    it('does not count a row ConversationIngress reports as deduped (concurrent double-ingest)', async () => {
      voicesms.receiveVoicemails.mockResolvedValue({ ok: true, voicemails: [voicemailRow()] });
      ingress.ingest.mockResolvedValue({ conversationId: 'cv1', messageId: 'm1', leadId: 'l1', isNewConversation: false, deduped: true });

      const out = await service.poll();

      expect(out.ingested).toBe(0);
    });

    it('skips a voicemail row with no id (no reliable dedupe key), never calling ingress', async () => {
      voicesms.receiveVoicemails.mockResolvedValue({ ok: true, voicemails: [voicemailRow({ id: null })] });

      const out = await service.poll();

      expect(ingress.ingest).not.toHaveBeenCalled();
      expect(out.ingested).toBe(0);
    });
  });

  describe('recording download + R2', () => {
    beforeEach(() => {
      prisma.channel.findMany.mockResolvedValue([activeSmsChannel()]);
    });

    it('R2-unconfigured: never attempts a download, keeps the provider url on the message, still ingests', async () => {
      voicesms.receiveVoicemails.mockResolvedValue({ ok: true, voicemails: [voicemailRow()] });
      r2.isConfigured.mockReturnValue(false);

      const out = await service.poll();

      expect(mockSafeFetch).not.toHaveBeenCalled();
      expect(r2.uploadToKey).not.toHaveBeenCalled();
      expect(ingress.ingest).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          raw: expect.objectContaining({ audioUrl: 'https://sesdosya.netgsm.com.tr/abc.wav', storedInR2: false }),
        }),
      );
      expect(out.ingested).toBe(1);
    });

    it('download failure never throws — the tick completes and still ingests the voicemail (provider url kept)', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      voicesms.receiveVoicemails.mockResolvedValue({ ok: true, voicemails: [voicemailRow()] });
      r2.isConfigured.mockReturnValue(true);
      mockSafeFetch.mockRejectedValue(new Error(`fetch failed for https://sesdosya.netgsm.com.tr/abc.wav?token=secret`));

      const out = await expect(service.poll()).resolves.toEqual({ polled: 1, ingested: 1 });
      void out;

      expect(r2.uploadToKey).not.toHaveBeenCalled();
      expect(ingress.ingest).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ raw: expect.objectContaining({ storedInR2: false }) }),
      );
      // The bearer-token-bearing audio URL must never reach a log line raw.
      const leaked = warnSpy.mock.calls.some(([msg]) => typeof msg === 'string' && msg.includes('token=secret'));
      expect(leaked).toBe(false);
    });

    it('an empty download body is treated as a failure (no R2 store, provider url kept)', async () => {
      voicesms.receiveVoicemails.mockResolvedValue({ ok: true, voicemails: [voicemailRow()] });
      r2.isConfigured.mockReturnValue(true);
      mockSafeFetch.mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) });

      await service.poll();

      expect(r2.uploadToKey).not.toHaveBeenCalled();
    });

    it('a non-ok download response is treated as a failure (no R2 store, provider url kept)', async () => {
      voicesms.receiveVoicemails.mockResolvedValue({ ok: true, voicemails: [voicemailRow()] });
      r2.isConfigured.mockReturnValue(true);
      mockSafeFetch.mockResolvedValue({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });

      await service.poll();

      expect(r2.uploadToKey).not.toHaveBeenCalled();
    });
  });
});
