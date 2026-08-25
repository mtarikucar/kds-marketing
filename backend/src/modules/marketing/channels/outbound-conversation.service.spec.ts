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
        findFirst: jest.fn().mockResolvedValue(null),
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
    prisma.contactIdentity.findFirst.mockResolvedValue({ id: 'ci-9', leadId: 'someone-else' });

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

/**
 * Address canonicalisation.
 *
 * addressFor used to call normalizePhone — a lead MATCH KEY that keeps whatever
 * shape the number arrived in. NetGSM inbound writes E.164, so a thread opened
 * on "05551112233" could never be matched by the reply arriving as
 * "+905551112233": ingress found no identity and forked the customer into a
 * second "SMS contact / Unknown" lead. It is also not a valid `to` for the
 * WhatsApp Cloud API, which the adapter forwards verbatim.
 */
describe('OutboundConversationService — address form', () => {
  const WS = 'ws-1';
  const LEAD = { id: 'lead-1', phone: '0555 111 22 33', whatsapp: null, email: 'a@b.com' };
  let prisma: any;
  let sender: { send: jest.Mock };
  let svc: OutboundConversationService;

  beforeEach(() => {
    sender = { send: jest.fn().mockResolvedValue({ id: 'msg-1' }) };
    prisma = {
      channel: { findFirst: jest.fn().mockResolvedValue({ id: 'ch-1', type: 'SMS', status: 'ACTIVE' }) },
      lead: { findFirst: jest.fn().mockResolvedValue(LEAD) },
      contactIdentity: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'ci-1', leadId: 'lead-1' }),
      },
      conversation: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'conv-1' }),
      },
    };
    svc = new OutboundConversationService(prisma, sender as any);
  });

  it('stores the identity in canonical E.164, the shape ingress writes', async () => {
    await svc.start(WS, { leadId: 'lead-1', channelId: 'ch-1', text: 'hi' });

    expect(prisma.contactIdentity.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ value: '+905551112233' }) }),
    );
  });

  it('looks for an existing identity across every spelling, not just the canonical one', async () => {
    await svc.start(WS, { leadId: 'lead-1', channelId: 'ch-1', text: 'hi' });

    const where = prisma.contactIdentity.findFirst.mock.calls[0][0].where;
    // Rows written before this fix are on file as "05551112233"; an exact match
    // on "+90…" would sail past the wrong-lead guard.
    expect(where.value.in).toEqual(expect.arrayContaining(['+905551112233', '05551112233']));
  });
});

/**
 * Opt-out on the initiating path.
 *
 * Campaigns suppress opted-out leads, ConversationAiEngineService refuses to
 * auto-reply to them, and esp-feedback sets the flag on a hard bounce or spam
 * report. The one path that was NOT checking is the one whose entire purpose is
 * contacting someone who has not asked to be contacted — "find a lead's number
 * and message them".
 *
 * Whatever the İYS position on a given recipient, a lead who said stop must not
 * be messaged again.
 */
describe('OutboundConversationService — opt-out', () => {
  const WS = 'ws-1';
  let prisma: any;
  let sender: { send: jest.Mock };
  let svc: OutboundConversationService;

  const build = (lead: any, type = 'SMS') => {
    sender = { send: jest.fn().mockResolvedValue({ id: 'msg-1' }) };
    prisma = {
      channel: { findFirst: jest.fn().mockResolvedValue({ id: 'ch-1', type, status: 'ACTIVE' }) },
      lead: { findFirst: jest.fn().mockResolvedValue(lead) },
      contactIdentity: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'ci-1', leadId: 'lead-1' }),
      },
      conversation: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'conv-1' }),
      },
    };
    svc = new OutboundConversationService(prisma, sender as any);
  };

  const LEAD = {
    id: 'lead-1',
    phone: '05551112233',
    whatsapp: '05551112233',
    email: 'a@b.com',
    emailOptOut: false,
    smsOptOut: false,
    waOptOut: false,
  };

  it('refuses to open an SMS thread with a lead who opted out of SMS', async () => {
    build({ ...LEAD, smsOptOut: true });

    await expect(
      svc.start(WS, { leadId: 'lead-1', channelId: 'ch-1', text: 'ilgilenir misiniz?' }),
    ).rejects.toThrow(BadRequestException);
    expect(sender.send).not.toHaveBeenCalled();
    // Refused before any identity or thread is written, so an opted-out lead
    // does not accumulate half-built conversations.
    expect(prisma.contactIdentity.create).not.toHaveBeenCalled();
    expect(prisma.conversation.create).not.toHaveBeenCalled();
  });

  it('refuses WhatsApp on waOptOut and email on emailOptOut', async () => {
    build({ ...LEAD, waOptOut: true }, 'WHATSAPP');
    await expect(
      svc.start(WS, { leadId: 'lead-1', channelId: 'ch-1', text: 'hi' }),
    ).rejects.toThrow(BadRequestException);

    build({ ...LEAD, emailOptOut: true }, 'EMAIL');
    await expect(
      svc.start(WS, { leadId: 'lead-1', channelId: 'ch-1', text: 'hi' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('checks the flag for the channel being used, not any flag', async () => {
    // Opted out of email, contacted by SMS — a legitimate send.
    build({ ...LEAD, emailOptOut: true }, 'SMS');

    await svc.start(WS, { leadId: 'lead-1', channelId: 'ch-1', text: 'hi' });

    expect(sender.send).toHaveBeenCalled();
  });

  it('still sends to a lead with no opt-out', async () => {
    build(LEAD);

    await svc.start(WS, { leadId: 'lead-1', channelId: 'ch-1', text: 'hi' });

    expect(sender.send).toHaveBeenCalled();
  });
});

/**
 * Templates are a WhatsApp feature.
 *
 * Only whatsapp-cloud.adapter reads `template`; every other adapter
 * destructures `{ config, to, text }` and drops it. The entry guard accepts
 * "text OR template", so a template-only send on SMS or email reached the
 * adapter with text `''` — an empty message, with nothing anywhere reporting
 * that the template had been ignored.
 */
describe('OutboundConversationService — template support', () => {
  const WS = 'ws-1';
  let prisma: any;
  let sender: { send: jest.Mock };
  let svc: OutboundConversationService;

  const build = (type: string) => {
    sender = { send: jest.fn().mockResolvedValue({ id: 'msg-1' }) };
    prisma = {
      channel: { findFirst: jest.fn().mockResolvedValue({ id: 'ch-1', type, status: 'ACTIVE' }) },
      lead: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'lead-1', phone: '05551112233', whatsapp: '05551112233', email: 'a@b.com',
          emailOptOut: false, smsOptOut: false, waOptOut: false,
        }),
      },
      contactIdentity: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'ci-1', leadId: 'lead-1' }),
      },
      conversation: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'conv-1' }),
      },
    };
    svc = new OutboundConversationService(prisma, sender as any);
  };

  const TPL = { name: 'intro', language: 'tr' } as any;

  it('refuses a template-only send on SMS instead of sending an empty message', async () => {
    build('SMS');
    await expect(
      svc.start(WS, { leadId: 'lead-1', channelId: 'ch-1', template: TPL }),
    ).rejects.toThrow(BadRequestException);
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('refuses a template-only send on email too', async () => {
    build('EMAIL');
    await expect(
      svc.start(WS, { leadId: 'lead-1', channelId: 'ch-1', template: TPL }),
    ).rejects.toThrow(BadRequestException);
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('allows a template-only send on WhatsApp — the one adapter that reads it', async () => {
    build('WHATSAPP');
    await svc.start(WS, { leadId: 'lead-1', channelId: 'ch-1', template: TPL });
    expect(sender.send).toHaveBeenCalledWith(expect.objectContaining({ template: TPL }));
  });

  it('still allows text plus a template on SMS — the text is what goes out', async () => {
    build('SMS');
    await svc.start(WS, { leadId: 'lead-1', channelId: 'ch-1', text: 'merhaba', template: TPL });
    expect(sender.send).toHaveBeenCalledWith(expect.objectContaining({ text: 'merhaba' }));
  });
});

/**
 * Address hygiene on the initiating path.
 *
 * Campaigns exclude `emailBouncedAt` and `emailVerifiedStatus: 'INVALID'`,
 * ad-audience sync drops them from hashes, and the bulk email tool filters
 * them. Individual sends did not — so the one path that reaches a stranger
 * could still mail an address every other path had written off.
 *
 * esp-feedback sets emailOptOut alongside emailBouncedAt, so a hard bounce was
 * already caught by the opt-out check. INVALID is the real gap: it is written
 * independently by the hygiene check at lead create/update.
 */
describe('OutboundConversationService — email hygiene', () => {
  const WS = 'ws-1';
  let prisma: any;
  let sender: { send: jest.Mock };
  let svc: OutboundConversationService;

  const build = (lead: any, type = 'EMAIL') => {
    sender = { send: jest.fn().mockResolvedValue({ id: 'msg-1' }) };
    prisma = {
      channel: { findFirst: jest.fn().mockResolvedValue({ id: 'ch-1', type, status: 'ACTIVE' }) },
      lead: { findFirst: jest.fn().mockResolvedValue(lead) },
      contactIdentity: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'ci-1', leadId: 'lead-1' }),
      },
      conversation: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'conv-1' }),
      },
    };
    svc = new OutboundConversationService(prisma, sender as any);
  };

  const LEAD = {
    id: 'lead-1', phone: '05551112233', whatsapp: '05551112233', email: 'a@b.com',
    emailOptOut: false, smsOptOut: false, waOptOut: false,
    emailVerifiedStatus: 'VALID', emailBouncedAt: null,
  };

  it('refuses an address that failed MX verification', async () => {
    build({ ...LEAD, emailVerifiedStatus: 'INVALID' });
    await expect(
      svc.start(WS, { leadId: 'lead-1', channelId: 'ch-1', text: 'merhaba' }),
    ).rejects.toThrow(BadRequestException);
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('refuses an address that hard-bounced', async () => {
    build({ ...LEAD, emailBouncedAt: new Date() });
    await expect(
      svc.start(WS, { leadId: 'lead-1', channelId: 'ch-1', text: 'merhaba' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('does not block SMS on an unusable EMAIL address', async () => {
    // The address is dead; the phone is not. Blocking here would lose a
    // reachable lead over an unrelated channel.
    build({ ...LEAD, emailVerifiedStatus: 'INVALID' }, 'SMS');
    await svc.start(WS, { leadId: 'lead-1', channelId: 'ch-1', text: 'merhaba' });
    expect(sender.send).toHaveBeenCalled();
  });

  it('allows UNKNOWN — unverified is not the same as invalid', async () => {
    build({ ...LEAD, emailVerifiedStatus: 'UNKNOWN' });
    await svc.start(WS, { leadId: 'lead-1', channelId: 'ch-1', text: 'merhaba' });
    expect(sender.send).toHaveBeenCalled();
  });
});
