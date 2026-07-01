import { SlackService } from './slack.service';
import {
  mockPrismaClient,
} from '../../../common/test/prisma-mock.service';
import { safeFetch } from '../../../common/util/safe-fetch';

// The Slack webhook URL is workspace-supplied, so delivery MUST go through the
// SSRF-hardened fetch (not raw fetch) — a tenant can't be allowed to point it at
// cloud metadata / loopback / private nets.
jest.mock('../../../common/util/safe-fetch', () => ({
  safeFetch: jest.fn(),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));
const safeFetchMock = safeFetch as unknown as jest.Mock;

const WS = 'ws-1';

function makeSvc() {
  const prisma = mockPrismaClient();
  const bus = { on: jest.fn() };
  const svc = new SlackService(prisma as any, bus as any);
  return { prisma, bus, svc };
}

const evt = (over: any = {}) => ({
  id: 'e1', type: 'marketing.lead.created.v1', tenantId: null, idempotencyKey: 'k',
  createdAt: new Date(), payload: { workspaceId: WS, source: 'WEBSITE' }, ...over,
});

describe('SlackService.fanOut', () => {
  beforeEach(() => {
    safeFetchMock.mockReset();
    safeFetchMock.mockResolvedValue({ ok: true });
  });

  it('posts a formatted message to subscribed ACTIVE integrations via the SSRF-safe fetch', async () => {
    const { prisma, svc } = makeSvc();
    prisma.slackIntegration.findMany.mockResolvedValue([
      { id: 'i1', webhookUrl: 'https://hooks.slack.test/x', events: [] },
    ] as any);
    (prisma.slackIntegration.update as jest.Mock).mockResolvedValue({});

    await svc.fanOut(evt() as any);

    expect(safeFetchMock).toHaveBeenCalledWith(
      'https://hooks.slack.test/x',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse(safeFetchMock.mock.calls[0][1].body);
    expect(body.text).toContain('New lead created');
  });

  it('skips integrations not subscribed to the event type', async () => {
    const { prisma, svc } = makeSvc();
    prisma.slackIntegration.findMany.mockResolvedValue([
      { id: 'i1', webhookUrl: 'u', events: ['marketing.booking.created.v1'] },
    ] as any);
    await svc.fanOut(evt() as any);
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it('ignores events with no workspaceId', async () => {
    const { prisma, svc } = makeSvc();
    await svc.fanOut(evt({ payload: {} }) as any);
    expect(prisma.slackIntegration.findMany).not.toHaveBeenCalled();
  });

  it('a blocked (SSRF) webhook target fails the delivery gracefully — no crash, not marked notified', async () => {
    const { prisma, svc } = makeSvc();
    prisma.slackIntegration.findMany.mockResolvedValue([
      { id: 'i1', webhookUrl: 'http://169.254.169.254/latest/meta-data/', events: [] },
    ] as any);
    safeFetchMock.mockRejectedValue(new Error('blocked IP literal: 169.254.169.254'));

    await expect(svc.fanOut(evt() as any)).resolves.toBeUndefined();
    // Delivery failed → the row is NOT stamped lastNotifiedAt.
    expect(prisma.slackIntegration.update).not.toHaveBeenCalled();
  });
});

describe('SlackService management', () => {
  it('create masks the webhookUrl out of the response', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.slackIntegration.create as jest.Mock).mockImplementation((a: any) =>
      Promise.resolve({ id: 'i1', channel: null, events: [], status: 'ACTIVE', lastNotifiedAt: null, createdAt: new Date(), ...a.data }),
    );
    const out: any = await svc.create(WS, { webhookUrl: 'https://secret' });
    expect(out.webhookUrl).toBeUndefined();
    expect(out.id).toBe('i1');
  });
});
