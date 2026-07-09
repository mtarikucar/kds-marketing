// ── safeFetch mock ──────────────────────────────────────────────────────────
const mockSafeFetch = jest.fn();
jest.mock('../../../common/util/safe-fetch', () => ({
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

import { NetgsmStatisticsClient } from './netgsm-statistics.client';

function res(status: number, body: unknown) {
  return { status, json: async () => body };
}

const CREDS = { usercode: 'u', password: 'p' };
const PARAMS1 = { mode: 1 as const, startdate: '01072026000000', stopdate: '07072026235900' };
const PARAMS2 = { mode: 2 as const, startdate: '01072026000000', stopdate: '07072026235900' };

describe('NetgsmStatisticsClient', () => {
  let client: NetgsmStatisticsClient;

  beforeEach(() => {
    client = new NetgsmStatisticsClient();
    mockSafeFetch.mockReset();
  });

  describe('fetchRaw', () => {
    it('POSTs usercode/password/mode/startdate/stopdate as JSON to the statistics URL', async () => {
      mockSafeFetch.mockResolvedValue(res(200, { code: '00' }));
      await client.fetchRaw(CREDS, PARAMS1);
      const [url, init] = mockSafeFetch.mock.calls[0];
      expect(url).toBe('https://api.netgsm.com.tr/netsantral/statistics');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({
        usercode: 'u', password: 'p', mode: 1, startdate: PARAMS1.startdate, stopdate: PARAMS1.stopdate,
      });
    });
  });

  describe('fetchStatistics — mode 1 (daily aggregates)', () => {
    it('normalizes a plain array of daily rows, tolerating several field aliases', async () => {
      mockSafeFetch.mockResolvedValue(
        res(200, [
          { date: '01072026', answered: '10', abandoned: '2', avgWaitSec: '35' },
          { tarih: '02072026', cevaplanan: 8, cevapsiz: 1, ortalama_bekleme: '00:42' },
        ]),
      );
      const r = await client.fetchStatistics(CREDS, PARAMS1);
      expect(r.ok).toBe(true);
      expect(r.daily).toEqual([
        { date: '01072026', answered: 10, abandoned: 2, avgWaitSec: 35 },
        { date: '02072026', answered: 8, abandoned: 1, avgWaitSec: 42 },
      ]);
      expect(r.calls).toBeUndefined();
    });

    it('unwraps a {data:[...]} envelope', async () => {
      mockSafeFetch.mockResolvedValue(res(200, { data: [{ date: '01072026', answered: 5, abandoned: 0 }] }));
      const r = await client.fetchStatistics(CREDS, PARAMS1);
      expect(r.ok).toBe(true);
      expect(r.daily).toEqual([{ date: '01072026', answered: 5, abandoned: 0, avgWaitSec: null }]);
    });

    it('unwraps a {daily:[...]} envelope', async () => {
      mockSafeFetch.mockResolvedValue(res(200, { daily: [{ date: '01072026', answered: 3, abandoned: 1 }] }));
      const r = await client.fetchStatistics(CREDS, PARAMS1);
      expect(r.daily).toEqual([{ date: '01072026', answered: 3, abandoned: 1, avgWaitSec: null }]);
    });

    it('returns [] (not null/throw) on a NetGSM error envelope (e.g. off-prod pre-auth rejection)', async () => {
      mockSafeFetch.mockResolvedValue(res(200, { code: '30', error: 'IP not allowed' }));
      const r = await client.fetchStatistics(CREDS, PARAMS1);
      expect(r.ok).toBe(false);
      expect(r.code).toBe('30');
      expect(r.message).toBe('IP not allowed');
      expect(r.daily).toEqual([]);
    });

    it('returns [] on an empty/null body without throwing', async () => {
      mockSafeFetch.mockResolvedValue(res(200, null));
      const r = await client.fetchStatistics(CREDS, PARAMS1);
      expect(r.ok).toBe(false);
      expect(r.daily).toEqual([]);
    });

    it('returns [] and never logs/leaks credentials when the transport throws', async () => {
      mockSafeFetch.mockRejectedValue(new Error(`ECONNRESET calling with password=${CREDS.password}`));
      const r = await client.fetchStatistics(CREDS, PARAMS1);
      expect(r.ok).toBe(false);
      expect(r.daily).toEqual([]);
      expect(r.message).not.toContain(CREDS.password);
    });
  });

  describe('fetchStatistics — mode 2 (per-call detail)', () => {
    it('normalizes per-call rows tolerantly, including the recording link', async () => {
      mockSafeFetch.mockResolvedValue(
        res(200, [
          { date: '01072026', source: '905551112233', destination: '02121234567', duration: '120', waitSec: '5', status: 'answered', recording: 'https://dosya.netgsm.com.tr/x' },
          { tarih: '01072026', arayan: '905559998877', aranan: '02129998877', sure: '0', bekleme: '00:15', durum: 'abandoned' },
        ]),
      );
      const r = await client.fetchStatistics(CREDS, PARAMS2);
      expect(r.ok).toBe(true);
      expect(r.calls).toEqual([
        {
          date: '01072026', source: '905551112233', destination: '02121234567',
          duration: 120, waitSec: 5, status: 'answered', recording: 'https://dosya.netgsm.com.tr/x',
        },
        {
          date: '01072026', source: '905559998877', destination: '02129998877',
          duration: 0, waitSec: 15, status: 'abandoned', recording: undefined,
        },
      ]);
      expect(r.daily).toBeUndefined();
    });

    it('returns [] on a NetGSM error envelope for mode 2 too', async () => {
      mockSafeFetch.mockResolvedValue(res(200, { code: '331', error: 'rate limited' }));
      const r = await client.fetchStatistics(CREDS, PARAMS2);
      expect(r.ok).toBe(false);
      expect(r.code).toBe('331');
      expect(r.calls).toEqual([]);
    });

    it('drops rows with neither source nor destination (junk/keyed-noise entries)', async () => {
      mockSafeFetch.mockResolvedValue(res(200, [{ duration: 10 }, { destination: '0212', duration: 5 }]));
      const r = await client.fetchStatistics(CREDS, PARAMS2);
      expect(r.calls).toHaveLength(1);
      expect(r.calls?.[0].destination).toBe('0212');
    });
  });
});
