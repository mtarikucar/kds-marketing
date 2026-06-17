import { UnauthorizedException } from '@nestjs/common';
import { NetgsmPublicController } from './netgsm-public.controller';
import { netgsmMoToken } from '../channels/netgsm-callback.util';

/**
 * Inbound MO route: NetGSM posts a customer's SMS reply to
 * /public/channels/netgsm/:channelId/:token/mo. The token (HMAC of channelId)
 * authenticates the call since NetGSM doesn't sign; a valid call resolves the
 * SMS channel, parses the reply, and funnels it through ConversationIngress.
 */
describe('NetgsmPublicController — MO inbound', () => {
  const KEY = Buffer.alloc(32, 7).toString('base64');
  let resolver: any;
  let registry: any;
  let ingress: any;
  let adapter: any;
  let controller: NetgsmPublicController;

  const channel = {
    id: 'chan-1',
    workspaceId: 'w1',
    type: 'SMS',
    status: 'ACTIVE',
    externalId: '08508407303',
    configSealed: null,
    configPublic: null,
  };

  beforeEach(() => {
    process.env.MARKETING_SECRET_KEY = KEY;
    adapter = {
      parseInbound: jest.fn().mockReturnValue([
        {
          externalUserId: '+905331234567',
          kind: 'PHONE',
          externalMessageId: 'netgsm-mo:10',
          text: 'merhaba',
          raw: {},
        },
      ]),
    };
    resolver = {
      channelForInbound: jest.fn().mockResolvedValue(channel),
      markDeliveryStatus: jest.fn(),
    };
    registry = {
      has: jest.fn().mockReturnValue(true),
      get: jest.fn().mockReturnValue(adapter),
      resolveConfig: jest.fn().mockReturnValue({
        channelId: 'chan-1',
        workspaceId: 'w1',
        type: 'SMS',
        externalId: '08508407303',
        secrets: {},
        public: {},
      }),
    };
    ingress = { ingest: jest.fn().mockResolvedValue({ messageId: 'm1' }) };
    controller = new NetgsmPublicController(resolver, registry, ingress);
  });

  afterEach(() => {
    delete process.env.MARKETING_SECRET_KEY;
  });

  it('ingests an inbound reply when the token is valid', async () => {
    const token = netgsmMoToken('chan-1');

    const res = await controller.mo('chan-1', token, {
      ceptel: '5331234567',
      mesaj: 'merhaba',
      gorevid: '10',
    });

    expect(res).toEqual({ ok: true, received: 1 });
    expect(resolver.channelForInbound).toHaveBeenCalledWith('chan-1');
    expect(ingress.ingest).toHaveBeenCalledWith(
      { id: 'chan-1', workspaceId: 'w1', type: 'SMS' },
      expect.objectContaining({ externalMessageId: 'netgsm-mo:10', text: 'merhaba' }),
    );
  });

  it('rejects an invalid token with 401 and never resolves or ingests', async () => {
    await expect(
      controller.mo('chan-1', 'bad-token', { ceptel: '533', mesaj: 'x' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(resolver.channelForInbound).not.toHaveBeenCalled();
    expect(ingress.ingest).not.toHaveBeenCalled();
  });

  it('acks with received:0 for an unknown or non-SMS channel without ingesting', async () => {
    resolver.channelForInbound.mockResolvedValue(null);
    const token = netgsmMoToken('chan-1');

    const res = await controller.mo('chan-1', token, { ceptel: '533', mesaj: 'x' });

    expect(res).toEqual({ ok: true, received: 0 });
    expect(ingress.ingest).not.toHaveBeenCalled();
  });

  it('acks with received:0 for a DISABLED channel without ingesting', async () => {
    resolver.channelForInbound.mockResolvedValue({ ...channel, status: 'DISABLED' });
    const token = netgsmMoToken('chan-1');

    const res = await controller.mo('chan-1', token, { ceptel: '533', mesaj: 'x' });

    expect(res).toEqual({ ok: true, received: 0 });
    expect(ingress.ingest).not.toHaveBeenCalled();
  });

  it('treats the legacy /dlr push as a no-op — NetGSM reports are polled, not pushed', async () => {
    const res = await controller.dlr([
      { jobid: '100001', status: '2' },
      { jobid: '100002', status: '1' },
    ]);

    // The unauthenticated push handler must NEVER touch delivery status: doing so
    // let an attacker flip any tenant's outbound Message.status by guessing the
    // low-entropy NetGSM job ids. Delivery comes from the polled report instead.
    expect(resolver.markDeliveryStatus).not.toHaveBeenCalled();
    expect(res.updated).toBe(0);
  });
});
