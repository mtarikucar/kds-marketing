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
    adapter = new NetgsmSmsAdapter(registry as any, { fetchBalance: jest.fn() } as any);
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
    jest.useFakeTimers();
    fetchMock.mockRejectedValue(new Error('connect failed for password=s3cr3t-pass&x=1'));
    const p = adapter.send({ config, to: '+90555', text: 'x' });
    await jest.runAllTimersAsync();
    const res = await p;
    expect(res.status).toBe('FAILED');
    expect(res.error).toContain('password=***');
    expect(res.error).not.toContain('s3cr3t-pass');
    jest.useRealTimers();
  });
});

/**
 * Send hardening: provider error codes become actionable messages, transient
 * failures (network/timeout/HTTP-5xx/rate-limit 80) are retried with backoff,
 * and every request carries an AbortSignal timeout so a hung connection can't
 * block a campaign batch forever.
 */
describe('NetgsmSmsAdapter.send — error mapping, retry & timeout', () => {
  let adapter: NetgsmSmsAdapter;
  let fetchMock: jest.Mock;
  const config = { secrets: { usercode: 'u', password: 'p', msgheader: 'ACME' } } as any;

  beforeEach(() => {
    adapter = new NetgsmSmsAdapter({ register: jest.fn() } as any, { fetchBalance: jest.fn() } as any);
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
  });
  afterEach(() => {
    delete (global as any).fetch;
    jest.useRealTimers();
  });

  it('maps a permanent error code (40) to an actionable message and does NOT retry', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '40' });
    const res = await adapter.send({ config, to: '+905551112233', text: 'x' });
    expect(res.status).toBe('FAILED');
    expect(res.error).toMatch(/header|msgheader|sender/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces auth/IP guidance for code 30', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '30' });
    const res = await adapter.send({ config, to: '+905551112233', text: 'x' });
    expect(res.error).toMatch(/auth|usercode|API|IP/i);
  });

  it('passes an AbortSignal (timeout) to fetch', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '00 1' });
    await adapter.send({ config, to: '+905551112233', text: 'x' });
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('retries a transient network error, then succeeds', async () => {
    jest.useFakeTimers();
    fetchMock
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValue({ ok: true, status: 200, text: async () => '00 9' });
    const p = adapter.send({ config, to: '+905551112233', text: 'x' });
    await jest.runAllTimersAsync();
    const res = await p;
    expect(res).toEqual({ externalMessageId: '9', status: 'SENT' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries rate-limit code 80, then gives up with the mapped error', async () => {
    jest.useFakeTimers();
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '80' });
    const p = adapter.send({ config, to: '+905551112233', text: 'x' });
    await jest.runAllTimersAsync();
    const res = await p;
    expect(res.status).toBe('FAILED');
    expect(res.error).toMatch(/rate limit/i);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a permanent İYS code (50) — exactly one attempt', async () => {
    jest.useFakeTimers();
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '50' });
    const p = adapter.send({ config, to: '+905551112233', text: 'x' });
    await jest.runAllTimersAsync();
    const res = await p;
    expect(res.status).toBe('FAILED');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries an HTTP 5xx (transient), then succeeds', async () => {
    jest.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 502, text: async () => 'Bad Gateway' })
      .mockResolvedValue({ ok: true, status: 200, text: async () => '00 7' });
    const p = adapter.send({ config, to: '+905551112233', text: 'x' });
    await jest.runAllTimersAsync();
    const res = await p;
    expect(res).toEqual({ externalMessageId: '7', status: 'SENT' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

/**
 * NetGSM inbound MO (mobile-originated reply). NetGSM pushes a JSON body with
 * fields { mesaj, ceptel, aboneno, gorevid, tarih } (verified against the
 * official netgsm1/sms package). parseInbound normalizes the sender to E.164
 * and namespaces the message id so an inbound gorevid can never collide with an
 * outbound bulkid in the globally-unique Message.externalMessageId column.
 */
describe('NetgsmSmsAdapter.parseInbound', () => {
  let adapter: NetgsmSmsAdapter;

  beforeEach(() => {
    adapter = new NetgsmSmsAdapter({ register: jest.fn() } as any, { fetchBalance: jest.fn() } as any);
  });

  const cfg = {
    channelId: 'c1',
    workspaceId: 'w1',
    type: 'SMS',
    externalId: '08508407303',
    secrets: {},
    public: {},
  } as any;

  it('maps a real NetGSM MO payload (ceptel/mesaj/gorevid) to one normalized inbound message', () => {
    const body = {
      mesaj: 'Merhaba, siparişim nerede?',
      ceptel: '5331234567',
      aboneno: '8508407303',
      gorevid: '112233720',
      tarih: '2026-06-17 16:28:41.053',
    };

    const out = adapter.parseInbound!(cfg, body);

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      externalUserId: '+905331234567',
      kind: 'PHONE',
      externalMessageId: 'netgsm-mo:112233720',
      text: 'Merhaba, siparişim nerede?',
    });
    expect(out[0].raw).toEqual(body);
  });

  it('normalizes ceptel variants (0-prefixed, 90-prefixed, spaced +90) to E.164', () => {
    for (const ceptel of ['05331234567', '905331234567', '+90 533 123 45 67']) {
      const [msg] = adapter.parseInbound!(cfg, { ceptel, mesaj: 'x', gorevid: '1' });
      expect(msg.externalUserId).toBe('+905331234567');
    }
  });

  it('accepts a batched array and skips rows with no sender number', () => {
    const body = [
      { ceptel: '5330000001', mesaj: 'bir', gorevid: '10' },
      { mesaj: 'no-sender', gorevid: '11' },
      { ceptel: '5330000002', mesaj: 'iki', gorevid: '12' },
    ];

    const out = adapter.parseInbound!(cfg, body);

    expect(out.map((m) => m.text)).toEqual(['bir', 'iki']);
    expect(out.map((m) => m.externalMessageId)).toEqual([
      'netgsm-mo:10',
      'netgsm-mo:12',
    ]);
  });

  it('falls back to a null externalMessageId when gorevid is absent (no dedup key)', () => {
    const [msg] = adapter.parseInbound!(cfg, { ceptel: '5330000003', mesaj: 'x' });
    expect(msg.externalMessageId).toBeNull();
  });

  it('caps an oversized inbound batch so one request cannot fan out unboundedly', () => {
    const body = Array.from({ length: 250 }, (_, i) => ({
      ceptel: '5330000000',
      mesaj: 'x',
      gorevid: String(i),
    }));
    const out = adapter.parseInbound!(cfg, body);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.length).toBeGreaterThan(0);
  });
});

/**
 * Live verify: healthCheck now does a real /balance auth probe (via
 * BalanceClient) instead of a presence-only check, so "Verify" actually
 * confirms NetGSM accepted the credentials.
 */
describe('NetgsmSmsAdapter.healthCheck', () => {
  const registryStub = { register: jest.fn() };

  it('probes NetGSM live and reports credsValid', async () => {
    const balance = {
      fetchBalance: jest
        .fn()
        .mockResolvedValue({ ok: true, credsValid: true, credit: '100', packages: [], code: null, message: null }),
    };
    const adapter = new NetgsmSmsAdapter(registryStub as any, balance as any);
    const res = await adapter.healthCheck({ secrets: { usercode: 'u', password: 'p', msgheader: 'HDR' } } as any);
    expect(balance.fetchBalance).toHaveBeenCalledWith({ usercode: 'u', password: 'p' });
    expect(res.ok).toBe(true);
    expect(res.details).toMatchObject({ credsValid: true });
  });

  it('missing secrets → ok:false without probing', async () => {
    const balance = { fetchBalance: jest.fn() };
    const adapter = new NetgsmSmsAdapter(registryStub as any, balance as any);
    const res = await adapter.healthCheck({ secrets: {} } as any);
    expect(res.ok).toBe(false);
    expect(balance.fetchBalance).not.toHaveBeenCalled();
  });

  it('rejected creds (code 30) → ok:false with the mapped message', async () => {
    const balance = {
      fetchBalance: jest
        .fn()
        .mockResolvedValue({ ok: false, credsValid: false, credit: null, packages: [], code: '30', message: 'Kimlik doğrulama hatası' }),
    };
    const adapter = new NetgsmSmsAdapter(registryStub as any, balance as any);
    const res = await adapter.healthCheck({ secrets: { usercode: 'u', password: 'wrong', msgheader: 'HDR' } } as any);
    expect(res.ok).toBe(false);
    expect(res.details).toMatchObject({ credsValid: false, code: '30' });
  });
});
