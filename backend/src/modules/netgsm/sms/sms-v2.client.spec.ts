import { SmsV2Client } from './sms-v2.client';
import { NetgsmRestClient } from '../core/netgsm-rest.client';

describe('SmsV2Client', () => {
  const rest = new NetgsmRestClient();
  const client = new SmsV2Client(rest);
  const creds = { usercode: 'u', password: 'p' };
  afterEach(() => jest.restoreAllMocks());

  describe('send', () => {
    it('maps n:n messages (with referansId) onto the wire body and returns the jobid on success', async () => {
      const requestSpy = jest.spyOn(rest, 'request').mockResolvedValue({
        httpStatus: 200,
        body: { code: '00', jobid: '26702360000000000123' },
        rawText: '{"code":"00","jobid":"26702360000000000123"}',
      } as any);
      const r = await client.send(creds, {
        msgheader: 'HDR1',
        messages: [
          { msg: 'merhaba', no: '05551112233', referansId: 'ref-1' },
          { msg: 'selam', no: '05551112244' },
        ],
        encoding: 'TR',
        iysfilter: '11',
        startdate: '081020261200',
        stopdate: '081020261300',
      });
      expect(r).toEqual({ ok: true, code: '00', jobid: '26702360000000000123', message: null, retriable: false });
      const [call] = requestSpy.mock.calls;
      expect(call[0].path).toBe('/sms/rest/v2/send');
      expect(call[0].method).toBe('POST');
      expect(call[0].creds).toBe(creds);
      const body: any = call[0].body;
      expect(body.msgheader).toBe('HDR1');
      expect(body.encoding).toBe('TR');
      expect(body.iysfilter).toBe('11');
      expect(body.startdate).toBe('081020261200');
      expect(body.stopdate).toBe('081020261300');
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0]).toMatchObject({ msg: 'merhaba', no: '05551112233' });
      // referansId must be carried onto SOME documented wire casing (referans/referansID)
      const wireRef = body.messages[0].referansID ?? body.messages[0].referansId ?? body.messages[0].referans;
      expect(wireRef).toBe('ref-1');
      expect(body.messages[1].referansID ?? body.messages[1].referansId ?? body.messages[1].referans).toBeUndefined();
    });

    it('omits optional fields (encoding/iysfilter/startdate/stopdate) when not provided', async () => {
      const requestSpy = jest.spyOn(rest, 'request').mockResolvedValue({
        httpStatus: 200,
        body: { code: '00', jobid: '1' },
        rawText: 'x',
      } as any);
      await client.send(creds, { msgheader: 'HDR1', messages: [{ msg: 'a', no: '05551112233' }] });
      const body: any = requestSpy.mock.calls[0][0].body;
      expect(body.encoding).toBeUndefined();
      expect(body.iysfilter).toBeUndefined();
      expect(body.startdate).toBeUndefined();
      expect(body.stopdate).toBeUndefined();
    });

    it('maps an error envelope {code, description} to a non-ok, non-retriable result', async () => {
      jest.spyOn(rest, 'request').mockResolvedValue({
        httpStatus: 200,
        body: { code: '40', description: 'msgheader tanımlı değil' },
        rawText: '{"code":"40"}',
      } as any);
      const r = await client.send(creds, { msgheader: 'BAD', messages: [{ msg: 'a', no: '05551112233' }] });
      expect(r.ok).toBe(false);
      expect(r.code).toBe('40');
      expect(r.jobid).toBeNull();
      expect(r.retriable).toBe(false);
      expect(r.message).toMatch(/başlık/i);
    });

    it('code 80 (rate limit) is retriable', async () => {
      jest.spyOn(rest, 'request').mockResolvedValue({
        httpStatus: 200,
        body: { code: '80' },
        rawText: '{"code":"80"}',
      } as any);
      const r = await client.send(creds, { msgheader: 'HDR1', messages: [{ msg: 'a', no: '05551112233' }] });
      expect(r.ok).toBe(false);
      expect(r.code).toBe('80');
      expect(r.retriable).toBe(true);
    });

    it('parses a bare non-JSON error code body tolerantly', async () => {
      jest.spyOn(rest, 'request').mockResolvedValue({ httpStatus: 200, body: null, rawText: '30' } as any);
      const r = await client.send(creds, { msgheader: 'HDR1', messages: [{ msg: 'a', no: '05551112233' }] });
      expect(r.ok).toBe(false);
      expect(r.code).toBe('30');
      expect(r.message).toMatch(/kimlik|IP/i);
    });

    it('a transport error (rejected promise) returns a non-throwing failure result', async () => {
      jest.spyOn(rest, 'request').mockRejectedValue(new Error('down'));
      const r = await client.send(creds, { msgheader: 'HDR1', messages: [{ msg: 'a', no: '05551112233' }] });
      expect(r.ok).toBe(false);
      expect(r.jobid).toBeNull();
      expect(r.retriable).toBe(false);
    });

    it('an unrecognized non-JSON body with no code is a non-retriable failure', async () => {
      jest.spyOn(rest, 'request').mockResolvedValue({
        httpStatus: 502, body: null, rawText: '<html>Bad Gateway</html>',
      } as any);
      const r = await client.send(creds, { msgheader: 'HDR1', messages: [{ msg: 'a', no: '05551112233' }] });
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/502/);
      expect(r.retriable).toBe(false);
    });
  });

  describe('report', () => {
    it('parses report rows, tolerating referansID/referansId/referans casing and numeric-or-string status', async () => {
      jest.spyOn(rest, 'request').mockResolvedValue({
        httpStatus: 200,
        body: {
          code: '00',
          jobs: [
            { jobid: '1', telno: '905551112233', status: 1, deliveredDate: '08102026121500', errorCode: null, referansID: 'r1' },
            { jobid: '2', telno: '905551112244', status: '0', deliveredDate: null, referansId: 'r2' },
            { jobid: '3', telno: '905551112255', status: 2, errorCode: '101', referans: 'r3' },
          ],
        },
        rawText: 'x',
      } as any);
      const r = await client.report(creds, ['1', '2', '3']);
      expect(r.ok).toBe(true);
      expect(r.rows).toHaveLength(3);
      expect(r.rows[0]).toEqual({
        jobid: '1', telno: '905551112233', status: 1,
        deliveredDate: '08102026121500', errorCode: null, referansId: 'r1',
      });
      expect(r.rows[1]).toEqual({
        jobid: '2', telno: '905551112244', status: 0,
        deliveredDate: null, errorCode: null, referansId: 'r2',
      });
      expect(r.rows[2]).toMatchObject({ jobid: '3', status: 2, errorCode: '101', referansId: 'r3' });
    });

    it('sends jobids in the request body', async () => {
      const requestSpy = jest.spyOn(rest, 'request').mockResolvedValue({
        httpStatus: 200, body: { code: '00', jobs: [] }, rawText: 'x',
      } as any);
      await client.report(creds, ['1', '2']);
      expect(requestSpy.mock.calls[0][0]).toMatchObject({
        path: '/sms/rest/v2/report', method: 'POST', body: { jobids: ['1', '2'] },
      });
    });

    it('an error envelope returns ok:false with empty rows', async () => {
      jest.spyOn(rest, 'request').mockResolvedValue({
        httpStatus: 200, body: { code: '60' }, rawText: '{"code":"60"}',
      } as any);
      const r = await client.report(creds, ['1']);
      expect(r.ok).toBe(false);
      expect(r.code).toBe('60');
      expect(r.rows).toEqual([]);
    });

    it('a non-JSON body returns ok:false with empty rows', async () => {
      jest.spyOn(rest, 'request').mockResolvedValue({ httpStatus: 200, body: null, rawText: '70' } as any);
      const r = await client.report(creds, ['1']);
      expect(r.ok).toBe(false);
      expect(r.code).toBe('70');
      expect(r.rows).toEqual([]);
    });
  });

  describe('otp', () => {
    const baseReq = { msgheader: 'HDR1', msg: 'Kodunuz: 123456', no: '05551112233' };

    it('sends a valid domestic OTP and normalizes the number to 05xxxxxxxxx on the wire', async () => {
      const requestSpy = jest.spyOn(rest, 'request').mockResolvedValue({
        httpStatus: 200, body: { code: '00', jobid: '99' }, rawText: 'x',
      } as any);
      const r = await client.otp(creds, { ...baseReq, no: '+905551112233' });
      expect(r.ok).toBe(true);
      expect(r.jobid).toBe('99');
      expect(requestSpy.mock.calls[0][0]).toMatchObject({
        path: '/sms/rest/v2/otp',
        method: 'POST',
        body: { msgheader: 'HDR1', msg: 'Kodunuz: 123456', no: '05551112233' },
      });
    });

    it('accepts a bare 5xxxxxxxxx (10-digit) mobile and normalizes it', async () => {
      const requestSpy = jest.spyOn(rest, 'request').mockResolvedValue({
        httpStatus: 200, body: { code: '00', jobid: '1' }, rawText: 'x',
      } as any);
      await client.otp(creds, { ...baseReq, no: '5551112233' });
      expect((requestSpy.mock.calls[0][0].body as any).no).toBe('05551112233');
    });

    it('rejects a message longer than a single 155-char segment WITHOUT calling NetGSM', async () => {
      const requestSpy = jest.spyOn(rest, 'request');
      const r = await client.otp(creds, { ...baseReq, msg: 'a'.repeat(156) });
      expect(r.ok).toBe(false);
      expect(r.retriable).toBe(false);
      expect(requestSpy).not.toHaveBeenCalled();
    });

    it('accepts exactly 155 chars', async () => {
      jest.spyOn(rest, 'request').mockResolvedValue({
        httpStatus: 200, body: { code: '00', jobid: '1' }, rawText: 'x',
      } as any);
      const r = await client.otp(creds, { ...baseReq, msg: 'a'.repeat(155) });
      expect(r.ok).toBe(true);
    });

    it('rejects Turkish characters WITHOUT calling NetGSM', async () => {
      const requestSpy = jest.spyOn(rest, 'request');
      const r = await client.otp(creds, { ...baseReq, msg: 'Şifreniz: 123456' });
      expect(r.ok).toBe(false);
      expect(requestSpy).not.toHaveBeenCalled();
    });

    it.each(['çÇğĞıİöÖşŞüÜ'.split('')])('rejects the Turkish character %s', async (ch) => {
      const r = await client.otp(creds, { ...baseReq, msg: `code${ch}` });
      expect(r.ok).toBe(false);
    });

    it('rejects a number that is not a normalizable domestic mobile (landline) WITHOUT calling NetGSM', async () => {
      const requestSpy = jest.spyOn(rest, 'request');
      const r = await client.otp(creds, { ...baseReq, no: '02123334455' });
      expect(r.ok).toBe(false);
      expect(requestSpy).not.toHaveBeenCalled();
    });

    it('rejects a foreign number WITHOUT calling NetGSM', async () => {
      const requestSpy = jest.spyOn(rest, 'request');
      const r = await client.otp(creds, { ...baseReq, no: '+14155552671' });
      expect(r.ok).toBe(false);
      expect(requestSpy).not.toHaveBeenCalled();
    });

    it('propagates a server error code (e.g. 60 — no OTP package)', async () => {
      jest.spyOn(rest, 'request').mockResolvedValue({
        httpStatus: 200, body: { code: '60' }, rawText: '{"code":"60"}',
      } as any);
      const r = await client.otp(creds, baseReq);
      expect(r.ok).toBe(false);
      expect(r.code).toBe('60');
    });
  });

  describe('msgheaders', () => {
    it('returns the header list on success', async () => {
      const requestSpy = jest.spyOn(rest, 'request').mockResolvedValue({
        httpStatus: 200, body: { code: '00', msgheaders: ['HDR1', 'HDR2'] }, rawText: 'x',
      } as any);
      const r = await client.msgheaders(creds);
      expect(r).toEqual({ ok: true, headers: ['HDR1', 'HDR2'] });
      expect(requestSpy.mock.calls[0][0]).toMatchObject({ path: '/sms/rest/v2/msgheader', method: 'GET' });
    });

    it('returns ok:false with empty headers on an error code', async () => {
      jest.spyOn(rest, 'request').mockResolvedValue({ httpStatus: 200, body: { code: '30' }, rawText: 'x' } as any);
      const r = await client.msgheaders(creds);
      expect(r).toEqual({ ok: false, headers: [] });
    });

    it('returns ok:false with empty headers on a non-JSON body', async () => {
      jest.spyOn(rest, 'request').mockResolvedValue({ httpStatus: 200, body: null, rawText: '<html/>' } as any);
      const r = await client.msgheaders(creds);
      expect(r).toEqual({ ok: false, headers: [] });
    });
  });

  describe('cancel', () => {
    it('cancels a future-dated job', async () => {
      const requestSpy = jest.spyOn(rest, 'request').mockResolvedValue({
        httpStatus: 200, body: { code: '00' }, rawText: 'x',
      } as any);
      const r = await client.cancel(creds, 'job-1');
      expect(r).toEqual({ ok: true, code: '00', message: null });
      expect(requestSpy.mock.calls[0][0]).toMatchObject({
        path: '/sms/rest/v2/cancel', method: 'POST', body: { jobid: 'job-1' },
      });
    });

    it('code 60 — not found / not cancellable', async () => {
      jest.spyOn(rest, 'request').mockResolvedValue({ httpStatus: 200, body: { code: '60' }, rawText: 'x' } as any);
      const r = await client.cancel(creds, 'job-1');
      expect(r.ok).toBe(false);
      expect(r.code).toBe('60');
      expect(r.message).toMatch(/paket|yetki/i);
    });

    it('a non-JSON body is an unrecognized failure', async () => {
      jest.spyOn(rest, 'request').mockResolvedValue({ httpStatus: 502, body: null, rawText: '<html/>' } as any);
      const r = await client.cancel(creds, 'job-1');
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/502/);
    });
  });

  describe('inbox', () => {
    it('requires a date range and forwards it as query params', async () => {
      const requestSpy = jest.spyOn(rest, 'request').mockResolvedValue({
        httpStatus: 200,
        body: { code: '00', messages: [{ msg: 'merhaba', no: '905551112233', date: '08102026121500', id: '77' }] },
        rawText: 'x',
      } as any);
      const r = await client.inbox(creds, '0107202600', '0807202600');
      expect(r.ok).toBe(true);
      expect(r.messages).toEqual([{ msg: 'merhaba', no: '905551112233', date: '08102026121500', id: '77' }]);
      const [call] = requestSpy.mock.calls;
      expect(call[0].method).toBe('GET');
      expect(call[0].path).toContain('/sms/rest/v2/inbox?');
      expect(call[0].path).toContain('startdate=0107202600');
      expect(call[0].path).toContain('stopdate=0807202600');
    });

    it('returns an empty list when there are no messages', async () => {
      jest.spyOn(rest, 'request').mockResolvedValue({
        httpStatus: 200, body: { code: '00', messages: [] }, rawText: 'x',
      } as any);
      const r = await client.inbox(creds, '0107202600', '0807202600');
      expect(r).toEqual({ ok: true, messages: [] });
    });

    it('an error code returns ok:false with empty messages', async () => {
      jest.spyOn(rest, 'request').mockResolvedValue({ httpStatus: 200, body: { code: '70' }, rawText: 'x' } as any);
      const r = await client.inbox(creds, '0107202600', '0807202600');
      expect(r).toEqual({ ok: false, messages: [] });
    });

    it('a non-JSON body returns ok:false with empty messages', async () => {
      jest.spyOn(rest, 'request').mockResolvedValue({ httpStatus: 200, body: null, rawText: '<html/>' } as any);
      const r = await client.inbox(creds, '0107202600', '0807202600');
      expect(r).toEqual({ ok: false, messages: [] });
    });
  });
});
