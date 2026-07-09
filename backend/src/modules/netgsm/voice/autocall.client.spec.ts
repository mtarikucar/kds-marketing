// ── safeFetch mock ──────────────────────────────────────────────────────────
const mockSafeFetch = jest.fn();
jest.mock('../../../common/util/safe-fetch', () => ({
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

import { AutocallClient, hasIysfilter } from './autocall.client';
import { AccountRateBudgeter } from '../core/account-rate-budgeter';

function res(status: number, body: unknown) {
  return { status, json: async () => body };
}

// Multi-character (not single-letter) creds so the "never leaks credentials"
// assertions below are meaningful substring checks, not accidental passes.
const CREDS = { usercode: 'acctcode', password: 'secretpw' };

function makeClient() {
  const budgeter = new AccountRateBudgeter();
  return { budgeter, client: new AutocallClient(budgeter) };
}

describe('hasIysfilter', () => {
  it('accepts only 0/11/12', () => {
    expect(hasIysfilter('0')).toBe(true);
    expect(hasIysfilter('11')).toBe(true);
    expect(hasIysfilter('12')).toBe(true);
    expect(hasIysfilter('13')).toBe(false);
    expect(hasIysfilter(undefined)).toBe(false);
    expect(hasIysfilter(null)).toBe(false);
    expect(hasIysfilter('')).toBe(false);
  });
});

describe('AutocallClient', () => {
  beforeEach(() => {
    mockSafeFetch.mockReset();
  });

  describe('addAutocall', () => {
    it('refuses to create a list without a valid iysfilter — never touches the network', async () => {
      const { client } = makeClient();
      const res2 = await client.addAutocall(CREDS, {
        listName: 'Parallel', destinationType: 'queue', queueName: 'sales-queue',
        iysfilter: undefined as any,
      });
      expect(res2.ok).toBe(false);
      expect(res2.message).toMatch(/iysfilter/i);
      expect(mockSafeFetch).not.toHaveBeenCalled();
    });

    it('creates a dynamic list, sends destination_type/queue_name/iysfilter, returns jobId/listId', async () => {
      const { client } = makeClient();
      mockSafeFetch.mockResolvedValue(res(200, { code: '00', jobid: 'job-123' }));
      const out = await client.addAutocall(CREDS, {
        listName: 'Parallel', destinationType: 'queue', queueName: 'sales-queue',
        iysfilter: '11', brandcode: 'BR1', retryCount: 2,
        timeWindows: [{ day: 'MONDAY', start: '09:00', end: '18:00' }],
        url: 'https://hub.example.com/autocall-report',
      });
      expect(out).toEqual({ ok: true, code: '00', jobId: 'job-123', listId: 'job-123', message: null, retriable: false });
      const [url, init] = mockSafeFetch.mock.calls[0];
      expect(url).toBe(AutocallClient.ADD_URL);
      const sentBody = JSON.parse(init.body);
      expect(sentBody).toMatchObject({
        usercode: 'acctcode', password: 'secretpw',
        list_name: 'Parallel', destination_type: 'queue', queue_name: 'sales-queue',
        iysfilter: '11', brandcode: 'BR1', retry_count: 2, list_type: 'DYNAMIC',
        url: 'https://hub.example.com/autocall-report',
      });
      expect(sentBody.time_windows).toEqual([{ day: 'MONDAY', start: '09:00', end: '18:00' }]);
    });

    it('a non-00 code maps to netgsmErrorMessage when the provider omits `error`', async () => {
      const { client } = makeClient();
      mockSafeFetch.mockResolvedValue(res(200, { code: '60' }));
      const out = await client.addAutocall(CREDS, {
        listName: 'L', destinationType: 'queue', queueName: 'q', iysfilter: '0',
      });
      expect(out.ok).toBe(false);
      expect(out.code).toBe('60');
      expect(out.message).toMatch(/paket/i);
    });

    it('code 80 is retriable, everything else is not', async () => {
      const { client } = makeClient();
      mockSafeFetch.mockResolvedValue(res(200, { code: '80', error: 'rate limited' }));
      const out = await client.addAutocall(CREDS, { listName: 'L', destinationType: 'queue', queueName: 'q', iysfilter: '0' });
      expect(out.retriable).toBe(true);
    });

    it('scrubs creds from a transport error before logging (never throws)', async () => {
      mockSafeFetch.mockRejectedValue(new Error('connect ECONNREFUSED to acctcode secretpw'));
      const { client } = makeClient();
      const warnSpy = jest.spyOn((client as any).logger, 'warn').mockImplementation(() => undefined);
      const out = await client.addAutocall(CREDS, { listName: 'L', destinationType: 'queue', queueName: 'q', iysfilter: '0' });
      expect(out.ok).toBe(false);
      expect(warnSpy.mock.calls[0][0]).not.toContain('secretpw');
      expect(warnSpy.mock.calls[0][0]).not.toContain('acctcode');
    });

    it('empty response body → ok:false without throwing', async () => {
      const { client } = makeClient();
      mockSafeFetch.mockResolvedValue(res(200, null));
      const out = await client.addAutocall(CREDS, { listName: 'L', destinationType: 'queue', queueName: 'q', iysfilter: '0' });
      expect(out.ok).toBe(false);
    });

    it('an exhausted budget denies the call before ever reaching the network', async () => {
      const { client, budgeter } = makeClient();
      for (let i = 0; i < 10; i++) budgeter.tryTake('acctcode', 'autocall', 10, 60_000);
      const out = await client.addAutocall(CREDS, { listName: 'L', destinationType: 'queue', queueName: 'q', iysfilter: '0' });
      expect(out.ok).toBe(false);
      expect(out.retriable).toBe(true);
      expect(mockSafeFetch).not.toHaveBeenCalled();
    });
  });

  describe('addNumber / deleteNumber', () => {
    it('addNumber posts list_id + no, returns ok on code 00', async () => {
      const { client } = makeClient();
      mockSafeFetch.mockResolvedValue(res(200, { code: '00' }));
      const out = await client.addNumber(CREDS, 'job-123', '905551112233');
      expect(out).toEqual({ ok: true, code: '00', message: null, retriable: false });
      const [url, init] = mockSafeFetch.mock.calls[0];
      expect(url).toBe(AutocallClient.ADD_NUMBER_URL);
      expect(JSON.parse(init.body)).toMatchObject({ list_id: 'job-123', no: '905551112233' });
    });

    it('deleteNumber posts to the delete endpoint', async () => {
      const { client } = makeClient();
      mockSafeFetch.mockResolvedValue(res(200, { code: '00' }));
      const out = await client.deleteNumber(CREDS, 'job-123', '905551112233');
      expect(out.ok).toBe(true);
      expect(mockSafeFetch.mock.calls[0][0]).toBe(AutocallClient.DELETE_NUMBER_URL);
    });

    it('shares the SAME budget bucket as addAutocall (10/min account-wide)', async () => {
      const { client, budgeter } = makeClient();
      mockSafeFetch.mockResolvedValue(res(200, { code: '00' }));
      for (let i = 0; i < 10; i++) budgeter.tryTake('acctcode', 'autocall', 10, 60_000);
      const out = await client.addNumber(CREDS, 'job-123', '905551112233');
      expect(out.ok).toBe(false);
      expect(out.retriable).toBe(true);
      expect(mockSafeFetch).not.toHaveBeenCalled();
    });

    it('a transport error never throws and scrubs creds', async () => {
      mockSafeFetch.mockRejectedValue(new Error('timeout for acctcode:secretpw'));
      const { client } = makeClient();
      const out = await client.addNumber(CREDS, 'job-123', '905551112233');
      expect(out.ok).toBe(false);
      expect(out.message).not.toContain('secretpw');
    });
  });

  describe('updateListStatus', () => {
    it('sends status=start / status=stop', async () => {
      const { client } = makeClient();
      mockSafeFetch.mockResolvedValue(res(200, { code: '00' }));
      await client.updateListStatus(CREDS, 'job-123', 'start');
      expect(JSON.parse(mockSafeFetch.mock.calls[0][1].body)).toMatchObject({ list_id: 'job-123', status: 'start' });

      mockSafeFetch.mockResolvedValue(res(200, { code: '00' }));
      await client.updateListStatus(CREDS, 'job-123', 'stop');
      expect(JSON.parse(mockSafeFetch.mock.calls[1][1].body)).toMatchObject({ list_id: 'job-123', status: 'stop' });
    });

    it('a non-00 code surfaces ok:false with the provider message', async () => {
      const { client } = makeClient();
      mockSafeFetch.mockResolvedValue(res(200, { code: '70', error: 'eksik parametre' }));
      const out = await client.updateListStatus(CREDS, 'job-123', 'start');
      expect(out).toEqual({ ok: false, code: '70', message: 'eksik parametre', retriable: false });
    });
  });

  describe('reportAutocall', () => {
    it('normalizes an array response into rows', async () => {
      const { client } = makeClient();
      mockSafeFetch.mockResolvedValue(res(200, [
        { called: '905551112233', unique_id: 'u1', status: 'ANSWERED' },
        { no: '905551112244', uniqueid: 'u2', durum: 'NO_ANSWER' },
      ]));
      const out = await client.reportAutocall(CREDS, 'job-123');
      expect(out.ok).toBe(true);
      expect(out.rows).toEqual([
        expect.objectContaining({ called: '905551112233', uniqueId: 'u1', status: 'ANSWERED' }),
        expect.objectContaining({ called: '905551112244', uniqueId: 'u2' }),
      ]);
    });

    it('an error envelope ({code, error}, no array) returns ok:false, rows:[]', async () => {
      const { client } = makeClient();
      mockSafeFetch.mockResolvedValue(res(200, { code: '30', error: 'auth failed' }));
      const out = await client.reportAutocall(CREDS, 'job-123');
      expect(out).toEqual({ ok: false, rows: [], message: 'auth failed', retriable: false });
    });

    it('budget exhaustion never reaches the network and is retriable', async () => {
      const { client, budgeter } = makeClient();
      for (let i = 0; i < 10; i++) budgeter.tryTake('acctcode', 'autocall', 10, 60_000);
      const out = await client.reportAutocall(CREDS, 'job-123');
      expect(out.ok).toBe(false);
      expect(out.retriable).toBe(true);
      expect(mockSafeFetch).not.toHaveBeenCalled();
    });
  });
});
