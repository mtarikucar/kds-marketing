import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import { TelephonyReportsService } from './telephony-reports.service';

describe('TelephonyReportsService', () => {
  let telephonyConfig: { resolveForWorkspace: jest.Mock };
  let client: { fetchStatistics: jest.Mock };
  let budgeter: { tryTake: jest.Mock };
  let svc: TelephonyReportsService;

  const WS = 'ws-1';
  const CREDS = { username: '8508407303', password: 'pw' };

  beforeEach(() => {
    telephonyConfig = { resolveForWorkspace: jest.fn().mockResolvedValue(CREDS) };
    client = { fetchStatistics: jest.fn().mockResolvedValue({ ok: true, daily: [] }) };
    budgeter = { tryTake: jest.fn().mockReturnValue(true) };
    svc = new TelephonyReportsService(telephonyConfig as any, client as any, budgeter as any);
  });

  it('resolves creds, budgets the request, and returns the daily aggregates + a rolled-up summary', async () => {
    client.fetchStatistics.mockResolvedValue({
      ok: true,
      daily: [
        { date: '2026-07-01', answered: 10, abandoned: 2, avgWaitSec: 30 },
        { date: '2026-07-02', answered: 5, abandoned: 0, avgWaitSec: 60 },
      ],
    });

    const res = await svc.statistics(WS, '2026-07-01', '2026-07-02');

    expect(telephonyConfig.resolveForWorkspace).toHaveBeenCalledWith(WS);
    // usercode is the workspace's netsantral `username` field, mapped for the api.netgsm.com.tr host.
    expect(budgeter.tryTake).toHaveBeenCalledWith('8508407303', 'statistics', 2, 60_000);
    expect(client.fetchStatistics).toHaveBeenCalledWith(
      { usercode: '8508407303', password: 'pw' },
      expect.objectContaining({ mode: 1 }),
    );
    expect(res.ok).toBe(true);
    expect(res.clamped).toBe(false);
    expect(res.daily).toHaveLength(2);
    // weighted: (10+2)*30 + (5+0)*60 = 360+300=660 / (12+5=17) = 38.8 -> 39
    expect(res.summary).toEqual({ answered: 15, abandoned: 2, avgWaitSec: 39 });
  });

  it('defaults to a trailing 7-day window when from/to are omitted', async () => {
    const res = await svc.statistics(WS);
    const spanMs = new Date(res.to).getTime() - new Date(res.from).getTime();
    expect(spanMs).toBe(6 * 24 * 3_600_000);
    expect(res.clamped).toBe(false);
  });

  it('clamps a wider-than-7-day request to the trailing week (keeps the most recent days)', async () => {
    const res = await svc.statistics(WS, '2026-06-01', '2026-07-08');
    expect(res.clamped).toBe(true);
    expect(res.to).toBe('2026-07-08');
    expect(res.from).toBe('2026-07-01'); // toDate - 7 days
    const [, params] = client.fetchStatistics.mock.calls[0];
    expect(params.mode).toBe(1);
  });

  it('does not clamp a request that is already within 7 days', async () => {
    const res = await svc.statistics(WS, '2026-07-01', '2026-07-05');
    expect(res.clamped).toBe(false);
    expect(res.from).toBe('2026-07-01');
    expect(res.to).toBe('2026-07-05');
  });

  it('surfaces a NetGSM rejection (e.g. off-prod IP not allow-listed) as {ok:false, code} instead of throwing', async () => {
    client.fetchStatistics.mockResolvedValue({ ok: false, code: '30', message: 'IP not allowed', daily: [] });

    const res = await svc.statistics(WS);

    expect(res.ok).toBe(false);
    expect(res.code).toBe('30');
    expect(res.message).toBe('IP not allowed');
    expect(res.daily).toEqual([]);
    expect(res.summary).toEqual({ answered: 0, abandoned: 0, avgWaitSec: null });
  });

  it('never crashes when the client omits daily on a success response', async () => {
    client.fetchStatistics.mockResolvedValue({ ok: true });
    const res = await svc.statistics(WS);
    expect(res.daily).toEqual([]);
    expect(res.summary).toEqual({ answered: 0, abandoned: 0, avgWaitSec: null });
  });

  it('throws a 429 HttpException when the statistics budget (2/min) is exhausted, without calling the client', async () => {
    budgeter.tryTake.mockReturnValue(false);
    await expect(svc.statistics(WS)).rejects.toBeInstanceOf(HttpException);
    await expect(svc.statistics(WS)).rejects.toMatchObject({ status: 429 });
    expect(client.fetchStatistics).not.toHaveBeenCalled();
  });

  it('503s when the workspace has no active netsantral config, without budgeting or calling the client', async () => {
    telephonyConfig.resolveForWorkspace.mockResolvedValue(null);
    await expect(svc.statistics(WS)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(budgeter.tryTake).not.toHaveBeenCalled();
    expect(client.fetchStatistics).not.toHaveBeenCalled();
  });
});
