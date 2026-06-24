import { TiktokDmAdapter } from './tiktok-dm.adapter';
import { tiktokBusinessFetch } from '../tiktok-business.util';

jest.mock('../tiktok-business.util', () => ({
  tiktokBusinessFetch: jest.fn(),
}));

const mockFetch = tiktokBusinessFetch as jest.MockedFunction<typeof tiktokBusinessFetch>;

describe('TiktokDmAdapter', () => {
  const registry = { register: jest.fn() } as any;
  const adapter = new TiktokDmAdapter(registry);

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('registers itself on module init as TIKTOK', () => {
    adapter.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(adapter);
    expect(adapter.type).toBe('TIKTOK');
  });

  it('send is inert (FAILED, no throw) without an access token', async () => {
    const res = await adapter.send({
      config: { secrets: {}, externalId: 'biz-1', public: { messaging: 'granted' } } as any,
      to: 'user-1',
      text: 'hi',
    });
    expect(res.status).toBe('FAILED');
    expect(res.error).toContain('access token');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('send returns FAILED (no API call) when messaging capability is not granted', async () => {
    const res = await adapter.send({
      config: { secrets: { accessToken: 'tok_abc' }, externalId: 'biz-1', public: {} } as any,
      to: 'user-1',
      text: 'hi',
    });
    expect(res.status).toBe('FAILED');
    expect(res.error).toContain('messaging access not granted');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('send returns FAILED (no API call) when public is undefined', async () => {
    const res = await adapter.send({
      config: { secrets: { accessToken: 'tok_abc' }, externalId: 'biz-1', public: undefined } as any,
      to: 'user-1',
      text: 'hi',
    });
    expect(res.status).toBe('FAILED');
    expect(res.error).toContain('messaging access not granted');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('send calls tiktokBusinessFetch and returns SENT on success', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, data: { message_id: 'msg-42' } });

    const res = await adapter.send({
      config: {
        secrets: { accessToken: 'tok_abc' },
        externalId: 'biz-1',
        public: { messaging: 'granted' },
      } as any,
      to: 'user-9',
      text: 'hello',
    });

    expect(mockFetch).toHaveBeenCalledWith(
      '/business/message/send/',
      expect.objectContaining({
        accessToken: 'tok_abc',
        method: 'POST',
        body: expect.objectContaining({ to_user_id: 'user-9' }),
      }),
    );
    expect(res).toEqual({ externalMessageId: 'msg-42', status: 'SENT' });
  });

  it('send returns FAILED with error message when tiktokBusinessFetch returns ok:false', async () => {
    const { TiktokBusinessError } = jest.requireActual('../tiktok-business.util');
    const err = new TiktokBusinessError('Token expired', 401, 40101, 'req-1', true);
    mockFetch.mockResolvedValueOnce({ ok: false, error: err });

    const res = await adapter.send({
      config: {
        secrets: { accessToken: 'tok_abc' },
        externalId: 'biz-1',
        public: { messaging: 'granted' },
      } as any,
      to: 'user-9',
      text: 'hello',
    });

    expect(res.status).toBe('FAILED');
    expect(res.error).toContain('Token expired');
    expect(res.externalMessageId).toBeNull();
  });

  it('send does not throw even if tiktokBusinessFetch rejects', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network boom'));

    const res = await adapter.send({
      config: {
        secrets: { accessToken: 'tok_abc' },
        externalId: 'biz-1',
        public: { messaging: 'granted' },
      } as any,
      to: 'user-9',
      text: 'hello',
    });

    expect(res.status).toBe('FAILED');
    expect(res.error).toContain('network boom');
  });

  it('parseInbound extracts a text DM and tags it TIKTOKID', () => {
    const config = { externalId: 'biz-1' } as any;
    const body = {
      data: {
        messages: [
          { from_user_id: 'u-9', message_id: 'm-1', text: 'merhaba', from_user_name: 'Ayşe' },
        ],
      },
    };
    const out = adapter.parseInbound(config, body);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      externalUserId: 'u-9',
      kind: 'TIKTOKID',
      externalMessageId: 'm-1',
      text: 'merhaba',
    });
  });

  it('parseInbound skips our own echoes (sender == connected business id)', () => {
    const config = { externalId: 'biz-1' } as any;
    const body = { data: { messages: [{ from_user_id: 'biz-1', message_id: 'm-2', text: 'echo' }] } };
    expect(adapter.parseInbound(config, body)).toHaveLength(0);
  });

  it('echo filter is type-robust — a NUMERIC sender id equal to the business id is still skipped', () => {
    const config = { externalId: '12345' } as any; // stored as string in the DB
    const body = { data: { messages: [{ from_user_id: 12345, message_id: 'm-3', text: 'echo' }] } };
    expect(adapter.parseInbound(config, body)).toHaveLength(0); // no reply loop
  });

  it('healthCheck is false without token/businessId', async () => {
    expect((await adapter.healthCheck({ secrets: {}, externalId: null } as any)).ok).toBe(false);
    expect(
      (await adapter.healthCheck({ secrets: { accessToken: 't' }, externalId: 'biz-1' } as any)).ok,
    ).toBe(true);
  });
});
