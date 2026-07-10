import { BadRequestException, ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { AutocallDialerService, AUTOCALL_STREAM_KIND } from './autocall-dialer.service';
import { mockPrismaClient } from '../../../common/test/prisma-mock.service';

const WS = 'ws-1';
const USER = 'rep-1';

function makeSvc() {
  const prisma = mockPrismaClient();
  const config = { get: jest.fn().mockReturnValue('https://hub.example.com') };
  const registry = { resolveConfig: jest.fn() };
  const scheduledJobs = { schedule: jest.fn().mockResolvedValue('job-1') };
  const runner = { registerHandler: jest.fn() };
  const autocall = {
    addAutocall: jest.fn(),
    addNumber: jest.fn(),
    deleteNumber: jest.fn(),
    updateListStatus: jest.fn(),
    reportAutocall: jest.fn(),
  };
  const iysClient = { search: jest.fn() };
  const budgeter = { tryTake: jest.fn().mockReturnValue(true) };
  const svc = new AutocallDialerService(
    prisma as any, config as any, registry as any, scheduledJobs as any, runner as any,
    autocall as any, iysClient as any, budgeter as any,
  );
  return { prisma, config, registry, scheduledJobs, runner, autocall, iysClient, budgeter, svc };
}

const ACTIVE_SMS_CHANNEL = { id: 'ch-1', workspaceId: WS, type: 'SMS', status: 'ACTIVE' };

function resolvedConfig(brandCode = 'BR1') {
  return { secrets: { usercode: 'acctcode', password: 'secretpw' }, public: { brandCode } };
}

describe('AutocallDialerService', () => {
  describe('onModuleInit', () => {
    it('registers the autocall.stream ScheduledJob handler', () => {
      const { svc, runner } = makeSvc();
      svc.onModuleInit();
      expect(runner.registerHandler).toHaveBeenCalledWith(AUTOCALL_STREAM_KIND, expect.any(Function));
    });
  });

  describe('start', () => {
    beforeEach(() => {
      process.env.MARKETING_SECRET_KEY = Buffer.from('k'.repeat(32)).toString('base64');
    });
    afterEach(() => {
      delete process.env.MARKETING_SECRET_KEY;
    });

    it('rejects when an ACTIVE session already exists for the workspace', async () => {
      const { prisma, svc } = makeSvc();
      (prisma.autocallSession.findFirst as jest.Mock).mockResolvedValue({ id: 'sess-1' });
      await expect(svc.start(WS, USER, 'MANAGER', { queueName: 'q1' } as any)).rejects.toBeInstanceOf(ConflictException);
    });

    it('fails closed when no ACTIVE SMS channel/creds are resolvable', async () => {
      const { prisma, svc } = makeSvc();
      (prisma.autocallSession.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.channel.findFirst as jest.Mock).mockResolvedValue(null);
      await expect(svc.start(WS, USER, 'MANAGER', { queueName: 'q1' } as any)).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('fails closed for a TİCARİ session with no İYS brandCode configured', async () => {
      const { prisma, registry, svc } = makeSvc();
      (prisma.autocallSession.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.channel.findFirst as jest.Mock).mockResolvedValue(ACTIVE_SMS_CHANNEL);
      registry.resolveConfig.mockReturnValue(resolvedConfig(''));
      await expect(
        svc.start(WS, USER, 'MANAGER', { queueName: 'q1', iysMessageType: 'TICARI' } as any),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('rejects when no callable leads match the filter', async () => {
      const { prisma, registry, svc } = makeSvc();
      (prisma.autocallSession.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.channel.findFirst as jest.Mock).mockResolvedValue(ACTIVE_SMS_CHANNEL);
      registry.resolveConfig.mockReturnValue(resolvedConfig());
      (prisma.lead.findMany as jest.Mock).mockResolvedValue([]);
      await expect(
        svc.start(WS, USER, 'MANAGER', { queueName: 'q1', iysMessageType: 'BILGILENDIRME' } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('BİLGİLENDİRME: excludes smsOptOut leads (DNC), streams the rest, creates the list + session + items, starts it, schedules the first tick', async () => {
      const { prisma, registry, autocall, scheduledJobs, svc } = makeSvc();
      (prisma.autocallSession.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.channel.findFirst as jest.Mock).mockResolvedValue(ACTIVE_SMS_CHANNEL);
      registry.resolveConfig.mockReturnValue(resolvedConfig());
      (prisma.lead.findMany as jest.Mock).mockResolvedValue([
        { id: 'l1', phone: '905551110001', smsOptOut: false },
        { id: 'l2', phone: '905551110002', smsOptOut: true }, // DNC — excluded
      ]);
      autocall.addAutocall.mockResolvedValue({ ok: true, code: '00', jobId: 'job-1', listId: 'job-1', message: null, retriable: false });
      autocall.updateListStatus.mockResolvedValue({ ok: true, code: '00', message: null, retriable: false });
      (prisma.autocallSession.create as jest.Mock).mockResolvedValue({ id: 'sess-1' });
      (prisma.autocallSession.findFirst as jest.Mock).mockResolvedValueOnce(null).mockResolvedValue({ id: 'sess-1', status: 'ACTIVE', queueName: 'q1', netgsmListId: 'job-1', total: 2 });
      (prisma.autocallSessionItem.count as jest.Mock).mockResolvedValue(0);

      const out = await svc.start(WS, USER, 'MANAGER', { queueName: 'q1', iysMessageType: 'BILGILENDIRME' } as any);

      // addAutocall carries destination_type=queue + iysfilter='0' (BİLGİLENDİRME)
      const addArgs = autocall.addAutocall.mock.calls[0][1];
      expect(addArgs).toMatchObject({ destinationType: 'queue', queueName: 'q1', iysfilter: '0' });
      expect(typeof addArgs.url).toBe('string');
      expect(addArgs.url).toContain('/autocall-report');
      expect(addArgs.url).toContain('ws-1');

      // session + items created — l2 (opted-out) is SKIPPED_DNC, l1 is PENDING
      const createArgs = (prisma.autocallSession.create as jest.Mock).mock.calls[0][0];
      expect(createArgs.data).toMatchObject({ workspaceId: WS, startedByUserId: USER, status: 'ACTIVE', netgsmListId: 'job-1', queueName: 'q1', total: 2 });
      const items = createArgs.data.items.create;
      expect(items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ leadId: 'l1', status: 'PENDING' }),
          expect.objectContaining({ leadId: 'l2', status: 'SKIPPED_DNC' }),
        ]),
      );

      // started + first tick scheduled
      expect(autocall.updateListStatus).toHaveBeenCalledWith(expect.anything(), 'job-1', 'start');
      expect(scheduledJobs.schedule).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: WS, kind: AUTOCALL_STREAM_KIND, dedupKey: 'sess-1' }),
      );
      expect(out).toMatchObject({ id: 'sess-1', status: 'ACTIVE' });
    });

    it('TİCARİ: hard-blocks İYS RET/YOK leads (SKIPPED_IYS), only streams ONAY', async () => {
      const { prisma, registry, autocall, iysClient, svc } = makeSvc();
      (prisma.autocallSession.findFirst as jest.Mock).mockResolvedValueOnce(null);
      (prisma.channel.findFirst as jest.Mock).mockResolvedValue(ACTIVE_SMS_CHANNEL);
      registry.resolveConfig.mockReturnValue(resolvedConfig('BR1'));
      (prisma.lead.findMany as jest.Mock).mockResolvedValue([
        { id: 'l1', phone: '905551110001', smsOptOut: false }, // ONAY
        { id: 'l2', phone: '905551110002', smsOptOut: false }, // RET
      ]);
      iysClient.search.mockImplementation(async (_creds: any, phone: string) =>
        phone === '905551110001' ? { ok: true, status: 'ONAY', message: null } : { ok: true, status: 'RET', message: null },
      );
      autocall.addAutocall.mockResolvedValue({ ok: true, code: '00', jobId: 'job-2', listId: 'job-2', message: null, retriable: false });
      autocall.updateListStatus.mockResolvedValue({ ok: true, code: '00', message: null, retriable: false });
      (prisma.autocallSession.create as jest.Mock).mockResolvedValue({ id: 'sess-2' });
      (prisma.autocallSession.findFirst as jest.Mock).mockResolvedValue({ id: 'sess-2', status: 'ACTIVE', queueName: 'q1', netgsmListId: 'job-2', total: 2 });
      (prisma.autocallSessionItem.count as jest.Mock).mockResolvedValue(0);

      await svc.start(WS, USER, 'MANAGER', { queueName: 'q1', iysMessageType: 'TICARI' } as any);

      const createArgs = (prisma.autocallSession.create as jest.Mock).mock.calls[0][0];
      const items = createArgs.data.items.create;
      expect(items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ leadId: 'l1', status: 'PENDING' }),
          expect.objectContaining({ leadId: 'l2', status: 'SKIPPED_IYS' }),
        ]),
      );
      const addArgs = autocall.addAutocall.mock.calls[0][1];
      expect(addArgs).toMatchObject({ iysfilter: '11', brandcode: 'BR1' });
    });

    it('rejects when EVERY candidate is filtered out (all DNC/İYS-blocked) — never creates a NetGSM list', async () => {
      const { prisma, registry, autocall, iysClient, svc } = makeSvc();
      (prisma.autocallSession.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.channel.findFirst as jest.Mock).mockResolvedValue(ACTIVE_SMS_CHANNEL);
      registry.resolveConfig.mockReturnValue(resolvedConfig('BR1'));
      (prisma.lead.findMany as jest.Mock).mockResolvedValue([{ id: 'l1', phone: '905551110001', smsOptOut: false }]);
      iysClient.search.mockResolvedValue({ ok: true, status: 'RET', message: null });

      await expect(
        svc.start(WS, USER, 'MANAGER', { queueName: 'q1', iysMessageType: 'TICARI' } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(autocall.addAutocall).not.toHaveBeenCalled();
    });

    it('surfaces NetGSM addAutocall failure as a BadRequestException (e.g. add-on not enabled)', async () => {
      const { prisma, registry, autocall, svc } = makeSvc();
      (prisma.autocallSession.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.channel.findFirst as jest.Mock).mockResolvedValue(ACTIVE_SMS_CHANNEL);
      registry.resolveConfig.mockReturnValue(resolvedConfig());
      (prisma.lead.findMany as jest.Mock).mockResolvedValue([{ id: 'l1', phone: '905551110001', smsOptOut: false }]);
      autocall.addAutocall.mockResolvedValue({ ok: false, code: '60', jobId: null, listId: null, message: 'no package', retriable: false });

      await expect(
        svc.start(WS, USER, 'MANAGER', { queueName: 'q1', iysMessageType: 'BILGILENDIRME' } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.autocallSession.create).not.toHaveBeenCalled();
    });

    it('a REP is clamped to their own assigned leads', async () => {
      const { prisma, registry, autocall, svc } = makeSvc();
      (prisma.autocallSession.findFirst as jest.Mock).mockResolvedValueOnce(null); // the "existing ACTIVE?" check
      (prisma.channel.findFirst as jest.Mock).mockResolvedValue(ACTIVE_SMS_CHANNEL);
      registry.resolveConfig.mockReturnValue(resolvedConfig());
      (prisma.lead.findMany as jest.Mock).mockResolvedValue([{ id: 'l1', phone: '905551110001', smsOptOut: false }]);
      autocall.addAutocall.mockResolvedValue({ ok: true, code: '00', jobId: 'job-3', listId: 'job-3', message: null, retriable: false });
      autocall.updateListStatus.mockResolvedValue({ ok: true, code: '00', message: null, retriable: false });
      (prisma.autocallSession.create as jest.Mock).mockResolvedValue({ id: 'sess-3' });
      (prisma.autocallSession.findFirst as jest.Mock).mockResolvedValue({ id: 'sess-3', status: 'ACTIVE', queueName: 'q1', netgsmListId: 'job-3', total: 1 }); // getSession() re-read
      (prisma.autocallSessionItem.count as jest.Mock).mockResolvedValue(0);

      await svc.start(WS, USER, 'REP', { queueName: 'q1', iysMessageType: 'BILGILENDIRME', assignedToId: 'someone-else' } as any);

      expect((prisma.lead.findMany as jest.Mock).mock.calls[0][0].where.assignedToId).toBe(USER);
    });
  });

  describe('stop', () => {
    it('404s a session that does not exist', async () => {
      const { prisma, svc } = makeSvc();
      (prisma.autocallSession.findFirst as jest.Mock).mockResolvedValue(null);
      await expect(svc.stop(WS, 'sess-x', USER)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('is idempotent — stopping an already-STOPPED session is a no-op read (no NetGSM call)', async () => {
      const { prisma, autocall, svc } = makeSvc();
      (prisma.autocallSession.findFirst as jest.Mock)
        .mockResolvedValueOnce({ id: 'sess-1', status: 'STOPPED', netgsmListId: 'job-1' })
        .mockResolvedValueOnce({ id: 'sess-1', status: 'STOPPED', queueName: 'q1', netgsmListId: 'job-1', total: 1 });
      (prisma.autocallSession.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
      (prisma.autocallSessionItem.count as jest.Mock).mockResolvedValue(0);

      const out = await svc.stop(WS, 'sess-1', USER);
      expect(out.status).toBe('STOPPED');
      expect(autocall.updateListStatus).not.toHaveBeenCalled();
    });

    it('flips status STOPPED and calls updateListStatus(stop) — app-side state wins even if that call fails', async () => {
      const { prisma, registry, autocall, svc } = makeSvc();
      (prisma.autocallSession.findFirst as jest.Mock)
        .mockResolvedValueOnce({ id: 'sess-1', status: 'ACTIVE', netgsmListId: 'job-1' })
        .mockResolvedValueOnce({ id: 'sess-1', status: 'STOPPED', queueName: 'q1', netgsmListId: 'job-1', total: 1 });
      (prisma.autocallSession.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.channel.findFirst as jest.Mock).mockResolvedValue(ACTIVE_SMS_CHANNEL);
      registry.resolveConfig.mockReturnValue(resolvedConfig());
      autocall.updateListStatus.mockResolvedValue({ ok: false, code: '70', message: 'boom', retriable: false });
      (prisma.autocallSessionItem.count as jest.Mock).mockResolvedValue(0);

      const out = await svc.stop(WS, 'sess-1', USER);

      expect(autocall.updateListStatus).toHaveBeenCalledWith(expect.anything(), 'job-1', 'stop');
      const updateArgs = (prisma.autocallSession.updateMany as jest.Mock).mock.calls[0][0];
      expect(updateArgs).toMatchObject({ where: { id: 'sess-1', workspaceId: WS, status: 'ACTIVE' }, data: { status: 'STOPPED' } });
      expect(out.status).toBe('STOPPED'); // reflects app-side state regardless of the NetGSM call's own success
    });
  });

  describe('streamTick (private, invoked as a ScheduledJob handler)', () => {
    it('does nothing for a session that is gone/not ACTIVE (no addNumber calls, no reschedule)', async () => {
      const { prisma, autocall, scheduledJobs, svc } = makeSvc();
      (prisma.autocallSession.findFirst as jest.Mock).mockResolvedValue({ id: 'sess-1', status: 'STOPPED' });
      await (svc as any).streamTick({ payload: { workspaceId: WS, sessionId: 'sess-1' } });
      expect(autocall.addNumber).not.toHaveBeenCalled();
      expect(scheduledJobs.schedule).not.toHaveBeenCalled();
    });

    it('streams PENDING items via addNumber, marks ADDED, and reschedules while items remain', async () => {
      const { prisma, registry, autocall, scheduledJobs, svc } = makeSvc();
      (prisma.autocallSession.findFirst as jest.Mock).mockResolvedValue({ id: 'sess-1', status: 'ACTIVE', netgsmListId: 'job-1' });
      (prisma.channel.findFirst as jest.Mock).mockResolvedValue(ACTIVE_SMS_CHANNEL);
      registry.resolveConfig.mockReturnValue(resolvedConfig());
      (prisma.autocallSessionItem.findMany as jest.Mock).mockResolvedValue([
        { id: 'it-1', phone: '905551110001' },
        { id: 'it-2', phone: '905551110002' },
      ]);
      autocall.addNumber.mockResolvedValue({ ok: true, code: '00', message: null, retriable: false });
      (prisma.autocallSessionItem.count as jest.Mock).mockResolvedValue(3); // items still remain PENDING

      await (svc as any).streamTick({ payload: { workspaceId: WS, sessionId: 'sess-1' } });

      expect(autocall.addNumber).toHaveBeenCalledTimes(2);
      expect(autocall.addNumber).toHaveBeenCalledWith(expect.anything(), 'job-1', '905551110001');
      const updateCalls = (prisma.autocallSessionItem.update as jest.Mock).mock.calls;
      expect(updateCalls).toEqual(
        expect.arrayContaining([
          [{ where: { id: 'it-1' }, data: { status: 'ADDED' } }],
          [{ where: { id: 'it-2' }, data: { status: 'ADDED' } }],
        ]),
      );
      expect(scheduledJobs.schedule).toHaveBeenCalledWith(expect.objectContaining({ dedupKey: 'sess-1' }));
    });

    it('stops the tick early on a retriable (budget-denied) addNumber, leaving that item PENDING', async () => {
      const { prisma, registry, autocall, svc } = makeSvc();
      (prisma.autocallSession.findFirst as jest.Mock).mockResolvedValue({ id: 'sess-1', status: 'ACTIVE', netgsmListId: 'job-1' });
      (prisma.channel.findFirst as jest.Mock).mockResolvedValue(ACTIVE_SMS_CHANNEL);
      registry.resolveConfig.mockReturnValue(resolvedConfig());
      (prisma.autocallSessionItem.findMany as jest.Mock).mockResolvedValue([
        { id: 'it-1', phone: '905551110001' },
        { id: 'it-2', phone: '905551110002' },
      ]);
      autocall.addNumber.mockResolvedValue({ ok: false, code: null, message: 'rate limit', retriable: true });
      (prisma.autocallSessionItem.count as jest.Mock).mockResolvedValue(2);

      await (svc as any).streamTick({ payload: { workspaceId: WS, sessionId: 'sess-1' } });

      expect(autocall.addNumber).toHaveBeenCalledTimes(1); // stopped after the first retriable denial
      expect(prisma.autocallSessionItem.update).not.toHaveBeenCalled(); // neither item touched
    });

    it('marks a hard (non-retriable) addNumber failure FAILED and keeps going', async () => {
      const { prisma, registry, autocall, svc } = makeSvc();
      (prisma.autocallSession.findFirst as jest.Mock).mockResolvedValue({ id: 'sess-1', status: 'ACTIVE', netgsmListId: 'job-1' });
      (prisma.channel.findFirst as jest.Mock).mockResolvedValue(ACTIVE_SMS_CHANNEL);
      registry.resolveConfig.mockReturnValue(resolvedConfig());
      (prisma.autocallSessionItem.findMany as jest.Mock).mockResolvedValue([{ id: 'it-1', phone: '905551110001' }]);
      autocall.addNumber.mockResolvedValue({ ok: false, code: '70', message: 'bad number', retriable: false });
      (prisma.autocallSessionItem.count as jest.Mock).mockResolvedValue(0);

      await (svc as any).streamTick({ payload: { workspaceId: WS, sessionId: 'sess-1' } });

      expect(prisma.autocallSessionItem.update).toHaveBeenCalledWith({ where: { id: 'it-1' }, data: { status: 'FAILED' } });
    });

    it('does NOT reschedule once no PENDING items remain', async () => {
      const { prisma, registry, autocall, scheduledJobs, svc } = makeSvc();
      (prisma.autocallSession.findFirst as jest.Mock).mockResolvedValue({ id: 'sess-1', status: 'ACTIVE', netgsmListId: 'job-1' });
      (prisma.channel.findFirst as jest.Mock).mockResolvedValue(ACTIVE_SMS_CHANNEL);
      registry.resolveConfig.mockReturnValue(resolvedConfig());
      (prisma.autocallSessionItem.findMany as jest.Mock).mockResolvedValue([{ id: 'it-1', phone: '905551110001' }]);
      autocall.addNumber.mockResolvedValue({ ok: true, code: '00', message: null, retriable: false });
      (prisma.autocallSessionItem.count as jest.Mock).mockResolvedValue(0);

      await (svc as any).streamTick({ payload: { workspaceId: WS, sessionId: 'sess-1' } });

      expect(scheduledJobs.schedule).not.toHaveBeenCalled();
    });

    it('warns and reschedules when no NetGSM creds are resolvable this tick (self-heals)', async () => {
      const { prisma, autocall, scheduledJobs, svc } = makeSvc();
      (prisma.autocallSession.findFirst as jest.Mock).mockResolvedValue({ id: 'sess-1', status: 'ACTIVE', netgsmListId: 'job-1' });
      (prisma.channel.findFirst as jest.Mock).mockResolvedValue(null);

      await (svc as any).streamTick({ payload: { workspaceId: WS, sessionId: 'sess-1' } });

      expect(autocall.addNumber).not.toHaveBeenCalled();
      expect(scheduledJobs.schedule).toHaveBeenCalledWith(expect.objectContaining({ dedupKey: 'sess-1' }));
    });
  });
});
