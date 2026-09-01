import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DistributionSendService } from './distribution-send.service';

const WS = 'ws-1';
const OTHER_WS = 'ws-2';
const HUMAN = { id: 'u-1', role: 'MANAGER' };

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

function makeSvc(over: { draft?: unknown; claim?: number; start?: jest.Mock } = {}) {
  const prisma: any = {
    marketingUser: { findFirst: jest.fn().mockResolvedValue(HUMAN) },
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
    expect(outbound.start).toHaveBeenCalledWith(WS, {
      leadId: 'lead-1',
      channelId: 'ch-1',
      text: 'Bunun motoru yok.',
    });
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
