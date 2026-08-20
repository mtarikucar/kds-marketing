import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { OutboundConversationService } from './outbound-conversation.service';

/**
 * Every conversation in the product used to begin with the customer: ingress
 * turned an inbound message into a lead. "Message this lead" had no path at
 * all — `jeeta.send_message` needs a conversationId, which only exists once
 * they have written first. This is the inverse.
 */
describe('OutboundConversationService', () => {
  const WS = 'ws-1';
  const LEAD = { id: 'lead-1', phone: '05551112233', whatsapp: null, email: 'a@b.com' };

  let prisma: any;
  let sender: { send: jest.Mock };
  let svc: OutboundConversationService;

  const channelOf = (type: string) => ({ id: 'ch-1', type, status: 'ACTIVE' });

  beforeEach(() => {
    sender = { send: jest.fn().mockResolvedValue({ id: 'msg-1', status: 'SENT' }) };
    prisma = {
      channel: { findFirst: jest.fn().mockResolvedValue(channelOf('SMS')) },
      lead: { findFirst: jest.fn().mockResolvedValue(LEAD) },
      contactIdentity: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'ci-1', leadId: 'lead-1' }),
      },
      conversation: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'conv-1' }),
      },
    };
    svc = new OutboundConversationService(prisma, sender as never);
  });

  it('opens a thread and sends through the normal sender', async () => {
    const out = await svc.start(WS, { leadId: 'lead-1', channelId: 'ch-1', text: 'merhaba' });

    expect(prisma.conversation.create).toHaveBeenCalled();
    // Delegated, not reimplemented: quota, adapter, Message row and spend
    // settlement all already live in MessageSenderService.
    expect(sender.send).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS, conversationId: 'conv-1', text: 'merhaba' }),
    );
    expect(out.reusedThread).toBe(false);
  });

  it('reuses an open thread instead of opening a second one', async () => {
    prisma.conversation.findFirst.mockResolvedValue({ id: 'conv-existing' });
    const out = await svc.start(WS, { leadId: 'lead-1', channelId: 'ch-1', text: 'hi' });

    expect(prisma.conversation.create).not.toHaveBeenCalled();
    expect(out.reusedThread).toBe(true);
    expect(sender.send).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-existing' }),
    );
  });

  it('refuses to send to an address that belongs to another lead', async () => {
    prisma.contactIdentity.findUnique.mockResolvedValue({ id: 'ci-9', leadId: 'someone-else' });

    await expect(
      svc.start(WS, { leadId: 'lead-1', channelId: 'ch-1', text: 'hi' }),
    ).rejects.toThrow(ConflictException);
    // The failure mode this prevents: attaching the thread to the wrong
    // customer record and messaging a person under someone else's name.
    expect(sender.send).not.toHaveBeenCalled();
  });

  it.each([
    ['INSTAGRAM', /messaged you first/i],
    ['MESSENGER', /window/i],
    ['TIKTOK', /inbound/i],
    ['WEBCHAT', /widget/i],
    ['VOICE', /inbound calls/i],
  ])('refuses %s and says why', async (type, reason) => {
    prisma.channel.findFirst.mockResolvedValue(channelOf(type));
    // These are platform limits, not missing adapters — there is no endpoint
    // that DMs an arbitrary Instagram user, so the honest answer is a refusal
    // that explains itself rather than a feature that quietly never works.
    await expect(
      svc.start(WS, { leadId: 'lead-1', channelId: 'ch-1', text: 'hi' }),
    ).rejects.toThrow(reason);
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('falls back to the plain phone for WhatsApp when no wa number is stored', async () => {
    prisma.channel.findFirst.mockResolvedValue(channelOf('WHATSAPP'));
    await svc.start(WS, { leadId: 'lead-1', channelId: 'ch-1', text: 'hi' });

    expect(prisma.contactIdentity.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ kind: 'WA' }) }),
    );
  });

  it('refuses when the lead has no address for that channel', async () => {
    prisma.channel.findFirst.mockResolvedValue(channelOf('EMAIL'));
    prisma.lead.findFirst.mockResolvedValue({ ...LEAD, email: null });

    await expect(
      svc.start(WS, { leadId: 'lead-1', channelId: 'ch-1', text: 'hi' }),
    ).rejects.toThrow(/no email address on file/i);
  });

  it('requires something to actually send', async () => {
    await expect(svc.start(WS, { leadId: 'lead-1', channelId: 'ch-1' })).rejects.toThrow(
      BadRequestException,
    );
    await expect(
      svc.start(WS, { leadId: 'lead-1', channelId: 'ch-1', text: '   ' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('scopes both the channel and the lead to the caller workspace', async () => {
    prisma.lead.findFirst.mockResolvedValue(null);
    await expect(
      svc.start(WS, { leadId: 'lead-1', channelId: 'ch-1', text: 'hi' }),
    ).rejects.toThrow(NotFoundException);

    expect(prisma.channel.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ workspaceId: WS }) }),
    );
    // Soft-deleted and merged-away leads must not be reachable either.
    expect(prisma.lead.findFirst.mock.calls[0][0].where).toMatchObject({
      workspaceId: WS,
      deletedAt: null,
      mergedIntoId: null,
    });
  });

  it('refuses a channel that is not ACTIVE', async () => {
    prisma.channel.findFirst.mockResolvedValue({ id: 'ch-1', type: 'SMS', status: 'DISABLED' });
    await expect(
      svc.start(WS, { leadId: 'lead-1', channelId: 'ch-1', text: 'hi' }),
    ).rejects.toThrow(/DISABLED/);
  });
});
