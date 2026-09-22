import { PublicChannelResolverService } from './public-channel-resolver.service';

/**
 * This service is the ONE sanctioned cross-workspace channel read — the public
 * webhooks that reach it have no workspace context at all, only a handle the
 * provider gave them. So the interesting thing about every method here is not
 * what it returns but exactly WHICH handle it keys on, because that handle is
 * the tenant boundary. These cases lock the four shapes apart.
 */
describe('PublicChannelResolverService', () => {
  const channel = {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
  };
  const voiceCall = { findUnique: jest.fn() };
  const prisma = { channel, voiceCall } as any;
  const resolver = new PublicChannelResolverService(prisma);

  beforeEach(() => jest.clearAllMocks());

  it('routes by provider identity only among ACTIVE channels', async () => {
    channel.findFirst.mockResolvedValue({ id: 'c1' });
    await resolver.byExternalId('EMAIL', 'destek@acme.test');
    expect(channel.findFirst).toHaveBeenCalledWith({
      where: { type: 'EMAIL', externalId: 'destek@acme.test', status: 'ACTIVE' },
    });
  });

  it('answers the REGISTRATION guard blind to status, so a DISABLED row still counts as taken', async () => {
    channel.findFirst.mockResolvedValue({ id: 'c1', workspaceId: 'ws-1', status: 'DISABLED' });
    const taken = await resolver.anyByExternalId('EMAIL', 'destek@acme.test');
    expect(channel.findFirst).toHaveBeenCalledWith({
      where: { type: 'EMAIL', externalId: 'destek@acme.test' },
      select: { id: true, workspaceId: true, status: true },
    });
    expect(taken?.status).toBe('DISABLED');
  });

  describe('channelForInbound — the tokenized-URL lookup', () => {
    it('keys on the channel id alone, which is what makes the URL the tenant boundary', async () => {
      channel.findUnique.mockResolvedValue({ id: 'chan-1', workspaceId: 'ws-1', type: 'EMAIL' });
      const row = await resolver.channelForInbound('chan-1');
      expect(channel.findUnique).toHaveBeenCalledWith({ where: { id: 'chan-1' } });
      expect(row?.workspaceId).toBe('ws-1');
    });

    it('does not filter type or status — the caller decides how to answer those', async () => {
      // Both the SMS MO route and the inbound-mail route ACK an empty result for
      // a disabled or wrong-type channel rather than 404ing, so a relay does not
      // retry something we will never accept. Filtering here would make that
      // indistinguishable from "no such channel".
      channel.findUnique.mockResolvedValue({ id: 'chan-1', type: 'SMS', status: 'DISABLED' });
      const row = await resolver.channelForInbound('chan-1');
      expect(row).toMatchObject({ type: 'SMS', status: 'DISABLED' });
      expect(channel.findUnique).toHaveBeenCalledWith({ where: { id: 'chan-1' } });
    });

    it('returns null for an id nobody registered', async () => {
      channel.findUnique.mockResolvedValue(null);
      expect(await resolver.channelForInbound('nope')).toBeNull();
    });
  });

  it('scopes a voice lookup through the call row rather than trusting the CallSid alone', async () => {
    voiceCall.findUnique.mockResolvedValue({ channelId: 'c1', workspaceId: 'ws-1' });
    channel.findFirst.mockResolvedValue({ id: 'c1' });
    await resolver.channelForVoiceCall('CA123');
    expect(channel.findFirst).toHaveBeenCalledWith({ where: { id: 'c1', workspaceId: 'ws-1' } });
  });

  it('returns null for an unknown CallSid without touching the channel table', async () => {
    voiceCall.findUnique.mockResolvedValue(null);
    expect(await resolver.channelForVoiceCall('CA-unknown')).toBeNull();
    expect(channel.findFirst).not.toHaveBeenCalled();
  });
});
