// ── safeFetch mock ──────────────────────────────────────────────────────────
const mockSafeFetch = jest.fn();
jest.mock('../../../common/util/safe-fetch', () => ({
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

import { FaxClient } from './fax.client';

function res(status: number, body: unknown) {
  return { status, json: async () => body };
}

// Multi-character (not single-letter) creds so the "never leaks credentials"
// assertions below are meaningful substring checks, not accidental passes.
const CREDS = { usercode: 'acctcode', password: 'secretpw' };
const STARTDATE = '01072026000000';
const STOPDATE = '01072026120000';

describe('FaxClient', () => {
  let client: FaxClient;

  beforeEach(() => {
    client = new FaxClient();
    mockSafeFetch.mockReset();
  });

  describe('send', () => {
    it('POSTs a multipart form with usercode/password/no/dosya to the fax/send URL', async () => {
      mockSafeFetch.mockResolvedValue(res(200, { code: '00', jobId: 'job-1' }));
      const doc = Buffer.from('%PDF-1.4 fake pdf body');
      const r = await client.send(CREDS, { to: '905551112233', document: doc, filename: 'offer.pdf' });
      expect(r).toEqual({ ok: true, code: '00', jobId: 'job-1', message: null, retriable: false, transport: false });
      const [url, init] = mockSafeFetch.mock.calls[0];
      expect(url).toBe('https://api.netgsm.com.tr/fax/send');
      expect(init.method).toBe('POST');
      expect(init.body).toBeInstanceOf(FormData);
      const form = init.body as FormData;
      expect(form.get('usercode')).toBe('acctcode');
      expect(form.get('password')).toBe('secretpw');
      expect(form.get('no')).toBe('905551112233');
      const file = form.get('dosya') as File;
      expect(file).toBeTruthy();
      expect(file.name).toBe('offer.pdf');
    });

    it('carries the optional header onto the wire as `baslik` when provided', async () => {
      mockSafeFetch.mockResolvedValue(res(200, { code: '00', jobId: 'job-2' }));
      await client.send(CREDS, {
        to: '905551112233',
        document: Buffer.from('%PDF-1.4'),
        filename: 'a.pdf',
        header: 'ACME A.Ş.',
      });
      const [, init] = mockSafeFetch.mock.calls[0];
      const form = init.body as FormData;
      expect(form.get('baslik')).toBe('ACME A.Ş.');
    });

    it('omits `baslik` when no header is provided', async () => {
      mockSafeFetch.mockResolvedValue(res(200, { code: '00', jobId: 'job-3' }));
      await client.send(CREDS, { to: '905551112233', document: Buffer.from('%PDF-1.4'), filename: 'a.pdf' });
      const [, init] = mockSafeFetch.mock.calls[0];
      const form = init.body as FormData;
      expect(form.get('baslik')).toBeNull();
    });

    it('rejects an empty document buffer WITHOUT calling NetGSM', async () => {
      const r = await client.send(CREDS, { to: '905551112233', document: Buffer.alloc(0), filename: 'empty.pdf' });
      expect(r.ok).toBe(false);
      expect(r.transport).toBe(false);
      expect(mockSafeFetch).not.toHaveBeenCalled();
    });

    it("rejects a document over the client's sanity cap WITHOUT calling NetGSM", async () => {
      const big = Buffer.alloc(5 * 1024 * 1024 + 1);
      const r = await client.send(CREDS, { to: '905551112233', document: big, filename: 'huge.pdf' });
      expect(r.ok).toBe(false);
      expect(mockSafeFetch).not.toHaveBeenCalled();
    });

    it('rejects a missing/blank recipient WITHOUT calling NetGSM', async () => {
      const r = await client.send(CREDS, { to: '   ', document: Buffer.from('%PDF-1.4'), filename: 'a.pdf' });
      expect(r.ok).toBe(false);
      expect(mockSafeFetch).not.toHaveBeenCalled();
    });

    it('maps an error envelope {code, error} to a non-ok, non-retriable, non-transport result', async () => {
      mockSafeFetch.mockResolvedValue(res(200, { code: '60', error: 'no fax package' }));
      const r = await client.send(CREDS, { to: '905551112233', document: Buffer.from('%PDF-1.4'), filename: 'a.pdf' });
      expect(r.ok).toBe(false);
      expect(r.code).toBe('60');
      expect(r.message).toBe('no fax package');
      expect(r.retriable).toBe(false);
      expect(r.transport).toBe(false);
      expect(r.jobId).toBeNull();
    });

    it('falls back to the shared netgsmErrorMessage vocabulary when no error text is supplied', async () => {
      mockSafeFetch.mockResolvedValue(res(200, { code: '30' }));
      const r = await client.send(CREDS, { to: '905551112233', document: Buffer.from('%PDF-1.4'), filename: 'a.pdf' });
      expect(r.ok).toBe(false);
      expect(r.message).toContain('kod 30');
    });

    it('code 80 (rate limit) is retriable', async () => {
      mockSafeFetch.mockResolvedValue(res(200, { code: '80' }));
      const r = await client.send(CREDS, { to: '905551112233', document: Buffer.from('%PDF-1.4'), filename: 'a.pdf' });
      expect(r.retriable).toBe(true);
      expect(r.transport).toBe(false);
    });

    it('a transport error (rejected promise) is flagged transport:true and never leaks credentials', async () => {
      mockSafeFetch.mockRejectedValue(new Error(`ECONNRESET password=${CREDS.password} usercode=${CREDS.usercode}`));
      const r = await client.send(CREDS, { to: '905551112233', document: Buffer.from('%PDF-1.4'), filename: 'a.pdf' });
      expect(r.ok).toBe(false);
      expect(r.transport).toBe(true);
      expect(r.message).not.toContain(CREDS.password);
      expect(r.message).not.toContain(CREDS.usercode);
    });

    it('an unrecognized body with no code is a non-retriable, non-transport failure (a response WAS received)', async () => {
      mockSafeFetch.mockResolvedValue(res(200, { foo: 'bar' }));
      const r = await client.send(CREDS, { to: '905551112233', document: Buffer.from('%PDF-1.4'), filename: 'a.pdf' });
      expect(r.ok).toBe(false);
      expect(r.retriable).toBe(false);
      expect(r.transport).toBe(false);
    });

    it('a null/empty body is a non-retriable, non-transport failure', async () => {
      mockSafeFetch.mockResolvedValue(res(200, null));
      const r = await client.send(CREDS, { to: '905551112233', document: Buffer.from('%PDF-1.4'), filename: 'a.pdf' });
      expect(r.ok).toBe(false);
      expect(r.transport).toBe(false);
    });
  });

  describe('receive', () => {
    it('POSTs usercode/password/startdate/stopdate as JSON to the fax/receive URL', async () => {
      mockSafeFetch.mockResolvedValue(res(200, []));
      await client.receive(CREDS, STARTDATE, STOPDATE);
      const [url, init] = mockSafeFetch.mock.calls[0];
      expect(url).toBe('https://api.netgsm.com.tr/fax/receive');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({
        usercode: 'acctcode', password: 'secretpw', startdate: STARTDATE, stopdate: STOPDATE,
      });
    });

    it('normalizes a plain array of fax rows, tolerating several field aliases', async () => {
      mockSafeFetch.mockResolvedValue(
        res(200, [
          { id: '123', from: '905551112233', date: '01072026091500', documentUrl: 'https://sesdosya.netgsm.com.tr/x.pdf' },
          { faxid: '456', gonderen: '905559998877', tarih: '01072026094500', dosya: 'https://sesdosya.netgsm.com.tr/y.pdf' },
        ]),
      );
      const r = await client.receive(CREDS, STARTDATE, STOPDATE);
      expect(r.ok).toBe(true);
      expect(r.rows).toEqual([
        { id: '123', from: '905551112233', date: '01072026091500', documentUrl: 'https://sesdosya.netgsm.com.tr/x.pdf' },
        { id: '456', from: '905559998877', date: '01072026094500', documentUrl: 'https://sesdosya.netgsm.com.tr/y.pdf' },
      ]);
    });

    it('unwraps a {data:[...]} envelope', async () => {
      mockSafeFetch.mockResolvedValue(
        res(200, { data: [{ id: '1', from: '905551112233', documentUrl: 'https://sesdosya.netgsm.com.tr/x.pdf' }] }),
      );
      const r = await client.receive(CREDS, STARTDATE, STOPDATE);
      expect(r.ok).toBe(true);
      expect(r.rows).toEqual([
        { id: '1', from: '905551112233', date: null, documentUrl: 'https://sesdosya.netgsm.com.tr/x.pdf' },
      ]);
    });

    it('unwraps a {rows:[...]} envelope', async () => {
      mockSafeFetch.mockResolvedValue(res(200, { rows: [{ id: '2', from: '905551112233' }] }));
      const r = await client.receive(CREDS, STARTDATE, STOPDATE);
      expect(r.rows).toEqual([{ id: '2', from: '905551112233', date: null, documentUrl: null }]);
    });

    it('returns [] (not null/throw) on a NetGSM error envelope (e.g. off-prod pre-auth rejection)', async () => {
      mockSafeFetch.mockResolvedValue(res(200, { code: '30', error: 'IP not allowed' }));
      const r = await client.receive(CREDS, STARTDATE, STOPDATE);
      expect(r.ok).toBe(false);
      expect(r.code).toBe('30');
      expect(r.message).toBe('IP not allowed');
      expect(r.rows).toEqual([]);
    });

    it('returns [] on an empty/null body without throwing', async () => {
      mockSafeFetch.mockResolvedValue(res(200, null));
      const r = await client.receive(CREDS, STARTDATE, STOPDATE);
      expect(r.ok).toBe(false);
      expect(r.rows).toEqual([]);
    });

    it('returns [] and never logs/leaks credentials when the transport throws', async () => {
      mockSafeFetch.mockRejectedValue(new Error(`ECONNRESET calling with password=${CREDS.password}`));
      const r = await client.receive(CREDS, STARTDATE, STOPDATE);
      expect(r.ok).toBe(false);
      expect(r.rows).toEqual([]);
      expect(r.message).not.toContain(CREDS.password);
    });

    it('drops rows with neither an id nor a from (junk/keyed-noise entries)', async () => {
      mockSafeFetch.mockResolvedValue(res(200, [{ documentUrl: 'x' }, { id: '9', from: '905551112233' }]));
      const r = await client.receive(CREDS, STARTDATE, STOPDATE);
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].id).toBe('9');
    });
  });
});
