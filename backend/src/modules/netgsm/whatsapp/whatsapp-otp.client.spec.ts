// ── safeFetch mock ──────────────────────────────────────────────────────────
const mockSafeFetch = jest.fn();
jest.mock('../../../common/util/safe-fetch', () => ({
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

import { WhatsAppOtpClient, WHATSAPP_VERIFY_TEMPLATE } from './whatsapp-otp.client';

function res(status: number, body: unknown) {
  return { status, json: async () => body };
}

// Multi-character (not single-letter) creds so the "never leaks credentials"
// assertions below are meaningful substring checks, not accidental passes.
const CREDS = { usercode: 'acctcode', password: 'secretpw' };

describe('WhatsAppOtpClient', () => {
  let client: WhatsAppOtpClient;

  beforeEach(() => {
    client = new WhatsAppOtpClient();
    mockSafeFetch.mockReset();
  });

  describe('sendVerifyCode', () => {
    it('POSTs the fixed netgsm_verify_code template with usercode/password/no/params to the send URL', async () => {
      mockSafeFetch.mockResolvedValue(res(200, { code: '00' }));
      const r = await client.sendVerifyCode(CREDS, { to: '905551112233', code: '123456' });
      expect(r).toEqual({ ok: true, code: '00', message: null, retriable: false, transport: false });

      const [url, init] = mockSafeFetch.mock.calls[0];
      expect(url).toBe('https://whatsappapi.netgsm.com.tr/api/send');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body);
      expect(body).toEqual({
        usercode: 'acctcode',
        password: 'secretpw',
        no: '905551112233',
        template: WHATSAPP_VERIFY_TEMPLATE,
        params: ['123456', '905551112233'],
      });
    });

    it('the fixed template name is exactly netgsm_verify_code', () => {
      expect(WHATSAPP_VERIFY_TEMPLATE).toBe('netgsm_verify_code');
    });

    it('rejects a missing/blank recipient WITHOUT calling NetGSM', async () => {
      const r = await client.sendVerifyCode(CREDS, { to: '   ', code: '123456' });
      expect(r.ok).toBe(false);
      expect(r.transport).toBe(false);
      expect(mockSafeFetch).not.toHaveBeenCalled();
    });

    it('rejects a missing/blank code WITHOUT calling NetGSM', async () => {
      const r = await client.sendVerifyCode(CREDS, { to: '905551112233', code: '  ' });
      expect(r.ok).toBe(false);
      expect(mockSafeFetch).not.toHaveBeenCalled();
    });

    it('maps an error envelope {code, error} to a non-ok, non-retriable, non-transport result', async () => {
      mockSafeFetch.mockResolvedValue(res(200, { code: '60', error: 'no whatsapp otp package' }));
      const r = await client.sendVerifyCode(CREDS, { to: '905551112233', code: '123456' });
      expect(r.ok).toBe(false);
      expect(r.code).toBe('60');
      expect(r.message).toBe('no whatsapp otp package');
      expect(r.retriable).toBe(false);
      expect(r.transport).toBe(false);
    });

    it('falls back to the shared netgsmErrorMessage vocabulary when no error text is supplied', async () => {
      mockSafeFetch.mockResolvedValue(res(200, { code: '30' }));
      const r = await client.sendVerifyCode(CREDS, { to: '905551112233', code: '123456' });
      expect(r.ok).toBe(false);
      expect(r.message).toContain('kod 30');
    });

    it('code 80 (rate limit) is retriable', async () => {
      mockSafeFetch.mockResolvedValue(res(200, { code: '80' }));
      const r = await client.sendVerifyCode(CREDS, { to: '905551112233', code: '123456' });
      expect(r.retriable).toBe(true);
      expect(r.transport).toBe(false);
    });

    it('a transport error (rejected promise) is flagged transport:true and never leaks credentials', async () => {
      mockSafeFetch.mockRejectedValue(new Error(`ECONNRESET password=${CREDS.password} usercode=${CREDS.usercode}`));
      const r = await client.sendVerifyCode(CREDS, { to: '905551112233', code: '123456' });
      expect(r.ok).toBe(false);
      expect(r.transport).toBe(true);
      expect(r.message).not.toContain(CREDS.password);
      expect(r.message).not.toContain(CREDS.usercode);
    });

    it('an unrecognized body with no code is a non-retriable, non-transport failure (a response WAS received)', async () => {
      mockSafeFetch.mockResolvedValue(res(200, { foo: 'bar' }));
      const r = await client.sendVerifyCode(CREDS, { to: '905551112233', code: '123456' });
      expect(r.ok).toBe(false);
      expect(r.retriable).toBe(false);
      expect(r.transport).toBe(false);
    });

    it('a null/empty body is a non-retriable, non-transport failure', async () => {
      mockSafeFetch.mockResolvedValue(res(200, null));
      const r = await client.sendVerifyCode(CREDS, { to: '905551112233', code: '123456' });
      expect(r.ok).toBe(false);
      expect(r.transport).toBe(false);
    });
  });
});
