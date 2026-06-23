jest.mock('../../../common/util/safe-fetch', () => {
  class SsrfBlockedError extends Error {}
  return { safeFetch: jest.fn(), SsrfBlockedError };
});

import { AuditService } from './audit.service';
import { safeFetch, SsrfBlockedError } from '../../../common/util/safe-fetch';
import { ServiceUnavailableException, BadRequestException } from '@nestjs/common';

const safeFetchMock = safeFetch as unknown as jest.Mock;

describe('AuditService', () => {
  const WS = 'ws-1';
  let prisma: any;
  let scheduledJob: { schedule: jest.Mock };
  let leads: { create: jest.Mock };
  let runnerHandler: (job: any) => Promise<void>;
  let svc: AuditService;
  const realKey = process.env.PAGESPEED_API_KEY;

  beforeEach(() => {
    safeFetchMock.mockReset();
    delete process.env.PAGESPEED_API_KEY;
    prisma = {
      prospectAudit: {
        create: jest.fn().mockImplementation(async ({ data }: any) => ({ id: 'aud1', publicToken: data.publicToken, ...data })),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      lead: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    scheduledJob = { schedule: jest.fn().mockResolvedValue('job1') };
    leads = { create: jest.fn().mockResolvedValue({ id: 'lead1' }) };
    const runner = {
      registerHandler: (_kind: string, fn: any) => {
        runnerHandler = fn;
      },
    };
    svc = new AuditService(prisma as any, scheduledJob as any, runner as any, leads as any);
    svc.onModuleInit();
  });

  afterAll(() => {
    if (realKey === undefined) delete process.env.PAGESPEED_API_KEY;
    else process.env.PAGESPEED_API_KEY = realKey;
  });

  describe('request (inert gate)', () => {
    it('is inert without PAGESPEED_API_KEY (503, no row, no job)', async () => {
      await expect(svc.request(WS, { targetUrl: 'acme.example' })).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(prisma.prospectAudit.create).not.toHaveBeenCalled();
      expect(scheduledJob.schedule).not.toHaveBeenCalled();
    });

    it('creates the audit + schedules a scan when configured', async () => {
      process.env.PAGESPEED_API_KEY = 'psi-key';
      const out = await svc.request(WS, { targetUrl: 'acme.example', businessName: 'Acme' });
      // bare host is normalised to an https URL
      expect(prisma.prospectAudit.create.mock.calls[0][0].data.targetUrl).toBe('https://acme.example/');
      expect(prisma.prospectAudit.create.mock.calls[0][0].data.workspaceId).toBe(WS);
      expect(scheduledJob.schedule.mock.calls[0][0]).toMatchObject({ workspaceId: WS, kind: 'prospect.audit.scan' });
      expect(out.reportPath).toMatch(/^\/api\/public\/audits\/pa_/);
    });

    it('rejects a non-http(s) target', async () => {
      process.env.PAGESPEED_API_KEY = 'psi-key';
      await expect(svc.request(WS, { targetUrl: 'javascript:alert(1)' })).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('runScan', () => {
    const job = { id: 'j1', workspaceId: WS, kind: 'prospect.audit.scan', payload: { auditId: 'aud1' }, attempts: 0 };

    it('grades on-page checks and finishes DONE (PSI skipped without a key)', async () => {
      prisma.prospectAudit.findFirst.mockResolvedValue({ id: 'aud1', workspaceId: WS, targetUrl: 'https://acme.example/', status: 'PENDING' });
      safeFetchMock.mockResolvedValue({
        url: 'https://acme.example/',
        ok: true,
        text: async () => '<title>Acme Coffee Roasters Izmir</title><meta name="viewport" content="x"><h1>Hi</h1>',
      });
      await runnerHandler(job);
      // exactly one fetch (the site) — no PSI call without a key
      expect(safeFetchMock).toHaveBeenCalledTimes(1);
      const finish = prisma.prospectAudit.updateMany.mock.calls.at(-1)[0];
      expect(finish.data.status).toBe('DONE');
      expect(typeof finish.data.score).toBe('number');
      expect(finish.data.sections.some((s: any) => s.status === 'skipped')).toBe(true);
    });

    it('marks FAILED when the prospect site is unreachable / SSRF-blocked', async () => {
      prisma.prospectAudit.findFirst.mockResolvedValue({ id: 'aud1', workspaceId: WS, targetUrl: 'https://internal/', status: 'PENDING' });
      safeFetchMock.mockRejectedValue(new SsrfBlockedError('blocked'));
      await runnerHandler(job);
      const finish = prisma.prospectAudit.updateMany.mock.calls.at(-1)[0];
      expect(finish.data.status).toBe('FAILED');
      expect(finish.data.error).toMatch(/disallowed or internal/i);
    });

    it('folds PageSpeed sections in when a key is configured (bounded read + parse)', async () => {
      process.env.PAGESPEED_API_KEY = 'psi-key';
      prisma.prospectAudit.findFirst.mockResolvedValue({ id: 'aud1', workspaceId: WS, targetUrl: 'https://acme.example/', status: 'PENDING' });
      safeFetchMock
        .mockResolvedValueOnce({ url: 'https://acme.example/', ok: true, text: async () => '<title>Acme Coffee Roasters</title><h1>Hi</h1>' })
        .mockResolvedValueOnce({ url: '', ok: true, text: async () => JSON.stringify({ lighthouseResult: { categories: { performance: { score: 0.5 }, seo: { score: 0.9 } } } }) });
      await runnerHandler(job);
      expect(safeFetchMock).toHaveBeenCalledTimes(2);
      // the PSI request carries the encoded target + the key, to the PSI endpoint
      expect(String(safeFetchMock.mock.calls[1][0])).toMatch(/pagespeedonline.*url=https%3A%2F%2Facme.example%2F.*key=psi-key/);
      const finish = prisma.prospectAudit.updateMany.mock.calls.at(-1)[0];
      expect(finish.data.status).toBe('DONE');
      expect(finish.data.sections.some((s: any) => s.key === 'performance' && s.score === 50)).toBe(true);
    });

    it('is idempotent — a re-dispatched job for a finished audit is a no-op', async () => {
      prisma.prospectAudit.findFirst.mockResolvedValue({ id: 'aud1', workspaceId: WS, targetUrl: 'https://acme.example/', status: 'DONE' });
      await runnerHandler(job);
      expect(safeFetchMock).not.toHaveBeenCalled();
      expect(prisma.prospectAudit.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('readCapped (bounded streaming — the real prod path)', () => {
    it('truncates a real ReadableStream body at the cap and stops reading', async () => {
      const out = await (svc as any).readCapped(new Response('x'.repeat(50)), 10);
      expect(out).toBe('x'.repeat(10));
    });
    it('returns the whole body when it is under the cap', async () => {
      expect(await (svc as any).readCapped(new Response('hello'), 100)).toBe('hello');
    });
  });

  describe('convertToLead', () => {
    it('creates a lead and stamps the audit idempotently', async () => {
      prisma.prospectAudit.findFirst.mockResolvedValue({ id: 'aud1', workspaceId: WS, targetUrl: 'https://acme.example/', businessName: 'Acme', score: 73, convertedLeadId: null });
      prisma.prospectAudit.updateMany.mockResolvedValue({ count: 1 });
      const out = await svc.convertToLead(WS, 'aud1', 'u1', 'MANAGER');
      expect(leads.create).toHaveBeenCalledWith(WS, expect.objectContaining({ businessName: 'Acme', source: 'WEBSITE' }), 'u1', 'MANAGER');
      expect(prisma.prospectAudit.updateMany.mock.calls[0][0].where).toMatchObject({ id: 'aud1', workspaceId: WS, convertedLeadId: null });
      expect(out).toEqual({ leadId: 'lead1', alreadyConverted: false });
    });

    it('returns the existing lead without creating a second one (already converted)', async () => {
      prisma.prospectAudit.findFirst.mockResolvedValue({ id: 'aud1', workspaceId: WS, targetUrl: 'https://acme.example/', convertedLeadId: 'lead-existing' });
      const out = await svc.convertToLead(WS, 'aud1', 'u1', 'MANAGER');
      expect(leads.create).not.toHaveBeenCalled();
      expect(out).toEqual({ leadId: 'lead-existing', alreadyConverted: true });
    });

    it('on a lost claim never creates a lead (no orphaned lead.created event) and adopts the winner', async () => {
      prisma.prospectAudit.findFirst
        .mockResolvedValueOnce({ id: 'aud1', workspaceId: WS, targetUrl: 'https://acme.example/', businessName: 'Acme', convertedLeadId: null })
        .mockResolvedValueOnce({ convertedLeadId: 'lead-winner' });
      prisma.prospectAudit.updateMany.mockResolvedValue({ count: 0 }); // a concurrent convert won the claim
      const out = await svc.convertToLead(WS, 'aud1', 'u1', 'MANAGER');
      // the whole point of claim-first: the loser must NOT create a lead at all
      expect(leads.create).not.toHaveBeenCalled();
      expect(prisma.lead.deleteMany).not.toHaveBeenCalled();
      expect(out).toEqual({ leadId: 'lead-winner', alreadyConverted: true });
    });

    it('self-heals a STALE pending sentinel (crashed mid-convert) so the audit converts again', async () => {
      const stale = `pending:${Date.now() - 10 * 60 * 1000}:deadbeef`;
      prisma.prospectAudit.findFirst.mockResolvedValue({ id: 'aud1', workspaceId: WS, targetUrl: 'https://acme.example/', businessName: 'Acme', convertedLeadId: stale });
      prisma.prospectAudit.updateMany.mockResolvedValue({ count: 1 });
      const out = await svc.convertToLead(WS, 'aud1', 'u1', 'MANAGER');
      // first updateMany releases the stale sentinel back to null
      expect(prisma.prospectAudit.updateMany.mock.calls[0][0]).toMatchObject({ where: { convertedLeadId: stale }, data: { convertedLeadId: null } });
      expect(leads.create).toHaveBeenCalled();
      expect(out.alreadyConverted).toBe(false);
    });

    it('does NOT double-convert while a FRESH claim is in flight', async () => {
      const fresh = `pending:${Date.now()}:abc`;
      prisma.prospectAudit.findFirst
        .mockResolvedValueOnce({ id: 'aud1', workspaceId: WS, targetUrl: 'https://acme.example/', convertedLeadId: fresh })
        .mockResolvedValueOnce({ convertedLeadId: null });
      prisma.prospectAudit.updateMany.mockResolvedValue({ count: 0 }); // the null-row claim finds nothing (row holds the fresh sentinel)
      const out = await svc.convertToLead(WS, 'aud1', 'u1', 'MANAGER');
      expect(leads.create).not.toHaveBeenCalled();
      expect(out).toEqual({ leadId: null, alreadyConverted: true });
    });

    it('claims the audit BEFORE creating the lead (sentinel-first ordering)', async () => {
      prisma.prospectAudit.findFirst.mockResolvedValue({ id: 'aud1', workspaceId: WS, targetUrl: 'https://acme.example/', businessName: 'Acme', convertedLeadId: null });
      prisma.prospectAudit.updateMany.mockResolvedValue({ count: 1 });
      const order: string[] = [];
      prisma.prospectAudit.updateMany.mockImplementation(async (args: any) => {
        order.push(typeof args.data.convertedLeadId === 'string' && args.data.convertedLeadId.startsWith('pending:') ? 'claim' : 'stamp');
        return { count: 1 };
      });
      leads.create.mockImplementation(async () => {
        order.push('create');
        return { id: 'lead1' };
      });
      await svc.convertToLead(WS, 'aud1', 'u1', 'MANAGER');
      expect(order).toEqual(['claim', 'create', 'stamp']);
    });
  });
});
