jest.mock('dns', () => ({ promises: { resolveTxt: jest.fn() } }));

import { promises as dns } from 'dns';
import { SendingDomainsService } from './sending-domains.service';
import {
  isSendingDomainsConfigured,
  platformSpfInclude,
  sendingDomainEspStatus,
} from './sending-domains.config';
import { ServiceUnavailableException, BadRequestException, ConflictException } from '@nestjs/common';

const resolveTxtMock = dns.resolveTxt as unknown as jest.Mock;

const SPF_INCLUDE = 'spf.jeeta.example';

/** A resolver failure that is not an answer (SERVFAIL, timeout, refused). */
function resolverBlip(): Error {
  return Object.assign(new Error('queryTxt ESERVFAIL'), { code: 'ESERVFAIL' });
}
/** A definitive "there is nothing at that host". */
function notFound(): Error {
  return Object.assign(new Error('queryTxt ENOTFOUND'), { code: 'ENOTFOUND' });
}

describe('SendingDomainsService', () => {
  const WS = 'ws-1';
  let prisma: any;
  let scheduledJob: { schedule: jest.Mock; cancel: jest.Mock };
  let runnerHandler: (job: any) => Promise<any>;
  let svc: SendingDomainsService;
  const realEnv = {
    esp: process.env.SENDING_DOMAIN_ESP,
    spf: process.env.SENDING_DOMAIN_SPF_INCLUDE,
  };

  /** Everything an operator has to set before the ESP path may do anything. */
  function arm() {
    process.env.SENDING_DOMAIN_ESP = 'postmark';
    process.env.SENDING_DOMAIN_SPF_INCLUDE = SPF_INCLUDE;
  }

  beforeAll(() => {
    process.env.MARKETING_SECRET_KEY = Buffer.alloc(32, 9).toString('base64');
  });

  beforeEach(() => {
    resolveTxtMock.mockReset();
    delete process.env.SENDING_DOMAIN_ESP;
    delete process.env.SENDING_DOMAIN_SPF_INCLUDE;
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
    for (const [key, value] of [
      ['SENDING_DOMAIN_ESP', realEnv.esp],
      ['SENDING_DOMAIN_SPF_INCLUDE', realEnv.spf],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  /**
   * The flag used to be a bare boolean, so `SENDING_DOMAIN_ESP=1` armed a path
   * that would have sent noreply@<tenant> through the platform's own SMTP while
   * telling the tenant to publish `include:spf.platform.example` — a placeholder
   * that authorises nothing. Naming a provider is a statement of intent, not a
   * working configuration.
   */
  describe('the flag alone does not arm the path', () => {
    it('is off with no provider named', () => {
      expect(sendingDomainEspStatus()).toEqual({
        armed: false,
        provider: null,
        missing: ['SENDING_DOMAIN_ESP', 'SENDING_DOMAIN_SPF_INCLUDE'],
      });
      expect(isSendingDomainsConfigured()).toBe(false);
    });

    it('is off when a provider is named but nothing backs it', () => {
      process.env.SENDING_DOMAIN_ESP = 'postmark';
      const status = sendingDomainEspStatus();
      expect(status.armed).toBe(false);
      expect(status.provider).toBe('postmark');
      expect(status.missing).toEqual(['SENDING_DOMAIN_SPF_INCLUDE']);
      expect(isSendingDomainsConfigured()).toBe(false);
    });

    it('is off for a provider name nothing knows how to talk to', () => {
      process.env.SENDING_DOMAIN_ESP = 'true';
      process.env.SENDING_DOMAIN_SPF_INCLUDE = SPF_INCLUDE;
      expect(sendingDomainEspStatus().missing).toEqual(['SENDING_DOMAIN_ESP']);
      expect(isSendingDomainsConfigured()).toBe(false);
    });

    it('is off while the SPF include is still the placeholder', () => {
      process.env.SENDING_DOMAIN_ESP = 'postmark';
      process.env.SENDING_DOMAIN_SPF_INCLUDE = 'spf.platform.example';
      expect(platformSpfInclude()).toBeNull();
      expect(isSendingDomainsConfigured()).toBe(false);
    });

    it('arms only once a known provider and a real include are both present', () => {
      arm();
      expect(sendingDomainEspStatus()).toEqual({ armed: true, provider: 'postmark', missing: [] });
      expect(platformSpfInclude()).toBe(SPF_INCLUDE);
      expect(isSendingDomainsConfigured()).toBe(true);
    });
  });

  describe('request (inert gate)', () => {
    it('is inert without a provider (503, no row, no job)', async () => {
      await expect(svc.request(WS, { domain: 'mail.acme.com' })).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(prisma.sendingDomain.create).not.toHaveBeenCalled();
      expect(scheduledJob.schedule).not.toHaveBeenCalled();
    });

    it('is inert with the provider named but no SPF include to hand out', async () => {
      process.env.SENDING_DOMAIN_ESP = 'postmark';
      await expect(svc.request(WS, { domain: 'mail.acme.com' })).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(prisma.sendingDomain.create).not.toHaveBeenCalled();
    });

    it('mints a sealed DKIM keypair, stores records, and schedules verification', async () => {
      arm();
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
      arm();
      prisma.sendingDomain.findFirst.mockResolvedValue(null);
      await expect(svc.request(WS, { domain: 'not a domain' })).rejects.toBeInstanceOf(BadRequestException);
      prisma.sendingDomain.findFirst.mockResolvedValue({ id: 'sd1' });
      await expect(svc.request(WS, { domain: 'acme.com' })).rejects.toBeInstanceOf(ConflictException);
    });

    // TOCTOU: two concurrent same-domain registrations both pass the findFirst
    // pre-check; the 2nd insert trips the (workspaceId, domain) unique → P2002.
    // Map to a clean 409, not a raw 500.
    it('maps a P2002 race to a 409', async () => {
      arm();
      prisma.sendingDomain.findFirst.mockResolvedValue(null); // pre-check passes
      prisma.sendingDomain.create.mockRejectedValue(
        Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
      );
      await expect(svc.request(WS, { domain: 'mail.acme.com' })).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('verifyNow', () => {
    const dom = { id: 'sd1', workspaceId: WS, domain: 'mail.acme.com', status: 'PENDING', dkimSelector: 'mkt0a0b', dkimPublicKey: 'PUB123' };

    /** Published DNS, per host, as the resolver would answer it. */
    function publish(over: { dkim?: unknown; spf?: unknown; dmarc?: unknown } = {}) {
      resolveTxtMock.mockImplementation(async (host: string) => {
        const answer = host.includes('_domainkey')
          ? over.dkim ?? [['v=DKIM1; k=rsa; p=PUB123']]
          : host.startsWith('_dmarc')
            ? over.dmarc ?? [['v=DMARC1; p=none']]
            : over.spf ?? [[`v=spf1 include:${SPF_INCLUDE} ~all`]];
        if (answer instanceof Error) throw answer;
        return answer;
      });
    }

    it('flips to VERIFIED when all three records resolve', async () => {
      arm();
      prisma.sendingDomain.findFirst.mockResolvedValue(dom);
      publish();
      const out = await svc.verifyNow(WS, 'sd1');
      expect(prisma.sendingDomain.updateMany.mock.calls[0][0].data.status).toBe('VERIFIED');
      expect(out.status).toBe('VERIFIED');
    });

    it('stays PENDING with a hint when records are missing', async () => {
      arm();
      prisma.sendingDomain.findFirst.mockResolvedValue(dom);
      publish({ dkim: notFound(), spf: notFound(), dmarc: notFound() });
      const out = await svc.verifyNow(WS, 'sd1');
      expect(prisma.sendingDomain.updateMany.mock.calls[0][0].data.status).toBeUndefined();
      expect(prisma.sendingDomain.updateMany.mock.calls[0][0].data.lastError).toMatch(/DKIM, SPF, DMARC/);
      expect(out.status).toBe('PENDING');
    });

    // The tenant already sends mail from this domain. Our record went in as a
    // SECOND v=spf1 TXT, which is a permerror for every sender of that domain —
    // "verified" here would be a lie that breaks their invoices.
    it('refuses to verify a domain that now has two SPF records, and says so', async () => {
      arm();
      prisma.sendingDomain.findFirst.mockResolvedValue(dom);
      publish({ spf: [['v=spf1 include:_spf.google.com ~all'], [`v=spf1 include:${SPF_INCLUDE} ~all`]] });
      const out = await svc.verifyNow(WS, 'sd1');
      expect(out.status).toBe('PENDING');
      expect(prisma.sendingDomain.updateMany.mock.calls[0][0].data.lastError).toMatch(/merge them into one/i);
      expect(out.checks?.spf).toEqual({ ok: false, reason: 'DUPLICATE' });
    });

    // A policy the tenant already publishes is theirs; we verify against it and
    // never ask them to replace it.
    it('verifies against an existing stricter DMARC policy instead of replacing it', async () => {
      arm();
      prisma.sendingDomain.findFirst.mockResolvedValue(dom);
      publish({ dmarc: [['v=DMARC1; p=reject; rua=mailto:dmarc@acme.com']] });
      expect((await svc.verifyNow(WS, 'sd1')).status).toBe('VERIFIED');
    });

    // resolveTxtSafe used to swallow every error into [], so a SERVFAIL read as
    // "the record was deleted". Nothing may move on a non-answer.
    it('writes nothing when the resolver did not answer', async () => {
      arm();
      prisma.sendingDomain.findFirst.mockResolvedValue(dom);
      publish({ dkim: resolverBlip() });
      const out = await svc.verifyNow(WS, 'sd1');
      expect(prisma.sendingDomain.updateMany).not.toHaveBeenCalled();
      expect(out.status).toBe('PENDING');
      expect(out.checks?.dkim).toEqual({ ok: false, reason: 'UNAVAILABLE' });
    });

    it('does not demote a VERIFIED domain on a resolver blip', async () => {
      arm();
      prisma.sendingDomain.findFirst.mockResolvedValue({ ...dom, status: 'VERIFIED' });
      publish({ spf: resolverBlip() });
      const out = await svc.verifyNow(WS, 'sd1');
      expect(prisma.sendingDomain.updateMany).not.toHaveBeenCalled();
      expect(out.status).toBe('VERIFIED');
    });

    // The other half of the same honesty: the records really are gone, so the
    // domain is not verified any more and the tenant is told on the spot.
    it('demotes a VERIFIED domain whose records are definitively gone', async () => {
      arm();
      prisma.sendingDomain.findFirst.mockResolvedValue({ ...dom, status: 'VERIFIED' });
      publish({ dkim: notFound() });
      const out = await svc.verifyNow(WS, 'sd1');
      expect(prisma.sendingDomain.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'PENDING' });
      expect(out.status).toBe('PENDING');
    });

    // Without an include there is nothing to ask for and nothing to grade.
    it('never verifies while the platform has no SPF include configured', async () => {
      process.env.SENDING_DOMAIN_ESP = 'postmark';
      prisma.sendingDomain.findFirst.mockResolvedValue(dom);
      publish();
      const out = await svc.verifyNow(WS, 'sd1');
      expect(out.status).toBe('PENDING');
      expect(out.checks?.spf).toEqual({ ok: false, reason: 'NOT_CONFIGURED' });
    });
  });

  describe('runVerifyJob', () => {
    const dom = { id: 'sd1', workspaceId: WS, domain: 'mail.acme.com', status: 'PENDING', dkimSelector: 'mkt0a0b', dkimPublicKey: 'PUB123' };
    const job = { id: 'j1', workspaceId: WS, kind: 'sending-domain.verify', payload: { domainId: 'sd1', polls: 0 }, attempts: 0 };

    beforeEach(arm);

    it('reschedules in place while DNS is not yet published', async () => {
      prisma.sendingDomain.findFirst.mockResolvedValue(dom);
      resolveTxtMock.mockRejectedValue(notFound());
      const res = await runnerHandler(job);
      expect(res?.reschedule).toBeDefined();
      expect(res.reschedule.payload).toMatchObject({ domainId: 'sd1', polls: 1 });
    });

    // A resolver outage must not eat the tenant's 14-day budget, and must not
    // leave a "records not found" hint that was never established.
    it('retries without spending a poll when the resolver did not answer', async () => {
      prisma.sendingDomain.findFirst.mockResolvedValue(dom);
      resolveTxtMock.mockRejectedValue(resolverBlip());
      const res = await runnerHandler({ ...job, payload: { domainId: 'sd1', polls: 3 } });
      expect(res.reschedule.payload).toMatchObject({ polls: 3 });
      expect(prisma.sendingDomain.updateMany).not.toHaveBeenCalled();
    });

    it('finalizes VERIFIED (no reschedule) once records resolve', async () => {
      prisma.sendingDomain.findFirst.mockResolvedValue(dom);
      resolveTxtMock.mockImplementation(async (host: string) => {
        if (host.includes('_domainkey')) return [['v=DKIM1; k=rsa; p=PUB123']];
        if (host.startsWith('_dmarc')) return [['v=DMARC1; p=none']];
        return [[`v=spf1 include:${SPF_INCLUDE} ~all`]];
      });
      const res = await runnerHandler(job);
      expect(res).toBeUndefined();
      expect(prisma.sendingDomain.updateMany.mock.calls.at(-1)[0].data.status).toBe('VERIFIED');
    });

    it('gives up (FAILED) after the poll cap', async () => {
      prisma.sendingDomain.findFirst.mockResolvedValue(dom);
      resolveTxtMock.mockRejectedValue(notFound());
      const res = await runnerHandler({ ...job, payload: { domainId: 'sd1', polls: 100000 } });
      expect(res).toBeUndefined();
      expect(prisma.sendingDomain.updateMany.mock.calls.at(-1)[0].data.status).toBe('FAILED');
    });
  });

  describe('resolveFrom (campaign integration — inert by default)', () => {
    it('returns null WITHOUT a DB query when the ESP path is not armed', async () => {
      process.env.SENDING_DOMAIN_ESP = 'postmark'; // named, but nothing behind it
      prisma.sendingDomain.findFirst.mockResolvedValue({ fromEmail: 'noreply@acme.com' });
      const out = await svc.resolveFrom(WS);
      expect(out).toBeNull();
      expect(prisma.sendingDomain.findFirst).not.toHaveBeenCalled();
    });

    it('returns the verified domain From once the path is armed', async () => {
      arm();
      const { sealSecret } = require('../../../common/crypto/secret-box.helper');
      prisma.sendingDomain.findFirst.mockResolvedValue({
        domain: 'acme.com', fromEmail: 'noreply@acme.com', fromName: 'Acme',
        dkimSelector: 'mkt1a2b', dkimPrivateSealed: sealSecret('-----BEGIN PRIVATE KEY-----\nk\n-----END PRIVATE KEY-----'),
      });
      const out = await svc.resolveFrom(WS);
      expect(out).toMatchObject({ email: 'noreply@acme.com', name: 'Acme' });
      expect(prisma.sendingDomain.findFirst.mock.calls[0][0].where).toMatchObject({ workspaceId: WS, status: 'VERIFIED' });
    });

    it('attaches DKIM signing material (opened from the sealed key) so the From-swap is authenticated', async () => {
      arm();
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

    // The platform's envelope is not authorised by the tenant's SPF, so an
    // UNSIGNED From-swap fails DMARC outright — strictly worse than sending as
    // the platform. Falling back is the safe answer, never "send it unsigned".
    it('falls back to the platform identity when it cannot sign as the tenant', async () => {
      arm();
      prisma.sendingDomain.findFirst.mockResolvedValue({
        domain: 'mail.acme.com', fromEmail: 'noreply@mail.acme.com', fromName: 'Acme',
        dkimSelector: 'mkt1a2b', dkimPrivateSealed: 'v1:not-openable',
      });
      expect(await svc.resolveFrom(WS)).toBeNull();
    });

    it('falls back when the row carries no sealed key at all', async () => {
      arm();
      prisma.sendingDomain.findFirst.mockResolvedValue({
        domain: 'mail.acme.com', fromEmail: 'noreply@mail.acme.com', fromName: 'Acme',
        dkimSelector: 'mkt1a2b', dkimPrivateSealed: null,
      });
      expect(await svc.resolveFrom(WS)).toBeNull();
    });
  });
});
