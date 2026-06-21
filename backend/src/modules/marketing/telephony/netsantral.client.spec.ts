import { NetsantralClient } from './netsantral.client';

describe('NetsantralClient', () => {
  const creds = { username: '8508407303', password: 'pw' };
  let fetchMock: jest.SpyInstance;
  afterEach(() => fetchMock?.mockRestore());

  it('posts form-encoded params and returns the call id on success', async () => {
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      status: 200, text: async () => '{"status":"success","unique_id":"u-1"}',
    } as any);
    const client = new NetsantralClient();
    const out = await client.originate({ ...creds, customer_num: '5551112233', internal_num: '104', trunk: '8508407303' });
    expect(out).toEqual({ ok: true, callId: 'u-1' });
    const body = (fetchMock.mock.calls[0][1] as any).body as string;
    expect(body).toContain('customer_num=5551112233');
    expect(body).toContain('internal_num=104');
    expect((fetchMock.mock.calls[0][0] as string)).not.toContain('password');
  });

  it('returns ok:false on a provider error code', async () => {
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ status: 200, text: async () => '30' } as any);
    const out = await new NetsantralClient().originate({ ...creds, customer_num: '5551112233', internal_num: '104', trunk: '8508407303' });
    expect(out.ok).toBe(false);
    expect(out.code).toBe('30');
  });

  it('scrubs the password from a thrown error', async () => {
    fetchMock = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('boom password=pw leaked'));
    const out = await new NetsantralClient().originate({ ...creds, customer_num: '5', internal_num: '104', trunk: '850' });
    expect(out.ok).toBe(false);
    expect(out.message).not.toContain('pw');
  });

  it('scrubs all occurrences of the password when it appears multiple times in the error', async () => {
    fetchMock = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('error: pw and again pw'));
    const out = await new NetsantralClient().originate({ ...creds, customer_num: '5', internal_num: '104', trunk: '850' });
    expect(out.ok).toBe(false);
    expect(out.message).not.toContain('pw');
    expect(out.message).toContain('***');
  });
});
