import { NetgsmRestClient } from './netgsm-rest.client';

describe('NetgsmRestClient', () => {
  const client = new NetgsmRestClient();
  const creds = { usercode: '8503021234', password: 'p@ss&w=rd' };

  afterEach(() => jest.restoreAllMocks());

  it('sends Basic Auth and JSON body, parses a JSON response', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      status: 200,
      text: async () => '{"balance":"1234.56"}',
    } as any);
    const res = await client.request<{ balance: string }>({
      path: '/balance', method: 'POST', creds, body: { stip: 1 },
    });
    expect(res.httpStatus).toBe(200);
    expect(res.body).toEqual({ balance: '1234.56' });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.netgsm.com.tr/balance');
    expect(init.headers['Authorization']).toBe(
      'Basic ' + Buffer.from('8503021234:p@ss&w=rd').toString('base64'),
    );
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('returns rawText with body=null on a non-JSON response', async () => {
    jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      status: 200, text: async () => '30',
    } as any);
    const res = await client.request({ path: '/balance', method: 'POST', creds, body: {} });
    expect(res.body).toBeNull();
    expect(res.rawText).toBe('30');
  });

  it('scrubs credentials from thrown transport errors', async () => {
    jest.spyOn(global, 'fetch' as any).mockRejectedValue(new Error('connect fail p@ss&w=rd'));
    await expect(
      client.request({ path: '/x', method: 'POST', creds, body: {} }),
    ).rejects.toThrow(/\*\*\*/);
  });

  it('scrubs a usercode containing unescaped regex metacharacters instead of crashing', async () => {
    // An unbalanced '(' in the usercode used to be interpolated straight into
    // `new RegExp(...)`, which throws "Unterminated group" instead of
    // producing the scrubbed error — masking the real transport failure.
    const metaCreds = { usercode: '850(3021234', password: 'p@ss&w=rd' };
    jest
      .spyOn(global, 'fetch' as any)
      .mockRejectedValue(new Error('auth failed for 850(3021234'));
    await expect(
      client.request({ path: '/x', method: 'POST', creds: metaCreds, body: {} }),
    ).rejects.toThrow(/\*\*\*/);
  });
});
