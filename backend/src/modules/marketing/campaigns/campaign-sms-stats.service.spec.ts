import { CampaignSmsStatsService } from './campaign-sms-stats.service';

/**
 * The stats reconciler pulls NetGSM's per-jobid `/sms/rest/v2/stats` rollup
 * for every SMS campaign still SENDING (or SENT within the lookback window)
 * that has stamped jobids, spending one AccountRateBudgeter slot PER JOBID
 * (not a shared per-account budget like the DLR poller's `report` calls). A
 * denied jobid keeps its last-known rollup; the whole `stats.sms` block is
 * re-derived every tick from every jobid's latest known snapshot so a
 * partial-budget tick never double-counts. The write always merges under
 * `stats.sms`, preserving every other key in the `stats` blob.
 */
describe('CampaignSmsStatsService.reconcile', () => {
  let prisma: any;
  let registry: any;
  let smsV2: any;
  let budgeter: any;
  let service: CampaignSmsStatsService;

  const smsCampaign = (overrides: Record<string, unknown> = {}) => ({
    id: 'camp1',
    workspaceId: 'w1',
    status: 'SENT',
    completedAt: new Date(),
    netgsmJobIds: ['job-1'],
    stats: {},
    ...overrides,
  });

  const activeSmsChannel = (overrides: Record<string, unknown> = {}) => ({
    id: 'ch-1',
    workspaceId: 'w1',
    type: 'SMS',
    status: 'ACTIVE',
    configSealed: 'sealed',
    configPublic: null,
    ...overrides,
  });

  beforeEach(() => {
    prisma = {
      campaign: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
      },
      channel: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    registry = { resolveConfig: jest.fn().mockReturnValue({ secrets: {}, public: {} }) };
    smsV2 = { stats: jest.fn().mockResolvedValue({ ok: true, code: '00', rows: [] }) };
    budgeter = { tryTake: jest.fn().mockReturnValue(true) };
    service = new CampaignSmsStatsService(prisma, registry, smsV2, budgeter);
  });

  it('does nothing when there are no candidate campaigns', async () => {
    const out = await service.reconcile();
    expect(out).toEqual({ scanned: 0, updated: 0 });
    expect(prisma.channel.findFirst).not.toHaveBeenCalled();
    expect(smsV2.stats).not.toHaveBeenCalled();
  });

  it('queries the DB scoped to SMS channel, SENDING|SENT status', async () => {
    await service.reconcile();
    expect(prisma.campaign.findMany.mock.calls[0][0].where).toEqual(
      expect.objectContaining({ channel: 'SMS', status: { in: ['SENDING', 'SENT'] } }),
    );
  });

  it('skips a campaign with no netgsmJobIds (or an empty array)', async () => {
    prisma.campaign.findMany.mockResolvedValue([
      smsCampaign({ id: 'a', netgsmJobIds: null }),
      smsCampaign({ id: 'b', netgsmJobIds: [] }),
    ]);
    const out = await service.reconcile();
    expect(out).toEqual({ scanned: 0, updated: 0 });
    expect(prisma.channel.findFirst).not.toHaveBeenCalled();
  });

  it('skips a campaign whose workspace has no active SMS channel (or incomplete secrets)', async () => {
    prisma.campaign.findMany.mockResolvedValue([smsCampaign()]);
    prisma.channel.findFirst.mockResolvedValue(null);
    const out = await service.reconcile();
    expect(out).toEqual({ scanned: 1, updated: 0 });
    expect(smsV2.stats).not.toHaveBeenCalled();

    prisma.channel.findFirst.mockResolvedValue(activeSmsChannel());
    registry.resolveConfig.mockReturnValue({ secrets: { usercode: 'u1' }, public: {} }); // no password
    const out2 = await service.reconcile();
    expect(out2.updated).toBe(0);
    expect(smsV2.stats).not.toHaveBeenCalled();
  });

  describe('happy path', () => {
    beforeEach(() => {
      prisma.channel.findFirst.mockResolvedValue(activeSmsChannel());
      registry.resolveConfig.mockReturnValue({ secrets: { usercode: 'u1', password: 'p1' }, public: {} });
    });

    it('queries stats for each jobid and merges the rollup under stats.sms, preserving other stats keys', async () => {
      prisma.campaign.findMany.mockResolvedValue([
        smsCampaign({ stats: { recipients: 10, sent: 10 } }),
      ]);
      smsV2.stats.mockResolvedValue({
        ok: true,
        code: '00',
        rows: [
          { status: 'delivered', count: 8 },
          { status: 'undelivered', count: 1 },
          { status: 'blacklist', count: 1 },
        ],
      });

      const out = await service.reconcile();

      expect(smsV2.stats).toHaveBeenCalledWith({ usercode: 'u1', password: 'p1' }, 'job-1');
      expect(prisma.campaign.update).toHaveBeenCalledWith({
        where: { id: 'camp1' },
        data: {
          stats: {
            recipients: 10,
            sent: 10,
            sms: {
              delivered: 8,
              undelivered: 1,
              blacklist: 1,
              jobs: { 'job-1': { delivered: 8, undelivered: 1, blacklist: 1 } },
            },
          },
        },
      });
      expect(out.updated).toBe(1);
    });

    it('spends ONE budget unit per jobid keyed stats:<jobid> with a 10-min window, not the shared report budget', async () => {
      prisma.campaign.findMany.mockResolvedValue([smsCampaign({ netgsmJobIds: ['job-1', 'job-2'] })]);
      await service.reconcile();
      expect(budgeter.tryTake).toHaveBeenCalledWith('u1', 'stats:job-1', 1, 600_000);
      expect(budgeter.tryTake).toHaveBeenCalledWith('u1', 'stats:job-2', 1, 600_000);
    });

    it('a budget-denied jobid is skipped this tick and keeps its prior stored rollup', async () => {
      prisma.campaign.findMany.mockResolvedValue([
        smsCampaign({
          netgsmJobIds: ['job-1', 'job-2'],
          stats: { sms: { delivered: 5, jobs: { 'job-1': { delivered: 5 } } } },
        }),
      ]);
      budgeter.tryTake.mockImplementation((_u: string, bucket: string) => bucket !== 'stats:job-1'); // job-1 denied, job-2 allowed
      smsV2.stats.mockResolvedValue({ ok: true, code: '00', rows: [{ status: 'delivered', count: 3 }] });

      await service.reconcile();

      // job-1's report() is never called (denied); job-2's rollup is added on top
      // of job-1's carried-over snapshot — total across both, no double-count.
      expect(smsV2.stats).toHaveBeenCalledTimes(1);
      expect(smsV2.stats).toHaveBeenCalledWith({ usercode: 'u1', password: 'p1' }, 'job-2');
      expect(prisma.campaign.update).toHaveBeenCalledWith({
        where: { id: 'camp1' },
        data: {
          stats: {
            sms: {
              delivered: 8, // 5 (carried job-1) + 3 (fresh job-2)
              jobs: { 'job-1': { delivered: 5 }, 'job-2': { delivered: 3 } },
            },
          },
        },
      });
    });

    it('writes nothing when every jobid is budget-denied this tick', async () => {
      prisma.campaign.findMany.mockResolvedValue([smsCampaign()]);
      budgeter.tryTake.mockReturnValue(false);

      const out = await service.reconcile();

      expect(smsV2.stats).not.toHaveBeenCalled();
      expect(prisma.campaign.update).not.toHaveBeenCalled();
      expect(out.updated).toBe(0);
    });

    it('re-querying the SAME jobid on a later tick REPLACES (not adds to) its stored snapshot', async () => {
      prisma.campaign.findMany.mockResolvedValue([
        smsCampaign({ stats: { sms: { delivered: 5, jobs: { 'job-1': { delivered: 5 } } } } }),
      ]);
      smsV2.stats.mockResolvedValue({ ok: true, code: '00', rows: [{ status: 'delivered', count: 9 }] });

      await service.reconcile();

      expect(prisma.campaign.update).toHaveBeenCalledWith({
        where: { id: 'camp1' },
        data: { stats: { sms: { delivered: 9, jobs: { 'job-1': { delivered: 9 } } } } },
      });
    });

    it('a non-ok stats() result for a jobid leaves its prior snapshot untouched', async () => {
      prisma.campaign.findMany.mockResolvedValue([
        smsCampaign({ stats: { sms: { delivered: 5, jobs: { 'job-1': { delivered: 5 } } } } }),
      ]);
      smsV2.stats.mockResolvedValue({ ok: false, code: '70', rows: [] });

      const out = await service.reconcile();

      expect(prisma.campaign.update).not.toHaveBeenCalled();
      expect(out.updated).toBe(0);
    });

    it('resolves the workspace SMS channel at most once per tick across several campaigns in the same workspace', async () => {
      prisma.campaign.findMany.mockResolvedValue([
        smsCampaign({ id: 'a', netgsmJobIds: ['job-a'] }),
        smsCampaign({ id: 'b', netgsmJobIds: ['job-b'] }),
      ]);
      await service.reconcile();
      expect(prisma.channel.findFirst).toHaveBeenCalledTimes(1);
    });
  });
});
