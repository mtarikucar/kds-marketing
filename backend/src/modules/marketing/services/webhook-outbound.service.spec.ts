import { WebhookOutboundService } from './webhook-outbound.service';
import {
  mockPrismaClient,
  MockPrismaClient,
} from '../../../common/test/prisma-mock.service';

const WS = 'ws-1';

function makeSvc() {
  const prisma = mockPrismaClient();
  const scheduledJob = { schedule: jest.fn().mockResolvedValue('job-1') };
  const runner = { registerHandler: jest.fn() };
  const bus = { on: jest.fn() };
  const svc = new WebhookOutboundService(prisma as any, scheduledJob as any, runner as any, bus as any);
  return { prisma, scheduledJob, runner, bus, svc };
}

const evt = (over: any = {}) => ({
  id: 'evt-1',
  type: 'marketing.lead.created.v1',
  tenantId: null,
  idempotencyKey: 'k',
  createdAt: new Date(),
  payload: { workspaceId: WS, leadId: 'lead-1' },
  ...over,
});

describe('WebhookOutboundService.fanOut', () => {
  it('creates a delivery + enqueues a job per subscribed endpoint', async () => {
    const { prisma, scheduledJob, svc } = makeSvc();
    prisma.webhookEndpoint.findMany.mockResolvedValue([
      { id: 'ep-1', events: ['marketing.lead.created.v1'] },
    ] as any);
    (prisma.webhookDelivery.create as jest.Mock).mockResolvedValue({ id: 'd1' });

    await svc.fanOut(evt() as any);

    expect(prisma.webhookDelivery.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ workspaceId: WS, endpointId: 'ep-1', eventId: 'evt-1' }) }),
    );
    expect(scheduledJob.schedule).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'webhook.deliver', payload: expect.objectContaining({ deliveryId: 'd1' }) }),
    );
  });

  it('skips endpoints not subscribed to the event type', async () => {
    const { prisma, scheduledJob, svc } = makeSvc();
    prisma.webhookEndpoint.findMany.mockResolvedValue([
      { id: 'ep-1', events: ['marketing.lead.merged.v1'] },
    ] as any);
    await svc.fanOut(evt() as any);
    expect(prisma.webhookDelivery.create).not.toHaveBeenCalled();
    expect(scheduledJob.schedule).not.toHaveBeenCalled();
  });

  it('ignores events with no workspaceId in the payload', async () => {
    const { prisma, svc } = makeSvc();
    await svc.fanOut(evt({ payload: {} }) as any);
    expect(prisma.webhookEndpoint.findMany).not.toHaveBeenCalled();
  });
});

describe('WebhookOutboundService.deliverOne', () => {
  const dp = { deliveryId: 'd1', event: { id: 'evt-1', type: 'marketing.lead.created.v1', payload: { workspaceId: WS } } };
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
  });

  it('POSTs a signed body and marks SUCCESS on 2xx', async () => {
    const { prisma, svc } = makeSvc();
    prisma.webhookDelivery.findUnique.mockResolvedValue({ id: 'd1', endpointId: 'ep-1', status: 'PENDING' } as any);
    prisma.webhookEndpoint.findUnique.mockResolvedValue({ id: 'ep-1', url: 'https://hook.test', secret: 's3cret', status: 'ACTIVE' } as any);
    (prisma.webhookDelivery.update as jest.Mock).mockResolvedValue({});
    (prisma.webhookEndpoint.update as jest.Mock).mockResolvedValue({});
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    await svc.deliverOne(dp, 0);

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://hook.test');
    expect(opts.headers['x-webhook-signature']).toMatch(/^sha256=/);
    expect((prisma.webhookDelivery.update as jest.Mock).mock.calls[0][0].data).toMatchObject({ status: 'SUCCESS', responseCode: 200 });
  });

  it('retries (throws) on a non-final failed attempt', async () => {
    const { prisma, svc } = makeSvc();
    prisma.webhookDelivery.findUnique.mockResolvedValue({ id: 'd1', endpointId: 'ep-1', status: 'PENDING' } as any);
    prisma.webhookEndpoint.findUnique.mockResolvedValue({ id: 'ep-1', url: 'https://hook.test', secret: 's', status: 'ACTIVE' } as any);
    (prisma.webhookDelivery.update as jest.Mock).mockResolvedValue({});
    fetchMock.mockResolvedValue({ ok: false, status: 500 });

    await expect(svc.deliverOne(dp, 0)).rejects.toThrow();
    expect((prisma.webhookDelivery.update as jest.Mock).mock.calls[0][0].data).toMatchObject({ attempts: 1 });
  });

  it('marks FAILED terminally on the last attempt and bumps the endpoint failure count', async () => {
    const { prisma, svc } = makeSvc();
    prisma.webhookDelivery.findUnique.mockResolvedValue({ id: 'd1', endpointId: 'ep-1', status: 'PENDING' } as any);
    prisma.webhookEndpoint.findUnique.mockResolvedValue({ id: 'ep-1', url: 'https://hook.test', secret: 's', status: 'ACTIVE' } as any);
    (prisma.webhookDelivery.update as jest.Mock).mockResolvedValue({});
    (prisma.webhookEndpoint.update as jest.Mock).mockResolvedValue({ failureCount: 3 });
    fetchMock.mockRejectedValue(new Error('timeout'));

    await svc.deliverOne(dp, 5); // next attempt = 6 = WEBHOOK_MAX_ATTEMPTS

    expect((prisma.webhookDelivery.update as jest.Mock).mock.calls[0][0].data).toMatchObject({ status: 'FAILED' });
    expect(prisma.webhookEndpoint.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { failureCount: { increment: 1 } } }),
    );
  });

  it('is a no-op when the delivery is already done', async () => {
    const { prisma, svc } = makeSvc();
    prisma.webhookDelivery.findUnique.mockResolvedValue({ id: 'd1', status: 'SUCCESS' } as any);
    await svc.deliverOne(dp, 0);
    expect(prisma.webhookEndpoint.findUnique).not.toHaveBeenCalled();
  });
});
