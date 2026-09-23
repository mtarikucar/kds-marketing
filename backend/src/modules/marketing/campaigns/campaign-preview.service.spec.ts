import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CampaignPreviewService } from './campaign-preview.service';
import { CampaignsService } from './campaigns.service';

/**
 * The pre-launch answers: how many people, who was left out, who signs the
 * mail, and one copy to the operator before the irreversible part.
 *
 * The load-bearing assertion in here is the first one: the preview must count
 * with the SAME predicate `launch()` freezes with, or the number on the confirm
 * sheet is a different promise from the one the send keeps.
 */
describe('CampaignPreviewService', () => {
  const WS = 'ws-1';
  const CAMPAIGN = {
    id: 'c1',
    workspaceId: WS,
    status: 'DRAFT',
    channel: 'EMAIL',
    subject: 'Bahar indirimi',
    body: 'Merhaba {{lead.contactPerson}}, indirim başladı.',
    bodyHtml: null,
    iysMessageType: 'BILGILENDIRME',
    audienceFilter: [{ field: 'lead.status', op: 'eq', value: 'NEW' }],
  };

  let prisma: any;
  let campaigns: CampaignsService;
  let suppression: { checkMany: jest.Mock };
  let outboundMail: { send: jest.Mock; preflight: jest.Mock };
  let config: { get: jest.Mock };
  let svc: CampaignPreviewService;

  const preflightOk = {
    ok: true,
    transport: 'PLATFORM',
    from: { email: 'admin@jeetagrowth.com', name: 'Acme via Jeeta', replyTo: 'acme@acme.test' },
  };

  beforeEach(() => {
    prisma = {
      campaign: { findFirst: jest.fn().mockResolvedValue(CAMPAIGN), update: jest.fn() },
      campaignRecipient: { createMany: jest.fn(), deleteMany: jest.fn(), findMany: jest.fn() },
      campaignVariant: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() },
      emailTemplate: { findMany: jest.fn().mockResolvedValue([]) },
      segment: { findFirst: jest.fn().mockResolvedValue(null) },
      lead: {
        findMany: jest.fn().mockResolvedValue([{ id: 'l1', email: 'a@x.io' }]),
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    campaigns = new CampaignsService(
      prisma as any,
      { schedule: jest.fn(), cancel: jest.fn() } as any,
      { getEffective: jest.fn() } as any,
      { compile: jest.fn() } as any,
      { readiness: jest.fn().mockResolvedValue({ configured: false }) } as any,
    );
    suppression = { checkMany: jest.fn().mockResolvedValue(new Map()) };
    outboundMail = {
      send: jest.fn().mockResolvedValue({
        outcome: 'SENT',
        ok: true,
        mailLogId: 'ml-1',
        messageId: 'mid-1',
        transport: 'PLATFORM',
        retriable: false,
      }),
      preflight: jest.fn().mockResolvedValue(preflightOk),
    };
    config = { get: jest.fn().mockReturnValue('https://app.test') };
    svc = new CampaignPreviewService(
      prisma as any,
      campaigns,
      suppression as any,
      outboundMail as any,
      config as any,
    );
  });

  describe('audience', () => {
    it('counts with the SAME where launch() freezes with', async () => {
      // What the send will do…
      prisma.lead.findMany.mockResolvedValue([{ id: 'l1' }]);
      await campaigns.launch(WS, 'c1');
      const sendWhere = prisma.lead.findMany.mock.calls[0][0].where;

      // …and what the card promises.
      prisma.lead.findMany.mockResolvedValue([{ id: 'l1', email: 'a@x.io' }]);
      prisma.lead.count.mockResolvedValue(1);
      await svc.audience(WS, 'c1');

      const matchedWhere = prisma.lead.count.mock.calls[0][0].where;
      expect(matchedWhere).toEqual(sendWhere);
    });

    it('breaks the excluded leads down by why, and never counts them as reachable', async () => {
      // matched, optedOut, bounced, invalid, noEmail — in call order.
      prisma.lead.count
        .mockResolvedValueOnce(40)
        .mockResolvedValueOnce(7)
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(5);
      prisma.lead.findMany.mockResolvedValue([]);

      const out = await svc.audience(WS, 'c1');

      expect(out.matched).toBe(40);
      expect(out.excluded).toEqual({ optedOut: 7, bounced: 2, invalid: 1, suppressed: 0, noEmail: 5 });
    });

    it('subtracts suppressed addresses from the reachable count', async () => {
      prisma.lead.count.mockResolvedValue(3);
      prisma.lead.findMany.mockResolvedValue([
        { id: 'l1', email: 'a@x.io' },
        { id: 'l2', email: 'b@x.io' },
        { id: 'l3', email: 'c@x.io' },
      ]);
      suppression.checkMany.mockResolvedValue(new Map([['b@x.io', 'COMPLAINT']]));

      const out = await svc.audience(WS, 'c1');

      expect(suppression.checkMany).toHaveBeenCalledWith(WS, ['a@x.io', 'b@x.io', 'c@x.io'], 'BULK');
      expect(out.excluded.suppressed).toBe(1);
      expect(out.matched).toBe(2);
    });

    /** A phone number cannot bounce or be syntactically invalid. Counting
     *  those buckets on an SMS campaign once meant counting the whole
     *  workspace and calling it "bounced". */
    it('does not invent email buckets for a phone channel', async () => {
      prisma.campaign.findFirst.mockResolvedValue({ ...CAMPAIGN, channel: 'SMS' });
      prisma.lead.count.mockResolvedValue(9);

      const out = await svc.audience(WS, 'c1');

      expect(out.excluded.bounced).toBe(0);
      expect(out.excluded.invalid).toBe(0);
      expect(out.excluded.suppressed).toBe(0);
      // matched + optedOut + noAddress: three counts, never five.
      expect(prisma.lead.count).toHaveBeenCalledTimes(3);
      // And the suppression sample is an EMAIL question, so it is not asked.
      expect(suppression.checkMany).not.toHaveBeenCalled();
    });

    it('reports the resolved sender identity', async () => {
      prisma.lead.count.mockResolvedValue(1);
      const out = await svc.audience(WS, 'c1');
      expect(out.sender.transport).toBe('PLATFORM');
      expect(out.sender.from.replyTo).toBe('acme@acme.test');
      expect(out.sender.ok).toBe(true);
    });

    /**
     * The preflight needs SOME address to run the gate against, and the only
     * one on hand is the operator's. A refusal about THAT address says nothing
     * about the campaign's audience, so it must never be reported as a reason
     * the blast will not go out.
     */
    it('does not report an address-scoped refusal as a campaign blocker', async () => {
      prisma.lead.count.mockResolvedValue(1);
      outboundMail.preflight.mockResolvedValue({
        ...preflightOk,
        ok: false,
        reason: 'SUPPRESSED_OPT_OUT',
      });
      const out = await svc.audience(WS, 'c1');
      expect(out.sender.ok).toBe(true);
      expect(out.sender.reason).toBeUndefined();
    });

    it('does report a workspace-level blocker', async () => {
      prisma.lead.count.mockResolvedValue(1);
      outboundMail.preflight.mockResolvedValue({ ...preflightOk, ok: false, reason: 'SENDING_PAUSED' });
      const out = await svc.audience(WS, 'c1');
      expect(out.sender.ok).toBe(false);
      expect(out.sender.reason).toBe('SENDING_PAUSED');
    });

    it('404s for a campaign outside the workspace', async () => {
      prisma.campaign.findFirst.mockResolvedValue(null);
      await expect(svc.audience(WS, 'nope')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('testSend', () => {
    const actor = { id: 'u-1', email: 'owner@acme.test' };

    it('sends one BULK copy through the gateway and touches nothing the campaign counts', async () => {
      prisma.lead.findMany.mockResolvedValue([]);

      const out = await svc.testSend(WS, 'c1', actor);

      expect(out.ok).toBe(true);
      const mail = outboundMail.send.mock.calls[0][0];
      expect(mail.mailClass).toBe('BULK');
      expect(mail.to).toBe('owner@acme.test');
      expect(mail.subject).toBe('Bahar indirimi');
      // Never the campaign's own source: a test must not land in the campaign's
      // ledger slice, its stats or its recipient rows.
      expect(mail.source).not.toBe('campaign:c1');
      expect(mail.idempotencyKey).toBeUndefined();
      expect(prisma.campaign.update).not.toHaveBeenCalled();
      expect(prisma.campaignRecipient.createMany).not.toHaveBeenCalled();
    });

    it('carries an unsubscribe link, because BULK fails closed without one', async () => {
      prisma.lead.findMany.mockResolvedValue([]);
      await svc.testSend(WS, 'c1', actor);
      const mail = outboundMail.send.mock.calls[0][0];
      expect(mail.unsubscribe.token).toBeTruthy();
      expect(mail.unsubscribe.url).toMatch(/^https:\/\/app\.test\/api\/public\/u\//);
    });

    /** The operator is often on file in their own CRM. Passing that lead makes
     *  the rehearsal honest: their own opt-out stops it, exactly as it would
     *  stop the real thing. */
    it('hands the gate the lead behind the address when there is one', async () => {
      prisma.lead.findFirst.mockResolvedValue({ id: 'lead-7' });
      await svc.testSend(WS, 'c1', actor);
      expect(outboundMail.send.mock.calls[0][0].leadId).toBe('lead-7');
    });

    it('never ships a raw merge tag to the operator', async () => {
      prisma.lead.findMany.mockResolvedValue([]);
      await svc.testSend(WS, 'c1', actor);
      expect(outboundMail.send.mock.calls[0][0].text).not.toContain('{{');
    });

    it('returns the refusal instead of throwing when the gate says no', async () => {
      prisma.lead.findMany.mockResolvedValue([]);
      outboundMail.send.mockResolvedValue({
        outcome: 'REFUSED',
        ok: false,
        mailLogId: 'ml-2',
        messageId: null,
        transport: 'PLATFORM',
        reason: 'DAILY_CAP',
        userMessage: { key: 'mail.reason.DAILY_CAP' },
        retriable: true,
      });

      const out = await svc.testSend(WS, 'c1', actor);

      expect(out.ok).toBe(false);
      expect(out.reason).toBe('DAILY_CAP');
      expect(out.userMessage).toEqual({ key: 'mail.reason.DAILY_CAP' });
    });

    it('refuses a campaign with no subject, the same rule launch() enforces', async () => {
      prisma.campaign.findFirst.mockResolvedValue({ ...CAMPAIGN, subject: '  ' });
      await expect(svc.testSend(WS, 'c1', actor)).rejects.toBeInstanceOf(BadRequestException);
      expect(outboundMail.send).not.toHaveBeenCalled();
    });

    it('refuses a non-EMAIL campaign', async () => {
      prisma.campaign.findFirst.mockResolvedValue({ ...CAMPAIGN, channel: 'SMS' });
      await expect(svc.testSend(WS, 'c1', actor)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses when the acting user has no address to send to', async () => {
      await expect(svc.testSend(WS, 'c1', { id: 'u-1', email: '' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });
});
