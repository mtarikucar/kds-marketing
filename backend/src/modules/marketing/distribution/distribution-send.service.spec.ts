import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DistributionSendService } from './distribution-send.service';

const WS = 'ws-1';
const OTHER_WS = 'ws-2';
/** An ACTIVE membership of THIS workspace, which is what the send gate reads —
 *  `MarketingUser.workspaceId/role/status` is the frozen home mirror and is
 *  deliberately NOT what authorises a send. `user.role` is the home role and is
 *  read only to keep the SYSTEM sentinel excluded. */
const HUMAN = { role: 'MANAGER', status: 'ACTIVE', user: { id: 'u-1', role: 'REP' } };

/** The third argument `start()` now takes. The rep who pressed send is stamped
 *  onto the Message, so an outreach a human wrote stops being recorded as AI
 *  (`human-start-recorded-ai`); `assertHumanActor` has already proved the id
 *  against the membership above, which is why the body can never supply it. */
const AUTHOR = { authorType: 'AGENT', authorId: 'u-1' };

const baseDraft = {
  id: 'draft-1',
  workspaceId: WS,
  planId: 'plan-1',
  campaignItemId: 'item-1',
  leadId: 'lead-1',
  channelId: 'ch-1',
  channelType: 'EMAIL',
  toAddress: 'a@example.com',
  body: 'Bunun motoru yok.',
  status: 'DRAFT',
};

function makeSvc(
  over: {
    draft?: unknown;
    claim?: number;
    start?: jest.Mock;
    /** What the send-time channel re-resolution finds. `undefined` keeps the
     *  draft's own channel, which is what every pre-existing case assumes. */
    channel?: jest.Mock;
  } = {},
) {
  const prisma: any = {
    workspaceMembership: { findFirst: jest.fn().mockResolvedValue(HUMAN) },
    channel: { findFirst: over.channel ?? jest.fn().mockResolvedValue({ id: 'ch-1' }) },
    distributionDraft: {
      findFirst: jest
        .fn()
        .mockResolvedValue(over.draft === undefined ? baseDraft : over.draft),
      updateMany: jest.fn().mockResolvedValue({ count: over.claim ?? 1 }),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const outbound = {
    start:
      over.start ??
      jest.fn().mockResolvedValue({
        conversationId: 'conv-1',
        to: 'a@example.com',
        channel: 'EMAIL',
      }),
  };
  return { svc: new DistributionSendService(prisma, outbound as never), prisma, outbound };
}

describe('DistributionSendService.send', () => {
  it('sends through the ONE outbound path, with the draft’s resolved channel and lead', async () => {
    const { svc, outbound } = makeSvc();
    const res = await svc.send(WS, 'draft-1', 'u-1');
    expect(outbound.start).toHaveBeenCalledWith(
      WS,
      { leadId: 'lead-1', channelId: 'ch-1', text: 'Bunun motoru yok.' },
      AUTHOR,
    );
    expect(res).toMatchObject({ draftId: 'draft-1', conversationId: 'conv-1', channel: 'EMAIL' });
  });

  /**
   * A draft a human edited before sending is the normal case, and the row must
   * end up holding what was SENT, not what was proposed — otherwise the record
   * of an outreach campaign is a record of drafts nobody actually used.
   */
  it('sends the edited text and stores it back onto the row', async () => {
    const { svc, prisma, outbound } = makeSvc();
    await svc.send(WS, 'draft-1', 'u-1', '  Kendi cümlelerimle.  ');
    expect(outbound.start).toHaveBeenCalledWith(
      WS,
      expect.objectContaining({ text: 'Kendi cümlelerimle.' }),
      AUTHOR,
    );
    expect(prisma.distributionDraft.updateMany.mock.calls[0][0].data.body).toBe(
      'Kendi cümlelerimle.',
    );
  });

  it('refuses an empty message rather than sending a blank one', async () => {
    const { svc, outbound } = makeSvc({ draft: { ...baseDraft, body: '   ' } });
    await expect(svc.send(WS, 'draft-1', 'u-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(outbound.start).not.toHaveBeenCalled();
  });

  it('refuses a draft from another workspace', async () => {
    const { svc, prisma } = makeSvc({ draft: null });
    await expect(svc.send(OTHER_WS, 'draft-1', 'u-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.distributionDraft.findFirst).toHaveBeenCalledWith({
      where: { id: 'draft-1', workspaceId: OTHER_WS },
    });
  });

  it('refuses one that is already SENT', async () => {
    const { svc, outbound } = makeSvc({ draft: { ...baseDraft, status: 'SENT' } });
    await expect(svc.send(WS, 'draft-1', 'u-1')).rejects.toThrow(/SENT/);
    expect(outbound.start).not.toHaveBeenCalled();
  });

  it('refuses one a human DISMISSED — that was a decision', async () => {
    const { svc, outbound } = makeSvc({ draft: { ...baseDraft, status: 'DISMISSED' } });
    await expect(svc.send(WS, 'draft-1', 'u-1')).rejects.toThrow(/decision/i);
    expect(outbound.start).not.toHaveBeenCalled();
  });

  /** A transient provider error must not strand a message someone has already
   *  decided to send. */
  it('allows a retry of a FAILED draft', async () => {
    const { svc, outbound } = makeSvc({ draft: { ...baseDraft, status: 'FAILED' } });
    await svc.send(WS, 'draft-1', 'u-1');
    expect(outbound.start).toHaveBeenCalled();
  });

  /**
   * The reason lands ON the row. A draft that could not be delivered must never
   * read like one nobody chose to send.
   */
  it('records the reason on the row when the send fails, and rethrows', async () => {
    const start = jest.fn().mockRejectedValue(new Error('This lead opted out of email messages'));
    const { svc, prisma } = makeSvc({ start });
    await expect(svc.send(WS, 'draft-1', 'u-1')).rejects.toThrow(/opted out/);
    expect(prisma.distributionDraft.update).toHaveBeenCalledWith({
      where: { id: 'draft-1' },
      data: expect.objectContaining({
        status: 'FAILED',
        sentAt: null,
        error: 'This lead opted out of email messages',
      }),
    });
  });

  it('links the conversation it opened back onto the draft', async () => {
    const { svc, prisma } = makeSvc();
    await svc.send(WS, 'draft-1', 'u-1');
    expect(prisma.distributionDraft.update).toHaveBeenCalledWith({
      where: { id: 'draft-1' },
      data: { conversationId: 'conv-1' },
    });
  });

  /**
   * Opt-out, email hygiene and the identity-collision check are NOT re-implemented
   * here — they live in `OutboundConversationService`, which this delegates to.
   * The assertion is that its refusal survives as the caller's refusal rather
   * than being swallowed into a quietly-skipped row.
   */
  it('surfaces the outbound path’s own refusals instead of swallowing them', async () => {
    const start = jest
      .fn()
      .mockRejectedValue(new Error('That address already belongs to a different lead'));
    const { svc } = makeSvc({ start });
    await expect(svc.send(WS, 'draft-1', 'u-1')).rejects.toThrow(/different lead/);
  });
});

/**
 * The draft's status is the PROVIDER's answer, not the click's.
 *
 * The send path never throws on a provider error — it persists the message as
 * FAILED, refunds the quota and hands the row back — so a refused send used to
 * leave the draft reading SENT, with a green badge and a sent stamp, while
 * nothing had left the building. A rep has no other place to look.
 */
describe('DistributionSendService.send — the row follows the provider', () => {
  function failing(error: string | null, status = 'FAILED') {
    return jest.fn().mockResolvedValue({
      conversationId: 'conv-1',
      to: 'a@example.com',
      channel: 'EMAIL',
      message: { id: 'msg-1', status, error },
    });
  }

  it('marks the draft FAILED when the provider refused, even though nothing threw', async () => {
    const { svc, prisma } = makeSvc({ start: failing('535 5.7.8 Authentication failed') });
    await expect(svc.send(WS, 'draft-1', 'u-1')).rejects.toThrow(/535 5\.7\.8/);
    expect(prisma.distributionDraft.update).toHaveBeenCalledWith({
      where: { id: 'draft-1' },
      data: expect.objectContaining({
        status: 'FAILED',
        sentAt: null,
        error: '535 5.7.8 Authentication failed',
      }),
    });
  });

  /** The provider gave no words. The row must still say something a person can
   *  act on rather than an empty reason under a FAILED badge. */
  it('says something when the provider refused without a reason', async () => {
    const { svc, prisma } = makeSvc({ start: failing(null) });
    await expect(svc.send(WS, 'draft-1', 'u-1')).rejects.toBeInstanceOf(BadRequestException);
    const failure = prisma.distributionDraft.update.mock.calls.at(-1)[0];
    expect(failure.data.status).toBe('FAILED');
    expect(String(failure.data.error).length).toBeGreaterThan(10);
  });

  /** A failed attempt still opened (or reused) the thread, and that thread now
   *  holds the FAILED message. Losing the link would hide the one place the
   *  rep can see what actually happened. */
  it('keeps the conversation link on a failed attempt', async () => {
    const { svc, prisma } = makeSvc({ start: failing('mailbox unavailable') });
    await expect(svc.send(WS, 'draft-1', 'u-1')).rejects.toThrow(/mailbox unavailable/);
    expect(prisma.distributionDraft.update.mock.calls[0][0]).toEqual({
      where: { id: 'draft-1' },
      data: { conversationId: 'conv-1' },
    });
  });

  it('leaves a SENT message SENT', async () => {
    const { svc, prisma } = makeSvc({ start: failing(null, 'SENT') });
    await expect(svc.send(WS, 'draft-1', 'u-1')).resolves.toMatchObject({ draftId: 'draft-1' });
    expect(prisma.distributionDraft.update).toHaveBeenCalledTimes(1);
  });

  /**
   * Only an EXPLICIT failure fails the row.
   *
   * The optional chaining is load-bearing twice over: a caller that hands back
   * no message row at all (every fixture in this suite, and the real-DB spec)
   * must not turn into a TypeError the catch below converts into a false
   * failure — and a row in some other state is not evidence that nothing was
   * sent. This file's whole trade is that a message which went twice is worse
   * than one that did not go, so anything short of "the provider said no" keeps
   * the claim.
   */
  it('does not fail the row on a send that reported no message at all', async () => {
    const { svc, prisma } = makeSvc();
    await expect(svc.send(WS, 'draft-1', 'u-1')).resolves.toMatchObject({
      conversationId: 'conv-1',
    });
    expect(prisma.distributionDraft.update).toHaveBeenCalledTimes(1);
  });

  it('does not fail the row on a message that is still settling', async () => {
    const { svc } = makeSvc({ start: failing(null, 'PENDING') });
    await expect(svc.send(WS, 'draft-1', 'u-1')).resolves.toMatchObject({ draftId: 'draft-1' });
  });
});

/**
 * Which channel the message leaves on is decided NOW, not when the plan was
 * written. A draft frozen onto the oldest ACTIVE mailbox kept failing with 535
 * while a working mailbox sat one row away.
 */
describe('DistributionSendService.send — the channel is re-resolved at send time', () => {
  it('sends on the best ACTIVE channel of the draft’s type, not the one the plan froze', async () => {
    const { svc, outbound } = makeSvc({
      channel: jest.fn().mockResolvedValue({ id: 'ch-verified' }),
    });
    await svc.send(WS, 'draft-1', 'u-1');
    expect(outbound.start).toHaveBeenCalledWith(
      WS,
      expect.objectContaining({ channelId: 'ch-verified' }),
      AUTHOR,
    );
  });

  /** Type-scoped, never cross-type: merit ordering must not move an email
   *  outreach onto a paid, İYS-governed SMS channel. */
  it('looks only at this workspace’s ACTIVE channels of the draft’s own type', async () => {
    const channel = jest.fn().mockResolvedValue({ id: 'ch-1' });
    const { svc } = makeSvc({ channel });
    await svc.send(WS, 'draft-1', 'u-1');
    expect(channel).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: WS, type: 'EMAIL', status: 'ACTIVE' },
      }),
    );
  });

  it('keeps the planned channel when nothing better answers, so the error stays truthful', async () => {
    const { svc, outbound } = makeSvc({ channel: jest.fn().mockResolvedValue(null) });
    await svc.send(WS, 'draft-1', 'u-1');
    expect(outbound.start).toHaveBeenCalledWith(WS, expect.objectContaining({ channelId: 'ch-1' }), AUTHOR);
  });

  /** Re-resolution is an improvement on the plan's guess. It is never a reason
   *  to refuse a send a human has already clicked and the row has already been
   *  claimed for. */
  it('sends on the planned channel when the lookup itself fails', async () => {
    const { svc, outbound, prisma } = makeSvc({
      channel: jest.fn().mockRejectedValue(new Error('connection pool timeout')),
    });
    await svc.send(WS, 'draft-1', 'u-1');
    expect(outbound.start).toHaveBeenCalledWith(WS, expect.objectContaining({ channelId: 'ch-1' }), AUTHOR);
    expect(prisma.distributionDraft.update).toHaveBeenCalledWith({
      where: { id: 'draft-1' },
      data: { conversationId: 'conv-1' },
    });
  });
});
