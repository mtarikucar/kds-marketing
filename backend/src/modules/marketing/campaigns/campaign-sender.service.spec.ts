import { CampaignSenderService } from './campaign-sender.service';

/**
 * The batch sender: it re-checks opt-out at send time (the audience froze
 * earlier), sends the rest, and completes the campaign when no PENDING
 * recipients remain.
 */
describe('CampaignSenderService.batch', () => {
  const WS = 'ws-1';
  let prisma: any;
  let email: { sendPlainEmail: jest.Mock };
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
        count: jest.fn().mockResolvedValue(0),
      },
      lead: {
        findFirst: jest.fn().mockImplementation(async ({ where }: any) =>
          where.id === 'l1'
            ? { id: 'l1', email: 'opt@out.com', emailOptOut: true }
            : { id: 'l2', email: 'ok@lead.com', emailOptOut: false },
        ),
      },
    };
    email = { sendPlainEmail: jest.fn().mockResolvedValue(true) };
    const config = { get: jest.fn().mockReturnValue('') };
    const scheduledJobs = { schedule: jest.fn() };
    const runner = { registerHandler: jest.fn() };
    const registry = { get: jest.fn(), resolveConfig: jest.fn() };
    const quota = { reserve: jest.fn(), refund: jest.fn() };
    svc = new CampaignSenderService(
      prisma as any, config as any, email as any, scheduledJobs as any, runner as any, registry as any, quota as any,
    );
  });

  it('skips opted-out recipients, sends the rest, and completes the campaign', async () => {
    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    // Only the opted-in lead got an email.
    expect(email.sendPlainEmail).toHaveBeenCalledTimes(1);
    expect(email.sendPlainEmail).toHaveBeenCalledWith('ok@lead.com', 'S', expect.any(String));

    const statuses = prisma.campaignRecipient.update.mock.calls.map((c: any) => c[0].data.status);
    expect(statuses).toContain('SKIPPED'); // the opted-out one
    expect(statuses).toContain('SENT'); // the opted-in one

    // No PENDING left → campaign marked SENT.
    const finalUpdate = prisma.campaign.update.mock.calls.find((c: any) => c[0].data.status === 'SENT');
    expect(finalUpdate).toBeTruthy();
  });

  it('does nothing for a campaign that is not SENDING', async () => {
    prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'PAUSED' });
    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });
    expect(prisma.campaignRecipient.findMany).not.toHaveBeenCalled();
  });
});
