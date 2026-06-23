import { RecordingSyncService } from './recording-sync.service';
import { NetsantralClient } from './netsantral.client';

jest.mock('../../../common/scheduling/advisory-lock', () => ({
  withAdvisoryLock: jest.fn(async (_p: any, _n: any, cb: () => Promise<void>) => { await cb(); }),
}));

const SAVED = process.env.NETGSM_RECORDING_BASE_URL;

function makeSvc() {
  const prisma = { salesCall: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn().mockResolvedValue({}) } };
  const client = { fetchRecordingUrl: jest.fn() };
  const telephonyConfig = { resolveForWorkspace: jest.fn() };
  return { prisma, client, telephonyConfig, svc: new RecordingSyncService(prisma as any, client as any, telephonyConfig as any) };
}

describe('RecordingSyncService (Epic 13, inert call-recording)', () => {
  afterEach(() => {
    if (SAVED === undefined) delete process.env.NETGSM_RECORDING_BASE_URL;
    else process.env.NETGSM_RECORDING_BASE_URL = SAVED;
    jest.clearAllMocks();
  });

  it('is INERT when no recording endpoint is configured (no DB read)', async () => {
    delete process.env.NETGSM_RECORDING_BASE_URL;
    const { prisma, svc } = makeSvc();
    await svc.pullDueRecordings();
    expect(prisma.salesCall.findMany).not.toHaveBeenCalled();
  });

  it('sweeps ended api-dial calls missing a recording across workspaces and stamps the URL', async () => {
    process.env.NETGSM_RECORDING_BASE_URL = 'https://rec.example/api';
    const { prisma, client, telephonyConfig, svc } = makeSvc();
    prisma.salesCall.findMany.mockResolvedValue([
      { id: 'call-1', workspaceId: 'ws-1', externalCallId: 'x1' },
      { id: 'call-2', workspaceId: 'ws-1', externalCallId: 'x2' },
    ]);
    telephonyConfig.resolveForWorkspace.mockResolvedValue({ username: 'u', password: 'p', trunk: '0850', pbxnum: undefined });
    client.fetchRecordingUrl.mockResolvedValueOnce('https://rec.example/r/x1.mp3').mockResolvedValueOnce(null);
    await svc.pullDueRecordings();
    // the DUE query targets ended CONNECTED netgsm calls with no recording yet,
    // re-checking only those past the backoff (watermark) — ordered nulls-first.
    const arg = prisma.salesCall.findMany.mock.calls[0][0];
    expect(arg.where).toMatchObject({ providerId: 'netgsm-netsantral', status: 'CONNECTED', externalCallId: { not: null }, recordingUrl: null });
    expect(arg.where.OR).toBeDefined();
    expect(arg.orderBy).toEqual({ recordingCheckedAt: { sort: 'asc', nulls: 'first' } });
    expect(telephonyConfig.resolveForWorkspace).toHaveBeenCalledTimes(1); // ws creds cached
    // EVERY processed call gets the watermark stamped (so dead rows leave the front);
    // only the one with a URL also gets recordingUrl.
    expect(prisma.salesCall.update).toHaveBeenCalledTimes(2);
    const c1 = prisma.salesCall.update.mock.calls.find((c: any) => c[0].where.id === 'call-1')![0];
    const c2 = prisma.salesCall.update.mock.calls.find((c: any) => c[0].where.id === 'call-2')![0];
    expect(c1.data.recordingUrl).toBe('https://rec.example/r/x1.mp3');
    expect(c1.data.recordingCheckedAt).toBeInstanceOf(Date);
    expect(c2.data.recordingUrl).toBeUndefined(); // no recording → only the watermark
    expect(c2.data.recordingCheckedAt).toBeInstanceOf(Date);
  });

  it('a fetch error on one call still stamps its watermark and does not abort the sweep', async () => {
    process.env.NETGSM_RECORDING_BASE_URL = 'https://rec.example/api';
    const { prisma, client, telephonyConfig, svc } = makeSvc();
    prisma.salesCall.findMany.mockResolvedValue([
      { id: 'call-1', workspaceId: 'ws-1', externalCallId: 'x1' },
      { id: 'call-2', workspaceId: 'ws-1', externalCallId: 'x2' },
    ]);
    telephonyConfig.resolveForWorkspace.mockResolvedValue({ username: 'u', password: 'p', trunk: '0850' });
    client.fetchRecordingUrl.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('https://rec.example/r/x2.mp3');
    await svc.pullDueRecordings();
    // both stamped (the errored one too, so it leaves the front of the queue)
    expect(prisma.salesCall.update).toHaveBeenCalledTimes(2);
    const c2 = prisma.salesCall.update.mock.calls.find((c: any) => c[0].where.id === 'call-2')![0];
    expect(c2.data.recordingUrl).toBe('https://rec.example/r/x2.mp3');
  });

  describe('thicker behaviors', () => {
    beforeEach(() => { process.env.NETGSM_RECORDING_BASE_URL = 'https://rec.example/api'; });

    it('resolves telephony creds ONCE per distinct workspace and reuses them', async () => {
      const { prisma, client, telephonyConfig, svc } = makeSvc();
      // 3 calls across 2 workspaces (ws-1 twice, ws-2 once).
      prisma.salesCall.findMany.mockResolvedValue([
        { id: 'c1', workspaceId: 'ws-1', externalCallId: 'x1' },
        { id: 'c2', workspaceId: 'ws-1', externalCallId: 'x2' },
        { id: 'c3', workspaceId: 'ws-2', externalCallId: 'x3' },
      ]);
      telephonyConfig.resolveForWorkspace.mockResolvedValue({ username: 'u', password: 'p', trunk: '0850' });
      client.fetchRecordingUrl.mockResolvedValue(null);
      await svc.pullDueRecordings();
      // creds memoised per workspace: 2 distinct workspaces → 2 resolves (not 3).
      expect(telephonyConfig.resolveForWorkspace).toHaveBeenCalledTimes(2);
      expect(telephonyConfig.resolveForWorkspace).toHaveBeenCalledWith('ws-1');
      expect(telephonyConfig.resolveForWorkspace).toHaveBeenCalledWith('ws-2');
      // every call still stamped its watermark (so dead rows leave the front).
      expect(prisma.salesCall.update).toHaveBeenCalledTimes(3);
    });

    it('a workspace with no telephony config still attempts (undefined creds) and stamps the watermark', async () => {
      const { prisma, client, telephonyConfig, svc } = makeSvc();
      prisma.salesCall.findMany.mockResolvedValue([{ id: 'c1', workspaceId: 'ws-noconf', externalCallId: 'x1' }]);
      telephonyConfig.resolveForWorkspace.mockResolvedValue(null); // no per-ws creds
      client.fetchRecordingUrl.mockResolvedValue(null);
      await svc.pullDueRecordings();
      // called with the external id + undefined creds (falls back to global endpoint creds).
      expect(client.fetchRecordingUrl).toHaveBeenCalledWith('x1', undefined);
      expect(prisma.salesCall.update.mock.calls[0][0].data.recordingCheckedAt).toBeInstanceOf(Date);
    });

    it('the DUE query bounds the window (endedAt gte) and batches (take=200)', async () => {
      const { prisma, svc } = makeSvc();
      await svc.pullDueRecordings();
      const arg = prisma.salesCall.findMany.mock.calls[0][0];
      expect(arg.where.endedAt).toMatchObject({ not: null });
      expect(arg.where.endedAt.gte).toBeInstanceOf(Date);
      expect(arg.take).toBe(200);
    });
  });
});

describe('NetsantralClient.fetchRecordingUrl', () => {
  const client = new NetsantralClient();
  afterEach(() => {
    if (SAVED === undefined) delete process.env.NETGSM_RECORDING_BASE_URL;
    else process.env.NETGSM_RECORDING_BASE_URL = SAVED;
  });

  it('returns null (inert) when the endpoint env is unset', async () => {
    delete process.env.NETGSM_RECORDING_BASE_URL;
    expect(NetsantralClient.recordingEnabled()).toBe(false);
    expect(await client.fetchRecordingUrl('x1')).toBeNull();
  });
});
