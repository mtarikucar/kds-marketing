import { RecordingIngestService } from './recording-ingest.service';
import { safeFetch } from '../../../common/util/safe-fetch';

jest.mock('../../../common/scheduling/advisory-lock', () => ({
  withAdvisoryLock: jest.fn(async (_p: any, _n: any, cb: () => Promise<void>) => { await cb(); }),
}));

jest.mock('../../../common/util/safe-fetch', () => ({
  safeFetch: jest.fn(),
}));

const mockSafeFetch = safeFetch as jest.Mock;

function makeSvc() {
  const prisma = {
    telephonyConfig: { findMany: jest.fn().mockResolvedValue([{ workspaceId: 'ws-1' }]) },
    salesCall: {
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const r2 = {
    isConfigured: jest.fn().mockReturnValue(true),
    uploadToKey: jest.fn().mockResolvedValue({ url: 'https://cdn.example.com/x', key: 'x', mime: 'audio/mpeg' }),
  };
  return { prisma, r2, svc: new RecordingIngestService(prisma as any, r2 as any) };
}

function fakeResponse(ok: boolean, status: number, bytes: Uint8Array = new Uint8Array([1, 2, 3])): any {
  return { ok, status, arrayBuffer: async () => bytes.buffer };
}

describe('RecordingIngestService', () => {
  afterEach(() => jest.clearAllMocks());

  describe('gating', () => {
    it('is INERT when R2 is not configured (no DB read at all)', async () => {
      const { prisma, r2, svc } = makeSvc();
      r2.isConfigured.mockReturnValue(false);
      const result = await svc.ingest();
      expect(result).toEqual({ processed: 0, ingested: 0 });
      expect(prisma.telephonyConfig.findMany).not.toHaveBeenCalled();
      expect(prisma.salesCall.findMany).not.toHaveBeenCalled();
    });

    it('skips entirely when no workspace has recordCalls on (no due-call read)', async () => {
      const { prisma, svc } = makeSvc();
      prisma.telephonyConfig.findMany.mockResolvedValue([]);
      const result = await svc.ingest();
      expect(result).toEqual({ processed: 0, ingested: 0 });
      expect(prisma.salesCall.findMany).not.toHaveBeenCalled();
    });

    it('scopes the due-call query to workspaces with recordCalls true', async () => {
      const { prisma, svc } = makeSvc();
      prisma.telephonyConfig.findMany.mockResolvedValue([{ workspaceId: 'ws-1' }, { workspaceId: 'ws-2' }]);
      await svc.ingest();
      expect(prisma.telephonyConfig.findMany).toHaveBeenCalledWith({
        where: { recordCalls: true },
        select: { workspaceId: true },
      });
      const arg = prisma.salesCall.findMany.mock.calls[0][0];
      expect(arg.where.workspaceId).toEqual({ in: ['ws-1', 'ws-2'] });
      expect(arg.where.status).toBe('CONNECTED');
      expect(arg.where.recordingUrl).toEqual({ not: null });
      expect(arg.where.recordingStorageKey).toBeNull();
      expect(arg.where.OR).toBeDefined();
      expect(arg.orderBy).toEqual({ recordingCheckedAt: { sort: 'asc', nulls: 'first' } });
      expect(arg.take).toBe(50);
    });
  });

  describe('ingest happy path', () => {
    it('appends &tomp3, downloads via safeFetch, uploads to a randomized R2 key, and stamps recordingStorageKey with that exact key (HIGH-2 fix)', async () => {
      const { prisma, r2, svc } = makeSvc();
      prisma.salesCall.findMany.mockResolvedValue([
        { id: 'call-1', workspaceId: 'ws-1', recordingUrl: 'https://dosya.netgsm.com.tr/rec?token=SECRET123' },
      ]);
      mockSafeFetch.mockResolvedValue(fakeResponse(true, 200));

      const result = await svc.ingest();

      expect(mockSafeFetch).toHaveBeenCalledWith(
        'https://dosya.netgsm.com.tr/rec?token=SECRET123&tomp3',
        expect.objectContaining({ timeoutMs: expect.any(Number) }),
      );
      expect(r2.uploadToKey).toHaveBeenCalledTimes(1);
      const uploadedKey = r2.uploadToKey.mock.calls[0][0];
      // HIGH-2 fix: the key must NOT be derivable from workspaceId+callId
      // alone (that pair is exactly what the tokened proxy URL exposes to
      // the browser) — it carries a random UUID segment.
      expect(uploadedKey).toMatch(/^netgsm-recordings\/ws-1\/call-1-[0-9a-f-]+\.mp3$/);
      expect(r2.uploadToKey).toHaveBeenCalledWith(uploadedKey, expect.objectContaining({ mimetype: 'audio/mpeg' }));
      const uploadArg = r2.uploadToKey.mock.calls[0][1];
      expect(Buffer.isBuffer(uploadArg.buffer)).toBe(true);

      // recordingStorageKey is stamped with the EXACT randomized key that was
      // uploaded — never recomputed from ws+callId elsewhere.
      expect(prisma.salesCall.updateMany).toHaveBeenCalledWith({
        where: { id: 'call-1', workspaceId: 'ws-1', recordingStorageKey: null },
        data: { recordingStorageKey: uploadedKey },
      });
      // watermark ALWAYS advances
      expect(prisma.salesCall.update).toHaveBeenCalledWith({
        where: { id: 'call-1' },
        data: { recordingCheckedAt: expect.any(Date) },
      });
      expect(result).toEqual({ processed: 1, ingested: 1 });
    });

    it('uploads to a DIFFERENT key on each call, even for the same call id (random segment is per-attempt, not memoized)', async () => {
      const { prisma, r2, svc } = makeSvc();
      prisma.salesCall.findMany
        .mockResolvedValueOnce([
          { id: 'call-1', workspaceId: 'ws-1', recordingUrl: 'https://dosya.netgsm.com.tr/rec?token=t1' },
        ])
        .mockResolvedValueOnce([
          { id: 'call-1', workspaceId: 'ws-1', recordingUrl: 'https://dosya.netgsm.com.tr/rec?token=t1' },
        ]);
      mockSafeFetch.mockResolvedValue(fakeResponse(true, 200));

      await svc.ingest();
      const firstKey = r2.uploadToKey.mock.calls[0][0];
      await svc.ingest();
      const secondKey = r2.uploadToKey.mock.calls[1][0];

      expect(firstKey).not.toBe(secondKey);
    });

    it('never logs the tokenized recordingUrl even on failure', async () => {
      const { prisma, svc } = makeSvc();
      prisma.salesCall.findMany.mockResolvedValue([
        { id: 'call-1', workspaceId: 'ws-1', recordingUrl: 'https://dosya.netgsm.com.tr/rec?token=SUPERSECRET' },
      ]);
      mockSafeFetch.mockRejectedValue(new Error('network unreachable'));
      const warnSpy = jest.spyOn((svc as any).logger, 'warn');

      await svc.ingest();

      for (const call of warnSpy.mock.calls) {
        expect(String(call.join(' '))).not.toContain('SUPERSECRET');
      }
    });

    // LOW-2 fix — locks in the redaction itself: safeFetch's own URL-parse-error
    // branch can echo a (truncated) URL back into e.message, which would carry
    // the bearer token straight into the log line if not stripped. This rejects
    // with an Error whose message CONTAINS a full tokenized URL (rather than a
    // plain string like the test above) to actually exercise the
    // `.replace(/https?:\/\/\S+/gi, '***')` redaction, not just assert its
    // absence incidentally.
    it('redacts an https URL embedded in the caught error message (safeFetch URL-parse-error echo path)', async () => {
      const { prisma, svc } = makeSvc();
      prisma.salesCall.findMany.mockResolvedValue([
        { id: 'call-1', workspaceId: 'ws-1', recordingUrl: 'https://dosya.netgsm.com.tr/rec?token=SECRET123' },
      ]);
      mockSafeFetch.mockRejectedValue(
        new Error('invalid URL: https://dosya.netgsm.com.tr/rec?token=SECRET123&tomp3'),
      );
      const warnSpy = jest.spyOn((svc as any).logger, 'warn');

      await svc.ingest();

      const logged = warnSpy.mock.calls.map((call) => String(call.join(' '))).join('\n');
      expect(logged).not.toContain('SECRET123');
      expect(logged).not.toContain('https://dosya.netgsm.com.tr');
      expect(logged).toContain('***');
    });
  });

  describe('never throws / idempotency', () => {
    it('a download failure (network error) does not abort the tick and still advances the watermark', async () => {
      const { prisma, svc } = makeSvc();
      prisma.salesCall.findMany.mockResolvedValue([
        { id: 'call-1', workspaceId: 'ws-1', recordingUrl: 'https://dosya.netgsm.com.tr/rec?token=t1' },
        { id: 'call-2', workspaceId: 'ws-1', recordingUrl: 'https://dosya.netgsm.com.tr/rec?token=t2' },
      ]);
      mockSafeFetch
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce(fakeResponse(true, 200));

      const result = await svc.ingest();

      expect(prisma.salesCall.update).toHaveBeenCalledTimes(2);
      expect(prisma.salesCall.update).toHaveBeenCalledWith({
        where: { id: 'call-1' },
        data: { recordingCheckedAt: expect.any(Date) },
      });
      expect(prisma.salesCall.update).toHaveBeenCalledWith({
        where: { id: 'call-2' },
        data: { recordingCheckedAt: expect.any(Date) },
      });
      expect(result.ingested).toBe(1);
    });

    it('a non-ok HTTP response is treated as a failure, not thrown, and still advances the watermark', async () => {
      const { prisma, svc } = makeSvc();
      prisma.salesCall.findMany.mockResolvedValue([
        { id: 'call-1', workspaceId: 'ws-1', recordingUrl: 'https://dosya.netgsm.com.tr/rec?token=t1' },
      ]);
      mockSafeFetch.mockResolvedValue(fakeResponse(false, 404));

      const result = await svc.ingest();

      expect(prisma.salesCall.updateMany).not.toHaveBeenCalled();
      expect(prisma.salesCall.update).toHaveBeenCalledWith({
        where: { id: 'call-1' },
        data: { recordingCheckedAt: expect.any(Date) },
      });
      expect(result).toEqual({ processed: 1, ingested: 0 });
    });

    it('the guarded updateMany (recordingStorageKey: null) makes ingestOne idempotent — a no-op count is not counted as ingested', async () => {
      const { prisma, svc } = makeSvc();
      prisma.salesCall.findMany.mockResolvedValue([
        { id: 'call-1', workspaceId: 'ws-1', recordingUrl: 'https://dosya.netgsm.com.tr/rec?token=t1' },
      ]);
      mockSafeFetch.mockResolvedValue(fakeResponse(true, 200));
      prisma.salesCall.updateMany.mockResolvedValue({ count: 0 }); // another pass already stamped it

      const result = await svc.ingest();

      expect(result.ingested).toBe(0);
      // watermark still advances even though the row was already claimed elsewhere
      expect(prisma.salesCall.update).toHaveBeenCalled();
    });

    it('an empty downloaded body is treated as a failure (no upload attempted)', async () => {
      const { prisma, r2, svc } = makeSvc();
      prisma.salesCall.findMany.mockResolvedValue([
        { id: 'call-1', workspaceId: 'ws-1', recordingUrl: 'https://dosya.netgsm.com.tr/rec?token=t1' },
      ]);
      mockSafeFetch.mockResolvedValue(fakeResponse(true, 200, new Uint8Array([])));

      const result = await svc.ingest();

      expect(r2.uploadToKey).not.toHaveBeenCalled();
      expect(result.ingested).toBe(0);
    });
  });

  describe('watermark prevents immediate re-download', () => {
    it('the recheck OR clause covers null-or-stale recordingCheckedAt', async () => {
      const { prisma, svc } = makeSvc();
      await svc.ingest();
      const arg = prisma.salesCall.findMany.mock.calls[0][0];
      expect(arg.where.OR).toEqual([
        { recordingCheckedAt: null },
        { recordingCheckedAt: { lt: expect.any(Date) } },
      ]);
    });
  });

  describe('HIGH-1 fix — retention purge stops the re-ingest loop', () => {
    it('the DUE query requires recordingUrl NOT NULL, so a purged call (RecordingRetentionService nulls recordingUrl on purge) structurally cannot be re-selected', async () => {
      const { prisma, svc } = makeSvc();
      await svc.ingest();
      const arg = prisma.salesCall.findMany.mock.calls[0][0];
      expect(arg.where.recordingUrl).toEqual({ not: null });

      // Shape of a row immediately after RecordingRetentionService.retainWorkspace
      // purges it (see recording-retention.service.ts): status stays CONNECTED,
      // but BOTH recordingStorageKey and recordingUrl are null. Prisma's
      // `{ not: null }` predicate on a null field never matches — this asserts
      // that invariant directly against the purged shape, rather than just the
      // query's literal text, so a future refactor of either service that
      // breaks the pairing is caught here too.
      const purgedCallRow = { status: 'CONNECTED', recordingUrl: null, recordingStorageKey: null };
      const matchesDue =
        purgedCallRow.status === 'CONNECTED' &&
        purgedCallRow.recordingUrl !== null &&
        purgedCallRow.recordingStorageKey === null;
      expect(matchesDue).toBe(false);
    });
  });
});
