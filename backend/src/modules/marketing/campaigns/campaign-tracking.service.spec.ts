import { CampaignTrackingService } from './campaign-tracking.service';

/**
 * Tracking security: click resolves ONLY to a campaign-authored http(s) link
 * (no open redirect — even if a token is valid), and unsubscribe flips the
 * lead's per-channel opt-out so future sends + the AI engine honor it.
 */
describe('CampaignTrackingService', () => {
  const WS = 'ws-1';
  let prisma: any;
  let outbox: { append: jest.Mock };
  let svc: CampaignTrackingService;

  beforeEach(() => {
    prisma = {
      campaignRecipient: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        // The conditional claim: count 1 = this hit won the open/click/unsub
        // transition (→ bump); count 0 = a concurrent hit already claimed it.
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      campaign: {
        findFirst: jest.fn(),
        findUnique: jest.fn().mockResolvedValue({ stats: {} }),
        update: jest.fn().mockResolvedValue({}),
      },
      lead: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue({ phone: '05551112233' }),
      },
      // bump() now increments the counter via an atomic jsonb_set UPDATE.
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
    };
    // emitSmsOptOutEvent wraps the flip + phone read + outbox append in one
    // $transaction; the mock just runs the callback against the same mock
    // client (tx === prisma), matching the established test idiom elsewhere
    // (e.g. review-sync.service.spec.ts).
    prisma.$transaction = jest.fn((fn: any) => fn(prisma));
    outbox = { append: jest.fn().mockResolvedValue('evt-1') };
    svc = new CampaignTrackingService(prisma as any, outbox as any);
  });

  it('click returns the campaign-authored URL at the index', async () => {
    prisma.campaignRecipient.findUnique.mockResolvedValue({ id: 'r1', campaignId: 'c1', workspaceId: WS, clickedAt: null });
    prisma.campaign.findFirst.mockResolvedValue({ links: ['https://shop.example/spring'] });
    await expect(svc.click('tok', 0)).resolves.toBe('https://shop.example/spring');
  });

  it('open bumps the counter ATOMICALLY (single jsonb_set UPDATE, no read-modify-write race)', async () => {
    prisma.campaignRecipient.findUnique.mockResolvedValue({ id: 'r1', campaignId: 'c1', workspaceId: WS, openedAt: null });
    await svc.open('tok');
    // No findUnique→update read-modify-write on stats; a single atomic UPDATE.
    expect(prisma.campaign.findUnique).not.toHaveBeenCalled();
    const [sql, key, id] = (prisma.$executeRawUnsafe as jest.Mock).mock.calls[0];
    expect(sql).toContain('jsonb_set');
    expect(key).toBe('opened');
    expect(id).toBe('c1');
  });

  it('open does NOT bump the counter when a concurrent hit already claimed it (no double-count)', async () => {
    // Mail-client prefetch + real open both read openedAt=null; the loser's
    // conditional updateMany matches 0 rows, so it must NOT bump (unique opens).
    prisma.campaignRecipient.findUnique.mockResolvedValue({ id: 'r1', campaignId: 'c1', workspaceId: WS, openedAt: null });
    prisma.campaignRecipient.updateMany.mockResolvedValue({ count: 0 });
    await svc.open('tok');
    expect(prisma.campaignRecipient.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'r1', openedAt: null } }),
    );
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('open bumps exactly once when it wins the openedAt claim', async () => {
    prisma.campaignRecipient.findUnique.mockResolvedValue({ id: 'r1', campaignId: 'c1', workspaceId: WS, openedAt: null });
    prisma.campaignRecipient.updateMany.mockResolvedValue({ count: 1 });
    await svc.open('tok');
    expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(1);
  });

  it('click refuses an out-of-range index (no redirect target)', async () => {
    prisma.campaignRecipient.findUnique.mockResolvedValue({ id: 'r1', campaignId: 'c1', workspaceId: WS, clickedAt: null });
    prisma.campaign.findFirst.mockResolvedValue({ links: ['https://x.com'] });
    await expect(svc.click('tok', 9)).resolves.toBeNull();
  });

  it('click refuses a non-http(s) link (open-redirect guard)', async () => {
    prisma.campaignRecipient.findUnique.mockResolvedValue({ id: 'r1', campaignId: 'c1', workspaceId: WS, clickedAt: null });
    prisma.campaign.findFirst.mockResolvedValue({ links: ['javascript:alert(1)'] });
    await expect(svc.click('tok', 0)).resolves.toBeNull();
  });

  it('click on an unknown token returns null', async () => {
    prisma.campaignRecipient.findUnique.mockResolvedValue(null);
    await expect(svc.click('nope', 0)).resolves.toBeNull();
  });

  it('unsubscribe flips the channel-specific opt-out, workspace-scoped', async () => {
    prisma.campaignRecipient.findUnique.mockResolvedValue({ id: 'r1', campaignId: 'c1', workspaceId: WS, leadId: 'lead-1', status: 'SENT' });
    prisma.campaign.findFirst.mockResolvedValue({ channel: 'WHATSAPP' });
    await expect(svc.unsubscribe('tok')).resolves.toBe(true);
    expect(prisma.lead.updateMany).toHaveBeenCalledWith({
      where: { id: 'lead-1', workspaceId: WS },
      data: { waOptOut: true },
    });
    // Non-SMS channels never trigger the NetGSM blacklist-sync event.
    expect(outbox.append).not.toHaveBeenCalled();
  });

  it('SMS unsubscribe enqueues marketing.sms.optout.v1 keyed on the recipient id', async () => {
    prisma.campaignRecipient.findUnique.mockResolvedValue({ id: 'r1', campaignId: 'c1', workspaceId: WS, leadId: 'lead-1', status: 'SENT' });
    prisma.campaign.findFirst.mockResolvedValue({ channel: 'SMS' });
    await expect(svc.unsubscribe('tok')).resolves.toBe(true);
    expect(prisma.lead.updateMany).toHaveBeenCalledWith({
      where: { id: 'lead-1', workspaceId: WS },
      data: { smsOptOut: true },
    });
    expect(outbox.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'marketing.sms.optout.v1',
        payload: { workspaceId: WS, leadId: 'lead-1', phone: '05551112233' },
        idempotencyKey: 'ws-1:lead-1:marketing.sms.optout.v1:unsub:r1',
      }),
      expect.anything(), // the tx client the flip + append share
    );
  });

  it('SMS unsubscribe does NOT enqueue a blacklist-sync event when the lead has no phone', async () => {
    prisma.campaignRecipient.findUnique.mockResolvedValue({ id: 'r1', campaignId: 'c1', workspaceId: WS, leadId: 'lead-1', status: 'SENT' });
    prisma.campaign.findFirst.mockResolvedValue({ channel: 'SMS' });
    prisma.lead.findUnique.mockResolvedValue({ phone: null });
    await expect(svc.unsubscribe('tok')).resolves.toBe(true);
    expect(outbox.append).not.toHaveBeenCalled();
  });

  it('does not fail the unsubscribe when the outbox append throws', async () => {
    prisma.campaignRecipient.findUnique.mockResolvedValue({ id: 'r1', campaignId: 'c1', workspaceId: WS, leadId: 'lead-1', status: 'SENT' });
    prisma.campaign.findFirst.mockResolvedValue({ channel: 'SMS' });
    outbox.append.mockRejectedValue(new Error('outbox down'));
    await expect(svc.unsubscribe('tok')).resolves.toBe(true);
  });

  it('does not fail the unsubscribe when the phone lookup (findUnique) rejects, and still bumps the UNSUBSCRIBED status', async () => {
    prisma.campaignRecipient.findUnique.mockResolvedValue({ id: 'r1', campaignId: 'c1', workspaceId: WS, leadId: 'lead-1', status: 'SENT' });
    prisma.campaign.findFirst.mockResolvedValue({ channel: 'SMS' });
    prisma.lead.findUnique.mockRejectedValue(new Error('db down'));

    await expect(svc.unsubscribe('tok')).resolves.toBe(true);
    expect(outbox.append).not.toHaveBeenCalled();
    expect(prisma.lead.updateMany).toHaveBeenCalledWith({
      where: { id: 'lead-1', workspaceId: WS },
      data: { smsOptOut: true },
    });
    // The read failure must not skip the UNSUBSCRIBED status bump either.
    expect(prisma.campaignRecipient.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'r1', status: { not: 'UNSUBSCRIBED' } } }),
    );
  });
});
