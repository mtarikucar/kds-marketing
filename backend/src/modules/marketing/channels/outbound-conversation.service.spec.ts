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
  let suppression: { check: jest.Mock };

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
        // Reopening a closed thread is now part of start(); `status` is
        // non-null on the real row, so every fixture below states it.
        update: jest.fn().mockResolvedValue({}),
      },
    };
    suppression = { check: jest.fn().mockResolvedValue({ suppressed: false }) };
    svc = new OutboundConversationService(prisma, sender as never, suppression as never);
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
    prisma.conversation.findFirst.mockResolvedValue({ id: 'conv-existing', status: 'OPEN' });
    const out = await svc.start(WS, { leadId: 'lead-1', channelId: 'ch-1', text: 'hi' });

    expect(prisma.conversation.create).not.toHaveBeenCalled();
    expect(out.reusedThread).toBe(true);
    expect(sender.send).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-existing' }),
    );
  });

  /**
   * A CLOSED thread is a finished conversation, not a forbidden one.
   *
   * The reuse query asked for `status: 'OPEN'` only, so writing to a person
   * whose one thread on that channel had been closed forked a SECOND
   * conversation on the same (channel, identity) pair — which the inbox then
   * renders as the same button twice, and inbound mail keeps landing in
   * whichever one the ingress matcher picks. Reopening the newest closed one
   * keeps one thread per identity, which is what every other reader assumes.
   */
  describe('one thread per identity, open or not', () => {
    it('reopens the newest closed thread rather than forking a second one', async () => {
      prisma.conversation.update = jest.fn().mockResolvedValue({ id: 'conv-closed' });
      prisma.conversation.findFirst.mockResolvedValue({ id: 'conv-closed', status: 'CLOSED' });

      const out = await svc.start(WS, { leadId: 'lead-1', channelId: 'ch-1', text: 'hi' });

      expect(prisma.conversation.create).not.toHaveBeenCalled();
      expect(prisma.conversation.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'conv-closed' },
          data: expect.objectContaining({ status: 'OPEN' }),
        }),
      );
      expect(out.reusedThread).toBe(true);
      expect(sender.send).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'conv-closed' }),
      );
    });

    it('does not rewrite the status of a thread that is already open', async () => {
      prisma.conversation.update = jest.fn();
      prisma.conversation.findFirst.mockResolvedValue({ id: 'conv-open', status: 'OPEN' });

      await svc.start(WS, { leadId: 'lead-1', channelId: 'ch-1', text: 'hi' });

      expect(prisma.conversation.update).not.toHaveBeenCalled();
    });

    it('looks for the newest thread on the identity, whatever its status', async () => {
      prisma.conversation.update = jest.fn().mockResolvedValue({});
      await svc.start(WS, { leadId: 'lead-1', channelId: 'ch-1', text: 'hi' });

      const where = prisma.conversation.findFirst.mock.calls[0][0].where;
      expect(where).toMatchObject({ workspaceId: WS, channelId: 'ch-1', contactIdentityId: 'ci-1' });
      expect(where).not.toHaveProperty('status');
    });
  });

  /**
   * A refusal a Turkish rep reads. `suppressionRefusal` answered with an
   * English sentence that the dialog printed verbatim (PLAN G8), and the three
   * lead-column cases the dialog pre-empts do not cover an address-level
   * `ContactSuppression` row — which is exactly the case with no lead flag to
   * read. The code rides alongside the sentence so the sentence can stay for a
   * log and the UI can use the code.
   */
  it('names a machine reason on an address-level suppression', async () => {
    prisma.channel.findFirst.mockResolvedValue(channelOf('EMAIL'));
    suppression.check.mockResolvedValue({ suppressed: true, reason: 'COMPLAINT' });

    await expect(
      svc.start(WS, { leadId: 'lead-1', channelId: 'ch-1', text: 'hi' }),
    ).rejects.toMatchObject({
      response: { reason: 'SUPPRESSED_COMPLAINT', message: expect.stringMatching(/spam/i) },
    });
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
  let suppression: { check: jest.Mock };

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
        // Reopening a closed thread is now part of start(); `status` is
        // non-null on the real row, so every fixture below states it.
        update: jest.fn().mockResolvedValue({}),
      },
    };
    suppression = { check: jest.fn().mockResolvedValue({ suppressed: false }) };
    svc = new OutboundConversationService(prisma, sender as any, suppression as any);
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
  let suppression: { check: jest.Mock };

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
        // Reopening a closed thread is now part of start(); `status` is
        // non-null on the real row, so every fixture below states it.
        update: jest.fn().mockResolvedValue({}),
      },
    };
    suppression = { check: jest.fn().mockResolvedValue({ suppressed: false }) };
    svc = new OutboundConversationService(prisma, sender as any, suppression as any);
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
  let suppression: { check: jest.Mock };

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
        // Reopening a closed thread is now part of start(); `status` is
        // non-null on the real row, so every fixture below states it.
        update: jest.fn().mockResolvedValue({}),
      },
    };
    suppression = { check: jest.fn().mockResolvedValue({ suppressed: false }) };
    svc = new OutboundConversationService(prisma, sender as any, suppression as any);
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
  let suppression: { check: jest.Mock };

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
        // Reopening a closed thread is now part of start(); `status` is
        // non-null on the real row, so every fixture below states it.
        update: jest.fn().mockResolvedValue({}),
      },
    };
    suppression = { check: jest.fn().mockResolvedValue({ suppressed: false }) };
    svc = new OutboundConversationService(prisma, sender as any, suppression as any);
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

/**
 * Who wrote the first message.
 *
 * `start()` hard-coded `authorType: 'AI'`, so a rep pressing "Mesaj" in the
 * panel and a distribution send by a named human both landed in the stream as
 * the assistant's work (`human-start-recorded-ai`). Attribution is a parameter
 * now — a THIRD one rather than a DTO field, because a client-supplied
 * `authorId` would let a rep forge another user's name onto a customer-facing
 * message.
 */
describe('OutboundConversationService — authorship', () => {
  const WS = 'ws-1';
  let prisma: any;
  let sender: { send: jest.Mock };
  let suppression: { check: jest.Mock };
  let svc: OutboundConversationService;

  beforeEach(() => {
    sender = { send: jest.fn().mockResolvedValue({ id: 'msg-1', status: 'SENT' }) };
    suppression = { check: jest.fn().mockResolvedValue({ suppressed: false }) };
    prisma = {
      channel: { findFirst: jest.fn().mockResolvedValue({ id: 'ch-1', type: 'SMS', status: 'ACTIVE' }) },
      lead: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'lead-1', phone: '05551112233', whatsapp: null, email: 'a@b.com',
          smsOptOut: false, waOptOut: false, emailOptOut: false,
          emailVerifiedStatus: 'VALID', emailBouncedAt: null,
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
        // Reopening a closed thread is now part of start(); `status` is
        // non-null on the real row, so every fixture below states it.
        update: jest.fn().mockResolvedValue({}),
      },
    };
    svc = new OutboundConversationService(prisma, sender as any, suppression as any);
  });

  it('records the human who actually pressed send', async () => {
    await svc.start(
      WS,
      { leadId: 'lead-1', channelId: 'ch-1', text: 'merhaba' },
      { authorType: 'AGENT', authorId: 'user-7' },
    );
    expect(sender.send).toHaveBeenCalledWith(
      expect.objectContaining({ authorType: 'AGENT', authorId: 'user-7' }),
    );
  });

  it('still defaults to the assistant when no author is named', async () => {
    // `jeeta.message_lead` runs on an API key and carries no human at all;
    // inventing a synthetic agent id there would be the worse error.
    await svc.start(WS, { leadId: 'lead-1', channelId: 'ch-1', text: 'merhaba' });
    expect(sender.send).toHaveBeenCalledWith(
      expect.objectContaining({ authorType: 'AI', authorId: null }),
    );
  });

  it('does not pause the AI on an outbound-first thread', async () => {
    // A reply INTO a thread is a takeover; opening one deliberately leaves the
    // AI free to follow up, so attribution must not quietly change that.
    await svc.start(
      WS,
      { leadId: 'lead-1', channelId: 'ch-1', text: 'merhaba' },
      { authorType: 'AGENT', authorId: 'user-7' },
    );
    expect(prisma.conversation.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.not.objectContaining({ aiPaused: true }) }),
    );
  });
});

/**
 * Suppression is per ADDRESS, not per lead row.
 *
 * The lead flags below are the row-local half of the answer and stay exactly as
 * they were. They cannot see the other half: the same person on file twice
 * unsubscribed once (`optout-per-lead-row`), and a hard bounce or a spam report
 * recorded against the address itself belongs to no particular row. Both halves
 * refuse with the same sentences the flags always used.
 */
describe('OutboundConversationService — address-level suppression', () => {
  const WS = 'ws-1';
  let prisma: any;
  let sender: { send: jest.Mock };
  let suppression: { check: jest.Mock };
  let svc: OutboundConversationService;

  const LEAD = {
    id: 'lead-1', phone: '05551112233', whatsapp: '05551112233', email: 'A@B.com',
    emailOptOut: false, smsOptOut: false, waOptOut: false,
    emailVerifiedStatus: 'VALID', emailBouncedAt: null,
  };

  const build = (verdict: any, type = 'EMAIL') => {
    sender = { send: jest.fn().mockResolvedValue({ id: 'msg-1' }) };
    suppression = { check: jest.fn().mockResolvedValue(verdict) };
    prisma = {
      channel: { findFirst: jest.fn().mockResolvedValue({ id: 'ch-1', type, status: 'ACTIVE' }) },
      lead: { findFirst: jest.fn().mockResolvedValue(LEAD) },
      contactIdentity: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'ci-1', leadId: 'lead-1' }),
      },
      conversation: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'conv-1' }),
        // Reopening a closed thread is now part of start(); `status` is
        // non-null on the real row, so every fixture below states it.
        update: jest.fn().mockResolvedValue({}),
      },
    };
    svc = new OutboundConversationService(prisma, sender as any, suppression as any);
  };

  it('asks about the canonical address, as a proactive CONVERSATIONAL send', async () => {
    build({ suppressed: false });
    await svc.start(WS, { leadId: 'lead-1', channelId: 'ch-1', text: 'merhaba' });
    // Opening a thread IS reaching out, so the reply exemption cannot apply:
    // there is no inbound message to have earned it.
    expect(suppression.check).toHaveBeenCalledWith(WS, 'a@b.com', 'CONVERSATIONAL', {
      proactive: true,
    });
  });

  it.each([
    ['OPT_OUT', /opted out of email/i],
    ['MANUAL', /opted out of email/i],
    ['HARD_BOUNCE', /hard-bounced/i],
    ['INVALID', /failed verification/i],
    ['COMPLAINT', /spam/i],
    ['ERASURE', /erased/i],
  ])('refuses a %s row and says so in the same words the flags use', async (reason, message) => {
    build({ suppressed: true, reason });
    await expect(
      svc.start(WS, { leadId: 'lead-1', channelId: 'ch-1', text: 'merhaba' }),
    ).rejects.toThrow(message);
    expect(sender.send).not.toHaveBeenCalled();
    // Refused before any identity or thread is written, so a suppressed
    // address does not accumulate half-built conversations.
    expect(prisma.contactIdentity.create).not.toHaveBeenCalled();
    expect(prisma.conversation.create).not.toHaveBeenCalled();
  });

  it('does not ask on a channel this gate does not cover', async () => {
    build({ suppressed: false }, 'SMS');
    await svc.start(WS, { leadId: 'lead-1', channelId: 'ch-1', text: 'merhaba' });
    expect(suppression.check).not.toHaveBeenCalled();
  });

  it('opens the thread anyway when the suppression read itself fails', async () => {
    // A database hiccup is not a customer's refusal. There was no check here at
    // all until now, so failing open is this path's own previous behaviour.
    build({ suppressed: false });
    suppression.check.mockRejectedValue(new Error('connection pool timeout'));
    await svc.start(WS, { leadId: 'lead-1', channelId: 'ch-1', text: 'merhaba' });
    expect(sender.send).toHaveBeenCalled();
  });
});
