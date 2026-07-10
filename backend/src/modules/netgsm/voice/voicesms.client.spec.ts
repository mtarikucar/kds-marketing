// ── safeFetch mock ──────────────────────────────────────────────────────────
const mockSafeFetch = jest.fn();
jest.mock('../../../common/util/safe-fetch', () => ({
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

import { VoicesmsClient } from './voicesms.client';

function res(status: number, body: unknown) {
  return { status, json: async () => body };
}

const CREDS = { usercode: 'u', password: 'p' };
const STARTDATE = '01072026000000';
const STOPDATE = '01072026120000';

describe('VoicesmsClient', () => {
  let client: VoicesmsClient;

  beforeEach(() => {
    client = new VoicesmsClient();
    mockSafeFetch.mockReset();
  });

  describe('fetchRaw', () => {
    it('POSTs usercode/password/startdate/stopdate as JSON to the voicesms/receive URL', async () => {
      mockSafeFetch.mockResolvedValue(res(200, []));
      await client.fetchRaw(CREDS, STARTDATE, STOPDATE);
      const [url, init] = mockSafeFetch.mock.calls[0];
      expect(url).toBe('https://api.netgsm.com.tr/voicesms/receive');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({
        usercode: 'u', password: 'p', startdate: STARTDATE, stopdate: STOPDATE,
      });
    });
  });

  describe('receiveVoicemails', () => {
    it('requires both startdate and stopdate in its signature (never a parameterless call)', async () => {
      mockSafeFetch.mockResolvedValue(res(200, []));
      await client.receiveVoicemails(CREDS, STARTDATE, STOPDATE);
      const [, init] = mockSafeFetch.mock.calls[0];
      const body = JSON.parse(init.body);
      expect(body.startdate).toBe(STARTDATE);
      expect(body.stopdate).toBe(STOPDATE);
      expect(body.startdate).toMatch(/^\d+$/);
      expect(body.stopdate).toMatch(/^\d+$/);
    });

    it('normalizes a plain array of voicemail rows, tolerating several field aliases', async () => {
      mockSafeFetch.mockResolvedValue(
        res(200, [
          { id: '123', from: '905551112233', date: '01072026091500', audioUrl: 'https://sesdosya.netgsm.com.tr/x.wav', durationSec: '12' },
          { gorevid: '456', arayan: '905559998877', tarih: '01072026094500', sesdosya: 'https://sesdosya.netgsm.com.tr/y.wav', sure: '30' },
        ]),
      );
      const r = await client.receiveVoicemails(CREDS, STARTDATE, STOPDATE);
      expect(r.ok).toBe(true);
      expect(r.voicemails).toEqual([
        { id: '123', from: '905551112233', date: '01072026091500', audioUrl: 'https://sesdosya.netgsm.com.tr/x.wav', durationSec: 12 },
        { id: '456', from: '905559998877', date: '01072026094500', audioUrl: 'https://sesdosya.netgsm.com.tr/y.wav', durationSec: 30 },
      ]);
    });

    it('unwraps a {data:[...]} envelope', async () => {
      mockSafeFetch.mockResolvedValue(
        res(200, { data: [{ id: '1', from: '905551112233', audioUrl: 'https://sesdosya.netgsm.com.tr/x.wav' }] }),
      );
      const r = await client.receiveVoicemails(CREDS, STARTDATE, STOPDATE);
      expect(r.ok).toBe(true);
      expect(r.voicemails).toEqual([
        { id: '1', from: '905551112233', date: null, audioUrl: 'https://sesdosya.netgsm.com.tr/x.wav' },
      ]);
    });

    it('unwraps a {voicemails:[...]} envelope', async () => {
      mockSafeFetch.mockResolvedValue(
        res(200, { voicemails: [{ id: '2', from: '905551112233' }] }),
      );
      const r = await client.receiveVoicemails(CREDS, STARTDATE, STOPDATE);
      expect(r.voicemails).toEqual([{ id: '2', from: '905551112233', date: null, audioUrl: null }]);
    });

    it('returns [] (not null/throw) on a NetGSM error envelope (e.g. off-prod pre-auth rejection)', async () => {
      mockSafeFetch.mockResolvedValue(res(200, { code: '30', error: 'IP not allowed' }));
      const r = await client.receiveVoicemails(CREDS, STARTDATE, STOPDATE);
      expect(r.ok).toBe(false);
      expect(r.code).toBe('30');
      expect(r.message).toBe('IP not allowed');
      expect(r.voicemails).toEqual([]);
    });

    it('returns [] on an empty/null body without throwing', async () => {
      mockSafeFetch.mockResolvedValue(res(200, null));
      const r = await client.receiveVoicemails(CREDS, STARTDATE, STOPDATE);
      expect(r.ok).toBe(false);
      expect(r.voicemails).toEqual([]);
    });

    it('returns [] and never logs/leaks credentials when the transport throws', async () => {
      mockSafeFetch.mockRejectedValue(new Error(`ECONNRESET calling with password=${CREDS.password}`));
      const r = await client.receiveVoicemails(CREDS, STARTDATE, STOPDATE);
      expect(r.ok).toBe(false);
      expect(r.voicemails).toEqual([]);
      expect(r.message).not.toContain(CREDS.password);
    });

    it('drops rows with neither an id nor a from (junk/keyed-noise entries)', async () => {
      mockSafeFetch.mockResolvedValue(res(200, [{ duration: 10 }, { id: '9', from: '905551112233' }]));
      const r = await client.receiveVoicemails(CREDS, STARTDATE, STOPDATE);
      expect(r.voicemails).toHaveLength(1);
      expect(r.voicemails[0].id).toBe('9');
    });

    it('reports a null id as null (never a literal "null" string) so the caller can fall back safely', async () => {
      mockSafeFetch.mockResolvedValue(res(200, [{ from: '905551112233', audioUrl: 'https://sesdosya.netgsm.com.tr/z.wav' }]));
      const r = await client.receiveVoicemails(CREDS, STARTDATE, STOPDATE);
      expect(r.voicemails).toEqual([
        { id: null, from: '905551112233', date: null, audioUrl: 'https://sesdosya.netgsm.com.tr/z.wav' },
      ]);
    });
  });
});
