import { createHash } from 'node:crypto';
import { tiktokBusinessFetch } from '../channels/tiktok-business.util';
import {
  sendTiktokEvent,
  buildTiktokUserData,
  TiktokCapiEvent,
} from './tiktok-capi.client';

// Mock only the transport seam — keep sha256/toE164Digits (from meta-capi.client) real.
jest.mock('../channels/tiktok-business.util', () => ({
  tiktokBusinessFetch: jest.fn(),
}));

const mockFetch = tiktokBusinessFetch as jest.MockedFunction<typeof tiktokBusinessFetch>;
const hex = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');

const event = (): TiktokCapiEvent => ({
  event: 'CompletePayment',
  event_time: 1_780_000_000,
  event_id: 'evt-100',
  user: buildTiktokUserData({ email: 'Ada@X.com', phone: '05551112233', ttclid: 'ttclid-xyz' }),
  properties: { value: 150, currency: 'TRY', content_type: 'product' },
});

beforeEach(() => {
  mockFetch.mockReset().mockResolvedValue({ ok: true, data: {} });
  delete process.env.TIKTOK_CAPI_TEST_EVENT_CODE;
});

describe('buildTiktokUserData', () => {
  it('hashes email + phone into single-element arrays and passes ttclid raw', () => {
    const u = buildTiktokUserData({ email: '  Ada@X.com ', phone: '05551112233', ttclid: 'ttclid-xyz' });
    expect(u.email).toEqual([hex('ada@x.com')]);
    expect(u.phone).toEqual([hex('905551112233')]); // E.164 (TR cc) then SHA-256
    expect(u.ttclid).toBe('ttclid-xyz'); // NOT hashed
  });

  it('omits empty fields (no email/phone/ttclid → empty object)', () => {
    expect(buildTiktokUserData({})).toEqual({});
    expect(buildTiktokUserData({ email: '', phone: null, ttclid: undefined })).toEqual({});
  });

  it('emits phone/email independently when only one is present', () => {
    expect(buildTiktokUserData({ ttclid: 'raw' })).toEqual({ ttclid: 'raw' });
    expect(buildTiktokUserData({ email: 'a@b.co' })).toEqual({ email: [hex('a@b.co')] });
  });
});

describe('sendTiktokEvent', () => {
  it('POSTs to /event/track/ with event_source web, event_source_id = pixel code, and a data[] array', async () => {
    await sendTiktokEvent('TOK', 'PIXEL-CODE-9', event());

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [path, opts] = mockFetch.mock.calls[0] as [string, any];
    expect(path).toBe('/event/track/');
    expect(opts).toMatchObject({ accessToken: 'TOK', method: 'POST' });
    expect(opts.body.event_source).toBe('web');
    expect(opts.body.event_source_id).toBe('PIXEL-CODE-9');
    expect(opts.body.data).toHaveLength(1);
  });

  it('carries the dedup event_id, hashed email/phone, raw ttclid, and value/currency', async () => {
    await sendTiktokEvent('TOK', 'PIXEL-CODE-9', event());
    const sent = (mockFetch.mock.calls[0][1] as any).body.data[0];
    expect(sent).toMatchObject({
      event: 'CompletePayment',
      event_id: 'evt-100',
      properties: { value: 150, currency: 'TRY', content_type: 'product' },
    });
    expect(sent.user.email).toEqual([hex('ada@x.com')]);
    expect(sent.user.phone).toEqual([hex('905551112233')]);
    expect(sent.user.ttclid).toBe('ttclid-xyz');
  });

  it('omits test_event_code by default and includes it when the platform env is set', async () => {
    await sendTiktokEvent('TOK', 'PIXEL-CODE-9', event());
    expect((mockFetch.mock.calls[0][1] as any).body.test_event_code).toBeUndefined();

    mockFetch.mockClear();
    process.env.TIKTOK_CAPI_TEST_EVENT_CODE = 'TEST123';
    await sendTiktokEvent('TOK', 'PIXEL-CODE-9', event());
    expect((mockFetch.mock.calls[0][1] as any).body.test_event_code).toBe('TEST123');
  });

  it('returns the transport result verbatim (ok pass-through)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, data: { request_id: 'req-1' } } as any);
    const r = await sendTiktokEvent('TOK', 'PIXEL-CODE-9', event());
    expect(r).toEqual({ ok: true, data: { request_id: 'req-1' } });
  });

  it('surfaces a transport failure (auth error) without throwing → drives reauth', async () => {
    const { TiktokBusinessError } = jest.requireActual('../channels/tiktok-business.util');
    const err = new TiktokBusinessError('Token expired', 401, 40101, 'req-1', true);
    mockFetch.mockResolvedValueOnce({ ok: false, error: err });
    const r = await sendTiktokEvent('TOK', 'PIXEL-CODE-9', event());
    expect(r.ok).toBe(false);
    expect((r as any).error.isAuthError).toBe(true);
  });
});
