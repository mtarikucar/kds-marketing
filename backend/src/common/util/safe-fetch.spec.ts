const mockLookup = jest.fn();

jest.mock('node:dns/promises', () => ({
  __esModule: true,
  lookup: (...args: unknown[]) => mockLookup(...args),
}));

import { isBlockedIp, safeFetch, SsrfBlockedError } from './safe-fetch';

/**
 * The SSRF guard is the boundary for any outbound call whose URL is partly
 * caller-controlled (workflow http_webhook_out today). These pin the two halves
 * of the defense: the literal-IP classifier (isBlockedIp) and the request path
 * (scheme allow-list, DNS-resolution rejection, redirect re-validation).
 */
describe('safe-fetch', () => {
  describe('isBlockedIp', () => {
    it.each([
      ['cloud metadata', '169.254.169.254'],
      ['loopback v4', '127.0.0.1'],
      ['private 10/8', '10.1.2.3'],
      ['private 192.168/16', '192.168.0.1'],
      ['loopback v6', '::1'],
      ['IPv4-mapped metadata', '::ffff:169.254.169.254'],
      ['unique-local v6', 'fd00::1'],
    ])('blocks %s (%s)', (_label, ip) => {
      expect(isBlockedIp(ip)).toBe(true);
    });

    it('allows a public IP', () => {
      expect(isBlockedIp('8.8.8.8')).toBe(false);
    });

    it('refuses a non-IP string', () => {
      expect(isBlockedIp('not-an-ip')).toBe(true);
    });
  });

  describe('safeFetch', () => {
    let fetchMock: jest.Mock;

    beforeEach(() => {
      mockLookup.mockReset();
      fetchMock = jest.fn();
      (global as any).fetch = fetchMock;
    });

    const okResponse = (status = 200, headers: Record<string, string> = {}) =>
      ({
        status,
        headers: new Headers(headers),
        arrayBuffer: async () => new ArrayBuffer(0),
      }) as unknown as Response;

    it('rejects a non-http scheme without calling fetch', async () => {
      await expect(safeFetch('file:///etc/passwd')).rejects.toBeInstanceOf(SsrfBlockedError);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('blocks a host that resolves to a metadata/private IP (mocked DNS)', async () => {
      mockLookup.mockResolvedValue([{ address: '169.254.169.254' }]);

      await expect(safeFetch('https://evil.example.com')).rejects.toBeInstanceOf(
        SsrfBlockedError,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a 3xx redirect that points at an internal host', async () => {
      // First hop resolves public and returns a redirect to an internal host;
      // the guard must re-validate the Location target and refuse it.
      mockLookup
        .mockResolvedValueOnce([{ address: '93.184.216.34' }]) // public.example.com
        .mockResolvedValueOnce([{ address: '127.0.0.1' }]); // redirect target
      fetchMock.mockResolvedValueOnce(
        okResponse(302, { location: 'https://internal.example.com/' }),
      );

      await expect(safeFetch('https://public.example.com')).rejects.toBeInstanceOf(
        SsrfBlockedError,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1); // never followed the redirect
    });

    it('allows a public host and returns the response', async () => {
      mockLookup.mockResolvedValue([{ address: '93.184.216.34' }]);
      fetchMock.mockResolvedValue(okResponse(200));

      const res = await safeFetch('https://public.example.com', { method: 'POST' });

      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // The guard pins redirect:'manual' so 3xx are re-validated, not auto-followed.
      expect(fetchMock.mock.calls[0][1]).toEqual(
        expect.objectContaining({ method: 'POST', redirect: 'manual' }),
      );
    });
  });
});
