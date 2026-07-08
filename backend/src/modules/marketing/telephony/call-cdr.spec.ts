import { normalizeRecords } from '../../netgsm/santral/netgsm-cdr.client';
import { CallCdrSyncService } from './call-cdr-sync.service';

jest.mock('../../../common/scheduling/advisory-lock', () => ({
  withAdvisoryLock: jest.fn(async (_p: any, _n: any, cb: () => Promise<void>) => {
    await cb();
  }),
}));

describe('normalizeRecords — defensive CDR parsing', () => {
  it('parses a flat array with string duration', () => {
    const out = normalizeRecords([{ destination: '5551234567', duration: '42', recording: 'http://r/1' }]);
    expect(out[0]).toMatchObject({ destination: '5551234567', duration: 42, recording: 'http://r/1' });
  });

  it('parses Turkish field aliases and a 0 duration', () => {
    const out = normalizeRecords([{ aranan: '5060687100', sure: '0' }]);
    expect(out[0]).toMatchObject({ destination: '5060687100', duration: 0 });
  });

  it('unwraps a {uniqueid, values:{…}} shape', () => {
    const out = normalizeRecords([{ uniqueid: 'sip9-1.2', values: { destination: '900', duration: '7' } }]);
    expect(out[0]).toMatchObject({ uniqueid: 'sip9-1.2', destination: '900', duration: 7 });
  });

  it('handles a keyed-by-uniqueid object', () => {
    const out = normalizeRecords({ 'sip9-1': { destination: '111', duration: '3' } });
    expect(out).toHaveLength(1);
    expect(out[0].destination).toBe('111');
  });
});

describe('CallCdrSyncService.syncWorkspace', () => {
  let prisma: any;
  let registry: any;
  let cdr: any;
  let telephony: any;
  let svc: CallCdrSyncService;

  beforeEach(() => {
    prisma = {
      channel: { findMany: jest.fn().mockResolvedValue([{ id: 'sms1', type: 'SMS', status: 'ACTIVE' }]) },
      salesCall: { findMany: jest.fn(), update: jest.fn().mockResolvedValue({}) },
    };
    registry = { resolveConfig: jest.fn().mockReturnValue({ secrets: { usercode: 'u', password: 'p' } }) };
    cdr = { fetchCdr: jest.fn() };
    telephony = { resolveForWorkspace: jest.fn().mockResolvedValue(null) };
    svc = new CallCdrSyncService(prisma, registry, cdr, telephony);
  });

  it('fills a matched call as CONNECTED with duration + recording', async () => {
    prisma.salesCall.findMany.mockResolvedValue([
      { id: 'c1', toPhone: '+90 506 068 71 00', startedAt: new Date('2026-06-24T10:00:00Z') },
    ]);
    cdr.fetchCdr.mockResolvedValue([{ destination: '5060687100', duration: 42, recording: 'http://rec/1' }]);

    const n = await svc.syncWorkspace('ws');
    expect(n).toBe(1);
    expect(prisma.salesCall.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'c1' },
        data: expect.objectContaining({ status: 'CONNECTED', durationSec: 42, recordingUrl: 'http://rec/1' }),
      }),
    );
  });

  it('marks a zero-duration match as NO_ANSWER', async () => {
    prisma.salesCall.findMany.mockResolvedValue([{ id: 'c1', toPhone: '5060687100', startedAt: new Date() }]);
    cdr.fetchCdr.mockResolvedValue([{ destination: '905060687100', duration: 0 }]);
    await svc.syncWorkspace('ws');
    expect(prisma.salesCall.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'NO_ANSWER', durationSec: 0 }) }),
    );
  });

  it('is inert (no creds) when there is no ACTIVE SMS channel', async () => {
    prisma.channel.findMany.mockResolvedValue([]);
    const n = await svc.syncWorkspace('ws');
    expect(n).toBe(0);
    expect(prisma.salesCall.findMany).not.toHaveBeenCalled();
  });

  it('does nothing when no CDR record matches the call number', async () => {
    prisma.salesCall.findMany.mockResolvedValue([{ id: 'c1', toPhone: '5551112222', startedAt: new Date() }]);
    cdr.fetchCdr.mockResolvedValue([{ destination: '5060687100', duration: 30 }]);
    const n = await svc.syncWorkspace('ws');
    expect(n).toBe(0);
    expect(prisma.salesCall.update).not.toHaveBeenCalled();
  });

  it('falls back to telephony-config creds when there is no SMS channel', async () => {
    prisma.channel.findMany.mockResolvedValue([]); // no SMS channel
    telephony.resolveForWorkspace.mockResolvedValue({ username: '8508407303', password: 'D.78ABC', trunk: 't' });
    prisma.salesCall.findMany.mockResolvedValue([{ id: 'c1', toPhone: '5060687100', startedAt: new Date() }]);
    cdr.fetchCdr.mockResolvedValue([{ destination: '5060687100', duration: 12 }]);
    const n = await svc.syncWorkspace('ws');
    expect(n).toBe(1);
    expect(cdr.fetchCdr).toHaveBeenCalledWith(
      { usercode: '8508407303', password: 'D.78ABC' },
      expect.any(String),
      expect.any(String),
    );
  });
});

describe('CallCdrSyncService.syncDue (cron tick — workspace enumeration)', () => {
  let prisma: any;
  let registry: any;
  let cdr: any;
  let telephony: any;
  let svc: CallCdrSyncService;

  beforeEach(() => {
    prisma = { channel: { findMany: jest.fn().mockResolvedValue([]) } };
    registry = { resolveConfig: jest.fn() };
    cdr = { fetchCdr: jest.fn() };
    telephony = { resolveForWorkspace: jest.fn() };
    svc = new CallCdrSyncService(prisma, registry, cdr, telephony);
  });

  it('syncs a workspace that has an ACTIVE SMS channel', async () => {
    prisma.channel.findMany.mockResolvedValue([{ workspaceId: 'ws-with-sms' }]);
    const spy = jest.spyOn(svc, 'syncWorkspace').mockResolvedValue(0);

    await svc.syncDue();

    expect(prisma.channel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { type: 'SMS', status: 'ACTIVE' } }),
    );
    expect(spy).toHaveBeenCalledWith('ws-with-sms');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does not sync a workspace without an ACTIVE SMS channel', async () => {
    prisma.channel.findMany.mockResolvedValue([]); // no ACTIVE SMS channel anywhere
    const spy = jest.spyOn(svc, 'syncWorkspace').mockResolvedValue(0);

    await svc.syncDue();

    expect(spy).not.toHaveBeenCalled();
  });

  it('syncs each distinct workspace exactly once', async () => {
    prisma.channel.findMany.mockResolvedValue([{ workspaceId: 'ws-a' }, { workspaceId: 'ws-b' }]);
    const spy = jest.spyOn(svc, 'syncWorkspace').mockResolvedValue(0);

    await svc.syncDue();

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenCalledWith('ws-a');
    expect(spy).toHaveBeenCalledWith('ws-b');
  });
});
