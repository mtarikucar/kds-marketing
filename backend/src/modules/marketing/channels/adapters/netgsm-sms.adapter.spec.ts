import { NetgsmSmsAdapter } from './netgsm-sms.adapter';

/**
 * NetGSM sends via REST v2 by default; `configPublic.useLegacySend === true`
 * opts a channel back into the legacy `/sms/send/get` GET API while its
 * account bakes on v2. These two describe-blocks cover the legacy path
 * (credential hygiene, unchanged wire shape) — v2-default coverage lives
 * further down.
 */
describe('NetgsmSmsAdapter.send — legacy path (configPublic.useLegacySend: true)', () => {
  let registry: { register: jest.Mock };
  let adapter: NetgsmSmsAdapter;
  let fetchMock: jest.Mock;
  let smsV2: { send: jest.Mock; msgheaders: jest.Mock };

  const config = {
    secrets: { usercode: 'u123', password: 's3cr3t-pass', msgheader: 'ACME' },
    public: { useLegacySend: true },
  } as any;

  beforeEach(() => {
    registry = { register: jest.fn() };
    smsV2 = { send: jest.fn(), msgheaders: jest.fn() };
    adapter = new NetgsmSmsAdapter(registry as any, { fetchBalance: jest.fn() } as any, smsV2 as any);
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
    expect(smsV2.send).not.toHaveBeenCalled();

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
 * Send hardening on the legacy path: provider error codes become actionable
 * messages, transient failures (network/timeout/HTTP-5xx/rate-limit 80) are
 * retried with backoff, and every request carries an AbortSignal timeout so a
 * hung connection can't block a campaign batch forever.
 */
describe('NetgsmSmsAdapter.send — legacy error mapping, retry & timeout', () => {
  let adapter: NetgsmSmsAdapter;
  let fetchMock: jest.Mock;
  const config = {
    secrets: { usercode: 'u', password: 'p', msgheader: 'ACME' },
    public: { useLegacySend: true },
  } as any;

  beforeEach(() => {
    adapter = new NetgsmSmsAdapter(
      { register: jest.fn() } as any,
      { fetchBalance: jest.fn() } as any,
      { send: jest.fn(), msgheaders: jest.fn() } as any,
    );
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
 * Send v2 — the DEFAULT path (no `useLegacySend`, or `useLegacySend: false`).
 * `NetgsmSmsAdapter.send` calls `SmsV2Client.send` directly (no `fetch` here —
 * that's `SmsV2Client`'s job via `NetgsmRestClient`), mapping `jobid` onto
 * `externalMessageId` and mirroring the legacy retry semantics: code 80 +
 * a genuine transport failure (`result.transport === true` — the request
 * never reached NetGSM) retry; a received-but-unparseable response (empty
 * `code`, `transport: false`) does NOT retry, since NetGSM may already have
 * accepted/sent the message and retrying would risk a duplicate billed SMS.
 */
describe('NetgsmSmsAdapter.send — v2 default path', () => {
  let adapter: NetgsmSmsAdapter;
  let smsV2Send: jest.Mock;
  const secrets = { usercode: 'u123', password: 's3cr3t-pass', msgheader: 'ACME' };

  beforeEach(() => {
    smsV2Send = jest.fn();
    adapter = new NetgsmSmsAdapter(
      { register: jest.fn() } as any,
      { fetchBalance: jest.fn() } as any,
      { send: smsV2Send, msgheaders: jest.fn() } as any,
    );
  });
  afterEach(() => jest.useRealTimers());

  it('calls SmsV2Client.send with the exact n:n wire payload (no useLegacySend set)', async () => {
    smsV2Send.mockResolvedValue({ ok: true, code: '00', jobid: '26702360000000000123', message: null, retriable: false });
    const config = { secrets, public: {} } as any;

    const res = await adapter.send({ config, to: '+90 555 111 22 33', text: 'Merhaba' });

    expect(res).toEqual({ externalMessageId: '26702360000000000123', status: 'SENT' });
    expect(smsV2Send).toHaveBeenCalledTimes(1);
    const [creds, req] = smsV2Send.mock.calls[0];
    expect(creds).toEqual({ usercode: 'u123', password: 's3cr3t-pass' });
    expect(req).toEqual({
      msgheader: 'ACME',
      messages: [{ msg: 'Merhaba', no: '905551112233' }],
    });
  });

  it('defaults to v2 when configPublic is entirely absent', async () => {
    smsV2Send.mockResolvedValue({ ok: true, code: '00', jobid: '1', message: null, retriable: false });
    const res = await adapter.send({ config: { secrets } as any, to: '+905551112233', text: 'x' });
    expect(res.status).toBe('SENT');
    expect(smsV2Send).toHaveBeenCalledTimes(1);
  });

  it('defaults to v2 when useLegacySend is explicitly false', async () => {
    smsV2Send.mockResolvedValue({ ok: true, code: '00', jobid: '1', message: null, retriable: false });
    const config = { secrets, public: { useLegacySend: false } } as any;
    await adapter.send({ config, to: '+905551112233', text: 'x' });
    expect(smsV2Send).toHaveBeenCalledTimes(1);
  });

  it('maps a permanent error code (40) to the mapped message and does NOT retry', async () => {
    smsV2Send.mockResolvedValue({ ok: false, code: '40', jobid: null, message: 'msgheader tanımlı değil', retriable: false });
    const config = { secrets, public: {} } as any;
    const res = await adapter.send({ config, to: '+905551112233', text: 'x' });
    expect(res).toEqual({ externalMessageId: null, status: 'FAILED', error: 'msgheader tanımlı değil' });
    expect(smsV2Send).toHaveBeenCalledTimes(1);
  });

  it('retries rate-limit code 80, then gives up with the mapped error', async () => {
    jest.useFakeTimers();
    smsV2Send.mockResolvedValue({ ok: false, code: '80', jobid: null, message: 'NetGSM hız limiti aşıldı', retriable: true });
    const config = { secrets, public: {} } as any;
    const p = adapter.send({ config, to: '+905551112233', text: 'x' });
    await jest.runAllTimersAsync();
    const res = await p;
    expect(res.status).toBe('FAILED');
    expect(res.error).toMatch(/hız limiti/i);
    expect(smsV2Send).toHaveBeenCalledTimes(3);
  });

  it('retries a genuine transport-level failure (transport:true), then succeeds', async () => {
    jest.useFakeTimers();
    smsV2Send
      .mockResolvedValueOnce({ ok: false, code: '', jobid: null, message: 'NetGSM erişilemedi', retriable: false, transport: true })
      .mockResolvedValue({ ok: true, code: '00', jobid: '9', message: null, retriable: false, transport: false });
    const config = { secrets, public: {} } as any;
    const p = adapter.send({ config, to: '+905551112233', text: 'x' });
    await jest.runAllTimersAsync();
    const res = await p;
    expect(res).toEqual({ externalMessageId: '9', status: 'SENT' });
    expect(smsV2Send).toHaveBeenCalledTimes(2);
  });

  it('gives up after MAX_ATTEMPTS on a persistent genuine transport failure (transport:true)', async () => {
    jest.useFakeTimers();
    smsV2Send.mockResolvedValue({ ok: false, code: '', jobid: null, message: 'NetGSM erişilemedi', retriable: false, transport: true });
    const config = { secrets, public: {} } as any;
    const p = adapter.send({ config, to: '+905551112233', text: 'x' });
    await jest.runAllTimersAsync();
    const res = await p;
    expect(res.status).toBe('FAILED');
    expect(res.error).toMatch(/erişilemedi/i);
    expect(smsV2Send).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a received-but-unparseable response (empty code, transport:false) — avoids a duplicate billed SMS', async () => {
    smsV2Send.mockResolvedValue({
      ok: false, code: '', jobid: null,
      message: 'NetGSM beklenmedik yanıt döndürdü (HTTP 200).',
      retriable: false, transport: false,
    });
    const config = { secrets, public: {} } as any;
    const res = await adapter.send({ config, to: '+905551112233', text: 'x' });
    expect(res.status).toBe('FAILED');
    expect(smsV2Send).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a permanent İYS code (51) — exactly one attempt', async () => {
    smsV2Send.mockResolvedValue({ ok: false, code: '51', jobid: null, message: 'İYS...', retriable: false });
    const config = { secrets, public: {} } as any;
    const res = await adapter.send({ config, to: '+905551112233', text: 'x' });
    expect(res.status).toBe('FAILED');
    expect(smsV2Send).toHaveBeenCalledTimes(1);
  });

  it('returns FAILED on a config-missing guard without calling SmsV2Client', async () => {
    const res = await adapter.send({ config: { secrets: {} } as any, to: '+90555', text: 'x' });
    expect(res.status).toBe('FAILED');
    expect(smsV2Send).not.toHaveBeenCalled();
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
    adapter = new NetgsmSmsAdapter(
      { register: jest.fn() } as any,
      { fetchBalance: jest.fn() } as any,
      { send: jest.fn(), msgheaders: jest.fn() } as any,
    );
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
 * Live verify: healthCheck does a real /balance auth probe (via BalanceClient)
 * and — once creds are confirmed live — a msgheader-list check (via
 * SmsV2Client.msgheaders) so "Verify" also catches a header that's live but
 * not İYS-approved on the account, distinct from bad credentials.
 */
describe('NetgsmSmsAdapter.healthCheck', () => {
  const registryStub = { register: jest.fn() };

  it('creds valid + header approved → ok:true, headerApproved:true, approvedHeaders cached', async () => {
    const balance = {
      fetchBalance: jest
        .fn()
        .mockResolvedValue({ ok: true, credsValid: true, credit: '100', packages: [], code: null, message: null }),
    };
    const smsV2 = { send: jest.fn(), msgheaders: jest.fn().mockResolvedValue({ ok: true, headers: ['ACME', 'OTHERHDR'] }) };
    const adapter = new NetgsmSmsAdapter(registryStub as any, balance as any, smsV2 as any);
    const res = await adapter.healthCheck({ secrets: { usercode: 'u', password: 'p', msgheader: 'ACME' } } as any);
    expect(balance.fetchBalance).toHaveBeenCalledWith({ usercode: 'u', password: 'p' });
    expect(smsV2.msgheaders).toHaveBeenCalledWith({ usercode: 'u', password: 'p' });
    expect(res.ok).toBe(true);
    expect(res.details).toMatchObject({
      credsValid: true,
      headerApproved: true,
      approvedHeaders: ['ACME', 'OTHERHDR'],
    });
  });

  it('creds valid but header NOT in the approved list → ok:false, headerApproved:false, approvedHeaders cached', async () => {
    const balance = {
      fetchBalance: jest
        .fn()
        .mockResolvedValue({ ok: true, credsValid: true, credit: '100', packages: [], code: null, message: null }),
    };
    const smsV2 = { send: jest.fn(), msgheaders: jest.fn().mockResolvedValue({ ok: true, headers: ['OTHERHDR'] }) };
    const adapter = new NetgsmSmsAdapter(registryStub as any, balance as any, smsV2 as any);
    const res = await adapter.healthCheck({ secrets: { usercode: 'u', password: 'p', msgheader: 'ACME' } } as any);
    expect(res.ok).toBe(false);
    expect(res.details).toMatchObject({
      credsValid: true,
      headerApproved: false,
      approvedHeaders: ['OTHERHDR'],
    });
  });

  it('creds valid but the msgheader-list endpoint hiccups → ok stays true, headerApproved stays undefined (does NOT fail verify)', async () => {
    const balance = {
      fetchBalance: jest
        .fn()
        .mockResolvedValue({ ok: true, credsValid: true, credit: '100', packages: [], code: null, message: null }),
    };
    const smsV2 = { send: jest.fn(), msgheaders: jest.fn().mockResolvedValue({ ok: false, headers: [] }) };
    const adapter = new NetgsmSmsAdapter(registryStub as any, balance as any, smsV2 as any);
    const res = await adapter.healthCheck({ secrets: { usercode: 'u', password: 'p', msgheader: 'ACME' } } as any);
    expect(res.ok).toBe(true);
    expect(res.details?.headerApproved).toBeUndefined();
    expect(res.details?.approvedHeaders).toBeUndefined();
    expect(res.details).toMatchObject({ credsValid: true });
  });

  it('missing secrets → ok:false without probing balance or msgheaders', async () => {
    const balance = { fetchBalance: jest.fn() };
    const smsV2 = { send: jest.fn(), msgheaders: jest.fn() };
    const adapter = new NetgsmSmsAdapter(registryStub as any, balance as any, smsV2 as any);
    const res = await adapter.healthCheck({ secrets: {} } as any);
    expect(res.ok).toBe(false);
    expect(balance.fetchBalance).not.toHaveBeenCalled();
    expect(smsV2.msgheaders).not.toHaveBeenCalled();
  });

  it('rejected creds (code 30) → ok:false with the mapped message, short-circuits before msgheaders', async () => {
    const balance = {
      fetchBalance: jest
        .fn()
        .mockResolvedValue({ ok: false, credsValid: false, credit: null, packages: [], code: '30', message: 'Kimlik doğrulama hatası' }),
    };
    const smsV2 = { send: jest.fn(), msgheaders: jest.fn() };
    const adapter = new NetgsmSmsAdapter(registryStub as any, balance as any, smsV2 as any);
    const res = await adapter.healthCheck({ secrets: { usercode: 'u', password: 'wrong', msgheader: 'HDR' } } as any);
    expect(res.ok).toBe(false);
    expect(res.details).toMatchObject({ credsValid: false, code: '30' });
    expect(smsV2.msgheaders).not.toHaveBeenCalled();
  });

  it('unreachable creds (credsValid: null) → ok:false, short-circuits before msgheaders', async () => {
    const balance = {
      fetchBalance: jest
        .fn()
        .mockResolvedValue({ ok: false, credsValid: null, credit: null, packages: [], code: null, message: 'NetGSM erişilemedi' }),
    };
    const smsV2 = { send: jest.fn(), msgheaders: jest.fn() };
    const adapter = new NetgsmSmsAdapter(registryStub as any, balance as any, smsV2 as any);
    const res = await adapter.healthCheck({ secrets: { usercode: 'u', password: 'p', msgheader: 'HDR' } } as any);
    expect(res.ok).toBe(false);
    expect(res.details).toMatchObject({ credsValid: null });
    expect(smsV2.msgheaders).not.toHaveBeenCalled();
  });
});
