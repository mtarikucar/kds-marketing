jest.mock('dns', () => ({ promises: { resolveTxt: jest.fn() } }));
jest.mock('../../../common/scheduling/advisory-lock', () => ({
  withAdvisoryLock: (_p: any, _n: string, fn: () => any) => fn(),
}));

import { promises as dns } from 'dns';
import { CustomDomainsService } from './custom-domains.service';
import { ServiceUnavailableException, BadRequestException, ConflictException } from '@nestjs/common';

const resolveTxtMock = dns.resolveTxt as unknown as jest.Mock;

describe('CustomDomainsService', () => {
  const WS = 'ws-1';
  let prisma: any;
  let svc: CustomDomainsService;
  const realFlag = process.env.CUSTOM_DOMAINS_ENABLED;

  beforeEach(() => {
    resolveTxtMock.mockReset();
    delete process.env.CUSTOM_DOMAINS_ENABLED;
    prisma = {
      customDomain: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockImplementation(async ({ data }: any) => ({ id: 'cd1', createdAt: new Date(), ...data })),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    svc = new CustomDomainsService(prisma as any);
  });

  afterAll(() => {
    if (realFlag === undefined) delete process.env.CUSTOM_DOMAINS_ENABLED;
    else process.env.CUSTOM_DOMAINS_ENABLED = realFlag;
  });

  describe('request (inert gate)', () => {
    it('is inert without CUSTOM_DOMAINS_ENABLED (503, no row)', async () => {
      await expect(svc.request(WS, { hostname: 'www.acme.com' })).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(prisma.customDomain.create).not.toHaveBeenCalled();
    });

    it('registers a PENDING domain with a verify token + instructions', async () => {
      process.env.CUSTOM_DOMAINS_ENABLED = '1';
      prisma.customDomain.findUnique.mockResolvedValue(null);
      const out = await svc.request(WS, { hostname: 'https://WWW.Acme.com/', homeSlug: 'landing' });
      const data = prisma.customDomain.create.mock.calls[0][0].data;
      expect(data.workspaceId).toBe(WS);
      expect(data.hostname).toBe('www.acme.com'); // normalized
      expect(data.homeSlug).toBe('landing');
      expect(data.status).toBe('PENDING');
      expect(data.verifyToken).toMatch(/^[0-9a-f]{32}$/);
      expect(out.instructions).toHaveLength(2); // CNAME + TXT
    });

    it('rejects an invalid hostname and a duplicate', async () => {
      process.env.CUSTOM_DOMAINS_ENABLED = '1';
      prisma.customDomain.findUnique.mockResolvedValue(null);
      await expect(svc.request(WS, { hostname: 'not a host' })).rejects.toBeInstanceOf(BadRequestException);
      prisma.customDomain.findUnique.mockResolvedValue({ id: 'cd1' });
      await expect(svc.request(WS, { hostname: 'www.acme.com' })).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('verifyNow', () => {
    const dom = { id: 'cd1', workspaceId: WS, hostname: 'www.acme.com', verifyToken: 'tok123', status: 'PENDING' };

    it('flips to VERIFIED when the TXT token resolves', async () => {
      prisma.customDomain.findFirst.mockResolvedValue(dom);
      resolveTxtMock.mockResolvedValue([['platform-verify=tok123']]);
      const out = await svc.verifyNow(WS, 'cd1');
      expect(prisma.customDomain.updateMany.mock.calls[0][0].data.status).toBe('VERIFIED');
      expect(out.status).toBe('VERIFIED');
    });

    it('stays PENDING with a hint when the token is not yet published', async () => {
      prisma.customDomain.findFirst.mockResolvedValue(dom);
      resolveTxtMock.mockRejectedValue(new Error('ENOTFOUND'));
      const out = await svc.verifyNow(WS, 'cd1');
      expect(prisma.customDomain.updateMany.mock.calls[0][0].data.status).toBeUndefined();
      expect(out.status).toBe('PENDING');
    });
  });

  describe('resolveHost (middleware lookup)', () => {
    it('returns the workspace + slug for a VERIFIED host and caches it', async () => {
      prisma.customDomain.findUnique.mockResolvedValue({ workspaceId: WS, homeSlug: 'home', status: 'VERIFIED' });
      const a = await svc.resolveHost('www.acme.com');
      const b = await svc.resolveHost('www.acme.com'); // cached
      expect(a).toEqual({ workspaceId: WS, homeSlug: 'home' });
      expect(b).toEqual(a);
      expect(prisma.customDomain.findUnique).toHaveBeenCalledTimes(1); // TTL cache, one DB hit
    });

    it('returns null for an unknown or not-yet-verified host', async () => {
      prisma.customDomain.findUnique.mockResolvedValueOnce(null);
      expect(await svc.resolveHost('nope.example')).toBeNull();
      prisma.customDomain.findUnique.mockResolvedValueOnce({ workspaceId: WS, homeSlug: 'home', status: 'PENDING' });
      expect(await svc.resolveHost('pending.example')).toBeNull();
    });

    it('rejects a garbage/invalid Host header WITHOUT touching the DB (cache-spray defense)', async () => {
      expect(await svc.resolveHost('not a host')).toBeNull();
      expect(await svc.resolveHost('javascript:alert(1)')).toBeNull();
      expect(await svc.resolveHost('')).toBeNull();
      expect(prisma.customDomain.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('tlsAsk (Caddy on-demand TLS gate)', () => {
    it('is inert (false, no DB) when custom domains are disabled', async () => {
      expect(await svc.tlsAsk('go.acme.com')).toBe(false);
      expect(prisma.customDomain.findUnique).not.toHaveBeenCalled();
    });
    it('authorizes a cert + flips ACTIVE/ISSUED for a VERIFIED host', async () => {
      process.env.CUSTOM_DOMAINS_ENABLED = '1';
      prisma.customDomain.findUnique.mockResolvedValue({ id: 'cd1', workspaceId: WS, status: 'VERIFIED', sslStatus: 'PENDING' });
      expect(await svc.tlsAsk('go.acme.com')).toBe(true);
      expect(prisma.customDomain.updateMany.mock.calls[0][0].data).toMatchObject({ sslStatus: 'ISSUED', status: 'ACTIVE' });
    });
    it('refuses a cert for an unknown/unverified host', async () => {
      process.env.CUSTOM_DOMAINS_ENABLED = '1';
      prisma.customDomain.findUnique.mockResolvedValueOnce(null);
      expect(await svc.tlsAsk('evil.example')).toBe(false);
      prisma.customDomain.findUnique.mockResolvedValueOnce({ id: 'cd2', workspaceId: WS, status: 'PENDING', sslStatus: 'PENDING' });
      expect(await svc.tlsAsk('pending.example')).toBe(false);
      expect(prisma.customDomain.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('verifySweep (system cron)', () => {
    it('is inert without CUSTOM_DOMAINS_ENABLED (no DNS, no read)', async () => {
      await svc.verifySweep();
      expect(prisma.customDomain.findMany).not.toHaveBeenCalled();
      expect(resolveTxtMock).not.toHaveBeenCalled();
    });

    it('flips published PENDING domains to VERIFIED and stamps every row (anti-starvation)', async () => {
      process.env.CUSTOM_DOMAINS_ENABLED = '1';
      prisma.customDomain.findMany.mockResolvedValue([
        { id: 'cd1', workspaceId: 'ws-a', hostname: 'a.example', verifyToken: 'ta' },
        { id: 'cd2', workspaceId: 'ws-b', hostname: 'b.example', verifyToken: 'tb' },
      ]);
      resolveTxtMock.mockImplementation(async (host: string) =>
        host.includes('a.example') ? [['platform-verify=ta']] : [], // only a.example is published
      );
      await svc.verifySweep();
      // reads oldest-checked first so rows past the window can't starve
      expect(prisma.customDomain.findMany.mock.calls[0][0].orderBy).toEqual({ lastCheckedAt: { sort: 'asc', nulls: 'first' } });
      const calls = prisma.customDomain.updateMany.mock.calls.map((c: any) => c[0]);
      // exactly the published one flips to VERIFIED, (id, workspaceId)-keyed
      const flipped = calls.filter((a: any) => a.data.status === 'VERIFIED');
      expect(flipped).toHaveLength(1);
      expect(flipped[0].where).toMatchObject({ id: 'cd1', workspaceId: 'ws-a' });
      // the unpublished one is NOT verified but IS stamped (cursor advances)
      const cd2 = calls.find((a: any) => a.where.id === 'cd2');
      expect(cd2.data.status).toBeUndefined();
      expect(cd2.data.lastCheckedAt).toBeInstanceOf(Date);
    });
  });
});
