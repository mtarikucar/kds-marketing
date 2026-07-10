import { IysClient, IysConsentRow } from './iys.client';
import { NetgsmRestClient } from '../core/netgsm-rest.client';

describe('IysClient', () => {
  const rest = new NetgsmRestClient();
  const client = new IysClient(rest);
  const creds = { usercode: 'u', password: 'p', brandCode: 'B123' };
  afterEach(() => jest.restoreAllMocks());

  const row = (over: Partial<IysConsentRow> = {}): IysConsentRow => ({
    recipient: '905551112233',
    type: 'MESAJ',
    status: 'ONAY',
    consentDate: '2026-07-08 12:00:00',
    source: 'HS_WEB',
    ...over,
  });

  describe('add', () => {
    it('posts the header {username,password,brandCode} + recipients and returns per-row refids on success', async () => {
      const requestSpy = jest.spyOn(rest, 'request').mockResolvedValue({
        httpStatus: 200,
        body: {
          code: '00',
          iys_recipients: [
            { recipient: '905551112233', refid: '20260708120000_0000001' },
            { recipient: '905551112244', refId: '20260708120000_0000002' },
          ],
        },
        rawText: 'x',
      } as any);
      const r = await client.add(creds, [row(), row({ recipient: '905551112244' })]);
      expect(r.ok).toBe(true);
      expect(r.code).toBe('00');
      expect(r.refids).toEqual(['20260708120000_0000001', '20260708120000_0000002']);
      expect(r.message).toBeNull();

      const [call] = requestSpy.mock.calls;
      expect(call[0].path).toBe('/iys/add');
      expect(call[0].method).toBe('POST');
      // Basic-Auth creds passed through to NetgsmRestClient unchanged.
      expect(call[0].creds).toEqual({ usercode: 'u', password: 'p' });
      const body: any = call[0].body;
      // İYS-specific auth: a `header` object carrying username/password/brandCode
      // (usercode is renamed `username` on the wire), per the İYS API facts.
      expect(body.header).toEqual({ username: 'u', password: 'p', brandCode: 'B123' });
      expect(body.iysRecipients).toHaveLength(2);
      expect(body.iysRecipients[0]).toMatchObject({
        recipient: '905551112233', type: 'MESAJ', status: 'ONAY',
        consentDate: '2026-07-08 12:00:00', source: 'HS_WEB',
      });
    });

    it('carries an existing refid onto the wire when the row already has one (correction/replay)', async () => {
      const requestSpy = jest.spyOn(rest, 'request').mockResolvedValue({
        httpStatus: 200,
        body: { code: '00', iysRecipients: [{ recipient: '905551112233', refid: 'r1' }] },
        rawText: 'x',
      } as any);
      await client.add(creds, [row({ refid: 'existing-ref' })]);
      const body: any = requestSpy.mock.calls[0][0].body;
      expect(body.iysRecipients[0].refid).toBe('existing-ref');
    });

    it('maps an error envelope (e.g. no İYS permission on the brand) to ok:false with no refids', async () => {
      jest.spyOn(rest, 'request').mockResolvedValue({
        httpStatus: 200,
        body: { code: '51', description: 'marka İYS için kayıtlı değil' },
        rawText: '{"code":"51"}',
      } as any);
      const r = await client.add(creds, [row()]);
      expect(r.ok).toBe(false);
      expect(r.code).toBe('51');
      expect(r.refids).toEqual([]);
      expect(r.message).toMatch(/marka/i);
    });

    it('rejects a batch over 500 rows WITHOUT calling NetGSM (caller is supposed to chunk)', async () => {
      const requestSpy = jest.spyOn(rest, 'request');
      const rows = Array.from({ length: 501 }, (_, i) => row({ recipient: `90555000${String(i).padStart(4, '0')}` }));
      const r = await client.add(creds, rows);
      expect(r.ok).toBe(false);
      expect(r.refids).toEqual([]);
      expect(requestSpy).not.toHaveBeenCalled();
    });

    it('a non-JSON body is an unrecognized, non-retriable failure (HTTP status surfaced)', async () => {
      jest.spyOn(rest, 'request').mockResolvedValue({ httpStatus: 502, body: null, rawText: '<html>Bad Gateway</html>' } as any);
      const r = await client.add(creds, [row()]);
      expect(r.ok).toBe(false);
      expect(r.refids).toEqual([]);
      expect(r.message).toMatch(/502/);
    });

    it('a transport error (rejected promise) does not throw and scrubs creds from the message', async () => {
      jest.spyOn(rest, 'request').mockRejectedValue(new Error('down'));
      const r = await client.add(creds, [row()]);
      expect(r.ok).toBe(false);
      expect(r.refids).toEqual([]);
      expect(r.message).toBe('down');
    });
  });

  describe('search', () => {
    it('returns ONAY when İYS has a consent record', async () => {
      const requestSpy = jest.spyOn(rest, 'request').mockResolvedValue({
        httpStatus: 200, body: { code: '00', status: 'ONAY' }, rawText: 'x',
      } as any);
      const r = await client.search(creds, '905551112233', 'MESAJ');
      expect(r).toEqual({ ok: true, status: 'ONAY', message: null });
      const body: any = requestSpy.mock.calls[0][0].body;
      expect(requestSpy.mock.calls[0][0].path).toBe('/iys/search');
      expect(body.header).toEqual({ username: 'u', password: 'p', brandCode: 'B123' });
      expect(body.recipient).toBe('905551112233');
      expect(body.type).toBe('MESAJ');
    });

    it('returns RET when the recipient revoked consent', async () => {
      jest.spyOn(rest, 'request').mockResolvedValue({
        httpStatus: 200, body: { code: '00', status: 'RET' }, rawText: 'x',
      } as any);
      const r = await client.search(creds, '905551112233', 'MESAJ');
      expect(r.status).toBe('RET');
    });

    it('returns YOK (lowercase on the wire) when there is no İYS record at all', async () => {
      jest.spyOn(rest, 'request').mockResolvedValue({
        httpStatus: 200, body: { code: '00', status: 'yok' }, rawText: 'x',
      } as any);
      const r = await client.search(creds, '905551112233', 'ARAMA');
      expect(r.status).toBe('YOK');
    });

    it('tolerates the alternate `durum` field casing', async () => {
      jest.spyOn(rest, 'request').mockResolvedValue({
        httpStatus: 200, body: { code: '00', durum: 'ONAY' }, rawText: 'x',
      } as any);
      const r = await client.search(creds, '905551112233', 'EPOSTA');
      expect(r.status).toBe('ONAY');
    });

    it('an unrecognized status value is surfaced as null rather than a guess', async () => {
      jest.spyOn(rest, 'request').mockResolvedValue({
        httpStatus: 200, body: { code: '00', status: 'BEKLEMEDE' }, rawText: 'x',
      } as any);
      const r = await client.search(creds, '905551112233', 'MESAJ');
      expect(r.status).toBeNull();
      expect(r.ok).toBe(true);
    });

    it('maps an error envelope to ok:false, status:null', async () => {
      jest.spyOn(rest, 'request').mockResolvedValue({
        httpStatus: 200, body: { code: '30' }, rawText: '{"code":"30"}',
      } as any);
      const r = await client.search(creds, '905551112233', 'MESAJ');
      expect(r.ok).toBe(false);
      expect(r.status).toBeNull();
      expect(r.message).toMatch(/kimlik|IP/i);
    });

    it('a non-JSON body is an unrecognized failure', async () => {
      jest.spyOn(rest, 'request').mockResolvedValue({ httpStatus: 502, body: null, rawText: '<html/>' } as any);
      const r = await client.search(creds, '905551112233', 'MESAJ');
      expect(r.ok).toBe(false);
      expect(r.status).toBeNull();
      expect(r.message).toMatch(/502/);
    });

    it('a transport error does not throw', async () => {
      jest.spyOn(rest, 'request').mockRejectedValue(new Error('down'));
      const r = await client.search(creds, '905551112233', 'MESAJ');
      expect(r.ok).toBe(false);
      expect(r.status).toBeNull();
      expect(r.message).toBe('down');
    });
  });

  describe('registerWebhook', () => {
    it('registers the push-back URL with the header creds', async () => {
      const requestSpy = jest.spyOn(rest, 'request').mockResolvedValue({
        httpStatus: 200, body: { code: '00' }, rawText: 'x',
      } as any);
      const r = await client.registerWebhook(creds, 'https://app.example.com/api/public/netgsm/ws-1/tok/iys');
      expect(r).toEqual({ ok: true, code: '00', message: null });
      const [call] = requestSpy.mock.calls;
      expect(call[0].path).toBe('/iys/webhook');
      expect(call[0].method).toBe('POST');
      const body: any = call[0].body;
      expect(body.header).toEqual({ username: 'u', password: 'p', brandCode: 'B123' });
      expect(body.url).toBe('https://app.example.com/api/public/netgsm/ws-1/tok/iys');
    });

    it('maps an error envelope', async () => {
      jest.spyOn(rest, 'request').mockResolvedValue({
        httpStatus: 200, body: { code: '70' }, rawText: '{"code":"70"}',
      } as any);
      const r = await client.registerWebhook(creds, 'https://app.example.com/hook');
      expect(r.ok).toBe(false);
      expect(r.code).toBe('70');
      expect(r.message).toMatch(/parametre/i);
    });

    it('a non-JSON body is an unrecognized failure', async () => {
      jest.spyOn(rest, 'request').mockResolvedValue({ httpStatus: 502, body: null, rawText: '<html/>' } as any);
      const r = await client.registerWebhook(creds, 'https://app.example.com/hook');
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/502/);
    });

    it('a transport error does not throw', async () => {
      jest.spyOn(rest, 'request').mockRejectedValue(new Error('down'));
      const r = await client.registerWebhook(creds, 'https://app.example.com/hook');
      expect(r.ok).toBe(false);
      expect(r.message).toBe('down');
    });
  });
});
