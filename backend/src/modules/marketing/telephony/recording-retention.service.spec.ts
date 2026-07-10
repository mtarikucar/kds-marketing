import { RecordingRetentionService } from './recording-retention.service';

jest.mock('../../../common/scheduling/advisory-lock', () => ({
  withAdvisoryLock: jest.fn(async (_p: any, _n: any, cb: () => Promise<void>) => { await cb(); }),
}));

function makeSvc() {
  const prisma = {
    telephonyConfig: { findMany: jest.fn().mockResolvedValue([]) },
    salesCall: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
  const r2 = { deleteKeys: jest.fn().mockResolvedValue(undefined) };
  return { prisma, r2, svc: new RecordingRetentionService(prisma as any, r2 as any) };
}

describe('RecordingRetentionService', () => {
  afterEach(() => jest.clearAllMocks());

  it('skips entirely when no workspace has recordingRetentionDays set (keep-forever default)', async () => {
    const { prisma, r2, svc } = makeSvc();
    prisma.telephonyConfig.findMany.mockResolvedValue([]);
    const result = await svc.retain();
    expect(result).toEqual({ deleted: 0 });
    expect(prisma.telephonyConfig.findMany).toHaveBeenCalledWith({
      where: { recordingRetentionDays: { not: null } },
      select: { workspaceId: true, recordingRetentionDays: true },
    });
    expect(prisma.salesCall.findMany).not.toHaveBeenCalled();
    expect(r2.deleteKeys).not.toHaveBeenCalled();
  });

  it('a workspace with recordingRetentionDays: null is never queried (excluded by the config read itself)', async () => {
    // Simulated at the DB layer: findMany's `where` already excludes nulls, so
    // this asserts the query shape rather than app-level filtering.
    const { prisma, svc } = makeSvc();
    await svc.retain();
    const arg = prisma.telephonyConfig.findMany.mock.calls[0][0];
    expect(arg.where.recordingRetentionDays).toEqual({ not: null });
  });

  it('deletes R2 objects past retention and nulls BOTH recordingStorageKey and recordingUrl in the SAME updateMany (HIGH-1 fix — stops recording-ingest from re-selecting a purged call)', async () => {
    const { prisma, r2, svc } = makeSvc();
    prisma.telephonyConfig.findMany.mockResolvedValue([{ workspaceId: 'ws-1', recordingRetentionDays: 30 }]);
    prisma.salesCall.findMany.mockResolvedValue([
      { id: 'call-1', recordingStorageKey: 'netgsm-recordings/ws-1/call-1-abc123.mp3' },
      { id: 'call-2', recordingStorageKey: 'netgsm-recordings/ws-1/call-2-def456.mp3' },
    ]);
    prisma.salesCall.updateMany.mockResolvedValue({ count: 2 });

    const result = await svc.retain();

    const callArg = prisma.salesCall.findMany.mock.calls[0][0];
    expect(callArg.where.workspaceId).toBe('ws-1');
    expect(callArg.where.recordingStorageKey).toEqual({ not: null });
    expect(callArg.where.endedAt).toMatchObject({ not: null });
    expect(callArg.where.endedAt.lt).toBeInstanceOf(Date);

    expect(r2.deleteKeys).toHaveBeenCalledWith([
      'netgsm-recordings/ws-1/call-1-abc123.mp3',
      'netgsm-recordings/ws-1/call-2-def456.mp3',
    ]);
    // HIGH-1 fix: recordingUrl is nulled in the SAME updateMany as
    // recordingStorageKey — recording-ingest's DUE query requires
    // `recordingUrl: { not: null }`, so leaving it set would let a purged
    // call re-enter the ingest queue and get silently re-downloaded within
    // minutes, defeating retention entirely.
    expect(prisma.salesCall.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['call-1', 'call-2'] }, workspaceId: 'ws-1' },
      data: { recordingStorageKey: null, recordingUrl: null },
    });
    expect(result).toEqual({ deleted: 2 });
  });

  it('a workspace with no past-retention calls does nothing (no delete, no update)', async () => {
    const { prisma, r2, svc } = makeSvc();
    prisma.telephonyConfig.findMany.mockResolvedValue([{ workspaceId: 'ws-1', recordingRetentionDays: 30 }]);
    prisma.salesCall.findMany.mockResolvedValue([]);
    const result = await svc.retain();
    expect(r2.deleteKeys).not.toHaveBeenCalled();
    expect(prisma.salesCall.updateMany).not.toHaveBeenCalled();
    expect(result).toEqual({ deleted: 0 });
  });

  it('one workspace failing does not abort the sweep for other workspaces', async () => {
    const { prisma, r2, svc } = makeSvc();
    prisma.telephonyConfig.findMany.mockResolvedValue([
      { workspaceId: 'ws-bad', recordingRetentionDays: 10 },
      { workspaceId: 'ws-good', recordingRetentionDays: 10 },
    ]);
    prisma.salesCall.findMany
      .mockRejectedValueOnce(new Error('db hiccup'))
      .mockResolvedValueOnce([{ id: 'call-1', recordingStorageKey: 'netgsm-recordings/ws-good/call-1.mp3' }]);
    prisma.salesCall.updateMany.mockResolvedValue({ count: 1 });

    const result = await svc.retain();

    expect(r2.deleteKeys).toHaveBeenCalledWith(['netgsm-recordings/ws-good/call-1.mp3']);
    expect(result).toEqual({ deleted: 1 });
  });

  it('bounds the per-workspace read (take)', async () => {
    const { prisma, svc } = makeSvc();
    prisma.telephonyConfig.findMany.mockResolvedValue([{ workspaceId: 'ws-1', recordingRetentionDays: 30 }]);
    await svc.retain();
    expect(prisma.salesCall.findMany.mock.calls[0][0].take).toBe(200);
  });
});
