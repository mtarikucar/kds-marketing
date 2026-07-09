// ── safeFetch mock ──────────────────────────────────────────────────────────
const mockSafeFetch = jest.fn();
jest.mock('../../../common/util/safe-fetch', () => ({
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

import { VoicesmsSendClient } from './voicesms-send.client';

function res(status: number, body: unknown) {
  return { status, json: async () => body };
}

// Multi-character (not single-letter) creds so the "never leaks credentials"
// assertions below are meaningful substring checks, not accidental passes.
const CREDS = { usercode: 'acctcode', password: 'secretpw' };

describe('VoicesmsSendClient', () => {
  let client: VoicesmsSendClient;

  beforeEach(() => {
    client = new VoicesmsSendClient();
    mockSafeFetch.mockReset();
  });

  describe('send', () => {
    it('POSTs usercode/password/no/msg as JSON to the voicesms/send URL', async () => {
      mockSafeFetch.mockResolvedValue(res(200, { code: '00', jobid: '123', relationid: 'rec-1' }));
      await client.send(CREDS, { msg: 'Merhaba', no: '905551112233', relationid: 'rec-1' });
      const [url, init] = mockSafeFetch.mock.calls[0];
      expect(url).toBe('https://api.netgsm.com.tr/voicesms/send');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({
        usercode: 'acctcode', password: 'secretpw', no: '905551112233', msg: 'Merhaba', relationid: 'rec-1',
      });
    });

    it('carries iysfilter/brandcode/url/keys/scenario/audioid onto the wire when provided', async () => {
      mockSafeFetch.mockResolvedValue(res(200, { code: '00', jobid: '1' }));
      await client.send(CREDS, {
        audioid: 'aud-1',
        no: '905551112233',
        iysfilter: '11',
        brandcode: 'BRAND',
        relationid: 'rec-2',
        url: 'https://example.com/voice-report',
        keys: ['1', '2'],
        scenario: { series: [{ key: '1', action: 'transfer' }] },
      });
      const [, init] = mockSafeFetch.mock.calls[0];
      const body = JSON.parse(init.body);
      expect(body).toMatchObject({
        audioid: 'aud-1',
        iysfilter: '11',
        brandcode: 'BRAND',
        relationid: 'rec-2',
        url: 'https://example.com/voice-report',
        keys: ['1', '2'],
        scenario: { series: [{ key: '1', action: 'transfer' }] },
      });
      expect(body.msg).toBeUndefined();
    });

    it('rejects a request with neither msg nor audioid WITHOUT calling NetGSM', async () => {
      const r = await client.send(CREDS, { no: '905551112233' });
      expect(r.ok).toBe(false);
      expect(r.transport).toBe(false);
      expect(mockSafeFetch).not.toHaveBeenCalled();
    });

    it('returns jobid + relationid on a success envelope', async () => {
      mockSafeFetch.mockResolvedValue(res(200, { code: '00', jobid: '998877', relationid: 'rec-3' }));
      const r = await client.send(CREDS, { msg: 'Merhaba', no: '905551112233', relationid: 'rec-3' });
      expect(r).toEqual({
        ok: true, code: '00', jobid: '998877', relationid: 'rec-3', message: null, retriable: false, transport: false,
      });
    });

    it('falls back to the request relationid when the response omits one', async () => {
      mockSafeFetch.mockResolvedValue(res(200, { code: '00', jobid: '1' }));
      const r = await client.send(CREDS, { msg: 'Merhaba', no: '905551112233', relationid: 'rec-4' });
      expect(r.relationid).toBe('rec-4');
    });

    it('maps an error envelope {code, error} to a non-ok, non-retriable, non-transport result', async () => {
      mockSafeFetch.mockResolvedValue(res(200, { code: '60', error: 'no voice package' }));
      const r = await client.send(CREDS, { msg: 'Merhaba', no: '905551112233' });
      expect(r.ok).toBe(false);
      expect(r.code).toBe('60');
      expect(r.message).toBe('no voice package');
      expect(r.retriable).toBe(false);
      expect(r.transport).toBe(false);
      expect(r.jobid).toBeNull();
    });

    it('falls back to the shared netgsmErrorMessage vocabulary when no error text is supplied', async () => {
      mockSafeFetch.mockResolvedValue(res(200, { code: '30' }));
      const r = await client.send(CREDS, { msg: 'Merhaba', no: '905551112233' });
      expect(r.ok).toBe(false);
      expect(r.message).toContain('kod 30');
    });

    it('code 80 (rate limit) is retriable', async () => {
      mockSafeFetch.mockResolvedValue(res(200, { code: '80' }));
      const r = await client.send(CREDS, { msg: 'Merhaba', no: '905551112233' });
      expect(r.retriable).toBe(true);
      expect(r.transport).toBe(false);
    });

    it('a transport error (rejected promise) is flagged transport:true and never leaks credentials', async () => {
      mockSafeFetch.mockRejectedValue(new Error(`ECONNRESET password=${CREDS.password} usercode=${CREDS.usercode}`));
      const r = await client.send(CREDS, { msg: 'Merhaba', no: '905551112233' });
      expect(r.ok).toBe(false);
      expect(r.transport).toBe(true);
      expect(r.message).not.toContain(CREDS.password);
      expect(r.message).not.toContain(CREDS.usercode);
    });

    it('an unrecognized body with no code is a non-retriable, non-transport failure (a response WAS received)', async () => {
      mockSafeFetch.mockResolvedValue(res(200, { foo: 'bar' }));
      const r = await client.send(CREDS, { msg: 'Merhaba', no: '905551112233' });
      expect(r.ok).toBe(false);
      expect(r.retriable).toBe(false);
      expect(r.transport).toBe(false);
    });

    it('a null/empty body is a non-retriable, non-transport failure', async () => {
      mockSafeFetch.mockResolvedValue(res(200, null));
      const r = await client.send(CREDS, { msg: 'Merhaba', no: '905551112233' });
      expect(r.ok).toBe(false);
      expect(r.transport).toBe(false);
    });
  });

  describe('upload', () => {
    it('POSTs a multipart form with usercode/password/dosya to the voicesms/upload URL', async () => {
      mockSafeFetch.mockResolvedValue(res(200, { code: '00', audioid: 'aud-9' }));
      const wav = Buffer.from('RIFF....WAVEfmt ');
      const r = await client.upload(CREDS, wav, 'greeting.wav');
      expect(r).toEqual({ ok: true, audioid: 'aud-9', message: null });
      const [url, init] = mockSafeFetch.mock.calls[0];
      expect(url).toBe('https://api.netgsm.com.tr/voicesms/upload');
      expect(init.method).toBe('POST');
      expect(init.body).toBeInstanceOf(FormData);
      const form = init.body as FormData;
      expect(form.get('usercode')).toBe('acctcode');
      expect(form.get('password')).toBe('secretpw');
      const file = form.get('dosya') as File;
      expect(file).toBeTruthy();
      expect(file.name).toBe('greeting.wav');
    });

    it('rejects an empty buffer WITHOUT calling NetGSM', async () => {
      const r = await client.upload(CREDS, Buffer.alloc(0), 'empty.wav');
      expect(r.ok).toBe(false);
      expect(r.audioid).toBeNull();
      expect(mockSafeFetch).not.toHaveBeenCalled();
    });

    it("rejects a buffer over NetGSM's documented 4MB cap WITHOUT calling NetGSM", async () => {
      const big = Buffer.alloc(4 * 1024 * 1024 + 1);
      const r = await client.upload(CREDS, big, 'huge.wav');
      expect(r.ok).toBe(false);
      expect(r.message).toContain('4MB');
      expect(mockSafeFetch).not.toHaveBeenCalled();
    });

    it('maps an error envelope to a non-ok result', async () => {
      mockSafeFetch.mockResolvedValue(res(200, { code: '70', error: 'bad file' }));
      const r = await client.upload(CREDS, Buffer.from('x'), 'a.wav');
      expect(r).toEqual({ ok: false, audioid: null, message: 'bad file' });
    });

    it('a success code with no audioid in the body is a non-ok result', async () => {
      mockSafeFetch.mockResolvedValue(res(200, { code: '00' }));
      const r = await client.upload(CREDS, Buffer.from('x'), 'a.wav');
      expect(r.ok).toBe(false);
      expect(r.audioid).toBeNull();
    });

    it('a transport error never leaks credentials', async () => {
      mockSafeFetch.mockRejectedValue(new Error(`timeout password=${CREDS.password}`));
      const r = await client.upload(CREDS, Buffer.from('x'), 'a.wav');
      expect(r.ok).toBe(false);
      expect(r.message).not.toContain(CREDS.password);
    });
  });

  describe('cancel', () => {
    it('POSTs usercode/password/jobid to the voicesms/edit URL', async () => {
      mockSafeFetch.mockResolvedValue(res(200, { code: '00' }));
      const r = await client.cancel(CREDS, 'job-1');
      expect(r).toEqual({ ok: true, code: '00', message: null });
      const [url, init] = mockSafeFetch.mock.calls[0];
      expect(url).toBe('https://api.netgsm.com.tr/voicesms/edit');
      expect(JSON.parse(init.body)).toEqual({ usercode: 'acctcode', password: 'secretpw', jobid: 'job-1' });
    });

    it('code 60 — not found / not cancellable', async () => {
      mockSafeFetch.mockResolvedValue(res(200, { code: '60' }));
      const r = await client.cancel(CREDS, 'job-2');
      expect(r.ok).toBe(false);
      expect(r.code).toBe('60');
      expect(r.message).toContain('kod 60');
    });

    it('a transport error never leaks credentials', async () => {
      mockSafeFetch.mockRejectedValue(new Error(`ECONNRESET password=${CREDS.password}`));
      const r = await client.cancel(CREDS, 'job-3');
      expect(r.ok).toBe(false);
      expect(r.message).not.toContain(CREDS.password);
    });

    it('a null body is a non-ok failure', async () => {
      mockSafeFetch.mockResolvedValue(res(200, null));
      const r = await client.cancel(CREDS, 'job-4');
      expect(r.ok).toBe(false);
    });
  });
});
