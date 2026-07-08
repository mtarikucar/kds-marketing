import { BalanceClient } from './balance.client';
import { NetgsmRestClient } from '../core/netgsm-rest.client';

describe('BalanceClient', () => {
  const rest = new NetgsmRestClient();
  const client = new BalanceClient(rest);
  const creds = { usercode: 'u', password: 'p' };
  afterEach(() => jest.restoreAllMocks());

  it('parses a package/credit response', async () => {
    jest.spyOn(rest, 'request').mockResolvedValue({
      httpStatus: 200,
      body: [{ balance_name: 'OTP SMS', amount: '5000' }, { balance_name: 'TL', amount: '123.45' }],
      rawText: 'x',
    } as any);
    const r = await client.fetchBalance(creds);
    expect(r.ok).toBe(true);
    expect(r.credsValid).toBe(true);
    expect(r.packages.length).toBeGreaterThan(0);
  });

  it('code 30 → creds invalid', async () => {
    jest.spyOn(rest, 'request').mockResolvedValue({ httpStatus: 406, body: { code: '30' }, rawText: '30' } as any);
    const r = await client.fetchBalance(creds);
    expect(r.ok).toBe(false);
    expect(r.credsValid).toBe(false);
    expect(r.code).toBe('30');
    expect(r.message).toMatch(/kimlik|IP/i);
  });

  it('code 60 (no package) still proves creds', async () => {
    jest.spyOn(rest, 'request').mockResolvedValue({ httpStatus: 200, body: { code: '60' }, rawText: '60' } as any);
    const r = await client.fetchBalance(creds);
    expect(r.ok).toBe(false);
    expect(r.credsValid).toBe(true);
  });

  it('transport error → credsValid null', async () => {
    jest.spyOn(rest, 'request').mockRejectedValue(new Error('down'));
    const r = await client.fetchBalance(creds);
    expect(r.ok).toBe(false);
    expect(r.credsValid).toBeNull();
  });

  it('NUMERIC code 30 envelope is still recognized as creds-invalid', async () => {
    jest.spyOn(rest, 'request').mockResolvedValue({ httpStatus: 406, body: { code: 30 }, rawText: '' } as any);
    const r = await client.fetchBalance(creds);
    expect(r.ok).toBe(false);
    expect(r.credsValid).toBe(false);
    expect(r.code).toBe('30');
  });

  it('non-200 without a recognized code must NOT read as verified (gateway error page)', async () => {
    jest.spyOn(rest, 'request').mockResolvedValue({
      httpStatus: 502,
      body: null,
      rawText: '<html>Bad Gateway</html>',
    } as any);
    const r = await client.fetchBalance(creds);
    expect(r.ok).toBe(false);
    expect(r.credsValid).toBeNull();
    expect(r.message).toMatch(/502/);
  });
});
