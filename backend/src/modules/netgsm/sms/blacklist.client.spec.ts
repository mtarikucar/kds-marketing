import { Logger } from '@nestjs/common';
import { BlacklistClient } from './blacklist.client';

describe('BlacklistClient', () => {
  const creds = { usercode: 'u-secret', password: 'p-secret' };
  let fetchMock: jest.SpyInstance;
  afterEach(() => fetchMock?.mockRestore());

  it('add() POSTs XML (tip=1) with Content-Type text/xml and returns ok on code 00', async () => {
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ text: async () => '00' } as any);
    const out = await new BlacklistClient().add(creds, '05551112233');
    expect(out).toEqual({ ok: true, code: '00', message: null });

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.netgsm.com.tr/sms/blacklist');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('text/xml');
    const body = opts.body as string;
    expect(body).toContain('<?xml version="1.0"?>');
    expect(body).toContain('<usercode>u-secret</usercode>');
    expect(body).toContain('<password>p-secret</password>');
    expect(body).toContain('<type>1</type>');
    expect(body).toContain('<no>5551112233</no>'); // normalized: leading 0 stripped
  });

  it('remove() sends tip=2', async () => {
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ text: async () => '00' } as any);
    await new BlacklistClient().remove(creds, '5551112233');
    const body = fetchMock.mock.calls[0][1].body as string;
    expect(body).toContain('<type>2</type>');
  });

  it.each([
    ['905551112233', '5551112233'], // +90 (12 digits after stripping non-digits)
    ['05551112233', '5551112233'], // 0-prefixed (11 digits)
    ['5551112233', '5551112233'], // bare 10-digit
    ['+90 555 111 22 33', '5551112233'], // formatted E.164
  ])('normalizes %s -> <no>%s</no>', async (input, expected) => {
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ text: async () => '00' } as any);
    await new BlacklistClient().add(creds, input);
    const body = fetchMock.mock.calls[0][1].body as string;
    expect(body).toContain(`<no>${expected}</no>`);
  });

  it('rejects an unnormalizable number without ever calling fetch', async () => {
    fetchMock = jest.spyOn(global, 'fetch');
    const out = await new BlacklistClient().add(creds, '123');
    expect(out.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a call with missing credentials without calling fetch', async () => {
    fetchMock = jest.spyOn(global, 'fetch');
    const out = await new BlacklistClient().add({ usercode: '', password: '' }, '5551112233');
    expect(out.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns ok:false with a mapped message on a provider error code', async () => {
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ text: async () => '30' } as any);
    const out = await new BlacklistClient().add(creds, '5551112233');
    expect(out.ok).toBe(false);
    expect(out.code).toBe('30');
    expect(out.message).toMatch(/kimlik|IP/i);
  });

  it('treats an empty response as a failure', async () => {
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ text: async () => '' } as any);
    const out = await new BlacklistClient().remove(creds, '5551112233');
    expect(out.ok).toBe(false);
    expect(out.code).toBe('');
  });

  it('scrubs usercode+password from a thrown transport error (creds ride in the XML body)', async () => {
    fetchMock = jest.spyOn(global, 'fetch').mockRejectedValue(
      new Error('boom u-secret and again p-secret'),
    );
    const out = await new BlacklistClient().add(creds, '5551112233');
    expect(out.ok).toBe(false);
    expect(out.message).not.toContain('u-secret');
    expect(out.message).not.toContain('p-secret');
    expect(out.message).toContain('***');
  });

  it('never logs the request XML (which carries plaintext credentials)', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ text: async () => '00' } as any);
    await new BlacklistClient().add(creds, '5551112233');
    for (const call of [...logSpy.mock.calls, ...warnSpy.mock.calls]) {
      expect(JSON.stringify(call)).not.toContain('p-secret');
      expect(JSON.stringify(call)).not.toContain('u-secret');
    }
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
