import { NetgsmDlrPollService } from './netgsm-dlr-poll.service';

/**
 * The DLR poller queries NetGSM's report API for recently-sent SMS/campaign
 * blasts that haven't resolved yet and applies the mapped terminal status. It
 * must: enumerate ACTIVE SMS channels globally (no workspace loop), split
 * legacy-flag channels onto the OLD `NetgsmReportClient` path untouched, group
 * everything else by NetGSM account (usercode) and poll via `SmsV2Client`
 * batched ≤50 jobids/call, spend one `AccountRateBudgeter` unit per report
 * CALL (denial stops only that account this tick), cover BOTH 1:1 Message rows
 * and CampaignRecipient rows, and never write anything except by row id.
 */
describe('NetgsmDlrPollService.poll', () => {
  let prisma: any;
  let registry: any;
  let legacyReport: any;
  let smsV2: any;
  let budgeter: any;
  let service: NetgsmDlrPollService;

  const activeSmsChannel = (overrides: Record<string, unknown> = {}) => ({
    id: 'ch-1',
    workspaceId: 'w1',
    type: 'SMS',
    externalId: '08508407303',
    configSealed: 'sealed',
    configPublic: null,
    ...overrides,
  });

  beforeEach(() => {
    prisma = {
      channel: { findMany: jest.fn().mockResolvedValue([]) },
      conversation: { findMany: jest.fn().mockResolvedValue([]) },
      message: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
      },
      campaignRecipient: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
        count: jest.fn().mockResolvedValue(0),
      },
      campaign: {
        findFirst: jest.fn().mockResolvedValue({ stats: {} }),
        update: jest.fn().mockResolvedValue({}),
      },
      lead: { findMany: jest.fn().mockResolvedValue([]) },
    };
    registry = { resolveConfig: jest.fn().mockReturnValue({ secrets: { usercode: 'u', password: 'p' }, public: {} }) };
    legacyReport = { fetchStatus: jest.fn() };
    smsV2 = { report: jest.fn().mockResolvedValue({ ok: true, code: '00', rows: [] }) };
    budgeter = { tryTake: jest.fn().mockReturnValue(true) };
    service = new NetgsmDlrPollService(prisma, registry, legacyReport, smsV2, budgeter);
  });

  it('does nothing when there is no ACTIVE SMS channel', async () => {
    const out = await service.poll();
    expect(out).toEqual({ polled: 0, updated: 0 });
    expect(prisma.conversation.findMany).not.toHaveBeenCalled();
    expect(smsV2.report).not.toHaveBeenCalled();
    expect(legacyReport.fetchStatus).not.toHaveBeenCalled();
  });

  it('skips a channel whose resolved config secrets are incomplete', async () => {
    prisma.channel.findMany.mockResolvedValue([activeSmsChannel()]);
    registry.resolveConfig.mockReturnValue({ secrets: {}, public: {} });

    const out = await service.poll();

    expect(out).toEqual({ polled: 0, updated: 0 });
    expect(prisma.conversation.findMany).not.toHaveBeenCalled();
  });

  describe('1:1 messages — REST v2', () => {
    beforeEach(() => {
      prisma.channel.findMany.mockResolvedValue([activeSmsChannel()]);
      registry.resolveConfig.mockReturnValue({ secrets: { usercode: 'u1', password: 'p1' }, public: {} });
      prisma.conversation.findMany.mockResolvedValue([{ id: 'cv1' }]);
    });

    it('marks a delivered (status 1) message DELIVERED, matched by jobid', async () => {
      prisma.message.findMany.mockResolvedValue([{ id: 'm1', externalMessageId: 'job-1' }]);
      smsV2.report.mockResolvedValue({
        ok: true,
        code: '00',
        rows: [{ jobid: 'job-1', telno: '905551112233', status: 1, deliveredDate: null, errorCode: null, referansId: null }],
      });

      const out = await service.poll();

      expect(smsV2.report).toHaveBeenCalledWith({ usercode: 'u1', password: 'p1' }, ['job-1']);
      expect(prisma.message.update).toHaveBeenCalledWith({
        where: { id: 'm1' },
        data: { status: 'DELIVERED', error: null },
      });
      expect(out.updated).toBe(1);
    });

    it('writes the İYS no-permission reason for v2 status 16', async () => {
      prisma.message.findMany.mockResolvedValue([{ id: 'm1', externalMessageId: 'job-1' }]);
      smsV2.report.mockResolvedValue({
        ok: true,
        code: '00',
        rows: [{ jobid: 'job-1', telno: '905551112233', status: 16, deliveredDate: null, errorCode: null, referansId: null }],
      });

      await service.poll();

      expect(prisma.message.update).toHaveBeenCalledWith({
        where: { id: 'm1' },
        data: { status: 'FAILED', error: expect.stringMatching(/İYS|IYS/i) },
      });
    });

    it('leaves an unrecognized status untouched so it is re-polled later', async () => {
      prisma.message.findMany.mockResolvedValue([{ id: 'm1', externalMessageId: 'job-1' }]);
      smsV2.report.mockResolvedValue({
        ok: true,
        code: '00',
        rows: [{ jobid: 'job-1', telno: '905551112233', status: 99, deliveredDate: null, errorCode: null, referansId: null }],
      });

      const out = await service.poll();

      expect(prisma.message.update).not.toHaveBeenCalled();
      expect(out.polled).toBe(1);
      expect(out.updated).toBe(0);
    });

    it('does not update on a still-pending (status 0) report row', async () => {
      prisma.message.findMany.mockResolvedValue([{ id: 'm1', externalMessageId: 'job-1' }]);
      smsV2.report.mockResolvedValue({
        ok: true,
        code: '00',
        rows: [{ jobid: 'job-1', telno: '905551112233', status: 0, deliveredDate: null, errorCode: null, referansId: null }],
      });

      await service.poll();
      expect(prisma.message.update).not.toHaveBeenCalled();
    });

    it('writes only by message id (a system cron must not address rows cross-tenant)', async () => {
      prisma.message.findMany.mockResolvedValue([{ id: 'm1', externalMessageId: 'job-1' }]);
      smsV2.report.mockResolvedValue({
        ok: true,
        code: '00',
        rows: [{ jobid: 'job-1', telno: '905551112233', status: 1, deliveredDate: null, errorCode: null, referansId: null }],
      });

      await service.poll();
      for (const call of prisma.message.update.mock.calls) {
        expect(Object.keys(call[0].where)).toEqual(['id']);
      }
    });

    it('ignores a report row for a jobid outside the current candidate set', async () => {
      prisma.message.findMany.mockResolvedValue([{ id: 'm1', externalMessageId: 'job-1' }]);
      smsV2.report.mockResolvedValue({
        ok: true,
        code: '00',
        rows: [{ jobid: 'unrelated-job', telno: '905551112233', status: 1, deliveredDate: null, errorCode: null, referansId: null }],
      });

      const out = await service.poll();
      expect(prisma.message.update).not.toHaveBeenCalled();
      expect(out.updated).toBe(0);
    });
  });

  describe('legacy-flag channels', () => {
    it('keep the OLD per-bulkid NetgsmReportClient path (v2 report never called)', async () => {
      prisma.channel.findMany.mockResolvedValue([activeSmsChannel({ configPublic: { useLegacySend: true } })]);
      registry.resolveConfig.mockReturnValue({
        secrets: { usercode: 'uL', password: 'pL' },
        public: { useLegacySend: true },
      });
      prisma.conversation.findMany.mockResolvedValue([{ id: 'cv1' }]);
      prisma.message.findMany.mockResolvedValue([{ id: 'm1', externalMessageId: 'bulk-1' }]);
      legacyReport.fetchStatus.mockResolvedValue({ durumcode: '1', hatakod: null });

      const out = await service.poll();

      expect(legacyReport.fetchStatus).toHaveBeenCalledWith({ usercode: 'uL', password: 'pL' }, 'bulk-1');
      expect(smsV2.report).not.toHaveBeenCalled();
      expect(prisma.message.update).toHaveBeenCalledWith({
        where: { id: 'm1' },
        data: { status: 'DELIVERED', error: null },
      });
      expect(out.updated).toBe(1);
    });

    it('shares the same per-account report budget (denied ⇒ no fetchStatus call)', async () => {
      prisma.channel.findMany.mockResolvedValue([activeSmsChannel({ configPublic: { useLegacySend: true } })]);
      registry.resolveConfig.mockReturnValue({
        secrets: { usercode: 'uL', password: 'pL' },
        public: { useLegacySend: true },
      });
      prisma.conversation.findMany.mockResolvedValue([{ id: 'cv1' }]);
      prisma.message.findMany.mockResolvedValue([{ id: 'm1', externalMessageId: 'bulk-1' }]);
      budgeter.tryTake.mockReturnValue(false);

      const out = await service.poll();

      expect(legacyReport.fetchStatus).not.toHaveBeenCalled();
      expect(out.polled).toBe(0);
    });

    it('caps its candidates query at 60 (one account-minute of budget) even when far more are eligible', async () => {
      prisma.channel.findMany.mockResolvedValue([activeSmsChannel({ configPublic: { useLegacySend: true } })]);
      registry.resolveConfig.mockReturnValue({
        secrets: { usercode: 'uL', password: 'pL' },
        public: { useLegacySend: true },
      });
      prisma.conversation.findMany.mockResolvedValue([{ id: 'cv1' }]);
      prisma.message.findMany.mockResolvedValue([]);

      await service.poll();

      expect(prisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 60 }),
      );
    });
  });

  describe('per-account budget denial', () => {
    it('stops report calls for a budget-exhausted account but keeps polling other accounts', async () => {
      const chA = activeSmsChannel({ id: 'ch-a', workspaceId: 'wa' });
      const chB = activeSmsChannel({ id: 'ch-b', workspaceId: 'wb' });
      prisma.channel.findMany.mockResolvedValue([chA, chB]);
      registry.resolveConfig.mockImplementation((ch: any) =>
        ch.id === 'ch-a'
          ? { secrets: { usercode: 'uA', password: 'pA' }, public: {} }
          : { secrets: { usercode: 'uB', password: 'pB' }, public: {} },
      );
      prisma.conversation.findMany.mockImplementation(({ where }: any) =>
        Promise.resolve(where.channelId.in.includes('ch-a') ? [{ id: 'cv-a' }] : [{ id: 'cv-b' }]),
      );
      const manyAMessages = Array.from({ length: 60 }, (_, i) => ({ id: `mA${i}`, externalMessageId: `jobA${i}` }));
      prisma.message.findMany.mockImplementation(({ where }: any) =>
        Promise.resolve(where.workspaceId.in.includes('wa') ? manyAMessages : [{ id: 'mB0', externalMessageId: 'jobB0' }]),
      );

      let uaCalls = 0;
      budgeter.tryTake.mockImplementation((usercode: string) => {
        if (usercode === 'uA') {
          uaCalls++;
          return uaCalls <= 1; // only account A's FIRST batch is allowed
        }
        return true; // account B is unaffected by A's exhaustion
      });

      await service.poll();

      // 60 jobids chunk into [50, 10]; only the first batch gets a call.
      const callsForA = smsV2.report.mock.calls.filter((c: any) => c[0].usercode === 'uA');
      expect(callsForA).toHaveLength(1);
      expect(callsForA[0][1]).toHaveLength(50);

      const callsForB = smsV2.report.mock.calls.filter((c: any) => c[0].usercode === 'uB');
      expect(callsForB).toHaveLength(1);
      expect(callsForB[0][1]).toEqual(['jobB0']);
    });
  });

  describe('campaign recipients — REST v2 attribution', () => {
    beforeEach(() => {
      prisma.channel.findMany.mockResolvedValue([activeSmsChannel({ id: 'ch-c', workspaceId: 'wc' })]);
      registry.resolveConfig.mockReturnValue({ secrets: { usercode: 'uC', password: 'pC' }, public: {} });
      prisma.conversation.findMany.mockResolvedValue([]); // no 1:1 messages this tick
    });

    it('attributes by referansId, falls back to a telno match, and TOLERATES an unmatched row (skip silently)', async () => {
      const r1 = { id: 'r1', workspaceId: 'wc', campaignId: 'camp1', leadId: 'l1', netgsmJobId: 'jobC', referansId: 'r1' };
      const r2 = { id: 'r2', workspaceId: 'wc', campaignId: 'camp1', leadId: 'l2', netgsmJobId: 'jobC', referansId: 'r2' };
      prisma.campaignRecipient.findMany.mockResolvedValue([r1, r2]);
      prisma.lead.findMany.mockResolvedValue([
        { id: 'l1', phone: '05551234567' },
        { id: 'l2', phone: '05559876543' },
      ]);
      prisma.campaign.findFirst.mockResolvedValue({ stats: { recipients: 2, sent: 2, opened: 1 } });
      prisma.campaignRecipient.count.mockImplementation(({ where }: any) =>
        Promise.resolve(where.deliveryStatus === 'DELIVERED' || where.deliveryStatus === 'FAILED' ? 1 : 0),
      );

      smsV2.report.mockResolvedValue({
        ok: true,
        code: '00',
        rows: [
          // Correct referansId → straightforward match, DELIVERED.
          { jobid: 'jobC', telno: '905551234567', status: 1, deliveredDate: '0807202612', errorCode: null, referansId: 'r1' },
          // Wrong/stale referansId, but telno matches r2's lead phone → fallback attribution, FAILED.
          { jobid: 'jobC', telno: '905559876543', status: 2, deliveredDate: null, errorCode: '105', referansId: 'no-such-recipient' },
          // Matches neither referansId nor telno of anyone in this jobid's group → skip silently.
          { jobid: 'jobC', telno: '900000000000', status: 1, deliveredDate: null, errorCode: null, referansId: 'ghost' },
        ],
      });

      const out = await service.poll();

      expect(prisma.campaignRecipient.update).toHaveBeenCalledTimes(2);
      expect(prisma.campaignRecipient.update).toHaveBeenCalledWith({
        where: { id: 'r1' },
        data: { deliveryStatus: 'DELIVERED', deliveredAt: expect.any(Date), errorCode: null },
      });
      expect(prisma.campaignRecipient.update).toHaveBeenCalledWith({
        where: { id: 'r2' },
        data: { deliveryStatus: 'FAILED', deliveredAt: expect.any(Date), errorCode: '105' },
      });
      expect(out.updated).toBe(2);

      // Stats rollup MERGES delivered/undelivered without clobbering other keys.
      expect(prisma.campaign.update).toHaveBeenCalledWith({
        where: { id: 'camp1' },
        data: { stats: { recipients: 2, sent: 2, opened: 1, delivered: 1, undelivered: 1 } },
      });
    });

    it('leaves deliveryStatus untouched (re-polled later) for a still-pending campaign report row', async () => {
      const r1 = { id: 'r1', workspaceId: 'wc', campaignId: 'camp1', leadId: 'l1', netgsmJobId: 'jobC', referansId: 'r1' };
      prisma.campaignRecipient.findMany.mockResolvedValue([r1]);
      prisma.lead.findMany.mockResolvedValue([{ id: 'l1', phone: '05551234567' }]);
      smsV2.report.mockResolvedValue({
        ok: true,
        code: '00',
        rows: [{ jobid: 'jobC', telno: '905551234567', status: 0, deliveredDate: null, errorCode: null, referansId: 'r1' }],
      });

      const out = await service.poll();

      expect(prisma.campaignRecipient.update).not.toHaveBeenCalled();
      expect(prisma.campaign.update).not.toHaveBeenCalled();
      expect(out.updated).toBe(0);
    });

    it('only queries recipients missing a delivery resolution, jobid-stamped, within the recency window', async () => {
      prisma.campaignRecipient.findMany.mockResolvedValue([]);
      await service.poll();
      expect(prisma.campaignRecipient.findMany.mock.calls[0][0].where).toEqual(
        expect.objectContaining({ deliveryStatus: null, netgsmJobId: { not: null } }),
      );
    });
  });
});
