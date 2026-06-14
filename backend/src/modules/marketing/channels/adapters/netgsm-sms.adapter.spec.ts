import { NetgsmSmsAdapter } from './netgsm-sms.adapter';

/**
 * NetGSM credential hygiene: the secrets (usercode/password/msgheader) must
 * travel in the POST body, never the URL/query string, so they can't leak into
 * proxy/access logs. Response parsing (status code + job id) is unchanged.
 */
describe('NetgsmSmsAdapter.send', () => {
  let registry: { register: jest.Mock };
  let adapter: NetgsmSmsAdapter;
  let fetchMock: jest.Mock;

  const config = {
    secrets: { usercode: 'u123', password: 's3cr3t-pass', msgheader: 'ACME' },
  } as any;

  beforeEach(() => {
    registry = { register: jest.fn() };
    adapter = new NetgsmSmsAdapter(registry as any);
    fetchMock = jest.fn().mockResolvedValue({ text: async () => '00 9988776655' });
    (global as any).fetch = fetchMock;
  });

  afterEach(() => {
    delete (global as any).fetch;
  });

  it('POSTs credentials in a form body — exact URL, no secret in the query string', async () => {
    const res = await adapter.send({ config, to: '+90 555 111 22 33', text: 'Merhaba' });

    expect(res).toEqual({ externalMessageId: '9988776655', status: 'SENT' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0];
    // URL is exact and carries no query string at all.
    expect(url).toBe('https://api.netgsm.com.tr/sms/send/get');
    expect(url).not.toContain('?');
    expect(url).not.toContain('password');
    expect(url).not.toContain('s3cr3t-pass');
    expect(url).not.toContain('u123');

    // Method + content type.
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');

    // Password (and the other secrets) live in the body, form-encoded.
    const body = new URLSearchParams(init.body as string);
    expect(body.get('password')).toBe('s3cr3t-pass');
    expect(body.get('usercode')).toBe('u123');
    expect(body.get('msgheader')).toBe('ACME');
    expect(body.get('gsmno')).toBe('905551112233'); // non-digits stripped
    expect(body.get('message')).toBe('Merhaba');
  });

  it('returns FAILED on a config-missing guard without calling fetch', async () => {
    const res = await adapter.send({ config: { secrets: {} } as any, to: '+90555', text: 'x' });
    expect(res.status).toBe('FAILED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('scrubs a leaked password out of a thrown error message', async () => {
    fetchMock.mockRejectedValue(new Error('connect failed for password=s3cr3t-pass&x=1'));
    const res = await adapter.send({ config, to: '+90555', text: 'x' });
    expect(res.status).toBe('FAILED');
    expect(res.error).toContain('password=***');
    expect(res.error).not.toContain('s3cr3t-pass');
  });
});
