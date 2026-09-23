import { CampaignTrackingService, machineHitReason } from './campaign-tracking.service';
import { signLeadUnsubscribeToken } from '../channels/lead-unsubscribe.token';

/**
 * The classifier on its own. It is a DENY-list: it names the machines it can
 * name and lets everything else count, because over-blocking deletes a tenant's
 * real engagement and nothing on the screen would ever say why.
 */
describe('machineHitReason', () => {
  it.each([
    ['a HEAD request', { method: 'HEAD', ua: 'Mozilla/5.0' }, 'head'],
    ['a mail-security gateway', { method: 'GET', ua: 'Mimecast Link Scanner' }, 'scanner'],
    ['a script', { method: 'GET', ua: 'python-requests/2.31.0' }, 'tool'],
    // The naming every real crawler uses — and the one a bare word-boundary
    // rule misses, because there is no boundary inside "AhrefsBot".
    ['a versioned crawler', { method: 'GET', ua: 'Mozilla/5.0 (compatible; AhrefsBot/7.0)' }, 'bot'],
    ['a standalone bot token', { method: 'GET', ua: 'Mozilla/5.0 (some bot; +http://x.test)' }, 'bot'],
  ])('names %s', (_label, hit, reason) => {
    expect(machineHitReason(hit)).toBe(reason);
  });

  it.each([
    ['an ordinary browser', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 Mobile Safari/604.1'],
    ['the Gmail image proxy — that fetch IS the open', 'Mozilla/5.0 (via ggpht.com GoogleImageProxy)'],
    ['a UA that merely contains the letters bot', 'Mozilla/5.0 (Linux; Android 13; Cubot X30)'],
  ])('lets %s through', (_label, ua) => {
    expect(machineHitReason({ method: 'GET', ua })).toBeNull();
  });

  it('reads a hit landing seconds after the send as a delivery-time prefetch', () => {
    expect(machineHitReason({ method: 'GET', ua: 'Mozilla/5.0' }, new Date())).toBe('prefetch');
    // …and one an hour later as a person, on the same User-Agent.
    expect(machineHitReason({ method: 'GET', ua: 'Mozilla/5.0' }, new Date(Date.now() - 3_600_000))).toBeNull();
  });

  it('counts a hit it knows nothing about', () => {
    expect(machineHitReason(undefined)).toBeNull();
    expect(machineHitReason({})).toBeNull();
  });
});

/**
 * Tracking security: click resolves ONLY to a campaign-authored http(s) link
 * (no open redirect — even if a token is valid), and unsubscribe flips the
 * lead's per-channel opt-out so future sends + the AI engine honor it.
 */
describe('CampaignTrackingService', () => {
  const WS = 'ws-1';
  /** An ordinary reader: a real browser UA on a GET. */
  const HUMAN = { method: 'GET', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15' };
  let prisma: any;
  let outbox: { append: jest.Mock };
  let iysSync: { enqueueConsent: jest.Mock };
  let suppression: { suppress: jest.Mock };
  let ledger: { record: jest.Mock };
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
        findFirst: jest.fn().mockResolvedValue({ email: null, emailNormalized: null }),
      },
      workspace: { findUnique: jest.fn().mockResolvedValue({ defaultLanguage: 'tr' }) },
      // bump() now increments the counter via an atomic jsonb_set UPDATE.
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
    };
    // emitSmsOptOutEvent wraps the flip + phone read + outbox append + İYS
    // enqueue in one $transaction; the mock just runs the callback against
    // the same mock client (tx === prisma), matching the established test
    // idiom elsewhere (e.g. review-sync.service.spec.ts).
    prisma.$transaction = jest.fn((fn: any) => fn(prisma));
    outbox = { append: jest.fn().mockResolvedValue('evt-1') };
    iysSync = { enqueueConsent: jest.fn().mockResolvedValue(undefined) };
    suppression = { suppress: jest.fn().mockResolvedValue(undefined) };
    ledger = { record: jest.fn().mockResolvedValue(1) };
    svc = new CampaignTrackingService(
      prisma as any,
      outbox as any,
      iysSync as any,
      suppression as any,
      ledger as any,
    );
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
    // The flip is gated on the lead NOT already carrying it: the same "pending"
    // idiom SuppressionService projects with, so a repeat POST writes no second
    // ConsentRecord while the end state is identical.
    expect(prisma.lead.updateMany).toHaveBeenCalledWith({
      where: { id: 'lead-1', workspaceId: WS, waOptOut: false },
      data: { waOptOut: true },
    });
    // Non-SMS channels never trigger the NetGSM blacklist-sync event.
    expect(outbox.append).not.toHaveBeenCalled();
    expect(iysSync.enqueueConsent).not.toHaveBeenCalled();
  });

  it('SMS unsubscribe enqueues marketing.sms.optout.v1 keyed on the recipient id', async () => {
    prisma.campaignRecipient.findUnique.mockResolvedValue({ id: 'r1', campaignId: 'c1', workspaceId: WS, leadId: 'lead-1', status: 'SENT' });
    prisma.campaign.findFirst.mockResolvedValue({ channel: 'SMS' });
    await expect(svc.unsubscribe('tok')).resolves.toBe(true);
    expect(prisma.lead.updateMany).toHaveBeenCalledWith({
      where: { id: 'lead-1', workspaceId: WS, smsOptOut: false },
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
      where: { id: 'lead-1', workspaceId: WS, smsOptOut: false },
      data: { smsOptOut: true },
    });
    // The read failure must not skip the UNSUBSCRIBED status bump either.
    expect(prisma.campaignRecipient.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'r1', status: { not: 'UNSUBSCRIBED' } } }),
    );
  });

  // Phase 2 Task 3 — İYS auto-push: a public SMS unsubscribe is always a
  // revoke (RET), enqueued via IysSyncService inside the SAME transaction as
  // the smsOptOut flip + blacklist-mirror event, in its own savepoint.
  it('SMS unsubscribe enqueues an İYS RET job for the lead', async () => {
    prisma.campaignRecipient.findUnique.mockResolvedValue({ id: 'r1', campaignId: 'c1', workspaceId: WS, leadId: 'lead-1', status: 'SENT' });
    prisma.campaign.findFirst.mockResolvedValue({ channel: 'SMS' });

    await expect(svc.unsubscribe('tok')).resolves.toBe(true);

    expect(iysSync.enqueueConsent).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        workspaceId: WS,
        leadId: 'lead-1',
        recipient: '05551112233',
        direction: 'RET',
        source: 'HS_MESAJ',
      }),
    );
  });

  it('non-SMS unsubscribe never enqueues an İYS job', async () => {
    prisma.campaignRecipient.findUnique.mockResolvedValue({ id: 'r1', campaignId: 'c1', workspaceId: WS, leadId: 'lead-1', status: 'SENT' });
    prisma.campaign.findFirst.mockResolvedValue({ channel: 'EMAIL' });

    await expect(svc.unsubscribe('tok')).resolves.toBe(true);

    expect(iysSync.enqueueConsent).not.toHaveBeenCalled();
  });

  it('does not fail the unsubscribe when the İYS enqueue throws', async () => {
    prisma.campaignRecipient.findUnique.mockResolvedValue({ id: 'r1', campaignId: 'c1', workspaceId: WS, leadId: 'lead-1', status: 'SENT' });
    prisma.campaign.findFirst.mockResolvedValue({ channel: 'SMS' });
    iysSync.enqueueConsent.mockRejectedValue(new Error('iys down'));

    await expect(svc.unsubscribe('tok')).resolves.toBe(true);
    // The outbox mirror and the status bump are unaffected by the İYS failure.
    expect(prisma.lead.updateMany).toHaveBeenCalledWith({
      where: { id: 'lead-1', workspaceId: WS, smsOptOut: false },
      data: { smsOptOut: true },
    });
  });

  /**
   * `unsubscribe-deleted-campaign`: the channel is frozen onto the recipient at
   * launch, so deleting the campaign can no longer turn an email opt-out into a
   * WhatsApp one — and the orphan fallback never guesses its way onto the SMS
   * path, which would push an İYS RET and an ACCOUNT-WIDE NetGSM blacklist (it
   * would kill the customer's OTP messages too).
   */
  describe('channel resolution survives a deleted campaign', () => {
    it('uses the recipient\'s frozen channel without reading the campaign at all', async () => {
      prisma.campaignRecipient.findUnique.mockResolvedValue({ id: 'r1', campaignId: 'gone', workspaceId: WS, leadId: 'lead-1', status: 'SENT', channel: 'EMAIL' });
      prisma.lead.findFirst.mockResolvedValue({ email: 'a@b.com', emailNormalized: 'a@b.com' });

      await expect(svc.unsubscribe('tok')).resolves.toBe(true);

      expect(prisma.campaign.findFirst).not.toHaveBeenCalled();
      expect(suppression.suppress).toHaveBeenCalledWith(
        WS,
        'a@b.com',
        'EMAIL',
        'OPT_OUT',
        expect.objectContaining({ leadId: 'lead-1', source: 'unsubscribe-link' }),
      );
    });

    it('falls back to emailOptOut — never waOptOut — for a legacy row whose campaign is gone', async () => {
      prisma.campaignRecipient.findUnique.mockResolvedValue({ id: 'r1', campaignId: 'gone', workspaceId: WS, leadId: 'lead-1', status: 'SENT', channel: null });
      prisma.campaign.findFirst.mockResolvedValue(null); // the campaign was deleted

      await expect(svc.unsubscribe('tok')).resolves.toBe(true);

      expect(prisma.lead.updateMany).toHaveBeenCalledWith({
        where: { id: 'lead-1', workspaceId: WS, emailOptOut: false },
        data: { emailOptOut: true },
      });
      // The guess must not reach the SMS mirrors. (The EMAIL branch DOES emit
      // its own `marketing.email.unsubscribed.v1`, so the assertion names the
      // event it must not raise rather than counting appends.)
      expect(outbox.append).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'marketing.sms.optout.v1' }),
        expect.anything(),
      );
      expect(iysSync.enqueueConsent).not.toHaveBeenCalled();
    });

    it('treats an unrecognised channel as EMAIL rather than WhatsApp', async () => {
      prisma.campaignRecipient.findUnique.mockResolvedValue({ id: 'r1', campaignId: 'c1', workspaceId: WS, leadId: 'lead-1', status: 'SENT', channel: 'PIGEON' });
      prisma.lead.findFirst.mockResolvedValue({ email: 'a@b.com', emailNormalized: 'a@b.com' });

      await expect(svc.unsubscribe('tok')).resolves.toBe(true);

      expect(suppression.suppress).toHaveBeenCalledWith(WS, 'a@b.com', 'EMAIL', 'OPT_OUT', expect.anything());
      expect(prisma.lead.updateMany).not.toHaveBeenCalled();
    });

    it('maps VOICE onto smsOptOut (the flag its own audience gate reads) without the SMS mirrors', async () => {
      prisma.campaignRecipient.findUnique.mockResolvedValue({ id: 'r1', campaignId: 'c1', workspaceId: WS, leadId: 'lead-1', status: 'SENT', channel: 'VOICE' });

      await expect(svc.unsubscribe('tok')).resolves.toBe(true);

      expect(prisma.lead.updateMany).toHaveBeenCalledWith({
        where: { id: 'lead-1', workspaceId: WS, smsOptOut: false },
        data: { smsOptOut: true },
      });
      // "Stop calling me" must not blacklist the number for SMS at the provider.
      expect(outbox.append).not.toHaveBeenCalled();
      expect(iysSync.enqueueConsent).not.toHaveBeenCalled();
    });
  });

  /**
   * `unsubscribe-no-consent-record`: the flag is never flipped without a dated,
   * sourced ConsentRecord behind it, and a retried One-Click POST must not
   * append a second one.
   */
  describe('the withdrawal is recorded in the consent ledger', () => {
    it('routes an EMAIL opt-out through SuppressionService, which owns the ledger row', async () => {
      prisma.campaignRecipient.findUnique.mockResolvedValue({ id: 'r1', campaignId: 'c1', workspaceId: WS, leadId: 'lead-1', status: 'SENT', channel: 'EMAIL' });
      prisma.lead.findFirst.mockResolvedValue({ email: 'Person@Acme.COM', emailNormalized: 'person@acme.com' });

      await svc.unsubscribe('tok');

      // Address-level: every lead on file under that address opts out, not just
      // the one the click came through (`optout-per-lead-row`).
      expect(suppression.suppress).toHaveBeenCalledWith(
        WS,
        'person@acme.com',
        'EMAIL',
        'OPT_OUT',
        expect.objectContaining({ leadId: 'lead-1' }),
      );
      expect(prisma.lead.updateMany).not.toHaveBeenCalled();
    });

    it('still flips the flag and records consent when the lead has no address on file', async () => {
      prisma.campaignRecipient.findUnique.mockResolvedValue({ id: 'r1', campaignId: 'c1', workspaceId: WS, leadId: 'lead-1', status: 'SENT', channel: 'EMAIL' });
      prisma.lead.findFirst.mockResolvedValue({ email: null, emailNormalized: null });

      await svc.unsubscribe('tok');

      expect(suppression.suppress).not.toHaveBeenCalled();
      expect(ledger.record).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: WS, leadIds: ['lead-1'], type: 'MARKETING_EMAIL', granted: false }),
        expect.anything(),
      );
    });

    it('writes no second ledger row when the flag was already set (a retried One-Click POST)', async () => {
      prisma.campaignRecipient.findUnique.mockResolvedValue({ id: 'r1', campaignId: 'c1', workspaceId: WS, leadId: 'lead-1', status: 'UNSUBSCRIBED', channel: 'WHATSAPP' });
      prisma.lead.updateMany.mockResolvedValue({ count: 0 }); // nothing left to flip

      await expect(svc.unsubscribe('tok')).resolves.toBe(true);

      expect(ledger.record).not.toHaveBeenCalled();
      // A second POST is idempotent: no second counter bump either.
      expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
    });

    it('records an SMS withdrawal inside the same transaction as the flip', async () => {
      prisma.campaignRecipient.findUnique.mockResolvedValue({ id: 'r1', campaignId: 'c1', workspaceId: WS, leadId: 'lead-1', status: 'SENT', channel: 'SMS' });

      await svc.unsubscribe('tok');

      expect(ledger.record).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: WS, leadIds: ['lead-1'], type: 'MARKETING_SMS', granted: false }),
        prisma, // the tx client
      );
    });
  });

  /**
   * R1 — the lead-scoped token. Workflow/drip mail has no CampaignRecipient
   * row, so its footer link carries a signed lead token instead. Without this
   * branch that link resolves to "Link expired": an unsubscribe request that
   * visibly does nothing, which is worse than no link at all.
   */
  describe('lead-scoped unsubscribe token', () => {
    const OLD_KEY = process.env.MARKETING_SECRET_KEY;

    beforeAll(() => {
      process.env.MARKETING_SECRET_KEY = Buffer.from('unit-test-master-key').toString('base64');
    });
    afterAll(() => {
      if (OLD_KEY === undefined) delete process.env.MARKETING_SECRET_KEY;
      else process.env.MARKETING_SECRET_KEY = OLD_KEY;
    });

    it('opts the lead out with no CampaignRecipient row anywhere', async () => {
      prisma.campaignRecipient.findUnique.mockResolvedValue(null);
      prisma.lead.findFirst.mockResolvedValue({ email: 'drip@acme.com', emailNormalized: 'drip@acme.com' });
      const token = signLeadUnsubscribeToken(WS, 'lead-9')!;

      await expect(svc.unsubscribe(token)).resolves.toBe(true);

      expect(suppression.suppress).toHaveBeenCalledWith(
        WS,
        'drip@acme.com',
        'EMAIL',
        'OPT_OUT',
        expect.objectContaining({ leadId: 'lead-9', source: 'lead-token' }),
      );
      // There is no recipient row to claim and no campaign counter to bump.
      expect(prisma.campaignRecipient.updateMany).not.toHaveBeenCalled();
      expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
    });

    it('is workspace-bound: the signature covers the tenant', async () => {
      prisma.campaignRecipient.findUnique.mockResolvedValue(null);
      const token = signLeadUnsubscribeToken(WS, 'lead-9')!;
      // Re-point the payload at another tenant: the MAC no longer matches.
      const forged = `${Buffer.from(JSON.stringify({ w: 'ws-other', l: 'lead-9', c: 'EMAIL' })).toString('base64url')}.${token.split('.')[1]}`;

      await expect(svc.unsubscribe(forged)).resolves.toBe(false);
      expect(suppression.suppress).not.toHaveBeenCalled();
    });

    it('returns false for a token that is neither a recipient token nor a signed lead token', async () => {
      prisma.campaignRecipient.findUnique.mockResolvedValue(null);
      await expect(svc.unsubscribe('cr_nope')).resolves.toBe(false);
    });
  });

  /**
   * The confirm page is recipient-facing, so it speaks the workspace's language
   * (G8). Resolving it must never be able to break the unsubscribe itself.
   */
  describe('pageLang', () => {
    it('resolves the language of the recipient\'s workspace', async () => {
      prisma.campaignRecipient.findUnique.mockResolvedValue({ id: 'r1', campaignId: 'c1', workspaceId: WS, leadId: 'lead-1', status: 'SENT', channel: 'EMAIL' });
      prisma.workspace.findUnique.mockResolvedValue({ defaultLanguage: 'tr' });
      await expect(svc.pageLang('tok')).resolves.toBe('tr');
    });

    it('falls back to English for an unknown token and never throws on a DB failure', async () => {
      prisma.campaignRecipient.findUnique.mockResolvedValue(null);
      await expect(svc.pageLang('nope')).resolves.toBe('en');

      prisma.campaignRecipient.findUnique.mockRejectedValue(new Error('db down'));
      await expect(svc.pageLang('tok')).resolves.toBe('en');
    });
  });

  /**
   * `unsubscribe-post-swallows`: the controller turns a thrown error into a
   * retryable 5xx, so the service must keep propagating a real DB failure
   * instead of reporting a success it did not achieve.
   */
  it('propagates a DB failure rather than reporting a successful opt-out', async () => {
    prisma.campaignRecipient.findUnique.mockResolvedValue({ id: 'r1', campaignId: 'c1', workspaceId: WS, leadId: 'lead-1', status: 'SENT', channel: 'EMAIL' });
    prisma.lead.findFirst.mockResolvedValue({ email: 'a@b.com', emailNormalized: 'a@b.com' });
    suppression.suppress.mockRejectedValue(new Error('db down'));

    await expect(svc.unsubscribe('tok')).rejects.toThrow('db down');
  });

  /**
   * `click-not-open`: a reader whose client blocks images never loads the
   * pixel, so a campaign that was read and acted on reported "opened 0,
   * clicked 40". A click is proof of an open — claimed, never set, so the
   * pixel and the click racing each other still count one unique open.
   */
  describe('a click implies an open', () => {
    const emailClick = (over: any = {}) => {
      prisma.campaignRecipient.findUnique.mockResolvedValue({
        id: 'r1', campaignId: 'c1', workspaceId: WS, leadId: 'lead-1', openedAt: null, clickedAt: null, sentAt: null, ...over,
      });
      prisma.campaign.findFirst.mockResolvedValue({ links: ['https://shop.example/pricing'], channel: 'EMAIL' });
    };
    /** Which counters the run bumped, in order. */
    const bumped = () => (prisma.$executeRawUnsafe as jest.Mock).mock.calls.map((c: any[]) => c[1]);

    it('claims openedAt on the same conditional idiom the pixel uses, and bumps both counters', async () => {
      emailClick();
      await expect(svc.click('tok', 0, HUMAN)).resolves.toBe('https://shop.example/pricing');
      expect(prisma.campaignRecipient.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'r1', openedAt: null } }),
      );
      expect(bumped()).toEqual(expect.arrayContaining(['opened', 'clicked']));
    });

    it('does not bump opened when the open claim loses the race with the pixel', async () => {
      emailClick();
      prisma.campaignRecipient.updateMany.mockImplementation(async ({ where }: any) =>
        'openedAt' in where ? { count: 0 } : { count: 1 },
      );
      await svc.click('tok', 0, HUMAN);
      expect(bumped()).toEqual(['clicked']);
    });

    it('still claims the first open on a SECOND click (the claim is outside the clickedAt guard)', async () => {
      emailClick({ clickedAt: new Date('2026-01-01T00:00:00Z') });
      await svc.click('tok', 0, HUMAN);
      // Nothing left to claim on the click, everything left to claim on the open.
      expect(bumped()).toEqual(['opened']);
    });

    it('never fabricates an open on a channel that has none (SMS)', async () => {
      emailClick();
      prisma.campaign.findFirst.mockResolvedValue({ links: ['https://shop.example/pricing'], channel: 'SMS' });
      await expect(svc.click('tok', 0, HUMAN)).resolves.toBe('https://shop.example/pricing');
      expect(bumped()).toEqual(['clicked']);
      expect(prisma.campaignRecipient.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ openedAt: null }) }),
      );
      // …and an SMS click is not an "email.clicked" either.
      expect(outbox.append).not.toHaveBeenCalled();
    });
  });

  /**
   * `engagement-unqualified`: a mail-security scanner and an image proxy hit
   * the same URLs a person does. A hit we can NAME as a machine is not
   * recorded at all — deliberately not stamped onto the row either, so the
   * later genuine hit can still claim the open (a flag written from the first
   * hit would hide that person's engagement forever).
   */
  describe('machine hits do not count as engagement', () => {
    beforeEach(() => {
      prisma.campaignRecipient.findUnique.mockResolvedValue({
        id: 'r1', campaignId: 'c1', workspaceId: WS, leadId: 'lead-1', openedAt: null, clickedAt: null, sentAt: null,
      });
      prisma.campaign.findFirst.mockResolvedValue({ links: ['https://shop.example/pricing'], channel: 'EMAIL' });
    });

    it('a HEAD request on the pixel records nothing', async () => {
      await svc.open('tok', { method: 'HEAD', ua: 'Mozilla/5.0' });
      expect(prisma.campaignRecipient.updateMany).not.toHaveBeenCalled();
      expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
      expect(outbox.append).not.toHaveBeenCalled();
    });

    it.each([
      ['a link scanner', 'Mozilla/5.0 (compatible; Barracuda Sentinel; +https://barracuda.com)'],
      ['a URL rewriter', 'Mozilla/5.0 urldefense.proofpoint.com'],
      ['a crawler', 'Mozilla/5.0 (compatible; SomeBot/2.1; +http://bot.example)'],
      ['a script', 'curl/8.4.0'],
    ])('%s does not record an open', async (_label, ua) => {
      await svc.open('tok', { method: 'GET', ua });
      expect(prisma.campaignRecipient.updateMany).not.toHaveBeenCalled();
      expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
    });

    it('a delivery-time prefetch (a hit within seconds of the send) does not record an open', async () => {
      prisma.campaignRecipient.findUnique.mockResolvedValue({
        id: 'r1', campaignId: 'c1', workspaceId: WS, leadId: 'lead-1', openedAt: null, sentAt: new Date(),
      });
      await svc.open('tok', HUMAN);
      expect(prisma.campaignRecipient.updateMany).not.toHaveBeenCalled();
    });

    it('a scanner click still resolves the destination — only the counting stops', async () => {
      await expect(svc.click('tok', 0, { method: 'GET', ua: 'curl/8.4.0' })).resolves.toBe(
        'https://shop.example/pricing',
      );
      expect(prisma.campaignRecipient.updateMany).not.toHaveBeenCalled();
      expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
    });

    it.each([
      // The Gmail image proxy fetch IS the open — it happens when the mail is
      // displayed. Reading it as a machine would zero every Gmail open.
      ['the Gmail image proxy', 'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)'],
      ['a phone that happens to be a Cubot', 'Mozilla/5.0 (Linux; Android 13; Cubot X30) AppleWebKit/537.36'],
      ['a client that sends no User-Agent at all', undefined],
    ])('%s still counts', async (_label, ua) => {
      await svc.open('tok', { method: 'GET', ua: ua ?? null });
      expect(prisma.campaignRecipient.updateMany).toHaveBeenCalled();
    });

    it('counts the hit when the caller says nothing about it (an old call site)', async () => {
      await svc.open('tok');
      expect(prisma.campaignRecipient.updateMany).toHaveBeenCalled();
    });
  });

  /**
   * `no-email-event-triggers`: "clicked the pricing link → create a call task"
   * could not be built at all. The event carries the URL, so the filter
   * `trigger.url contains /pricing` works with no DSL change, and it is keyed
   * so a redelivery cannot start a second run.
   */
  describe('email engagement raises workflow trigger events', () => {
    beforeEach(() => {
      prisma.campaignRecipient.findUnique.mockResolvedValue({
        id: 'r1', campaignId: 'c1', workspaceId: WS, leadId: 'lead-1', openedAt: null, clickedAt: null, sentAt: null, status: 'SENT', channel: 'EMAIL',
      });
      prisma.campaign.findFirst.mockResolvedValue({ links: ['https://shop.example/pricing'], channel: 'EMAIL' });
    });
    const appended = (type: string) =>
      (outbox.append as jest.Mock).mock.calls.filter((c: any[]) => c[0]?.type === type);

    it('a human open emits marketing.email.opened.v1, keyed on the recipient', async () => {
      await svc.open('tok', HUMAN);
      expect(appended('marketing.email.opened.v1')).toHaveLength(1);
      expect(outbox.append).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'marketing.email.opened.v1',
          idempotencyKey: 'ws-1:marketing.email.opened.v1:r1',
          payload: expect.objectContaining({ workspaceId: WS, leadId: 'lead-1', campaignId: 'c1', recipientId: 'r1' }),
        }),
      );
    });

    it('does not emit when the open claim was already taken', async () => {
      prisma.campaignRecipient.updateMany.mockResolvedValue({ count: 0 });
      await svc.open('tok', HUMAN);
      expect(appended('marketing.email.opened.v1')).toHaveLength(0);
    });

    it('a click emits marketing.email.clicked.v1 carrying the destination and its index', async () => {
      await svc.click('tok', 0, HUMAN);
      expect(outbox.append).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'marketing.email.clicked.v1',
          // Per LINK, so "clicked pricing" still fires for someone who clicked
          // another link first — and a double-click still collapses into one.
          idempotencyKey: 'ws-1:marketing.email.clicked.v1:r1:0',
          payload: expect.objectContaining({ url: 'https://shop.example/pricing', linkIndex: 0 }),
        }),
      );
      // The click is an open too, so both triggers fire from one hit.
      expect(appended('marketing.email.opened.v1')).toHaveLength(1);
    });

    it('a machine hit raises nothing', async () => {
      await svc.click('tok', 0, { method: 'HEAD', ua: null });
      expect(outbox.append).not.toHaveBeenCalled();
    });

    it('an EMAIL unsubscribe emits marketing.email.unsubscribed.v1', async () => {
      prisma.lead.findFirst.mockResolvedValue({ email: 'a@b.com', emailNormalized: 'a@b.com' });
      await svc.unsubscribe('tok');
      expect(outbox.append).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'marketing.email.unsubscribed.v1',
          idempotencyKey: 'ws-1:marketing.email.unsubscribed.v1:r1',
          payload: expect.objectContaining({ workspaceId: WS, leadId: 'lead-1', campaignId: 'c1', recipientId: 'r1' }),
        }),
      );
    });

    it('an SMS unsubscribe raises no email event (SmsOptedOut already covers it)', async () => {
      prisma.campaignRecipient.findUnique.mockResolvedValue({ id: 'r1', campaignId: 'c1', workspaceId: WS, leadId: 'lead-1', status: 'SENT', channel: 'SMS' });
      await svc.unsubscribe('tok');
      expect(appended('marketing.email.unsubscribed.v1')).toHaveLength(0);
    });

    it('a lead-token unsubscribe (drip mail, no recipient row) emits it keyed on the lead', async () => {
      const OLD = process.env.MARKETING_SECRET_KEY;
      process.env.MARKETING_SECRET_KEY = Buffer.from('unit-test-master-key').toString('base64');
      try {
        prisma.campaignRecipient.findUnique.mockResolvedValue(null);
        prisma.lead.findFirst.mockResolvedValue({ email: 'drip@acme.com', emailNormalized: 'drip@acme.com' });
        await svc.unsubscribe(signLeadUnsubscribeToken(WS, 'lead-9')!);
        expect(outbox.append).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'marketing.email.unsubscribed.v1',
            idempotencyKey: 'ws-1:marketing.email.unsubscribed.v1:lead:lead-9',
            payload: expect.objectContaining({ leadId: 'lead-9', campaignId: null, recipientId: null }),
          }),
        );
      } finally {
        if (OLD === undefined) delete process.env.MARKETING_SECRET_KEY;
        else process.env.MARKETING_SECRET_KEY = OLD;
      }
    });

    it('never lets a failed append break the tracking hit it rode on', async () => {
      outbox.append.mockRejectedValue(new Error('outbox down'));
      await expect(svc.open('tok', HUMAN)).resolves.toBeUndefined();
      await expect(svc.click('tok', 0, HUMAN)).resolves.toBe('https://shop.example/pricing');
      prisma.lead.findFirst.mockResolvedValue({ email: 'a@b.com', emailNormalized: 'a@b.com' });
      await expect(svc.unsubscribe('tok')).resolves.toBe(true);
    });
  });
});
