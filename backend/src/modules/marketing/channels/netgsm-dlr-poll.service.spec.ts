import { NetgsmDlrPollService } from './netgsm-dlr-poll.service';

/**
 * The DLR poller queries NetGSM's report API for recently-sent SMS that are
 * still SENT and applies the mapped terminal status. It must: only touch ACTIVE
 * SMS channels, write per-message by id (so a system cron can't cross tenants),
 * leave pending/unknown reports untouched, and respect NetGSM's report rate cap.
 */
describe('NetgsmDlrPollService.poll', () => {
  let prisma: any;
  let registry: any;
  let reportClient: any;
  let service: NetgsmDlrPollService;

  const smsChannel = {
    id: 'ch-sms',
    workspaceId: 'w1',
    type: 'SMS',
    status: 'ACTIVE',
    configSealed: 'sealed',
    configPublic: null,
    externalId: '08508407303',
  };

  beforeEach(() => {
    prisma = {
      workspace: { findMany: jest.fn().mockResolvedValue([{ id: 'w1' }]) },
      channel: { findMany: jest.fn().mockResolvedValue([smsChannel]) },
      conversation: {
        findMany: jest.fn().mockResolvedValue([{ id: 'cv1', channelId: 'ch-sms' }]),
      },
      message: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'm1', workspaceId: 'w1', conversationId: 'cv1', externalMessageId: 'bulk-1', status: 'SENT' },
          { id: 'm2', workspaceId: 'w1', conversationId: 'cv1', externalMessageId: 'bulk-2', status: 'SENT' },
        ]),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    registry = { resolveConfig: jest.fn().mockReturnValue({ secrets: { usercode: 'u', password: 'p' } }) };
    reportClient = { fetchStatus: jest.fn() };
    service = new NetgsmDlrPollService(prisma, registry, reportClient);
  });

  it('marks delivered DELIVERED and failed FAILED, leaving pending as SENT', async () => {
    reportClient.fetchStatus
      .mockResolvedValueOnce({ durumcode: '1', hatakod: null }) // m1 delivered
      .mockResolvedValueOnce({ durumcode: '2', hatakod: '7' }); // m2 failed

    const out = await service.poll();

    expect(reportClient.fetchStatus).toHaveBeenCalledTimes(2);
    expect(prisma.message.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { status: 'DELIVERED', error: null },
    });
    expect(prisma.message.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'm2' }, data: expect.objectContaining({ status: 'FAILED' }) }),
    );
    expect(out.updated).toBe(2);
  });

  it('does NOT update a still-pending (durum 0) message', async () => {
    reportClient.fetchStatus.mockResolvedValue({ durumcode: '0', hatakod: null });
    const out = await service.poll();
    expect(prisma.message.update).not.toHaveBeenCalled();
    expect(out.updated).toBe(0);
  });

  it('skips a message when the report has no data yet (client returns null)', async () => {
    reportClient.fetchStatus.mockResolvedValue(null);
    await service.poll();
    expect(prisma.message.update).not.toHaveBeenCalled();
  });

  it('respects the per-tick report rate cap', async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      id: `m${i}`,
      workspaceId: 'w1',
      conversationId: 'cv1',
      externalMessageId: `b${i}`,
      status: 'SENT',
    }));
    prisma.message.findMany.mockResolvedValue(many);
    reportClient.fetchStatus.mockResolvedValue({ durumcode: '1', hatakod: null });

    await service.poll();

    expect(reportClient.fetchStatus.mock.calls.length).toBeLessThanOrEqual(10);
  });

  it('does nothing when the workspace has no active SMS channel', async () => {
    prisma.channel.findMany.mockResolvedValue([]);
    await service.poll();
    expect(prisma.message.findMany).not.toHaveBeenCalled();
    expect(reportClient.fetchStatus).not.toHaveBeenCalled();
  });

  it('writes only by message id (a system cron must not address rows cross-tenant)', async () => {
    reportClient.fetchStatus.mockResolvedValue({ durumcode: '1', hatakod: null });
    await service.poll();
    for (const call of prisma.message.update.mock.calls) {
      expect(Object.keys(call[0].where)).toEqual(['id']);
    }
  });

  it('scopes every candidate query by workspaceId', async () => {
    reportClient.fetchStatus.mockResolvedValue({ durumcode: '0', hatakod: null });
    await service.poll();
    expect(prisma.channel.findMany.mock.calls[0][0].where).toEqual(
      expect.objectContaining({ workspaceId: 'w1', type: 'SMS', status: 'ACTIVE' }),
    );
    expect(prisma.message.findMany.mock.calls[0][0].where).toEqual(
      expect.objectContaining({ workspaceId: 'w1' }),
    );
  });
});
