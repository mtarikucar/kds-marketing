jest.mock('dns', () => ({ promises: { resolveTxt: jest.fn() } }));

import { promises as dns } from 'dns';
import { SendingDomainsService } from './sending-domains.service';
import { ServiceUnavailableException, BadRequestException, ConflictException } from '@nestjs/common';

const resolveTxtMock = dns.resolveTxt as unknown as jest.Mock;

describe('SendingDomainsService', () => {
  const WS = 'ws-1';
  let prisma: any;
  let scheduledJob: { schedule: jest.Mock; cancel: jest.Mock };
  let runnerHandler: (job: any) => Promise<any>;
  let svc: SendingDomainsService;
  const realEsp = process.env.SENDING_DOMAIN_ESP;

  beforeAll(() => {
    process.env.MARKETING_SECRET_KEY = Buffer.alloc(32, 9).toString('base64');
  });

  beforeEach(() => {
    resolveTxtMock.mockReset();
    delete process.env.SENDING_DOMAIN_ESP;
    prisma = {
      sendingDomain: {
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockImplementation(async ({ data }: any) => ({ id: 'sd1', createdAt: new Date(), verifiedAt: null, ...data })),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    scheduledJob = { schedule: jest.fn().mockResolvedValue('job1'), cancel: jest.fn().mockResolvedValue(true) };
    const runner = { registerHandler: (_k: string, fn: any) => { runnerHandler = fn; } };
    svc = new SendingDomainsService(prisma as any, scheduledJob as any, runner as any);
    svc.onModuleInit();
  });

  afterAll(() => {
    if (realEsp === undefined) delete process.env.SENDING_DOMAIN_ESP;
    else process.env.SENDING_DOMAIN_ESP = realEsp;
  });

  describe('request (inert gate)', () => {
    it('is inert without SENDING_DOMAIN_ESP (503, no row, no job)', async () => {
      await expect(svc.request(WS, { domain: 'mail.acme.com' })).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(prisma.sendingDomain.create).not.toHaveBeenCalled();
      expect(scheduledJob.schedule).not.toHaveBeenCalled();
    });

    it('mints a sealed DKIM keypair, stores records, and schedules verification', async () => {
      process.env.SENDING_DOMAIN_ESP = 'postmark';
      prisma.sendingDomain.findFirst.mockResolvedValue(null);
      const out = await svc.request(WS, { domain: 'https://www.Acme.com', fromName: 'Acme' });
      const data = prisma.sendingDomain.create.mock.calls[0][0].data;
      expect(data.workspaceId).toBe(WS);
      expect(data.domain).toBe('acme.com'); // normalized
      expect(data.dkimSelector).toMatch(/^mkt[0-9a-f]{6}$/);
      expect(data.dkimPublicKey.length).toBeGreaterThan(100); // base64 DER SPKI
      // the PRIVATE key is sealed, never stored in the clear
      expect(data.dkimPrivateSealed).toMatch(/^v1:/);
      expect(data.dkimPrivateSealed).not.toContain('PRIVATE KEY');
      expect(scheduledJob.schedule.mock.calls[0][0]).toMatchObject({ workspaceId: WS, kind: 'sending-domain.verify' });
      // response carries the copy-able DNS records and NOT the sealed key
      expect(out.records).toHaveLength(3);
      expect((out as any).dkimPrivateSealed).toBeUndefined();
    });

    it('rejects an invalid domain and a duplicate', async () => {
      process.env.SENDING_DOMAIN_ESP = 'postmark';
      prisma.sendingDomain.findFirst.mockResolvedValue(null);
      await expect(svc.request(WS, { domain: 'not a domain' })).rejects.toBeInstanceOf(BadRequestException);
      prisma.sendingDomain.findFirst.mockResolvedValue({ id: 'sd1' });
      await expect(svc.request(WS, { domain: 'acme.com' })).rejects.toBeInstanceOf(ConflictException);
    });

    // TOCTOU: two concurrent same-domain registrations both pass the findFirst
    // pre-check; the 2nd insert trips the (workspaceId, domain) unique → P2002.
    // Map to a clean 409, not a raw 500.
    it('maps a P2002 race to a 409', async () => {
      process.env.SENDING_DOMAIN_ESP = 'postmark';
      prisma.sendingDomain.findFirst.mockResolvedValue(null); // pre-check passes
      prisma.sendingDomain.create.mockRejectedValue(
        Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
      );
      await expect(svc.request(WS, { domain: 'mail.acme.com' })).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('verifyNow', () => {
    const dom = { id: 'sd1', workspaceId: WS, domain: 'mail.acme.com', status: 'PENDING', dkimSelector: 'mkt0a0b', dkimPublicKey: 'PUB123' };

    it('flips to VERIFIED when all three records resolve', async () => {
      prisma.sendingDomain.findFirst.mockResolvedValue(dom);
      resolveTxtMock.mockImplementation(async (host: string) => {
        if (host.includes('_domainkey')) return [['v=DKIM1; k=rsa; p=PUB123']];
        if (host.startsWith('_dmarc')) return [['v=DMARC1; p=quarantine']];
        return [['v=spf1 include:spf.platform.example ~all']];
      });
      const out = await svc.verifyNow(WS, 'sd1');
      expect(prisma.sendingDomain.updateMany.mock.calls[0][0].data.status).toBe('VERIFIED');
      expect(out.status).toBe('VERIFIED');
    });

    it('stays PENDING with a hint when records are missing', async () => {
      prisma.sendingDomain.findFirst.mockResolvedValue(dom);
      resolveTxtMock.mockResolvedValue([]); // nothing published yet
      const out = await svc.verifyNow(WS, 'sd1');
      expect(prisma.sendingDomain.updateMany.mock.calls[0][0].data.status).toBeUndefined();
      expect(prisma.sendingDomain.updateMany.mock.calls[0][0].data.lastError).toMatch(/DKIM, SPF, DMARC/);
      expect(out.status).toBe('PENDING');
    });
  });

  describe('runVerifyJob', () => {
    const dom = { id: 'sd1', workspaceId: WS, domain: 'mail.acme.com', status: 'PENDING', dkimSelector: 'mkt0a0b', dkimPublicKey: 'PUB123' };
    const job = { id: 'j1', workspaceId: WS, kind: 'sending-domain.verify', payload: { domainId: 'sd1', polls: 0 }, attempts: 0 };

    it('reschedules in place while DNS is not yet published', async () => {
      prisma.sendingDomain.findFirst.mockResolvedValue(dom);
      resolveTxtMock.mockResolvedValue([]);
      const res = await runnerHandler(job);
      expect(res?.reschedule).toBeDefined();
      expect(res.reschedule.payload).toMatchObject({ domainId: 'sd1', polls: 1 });
    });

    it('finalizes VERIFIED (no reschedule) once records resolve', async () => {
      prisma.sendingDomain.findFirst.mockResolvedValue(dom);
      resolveTxtMock.mockImplementation(async (host: string) => {
        if (host.includes('_domainkey')) return [['v=DKIM1; k=rsa; p=PUB123']];
        if (host.startsWith('_dmarc')) return [['v=DMARC1']];
        return [['v=spf1 include:spf.platform.example ~all']];
      });
      const res = await runnerHandler(job);
      expect(res).toBeUndefined();
      expect(prisma.sendingDomain.updateMany.mock.calls.at(-1)[0].data.status).toBe('VERIFIED');
    });

    it('gives up (FAILED) after the poll cap', async () => {
      prisma.sendingDomain.findFirst.mockResolvedValue(dom);
      resolveTxtMock.mockResolvedValue([]);
      const res = await runnerHandler({ ...job, payload: { domainId: 'sd1', polls: 100000 } });
      expect(res).toBeUndefined();
      expect(prisma.sendingDomain.updateMany.mock.calls.at(-1)[0].data.status).toBe('FAILED');
    });
  });

  describe('resolveFrom (campaign integration — inert by default)', () => {
    it('returns null WITHOUT a DB query when no ESP transport is configured', async () => {
      prisma.sendingDomain.findFirst.mockResolvedValue({ fromEmail: 'noreply@acme.com' });
      const out = await svc.resolveFrom(WS);
      expect(out).toBeNull();
      expect(prisma.sendingDomain.findFirst).not.toHaveBeenCalled();
    });

    it('returns the verified domain From once an ESP transport is configured', async () => {
      process.env.SENDING_DOMAIN_ESP = 'postmark';
      prisma.sendingDomain.findFirst.mockResolvedValue({ fromEmail: 'noreply@acme.com', fromName: 'Acme' });
      const out = await svc.resolveFrom(WS);
      expect(out).toEqual({ email: 'noreply@acme.com', name: 'Acme' });
      expect(prisma.sendingDomain.findFirst.mock.calls[0][0].where).toMatchObject({ workspaceId: WS, status: 'VERIFIED' });
    });

    it('attaches DKIM signing material (opened from the sealed key) so the From-swap is authenticated', async () => {
      process.env.SENDING_DOMAIN_ESP = 'postmark';
      const { sealSecret } = require('../../../common/crypto/secret-box.helper');
      const pem = '-----BEGIN PRIVATE KEY-----\nMIItest\n-----END PRIVATE KEY-----';
      prisma.sendingDomain.findFirst.mockResolvedValue({
        domain: 'mail.acme.com', fromEmail: 'noreply@mail.acme.com', fromName: 'Acme',
        dkimSelector: 'mkt1a2b', dkimPrivateSealed: sealSecret(pem),
      });
      const out = await svc.resolveFrom(WS);
      expect(out).toMatchObject({
        email: 'noreply@mail.acme.com', name: 'Acme',
        dkim: { domainName: 'mail.acme.com', keySelector: 'mkt1a2b', privateKey: pem },
      });
    });
  });
});
