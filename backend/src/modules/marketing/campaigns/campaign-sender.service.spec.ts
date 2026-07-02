import { CampaignSenderService } from './campaign-sender.service';

/**
 * The batch sender: it re-checks opt-out at send time (the audience froze
 * earlier), sends the rest, and completes the campaign when no PENDING
 * recipients remain.
 */
describe('CampaignSenderService.batch', () => {
  const WS = 'ws-1';
  let prisma: any;
  let email: { sendPlainEmail: jest.Mock; sendCampaignEmail: jest.Mock };
  let scheduledJobs: { schedule: jest.Mock };
  let svc: CampaignSenderService;

  beforeEach(() => {
    prisma = {
      campaign: {
        findFirst: jest.fn().mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'SENDING', channel: 'EMAIL', subject: 'S', body: 'Hi', links: [] }),
        findUnique: jest.fn().mockResolvedValue({ stats: {} }),
        update: jest.fn().mockResolvedValue({}),
      },
      campaignRecipient: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'r1', leadId: 'l1', token: 't1' },
          { id: 'r2', leadId: 'l2', token: 't2' },
        ]),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      campaignVariant: {
        findMany: jest.fn().mockResolvedValue([]), // no A/B variants by default
        update: jest.fn().mockResolvedValue({}),
      },
      lead: {
        findFirst: jest.fn().mockImplementation(async ({ where }: any) =>
          where.id === 'l1'
            ? { id: 'l1', email: 'opt@out.com', emailOptOut: true }
            : { id: 'l2', email: 'ok@lead.com', emailOptOut: false },
        ),
      },
    };
    email = { sendPlainEmail: jest.fn().mockResolvedValue(true), sendCampaignEmail: jest.fn().mockResolvedValue(true) };
    // A base URL is required now — the sender refuses to send without one (the
    // unsubscribe link is mandatory and built from PUBLIC_BASE_URL).
    const config = { get: jest.fn().mockReturnValue('https://m.test') };
    scheduledJobs = { schedule: jest.fn() };
    const runner = { registerHandler: jest.fn() };
    const registry = { get: jest.fn(), resolveConfig: jest.fn() };
    const quota = { reserve: jest.fn(), refund: jest.fn() };
    // Inert by default: no ESP transport → platform-default From (null).
    const sendingDomains = { resolveFrom: jest.fn().mockResolvedValue(null) };
    svc = new CampaignSenderService(
      prisma as any, config as any, email as any, scheduledJobs as any, runner as any, registry as any, quota as any, sendingDomains as any,
    );
  });

  it('skips opted-out recipients, sends the rest, and completes the campaign', async () => {
    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    // Only the opted-in lead got an email.
    expect(email.sendPlainEmail).toHaveBeenCalledTimes(1);
    expect(email.sendPlainEmail).toHaveBeenCalledWith('ok@lead.com', 'S', expect.any(String), undefined);

    const statuses = prisma.campaignRecipient.update.mock.calls.map((c: any) => c[0].data.status);
    expect(statuses).toContain('SKIPPED'); // the opted-out one
    expect(statuses).toContain('SENT'); // the opted-in one

    // No PENDING left → campaign marked SENT.
    const finalUpdate = prisma.campaign.update.mock.calls.find((c: any) => c[0].data.status === 'SENT');
    expect(finalUpdate).toBeTruthy();
  });

  // The audience freezes at send-start, but a throttled campaign sends over
  // minutes/hours. A lead bulk-deleted (deletedAt) or merged (mergedIntoId)
  // AFTER the freeze must not still receive the message — bulk-delete means
  // "stop contacting", and a merged tombstone would double-send to the merge
  // target's same address. The per-recipient lead load must apply the active-
  // lead predicate so the DB excludes such a lead (→ SKIPPED).
  it('does NOT send to a lead soft-deleted/merged after the audience froze', async () => {
    prisma.lead.findFirst.mockImplementation(async ({ where }: any) => {
      if (where.id === 'l1') return { id: 'l1', email: 'ok@lead.com', emailOptOut: false };
      // l2 was deleted mid-campaign: a query filtering deletedAt:null won't return it.
      return where.deletedAt === null ? null : { id: 'l2', email: 'gone@lead.com', emailOptOut: false };
    });

    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    // Only the still-active lead is emailed; the deleted one is skipped.
    expect(email.sendPlainEmail).toHaveBeenCalledTimes(1);
    expect(email.sendPlainEmail).toHaveBeenCalledWith('ok@lead.com', 'S', expect.any(String), undefined);
    const statuses = prisma.campaignRecipient.update.mock.calls.map((c: any) => c[0].data.status);
    expect(statuses).toContain('SKIPPED');
  });

  it('does nothing for a campaign that is not SENDING', async () => {
    prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'PAUSED' });
    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });
    expect(prisma.campaignRecipient.findMany).not.toHaveBeenCalled();
  });

  it('atomically claims each recipient (PENDING→SENDING) before processing it', async () => {
    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });
    expect(prisma.campaignRecipient.updateMany).toHaveBeenCalledWith({
      where: { id: 'r1', workspaceId: WS, status: 'PENDING' },
      data: { status: 'SENDING' },
    });
  });

  it('does NOT send a recipient already claimed by a concurrent (reaped) batch', async () => {
    // Both leads opted-in, but our claim loses the race for the second recipient.
    prisma.lead.findFirst.mockResolvedValue({ id: 'x', email: 'a@b.com', emailOptOut: false });
    prisma.campaignRecipient.updateMany
      .mockResolvedValueOnce({ count: 0 }) // reclaim pass (no stranded SENDING rows)
      .mockResolvedValueOnce({ count: 1 }) // r1 — we claimed it
      .mockResolvedValueOnce({ count: 0 }); // r2 — a concurrent run already took it

    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    expect(email.sendPlainEmail).toHaveBeenCalledTimes(1); // only the one we claimed
  });

  it('reclaims recipients stranded in SENDING by a crashed prior batch before sending', async () => {
    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });
    // A SENDING→PENDING sweep runs first so a crash between claim and mark
    // doesn't silently drop the recipient (the batch only selects PENDING).
    expect(prisma.campaignRecipient.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: WS, campaignId: 'c1', status: 'SENDING' },
      data: { status: 'PENDING' },
    });
  });

  it('recomputes campaign stats from recipient counts (no lost update under concurrency)', async () => {
    prisma.campaignRecipient.groupBy.mockResolvedValue([
      { status: 'SENT', _count: { _all: 3 } },
      { status: 'FAILED', _count: { _all: 1 } },
      { status: 'SKIPPED', _count: { _all: 2 } },
    ]);

    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    const statsUpdate = prisma.campaign.update.mock.calls.find((c: any) => c[0].data.stats);
    expect(statsUpdate[0].data.stats).toEqual(
      expect.objectContaining({ sent: 3, failed: 1, skipped: 2 }),
    );
  });

  it('recomputes opened/clicked/unsubscribed from recipient rows, not the stale stats blob', async () => {
    // Snapshot the recompute reads. The tracker's atomic jsonb_set bump() has since
    // advanced the true engagement counts; the old `...s` spread re-wrote these
    // stale values, clobbering a concurrent open/click/unsubscribe (lost-update).
    prisma.campaign.findUnique.mockResolvedValue({
      stats: { recipients: 10, opened: 5, clicked: 2, unsubscribed: 1 },
      abEnabled: false,
    });
    prisma.campaignRecipient.groupBy.mockResolvedValue([
      { status: 'SENT', _count: { _all: 3 } },
      { status: 'FAILED', _count: { _all: 1 } },
      { status: 'SKIPPED', _count: { _all: 2 } },
      { status: 'UNSUBSCRIBED', _count: { _all: 4 } },
    ]);
    // Authoritative engagement from the recipient openedAt/clickedAt timestamps.
    prisma.campaignRecipient.count.mockImplementation(async ({ where }: any) =>
      where?.openedAt ? 6 : where?.clickedAt ? 3 : 0,
    );

    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    const statsUpdate = prisma.campaign.update.mock.calls.find((c: any) => c[0].data.stats);
    // Engagement is derived from rows (6/3/4), NOT carried from the stale blob
    // (5/2/1); the static launch-time `recipients` total is preserved.
    expect(statsUpdate[0].data.stats).toEqual({
      recipients: 10,
      sent: 3,
      failed: 1,
      skipped: 2,
      opened: 6,
      clicked: 3,
      unsubscribed: 4,
    });
  });

  describe('A/B WINNER mode', () => {
    it('does NOT mark a campaign SENT while HOLD recipients await the winner', async () => {
      prisma.campaignRecipient.findMany.mockResolvedValue([]); // test cohort all sent → no PENDING
      prisma.campaignRecipient.count.mockResolvedValue(8); // but 8 remainder are HELD
      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });
      expect(prisma.campaign.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'SENT' }) }));
    });

    it('does NOT mark SENT when the LAST PENDING batch drains but HOLD recipients remain', async () => {
      // The real completion path (not the empty-batch shortcut above): a batch
      // PROCESSES the last test-cohort recipient (recipients.length > 0), draining
      // PENDING to 0 — but the A/B WINNER remainder is still HELD. The campaign must
      // stay SENDING so the later ab.decide job can release + send the remainder;
      // marking it SENT here strands the held-back majority forever.
      prisma.campaignRecipient.findMany.mockResolvedValue([{ id: 'r2', leadId: 'l2', token: 't2' }]);
      prisma.campaignRecipient.count.mockImplementation(async ({ where }: any) =>
        where.status === 'HOLD' ? 8 : 0,
      );
      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });
      expect(prisma.campaign.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'SENT' }) }),
      );
    });

    it('picks the variant with most opens, releases the remainder to it, and kicks the batch', async () => {
      prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'SENDING', abWinnerKey: null, abWinnerMetric: 'OPEN' });
      prisma.campaignVariant.findMany.mockResolvedValue([
        { key: 'A', stats: { opened: 5 } },
        { key: 'B', stats: { opened: 12 } }, // winner
      ]);
      prisma.campaign.updateMany = jest.fn().mockResolvedValue({ count: 1 });
      await (svc as any).decideAbWinner({ payload: { workspaceId: WS, campaignId: 'c1' } });
      // claims the winner atomically (only the first decider)
      expect(prisma.campaign.updateMany.mock.calls[0][0]).toMatchObject({ where: { abWinnerKey: null, status: 'SENDING' }, data: { abWinnerKey: 'B' } });
      // releases the HELD remainder to the winning variant
      const release = prisma.campaignRecipient.updateMany.mock.calls.find((c: any) => c[0].where.status === 'HOLD');
      expect(release[0].data).toEqual({ status: 'PENDING', variantKey: 'B' });
      // and kicks the send batch
      expect(scheduledJobs.schedule.mock.calls.some((c: any) => c[0].kind === 'campaign.batch')).toBe(true);
    });

    it('does nothing if the winner was already decided (concurrent decide)', async () => {
      prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'SENDING', abWinnerKey: 'A', abWinnerMetric: 'OPEN' });
      await (svc as any).decideAbWinner({ payload: { workspaceId: WS, campaignId: 'c1' } });
      expect(prisma.campaignVariant.findMany).not.toHaveBeenCalled();
    });
  });
});
