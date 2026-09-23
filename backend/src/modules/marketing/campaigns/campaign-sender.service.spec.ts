import { CampaignSenderService, BATCH_BUDGET_MS } from './campaign-sender.service';
import { MailReceipt } from '../channels/outbound/outbound-mail.types';

/** A gateway receipt, in the shape the sender reads it. */
function receipt(patch: Partial<MailReceipt> = {}): MailReceipt {
  return {
    outcome: 'SENT',
    ok: true,
    mailLogId: 'ml-1',
    messageId: 'm1',
    transport: 'PLATFORM',
    retriable: false,
    ...patch,
  } as MailReceipt;
}

/** A refusal/failure receipt: `ok` follows the outcome, never the caller. */
function refused(patch: Partial<MailReceipt>): MailReceipt {
  return receipt({ outcome: 'REFUSED', ok: false, messageId: null, transport: 'NONE', ...patch });
}

/**
 * The batch sender: it re-checks opt-out at send time (the audience froze
 * earlier), sends the rest, and completes the campaign when no PENDING
 * recipients remain.
 */
describe('CampaignSenderService.batch', () => {
  const WS = 'ws-1';
  let prisma: any;
  let outboundMail: { send: jest.Mock };
  let quota: { reserve: jest.Mock; refund: jest.Mock };
  let scheduledJobs: { schedule: jest.Mock };
  let conversationSpend: { settleCampaignSms: jest.Mock };
  let registry: { get: jest.Mock; resolveConfig: jest.Mock };
  let svc: CampaignSenderService;

  /** Every revert is compound-scoped; this is how the tests find one. */
  const revertCalls = () =>
    prisma.campaignRecipient.updateMany.mock.calls.filter((c: any) => c[0]?.data?.status === 'PENDING' && c[0]?.where?.id);

  beforeEach(() => {
    prisma = {
      campaign: {
        findFirst: jest.fn().mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'SENDING', channel: 'EMAIL', subject: 'S', body: 'Hi', links: [] }),
        findUnique: jest.fn().mockResolvedValue({ stats: {} }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      // The workspace kill switch the batch preflight reads. ACTIVE and
      // unpaused is what every existing row looks like.
      workspace: { findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE', settings: {}, name: 'Acme' }) },
      campaignRecipient: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'r1', leadId: 'l1', token: 't1' },
          { id: 'r2', leadId: 'l2', token: 't2' },
        ]),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      campaignVariant: {
        findMany: jest.fn().mockResolvedValue([]), // no A/B variants by default
        update: jest.fn().mockResolvedValue({}),
      },
      lead: {
        findFirst: jest.fn().mockImplementation(async ({ where }: any) =>
          where.id === 'l1'
            ? { id: 'l1', email: 'opt@out.com', emailOptOut: true }
            : { id: 'l2', email: 'ok@lead.com', emailOptOut: false },
        ),
      },
      // No connected mailbox by default, so these tests keep exercising the
      // PLATFORM transport. The workspace-mailbox route has its own block.
      channel: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    // WHICH transport carries the mail is the gateway's question now
    // (SenderIdentityService + its spec); the sender's job is to ask once per
    // recipient and to honour the receipt.
    outboundMail = { send: jest.fn().mockResolvedValue(receipt()) };
    // A base URL is required now — the sender refuses to send without one (the
    // unsubscribe link is mandatory and built from PUBLIC_BASE_URL).
    const config = { get: jest.fn().mockReturnValue('https://m.test') };
    scheduledJobs = { schedule: jest.fn() };
    const runner = { registerHandler: jest.fn() };
    registry = { get: jest.fn(), resolveConfig: jest.fn() };
    quota = { reserve: jest.fn(), refund: jest.fn() };
    // Unused by this describe block's EMAIL-only fixtures (the SMS v2 batch
    // path is only entered for campaign.channel === 'SMS' — see the dedicated
    // 'SMS v2 batching' describe below), but still required by the constructor.
    const smsV2 = { send: jest.fn() };
    conversationSpend = { settleCampaignSms: jest.fn().mockResolvedValue({ amount: 1, quantity: 1, unitCost: 1 }) };
    // Unused by this describe block's EMAIL-only fixtures (the TİCARİ İYS
    // preflight only runs for campaign.channel === 'SMS' — see the dedicated
    // 'SMS v2 batching' describe below), but still required by the constructor.
    const iysClient = { search: jest.fn() };
    const budgeter = { tryTake: jest.fn().mockReturnValue(true) };
    // Unused by this describe block's EMAIL-only fixtures (the VOICE branch
    // only runs for campaign.channel === 'VOICE' — see the dedicated 'VOICE
    // campaign sends' describe below), but still required by the constructor.
    const voicesmsSend = { send: jest.fn() };
    svc = new CampaignSenderService(
      prisma as any, config as any, outboundMail as any, scheduledJobs as any, runner as any, registry as any, quota as any, smsV2 as any, conversationSpend as any, iysClient as any, budgeter as any, voicesmsSend as any,
    );
  });

  /**
   * The open pixel. Everything downstream of it already exists and has for a
   * long time: CampaignTrackingService.open() claims `openedAt` race-safely,
   * the public `t/o/:token` route serves a real 1x1 GIF, recomputeStats counts
   * the column, and decideAbWinner sorts on the number it produces. The one
   * thing missing was the `<img>` that would ever cause any of it to fire — so
   * `openedAt` was structurally always null and every open count was a zero
   * that looked measured.
   */
  describe('renderHtml — the open pixel', () => {
    const doc = '<html><body><p>Hi</p></body></html>';

    it('embeds the tracking pixel, so an open can be recorded at all', () => {
      const out = (svc as any).renderHtml(doc, 'tok-1', []);
      expect(out).toMatch(/<img[^>]+src="https:\/\/m\.test\/api\/public\/t\/o\/tok-1"/);
    });

    it('puts the pixel INSIDE the document, not after it', () => {
      // Markup appended past </body> is at the mercy of every client's sanitiser;
      // the unsubscribe footer is injected before the tag for the same reason.
      const out = (svc as any).renderHtml(doc, 'tok-1', []);
      const at = out.indexOf('t/o/tok-1');
      // Asserted explicitly: a missing pixel gives -1, which would otherwise sail
      // through the ordering check below and make this test prove nothing.
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(out.indexOf('</body>'));
    });

    it('still carries the pixel on a hand-authored fragment with no </body>', () => {
      const out = (svc as any).renderHtml('<p>Hi</p>', 'tok-2', []);
      expect(out).toContain('/api/public/t/o/tok-2');
    });

    it('keeps the click rewriting and the unsubscribe footer it already did', () => {
      // The pixel is an addition, not a replacement: these two were the whole
      // job of this method before and must survive it untouched.
      const out = (svc as any).renderHtml(
        '<html><body><a href="https://shop.test/x">Buy</a></body></html>',
        'tok-3',
        ['https://shop.test/x'],
      );
      expect(out).toContain('https://m.test/api/public/t/c/tok-3?i=0');
      expect(out).toContain('https://m.test/api/public/u/tok-3');
    });
  });

  // Campaign email used to be the ONLY outbound channel with no meter: the
  // EMAIL branch returned before the reserve, so `messagesMonthly` never saw
  // it. The economics were inverted — SMS/WhatsApp bill to the CUSTOMER's own
  // provider account and were metered; email leaves on JEETA's SMTP account
  // and was unlimited.
  it('meters every campaign email against the monthly message quota', async () => {
    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    expect(outboundMail.send).toHaveBeenCalledTimes(1);
    expect(quota.reserve).toHaveBeenCalledTimes(1);
    expect(quota.reserve).toHaveBeenCalledWith(WS, 'EMAIL');
    // A delivered message is not refunded.
    expect(quota.refund).not.toHaveBeenCalled();
  });

  it('tells the gateway the quota is already spent, so a campaign is never metered twice', async () => {
    // The sender reserves per recipient before it asks (it always has, and its
    // refund pairing is built around that); `alreadyMetered` is how the gate is
    // told not to reserve a second unit for the same mail.
    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });
    expect(outboundMail.send.mock.calls[0][0]).toMatchObject({ mailClass: 'BULK', alreadyMetered: true });
  });

  it('gives the gateway the same unsubscribe URL the body carries — bulk is bulk on either route', async () => {
    // Without this, whether a recipient's client offers an Unsubscribe button
    // would depend on which transport happened to carry the mail: the workspace
    // mailbox or ours. Same campaign, same obligation — and BULK fails closed
    // at the gate without a token, so this is load-bearing, not decoration.
    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });
    expect(outboundMail.send.mock.calls[0][0]).toMatchObject({
      to: 'ok@lead.com',
      subject: 'S',
      leadId: 'l2',
      source: 'campaign:c1',
      unsubscribe: { token: 't2', url: 'https://m.test/api/public/u/t2' },
    });
    expect(outboundMail.send.mock.calls[0][0].text).toContain('https://m.test/api/public/u/t2');
  });

  /**
   * A campaign writes its error onto EVERY recipient row.
   *
   * "email send failed" repeated three hundred times says only that something
   * is wrong. When the mailer itself is down — as it is right now, live: 535
   * Authentication Failed — all three hundred share ONE cause, and the
   * provider's own line is what turns a wall of identical rows into a single
   * fixable fact.
   */
  /**
   * WHO the mail is from, and which transport carries it, moved to the gateway
   * (SenderIdentityService + its spec) — this file used to resolve the
   * workspace mailbox, the sending domain and the platform fallback itself, in
   * a copy of the ladder three other callers each had their own version of.
   * What this block pins is what remains the sender's job: ask once per
   * recipient, and honour the receipt.
   */
  describe('the outbound gateway', () => {
    it('asks it once per sendable recipient instead of picking a transport itself', async () => {
      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });
      expect(outboundMail.send).toHaveBeenCalledTimes(1);
      // The mailbox / sending-domain ladder is not this service's business any
      // more; nothing here resolves a channel for an EMAIL campaign.
      expect(registry.get).not.toHaveBeenCalled();
    });

    it('hands it THIS recipient’s unsubscribe token, so the mail can carry List-Unsubscribe', async () => {
      // Per-recipient, because the token is what identifies who is opting out —
      // a shared campaign-level link could not tell the sender who clicked.
      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });
      expect(outboundMail.send.mock.calls[0][0].unsubscribe).toEqual({
        token: 't2',
        url: 'https://m.test/api/public/u/t2',
      });
    });

    it('records the message id the receipt reports, whichever transport earned it', async () => {
      // The one observable that answers "which address did this actually leave
      // from" after the fact. Without it the only way to find out is to open
      // the mail — which is the position this feature was written in.
      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });
      const ids = prisma.campaignRecipient.update.mock.calls
        .map((c: any) => c[0].data.messageId)
        .filter(Boolean);
      expect(ids).toContain('m1');
    });

    it('carries the campaign’s own subject, not a thread default', async () => {
      // The adapter was built for inbound replies, where the subject belongs to
      // the thread and lives on the channel config. A campaign has a different
      // one per send, which that shape could not express.
      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });
      expect(outboundMail.send.mock.calls[0][0]).toMatchObject({ subject: 'S', to: 'ok@lead.com' });
    });

    it('a NOT_CONFIGURED receipt leaves the recipient PENDING instead of burning it FAILED', async () => {
      // There is no transport at all — a deploy problem, not this recipient's
      // problem. Marking 2,000 rows FAILED for it destroys the audience, and
      // FAILED rows are never re-sent.
      outboundMail.send.mockResolvedValue(
        receipt({ outcome: 'FAILED_PERMANENT', ok: false, messageId: null, transport: 'NONE', reason: 'NOT_CONFIGURED' }),
      );
      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

      const statuses = prisma.campaignRecipient.update.mock.calls.map((c: any) => c[0].data.status);
      expect(statuses).not.toContain('FAILED');
      expect(revertCalls()).toHaveLength(1);
    });

    it('records the provider’s own line on the recipient row, not a generic string', async () => {
      // A campaign writes its error onto EVERY recipient row. "email send
      // failed" repeated three hundred times says only that something is wrong;
      // the provider's own line says WHICH thing — and when the mailer itself
      // is down, all three hundred share one cause.
      outboundMail.send.mockResolvedValue(
        receipt({
          outcome: 'FAILED_TRANSIENT',
          ok: false,
          messageId: null,
          reason: 'SYSTEMIC',
          error: 'Invalid login: 535 Authentication Failed for admin@jeetagrowth.com',
          retriable: false,
        }),
      );
      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

      expect(quota.refund).toHaveBeenCalledWith(WS, 'EMAIL');
      const errors = revertCalls().map((c: any) => c[0].data.error);
      expect(errors.join(' ')).toContain('535 Authentication Failed');
    });

    it('falls back to the reason code when the provider gave no words of its own', async () => {
      outboundMail.send.mockResolvedValue(
        receipt({ outcome: 'FAILED_PERMANENT', ok: false, messageId: null, reason: 'PERMANENT' }),
      );
      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

      const errors = prisma.campaignRecipient.update.mock.calls
        .map((c: any) => c[0].data.error)
        .filter(Boolean);
      expect(errors).toContain('PERMANENT');
    });
  });

  it('refunds the message quota when the email does not go out', async () => {
    outboundMail.send.mockResolvedValue(
      receipt({ outcome: 'FAILED_PERMANENT', ok: false, messageId: null, reason: 'PERMANENT' }),
    );

    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    expect(quota.reserve).toHaveBeenCalledWith(WS, 'EMAIL');
    expect(quota.refund).toHaveBeenCalledWith(WS, 'EMAIL');
  });

  it('refunds the message quota when the gateway deduped the send — one mail, one unit', async () => {
    // The crash window the idempotency key exists for: the relay took the mail
    // and the MailLog settled SENT, but the process died before the recipient
    // row was marked, so the stranded-SENDING sweep re-queues it and the row is
    // sent again. The gateway correctly dispatches NOTHING and answers DEDUPED
    // — but DEDUPED is `ok: true`, so a refund keyed on `!ok` keeps the second
    // reserved unit. The customer got one email; the tenant's plan was debited
    // twice, and the ledger shows a single SENT MailLog row, so nothing says so.
    outboundMail.send.mockResolvedValue(receipt({ outcome: 'DEDUPED', ok: true, messageId: null }));

    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    expect(quota.reserve).toHaveBeenCalledTimes(1);
    expect(quota.refund).toHaveBeenCalledTimes(1);
    expect(quota.refund).toHaveBeenCalledWith(WS, 'EMAIL');
    // And the row still settles as delivered: it really did reach the customer
    // on the first attempt, so it must never be re-queued.
    expect(prisma.campaignRecipient.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'r2' }, data: expect.objectContaining({ status: 'SENT' }) }),
    );
  });

  it('refunds the message quota when the gateway itself throws', async () => {
    // The gateway is documented never to throw; this is the backstop that keeps
    // a broken promise from leaking a reserved message unit.
    outboundMail.send.mockRejectedValue(new Error('smtp down'));

    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    expect(quota.refund).toHaveBeenCalledWith(WS, 'EMAIL');
  });

  it('skips opted-out recipients, sends the rest, and completes the campaign', async () => {
    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    // Only the opted-in lead got an email.
    expect(outboundMail.send).toHaveBeenCalledTimes(1);
    // The unsubscribe token is r2's own (bulk mail must carry one); l2 is the
    // opted-in lead here, so the token is t2.
    expect(outboundMail.send.mock.calls[0][0]).toMatchObject({
      to: 'ok@lead.com',
      subject: 'S',
      unsubscribe: { token: 't2', url: 'https://m.test/api/public/u/t2' },
    });

    const statuses = prisma.campaignRecipient.update.mock.calls.map((c: any) => c[0].data.status);
    expect(statuses).toContain('SKIPPED'); // the opted-out one
    expect(statuses).toContain('SENT'); // the opted-in one

    // No PENDING left → campaign marked SENT.
    const finalUpdate = prisma.campaign.update.mock.calls.find((c: any) => c[0].data.status === 'SENT');
    expect(finalUpdate).toBeTruthy();
  });

  /**
   * DELIVERABILITY IS PART OF "DO NOT SEND", not a separate question.
   *
   * The audience freezes at launch and a throttled campaign sends over hours.
   * A lead that hard-bounced or was verified INVALID in between is an address
   * the gateway will refuse anyway — so sending to it buys nothing and spends a
   * metered message, and each refusal is another point of reputation damage on
   * the shared relay. The three columns are the same three the audience filter
   * already excludes on; this is the freeze-window mirror of it.
   *
   * ONLY the EMAIL branch. An unconditional check would silently skip an SMS or
   * a VOICE recipient whose EMAIL happens to be bad.
   */
  describe('email deliverability at send time, not only at launch', () => {
    const only = (lead: any) => {
      prisma.campaignRecipient.findMany.mockResolvedValue([{ id: 'r1', leadId: 'l1', token: 't1' }]);
      prisma.lead.findFirst.mockResolvedValue(lead);
    };

    it.each([
      ['a hard bounce since the freeze', { emailBouncedAt: new Date() }],
      ['an address verified INVALID since the freeze', { emailVerifiedStatus: 'INVALID' }],
    ])('skips %s without spending a message', async (_what, over) => {
      only({ id: 'l1', email: 'dead@lead.com', emailOptOut: false, ...over });

      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

      expect(outboundMail.send).not.toHaveBeenCalled();
      expect(quota.reserve).not.toHaveBeenCalled();
      expect(
        prisma.campaignRecipient.update.mock.calls.map((c: any) => c[0].data.status),
      ).toContain('SKIPPED');
    });

    it('still sends to an address that is merely UNKNOWN', async () => {
      // Nothing has checked it. "Not yet verified" is the state every lead in
      // the product starts in — refusing it would empty every audience.
      only({ id: 'l1', email: 'ok@lead.com', emailOptOut: false, emailVerifiedStatus: 'UNKNOWN' });

      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

      expect(outboundMail.send).toHaveBeenCalledTimes(1);
    });

    it('does not read the email columns on an SMS campaign', async () => {
      prisma.campaign.findFirst.mockResolvedValue({
        id: 'c1', workspaceId: WS, status: 'SENDING', channel: 'SMS', body: 'Hi', links: [],
      });
      only({
        id: 'l1', phone: '+905551112233', smsOptOut: false,
        email: 'dead@lead.com', emailBouncedAt: new Date(), emailVerifiedStatus: 'INVALID',
      });

      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

      expect(
        prisma.campaignRecipient.update.mock.calls.map((c: any) => c[0].data.status),
      ).not.toContain('SKIPPED');
    });
  });

  // The audience freezes at send-start, but a throttled campaign sends over
  // minutes/hours. A lead bulk-deleted (deletedAt) or merged (mergedIntoId)
  // AFTER the freeze must not still receive the message — bulk-delete means
  // "stop contacting", and a merged tombstone would double-send to the merge
  // target's same address. The per-recipient lead load must apply the active-
  // lead predicate so the DB excludes such a lead (→ SKIPPED).
  it('does NOT send to a lead soft-deleted/merged after the audience froze', async () => {
    prisma.lead.findFirst.mockImplementation(async ({ where }: any) => {
      if (where.id === 'l1') return { id: 'l1', email: 'ok@lead.com', emailOptOut: false };
      // l2 was deleted mid-campaign: a query filtering deletedAt:null won't return it.
      return where.deletedAt === null ? null : { id: 'l2', email: 'gone@lead.com', emailOptOut: false };
    });

    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    // Only the still-active lead is emailed; the deleted one is skipped.
    expect(outboundMail.send).toHaveBeenCalledTimes(1);
    // This test inverts the lead fixture: l1 is the surviving lead, so the one
    // message that goes out belongs to r1 and carries r1's token.
    expect(outboundMail.send.mock.calls[0][0]).toMatchObject({
      to: 'ok@lead.com',
      subject: 'S',
      unsubscribe: { token: 't1', url: 'https://m.test/api/public/u/t1' },
    });
    const statuses = prisma.campaignRecipient.update.mock.calls.map((c: any) => c[0].data.status);
    expect(statuses).toContain('SKIPPED');
  });

  // Money-path fix scope check: the new legacy-SMS settlement call only fires
  // for channel === 'SMS'. An EMAIL campaign send must never touch
  // conversationSpend at all — email isn't priced/metered via SpendLedger.
  it('never calls conversationSpend.settleCampaignSms for an EMAIL campaign send', async () => {
    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });
    expect(conversationSpend.settleCampaignSms).not.toHaveBeenCalled();
  });

  it('does nothing for a campaign that is not SENDING', async () => {
    prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'PAUSED' });
    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });
    expect(prisma.campaignRecipient.findMany).not.toHaveBeenCalled();
  });

  it('atomically claims each recipient (PENDING→SENDING) before processing it', async () => {
    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });
    expect(prisma.campaignRecipient.updateMany).toHaveBeenCalledWith({
      where: { id: 'r1', workspaceId: WS, status: 'PENDING' },
      data: { status: 'SENDING' },
    });
  });

  it('does NOT send a recipient already claimed by a concurrent (reaped) batch', async () => {
    // Both leads opted-in, but our claim loses the race for the second recipient.
    prisma.lead.findFirst.mockResolvedValue({ id: 'x', email: 'a@b.com', emailOptOut: false });
    prisma.campaignRecipient.updateMany
      .mockResolvedValueOnce({ count: 0 }) // reclaim pass (no stranded SENDING rows)
      .mockResolvedValueOnce({ count: 1 }) // r1 — we claimed it
      .mockResolvedValueOnce({ count: 0 }); // r2 — a concurrent run already took it

    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    expect(outboundMail.send).toHaveBeenCalledTimes(1); // only the one we claimed
  });

  it('reclaims recipients stranded in SENDING by a crashed prior batch before sending', async () => {
    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });
    // A SENDING→PENDING sweep runs first so a crash between claim and mark
    // doesn't silently drop the recipient (the batch only selects PENDING).
    expect(prisma.campaignRecipient.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: WS, campaignId: 'c1', status: 'SENDING' },
      data: { status: 'PENDING' },
    });
  });

  it('recomputes campaign stats from recipient counts (no lost update under concurrency)', async () => {
    prisma.campaignRecipient.groupBy.mockResolvedValue([
      { status: 'SENT', _count: { _all: 3 } },
      { status: 'FAILED', _count: { _all: 1 } },
      { status: 'SKIPPED', _count: { _all: 2 } },
    ]);
    // The same three recipients, seen through the column `sent` is now derived
    // from: `sentAt` is stamped once at delivery and never cleared, whereas the
    // status a row carries later can move on (`sent-count-drops`).
    prisma.campaignRecipient.count.mockImplementation(async ({ where }: any) => (where?.sentAt ? 3 : 0));

    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    const statsUpdate = prisma.campaign.update.mock.calls.find((c: any) => c[0].data.stats);
    expect(statsUpdate[0].data.stats).toEqual(
      expect.objectContaining({ sent: 3, failed: 1, skipped: 2 }),
    );
  });

  it('recomputes opened/clicked/unsubscribed from recipient rows, not the stale stats blob', async () => {
    // Snapshot the recompute reads. The tracker's atomic jsonb_set bump() has since
    // advanced the true engagement counts; the old `...s` spread re-wrote these
    // stale values, clobbering a concurrent open/click/unsubscribe (lost-update).
    prisma.campaign.findUnique.mockResolvedValue({
      stats: { recipients: 10, opened: 5, clicked: 2, unsubscribed: 1 },
      abEnabled: false,
    });
    prisma.campaignRecipient.groupBy.mockResolvedValue([
      { status: 'SENT', _count: { _all: 3 } },
      { status: 'FAILED', _count: { _all: 1 } },
      { status: 'SKIPPED', _count: { _all: 2 } },
      { status: 'UNSUBSCRIBED', _count: { _all: 4 } },
    ]);
    // Authoritative engagement from the recipient openedAt/clickedAt timestamps,
    // and `sent` from `sentAt` — the four rows that later became UNSUBSCRIBED
    // were still sent, so the delivery total must not fall (`sent-count-drops`).
    prisma.campaignRecipient.count.mockImplementation(async ({ where }: any) =>
      where?.openedAt ? 6 : where?.clickedAt ? 3 : where?.sentAt ? 3 : 0,
    );

    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    const statsUpdate = prisma.campaign.update.mock.calls.find((c: any) => c[0].data.stats);
    // Engagement is derived from rows (6/3/4), NOT carried from the stale blob
    // (5/2/1); the static launch-time `recipients` total is preserved.
    expect(statsUpdate[0].data.stats).toEqual({
      recipients: 10,
      sent: 3,
      failed: 1,
      skipped: 2,
      opened: 6,
      clicked: 3,
      unsubscribed: 4,
    });
  });

  it('preserves a foreign stats key (delivered, owned by the DLR poller) while updating its own recomputed counters', async () => {
    // `campaign.stats.delivered`/`undelivered` are written by
    // netgsm-dlr-poll.service.ts's rollupCampaignStats merge, never by this
    // method's own fixed field list — a recomputeStats tick that lands after
    // that merge must not silently drop them.
    prisma.campaign.findUnique.mockResolvedValue({
      stats: { recipients: 10, delivered: 5, sent: 1 },
      abEnabled: false,
    });
    prisma.campaignRecipient.groupBy.mockResolvedValue([
      { status: 'SENT', _count: { _all: 3 } },
      { status: 'FAILED', _count: { _all: 1 } },
    ]);
    prisma.campaignRecipient.count.mockImplementation(async ({ where }: any) => (where?.sentAt ? 3 : 0));

    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    const statsUpdate = prisma.campaign.update.mock.calls.find((c: any) => c[0].data.stats);
    expect(statsUpdate[0].data.stats).toEqual({
      recipients: 10,
      delivered: 5, // foreign key survives, untouched
      sent: 3, // recomputed field wins over the stale `sent: 1`
      failed: 1,
      skipped: 0,
      opened: 0,
      clicked: 0,
      unsubscribed: 0,
    });
  });

  describe('A/B WINNER mode', () => {
    it('does NOT mark a campaign SENT while HOLD recipients await the winner', async () => {
      prisma.campaignRecipient.findMany.mockResolvedValue([]); // test cohort all sent → no PENDING
      prisma.campaignRecipient.count.mockResolvedValue(8); // but 8 remainder are HELD
      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });
      expect(prisma.campaign.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'SENT' }) }));
    });

    it('does NOT mark SENT when the LAST PENDING batch drains but HOLD recipients remain', async () => {
      // The real completion path (not the empty-batch shortcut above): a batch
      // PROCESSES the last test-cohort recipient (recipients.length > 0), draining
      // PENDING to 0 — but the A/B WINNER remainder is still HELD. The campaign must
      // stay SENDING so the later ab.decide job can release + send the remainder;
      // marking it SENT here strands the held-back majority forever.
      prisma.campaignRecipient.findMany.mockResolvedValue([{ id: 'r2', leadId: 'l2', token: 't2' }]);
      prisma.campaignRecipient.count.mockImplementation(async ({ where }: any) =>
        where.status === 'HOLD' ? 8 : 0,
      );
      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });
      expect(prisma.campaign.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'SENT' }) }),
      );
    });

    it('picks the variant with the best open RATE, releases the remainder to it, and kicks the batch', async () => {
      prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'SENDING', abWinnerKey: null, abWinnerMetric: 'OPEN' });
      prisma.campaignVariant.findMany.mockResolvedValue([
        { key: 'A', stats: { sent: 100, opened: 5 } },
        { key: 'B', stats: { sent: 100, opened: 12 } }, // winner
      ]);
      prisma.campaign.updateMany = jest.fn().mockResolvedValue({ count: 1 });
      await (svc as any).decideAbWinner({ payload: { workspaceId: WS, campaignId: 'c1' } });
      // claims the winner atomically (only the first decider)
      expect(prisma.campaign.updateMany.mock.calls[0][0]).toMatchObject({ where: { abWinnerKey: null, status: 'SENDING' }, data: { abWinnerKey: 'B' } });
      // releases the HELD remainder to the winning variant
      const release = prisma.campaignRecipient.updateMany.mock.calls.find((c: any) => c[0].where.status === 'HOLD');
      expect(release[0].data).toEqual({ status: 'PENDING', variantKey: 'B' });
      // and kicks the send batch
      expect(scheduledJobs.schedule.mock.calls.some((c: any) => c[0].kind === 'campaign.batch')).toBe(true);
    });

    it('says so when NO variant had any signal, rather than passing the alphabetical tiebreak off as a result', async () => {
      // The tiebreak exists so a no-data decision is deterministic, and the
      // remainder must still be released — stranding the held-back majority
      // would be far worse than sending it the wrong variant. What must not
      // happen is a coin toss reported in the same words as a measurement.
      const warn = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
      prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'SENDING', abWinnerKey: null, abWinnerMetric: 'OPEN' });
      prisma.campaignVariant.findMany.mockResolvedValue([
        { key: 'A', stats: { opened: 0 } },
        { key: 'B', stats: {} },
      ]);
      prisma.campaign.updateMany = jest.fn().mockResolvedValue({ count: 1 });

      await (svc as any).decideAbWinner({ payload: { workspaceId: WS, campaignId: 'c1' } });

      expect(prisma.campaign.updateMany.mock.calls[0][0]).toMatchObject({ data: { abWinnerKey: 'A' } });
      const release = prisma.campaignRecipient.updateMany.mock.calls.find((c: any) => c[0].where.status === 'HOLD');
      expect(release[0].data).toEqual({ status: 'PENDING', variantKey: 'A' });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/no .*signal/i));
      warn.mockRestore();
    });

    it('does nothing if the winner was already decided (concurrent decide)', async () => {
      prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'SENDING', abWinnerKey: 'A', abWinnerMetric: 'OPEN' });
      await (svc as any).decideAbWinner({ payload: { workspaceId: WS, campaignId: 'c1' } });
      expect(prisma.campaignVariant.findMany).not.toHaveBeenCalled();
    });

    /**
     * `ab-raw-counts`. Ranking by raw opens hands the win to whichever cohort
     * was bigger — and with weights 3:1 that is the worse variant, which then
     * goes to the entire held-back remainder.
     */
    it('ranks by RATE, so the smaller cohort wins when raw counts say otherwise', async () => {
      prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'SENDING', abWinnerKey: null, abWinnerMetric: 'OPEN' });
      prisma.campaignVariant.findMany.mockResolvedValue([
        { key: 'A', weight: 3, stats: { sent: 300, opened: 30 } }, // 10% — more opens
        { key: 'B', weight: 1, stats: { sent: 100, opened: 20 } }, // 20% — better variant
      ]);
      prisma.campaign.updateMany = jest.fn().mockResolvedValue({ count: 1 });

      await (svc as any).decideAbWinner({ payload: { workspaceId: WS, campaignId: 'c1' } });

      expect(prisma.campaign.updateMany.mock.calls[0][0]).toMatchObject({ data: { abWinnerKey: 'B' } });
    });

    it('a variant whose sends all FAILED scores zero instead of NaN', async () => {
      // A total comparator is not a detail: Array.prototype.sort with a
      // comparator that returns NaN produces engine-dependent output.
      prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'SENDING', abWinnerKey: null, abWinnerMetric: 'OPEN' });
      prisma.campaignVariant.findMany.mockResolvedValue([
        { key: 'A', weight: 1, stats: { sent: 0, opened: 0 } }, // every send FAILED
        { key: 'B', weight: 1, stats: { sent: 50, opened: 9 } },
        { key: 'C', weight: 1, stats: { sent: 40, opened: 2 } },
      ]);
      prisma.campaign.updateMany = jest.fn().mockResolvedValue({ count: 1 });

      await (svc as any).decideAbWinner({ payload: { workspaceId: WS, campaignId: 'c1' } });

      expect(prisma.campaign.updateMany.mock.calls[0][0]).toMatchObject({ data: { abWinnerKey: 'B' } });
    });

    it('too small a sample still DECIDES — on the highest weight, never leaving the remainder HELD', async () => {
      // Releasing the majority to the heaviest variant is the authored default;
      // falling back to the control would mail `campaign.body`, which in an A/B
      // campaign is usually a placeholder.
      prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'SENDING', abWinnerKey: null, abWinnerMetric: 'OPEN' });
      prisma.campaignVariant.findMany.mockResolvedValue([
        { key: 'A', weight: 1, stats: { sent: 4, opened: 1 } }, // 25%, but n=4
        { key: 'B', weight: 5, stats: { sent: 3, opened: 0 } },
      ]);
      prisma.campaign.updateMany = jest.fn().mockResolvedValue({ count: 1 });

      await (svc as any).decideAbWinner({ payload: { workspaceId: WS, campaignId: 'c1' } });

      expect(prisma.campaign.updateMany.mock.calls[0][0]).toMatchObject({ data: { abWinnerKey: 'B' } });
      const release = prisma.campaignRecipient.updateMany.mock.calls.find((c: any) => c[0].where.status === 'HOLD');
      expect(release[0].data).toEqual({ status: 'PENDING', variantKey: 'B' });
    });

    it('writes down what the decision was based on, so the tenant can audit it', async () => {
      prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'SENDING', abWinnerKey: null, abWinnerMetric: 'OPEN' });
      prisma.campaignVariant.findMany.mockResolvedValue([
        { key: 'A', weight: 1, stats: { sent: 100, opened: 30 } },
        { key: 'B', weight: 1, stats: { sent: 100, opened: 10 } },
      ]);
      prisma.campaign.findUnique.mockResolvedValue({ stats: { recipients: 200 }, abEnabled: true });
      prisma.campaign.updateMany = jest.fn().mockResolvedValue({ count: 1 });

      await (svc as any).decideAbWinner({ payload: { workspaceId: WS, campaignId: 'c1' } });

      const decision = prisma.campaign.update.mock.calls
        .map((c: any) => c[0].data?.stats?.abDecision)
        .filter(Boolean)
        .pop();
      expect(decision).toMatchObject({ metric: 'opened', basis: 'RATE', winner: 'A' });
      expect(decision.variants).toEqual(
        expect.arrayContaining([expect.objectContaining({ key: 'A', sent: 100, opened: 30, rate: 0.3 })]),
      );
      // Merged, never replaced: the launch-time total is somebody else's key.
      const merged = prisma.campaign.update.mock.calls.map((c: any) => c[0].data?.stats).filter(Boolean).pop();
      expect(merged.recipients).toBe(200);
    });

    /**
     * `ab-pause-strands`. Pausing through the decision time leaves the decide
     * job spent and the remainder HELD forever. `CampaignsService.resume()`
     * kicks a batch, and this is the batch that re-arms the decision.
     */
    it('re-arms the winner decision when a tick finds a HELD remainder and no winner', async () => {
      const decideAt = new Date('2026-01-01T10:00:00.000Z');
      prisma.campaign.findFirst.mockResolvedValue({
        id: 'c1', workspaceId: WS, status: 'SENDING', channel: 'EMAIL', subject: 'S', body: 'Hi', links: [],
        abMode: 'WINNER', abWinnerKey: null, abDecideAt: decideAt,
      });
      prisma.campaignRecipient.findMany.mockResolvedValue([]); // test cohort drained
      prisma.campaignRecipient.count.mockResolvedValue(8); // remainder still HELD

      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

      const armed = scheduledJobs.schedule.mock.calls.find((c: any) => c[0].kind === 'campaign.ab.decide');
      expect(armed).toBeTruthy();
      // The PERSISTED decide time, never `now + window`: repeated pause/resume
      // would otherwise push the decision forward forever, and a still-PENDING
      // job row would have its runAt shifted in place.
      expect(armed[0]).toMatchObject({ dedupKey: 'ab-decide:c1', runAt: decideAt });
    });

    it('does not re-arm once a winner has been decided', async () => {
      prisma.campaign.findFirst.mockResolvedValue({
        id: 'c1', workspaceId: WS, status: 'SENDING', channel: 'EMAIL', subject: 'S', body: 'Hi', links: [],
        abMode: 'WINNER', abWinnerKey: 'B', abDecideAt: new Date(),
      });
      prisma.campaignRecipient.findMany.mockResolvedValue([]);
      prisma.campaignRecipient.count.mockResolvedValue(8);

      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

      expect(scheduledJobs.schedule.mock.calls.some((c: any) => c[0].kind === 'campaign.ab.decide')).toBe(false);
    });
  });

  /**
   * `suspension-doesnt-stop`, the half that cannot live in the gateway.
   *
   * Zeroing entitlements alone makes the per-recipient reserve refuse, and the
   * old code turned each refusal into a permanent FAILED row — so a temporary
   * suspension burned a paying customer's whole remaining audience. FAILED rows
   * are never re-sent. The tick has to stop BEFORE the PENDING→SENDING claim.
   */
  describe('the workspace kill switch, at the top of the tick', () => {
    it('a suspended workspace claims nothing and leaves every recipient PENDING', async () => {
      prisma.workspace.findUnique.mockResolvedValue({ status: 'SUSPENDED', settings: {}, name: 'Acme' });

      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

      expect(prisma.campaignRecipient.updateMany).not.toHaveBeenCalled();
      expect(prisma.campaignRecipient.update).not.toHaveBeenCalled();
      expect(outboundMail.send).not.toHaveBeenCalled();
    });

    it('the operator’s email pause stops an EMAIL campaign the same way', async () => {
      prisma.workspace.findUnique.mockResolvedValue({ status: 'ACTIVE', settings: { email: { paused: true } }, name: 'Acme' });

      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

      expect(outboundMail.send).not.toHaveBeenCalled();
      expect(prisma.campaignRecipient.update).not.toHaveBeenCalled();
    });

    it('an unreadable workspace row is not a reason to stop a tenant’s campaign', async () => {
      prisma.workspace.findUnique.mockResolvedValue(null);
      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });
      expect(outboundMail.send).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * `campaign-failures-terminal`. Every error used to be terminal FAILED, so a
   * mailbox that hit its quota — or whose password rotated — turned the rest of
   * the audience into rows that are never re-sent, while the campaign itself
   * finished green.
   */
  describe('classified failures', () => {
    const transient = () =>
      receipt({ outcome: 'FAILED_TRANSIENT', ok: false, messageId: null, reason: 'TRANSIENT', error: '451 try later', retriable: true });

    it('reverts a transient failure to PENDING with the FULL compound WHERE', async () => {
      // An id-only WHERE stomps a concurrently-set UNSUBSCRIBED back to PENDING
      // and re-mails somebody who just opted out. That is a consent breach, not
      // a retry.
      outboundMail.send.mockResolvedValue(transient());

      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

      expect(revertCalls()).toHaveLength(1);
      expect(revertCalls()[0][0].where).toEqual({ id: 'r2', workspaceId: WS, campaignId: 'c1', status: 'SENDING' });
    });

    it('leaves a row that moved to a terminal state alone (the guard matched nothing)', async () => {
      outboundMail.send.mockResolvedValue(transient());
      // The claim still wins; only the REVERT matches nothing, because the
      // tracker flipped the row to UNSUBSCRIBED in between.
      prisma.campaignRecipient.updateMany.mockImplementation(async ({ data }: any) =>
        data.status === 'SENDING' ? { count: 1 } : { count: 0 },
      );

      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

      // The row is left exactly as the tracker set it — nothing here writes
      // over a terminal state, and nothing marks it FAILED as a consolation.
      expect(revertCalls()[0][0].where.status).toBe('SENDING');
      const statuses = prisma.campaignRecipient.update.mock.calls.map((c: any) => c[0].data.status);
      expect(statuses).not.toContain('FAILED');
      expect(statuses).not.toContain('SENT');
    });

    it('a permanent rejection is still terminal FAILED', async () => {
      outboundMail.send.mockResolvedValue(
        receipt({ outcome: 'FAILED_PERMANENT', ok: false, messageId: null, reason: 'PERMANENT', error: '550 user unknown' }),
      );

      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

      const failed = prisma.campaignRecipient.update.mock.calls.find((c: any) => c[0].data.status === 'FAILED');
      expect(failed[0].data.error).toContain('550 user unknown');
      expect(revertCalls()).toHaveLength(0);
    });

    it('a suppression refusal is SKIPPED, not FAILED — policy said no, nothing broke', async () => {
      outboundMail.send.mockResolvedValue(refused({ reason: 'SUPPRESSED_OPT_OUT' }));

      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

      const statuses = prisma.campaignRecipient.update.mock.calls.map((c: any) => c[0].data.status);
      expect(statuses).not.toContain('FAILED');
      expect(statuses.filter((s: string) => s === 'SKIPPED')).toHaveLength(2); // the opted-out lead + this one
    });

    it('a systemic refusal stops the whole tick instead of walking the audience', async () => {
      prisma.campaignRecipient.findMany.mockResolvedValue([
        { id: 'r1', leadId: 'l2', token: 't1' },
        { id: 'r2', leadId: 'l2', token: 't2' },
        { id: 'r3', leadId: 'l2', token: 't3' },
      ]);
      outboundMail.send.mockResolvedValue(refused({ reason: 'QUOTA_EXHAUSTED' }));

      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

      expect(outboundMail.send).toHaveBeenCalledTimes(1); // it asked once and stopped
      expect(revertCalls()).toHaveLength(1);
    });

    it('a quota reserve that throws leaves the recipient PENDING, not FAILED', async () => {
      // MESSAGES_EXHAUSTED is the workspace's condition, not this lead's.
      quota.reserve.mockRejectedValue(Object.assign(new Error('Message quota exhausted'), { code: 'MESSAGES_EXHAUSTED' }));

      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

      const statuses = prisma.campaignRecipient.update.mock.calls.map((c: any) => c[0].data.status);
      expect(statuses).not.toContain('FAILED');
      expect(revertCalls()).toHaveLength(1);
      expect(quota.refund).not.toHaveBeenCalled(); // nothing was reserved
    });

    it('a send-window clamp moves the next tick and does NOT feed the auto-pause streak', async () => {
      // "Come back at 09:00" is not a failure. Counting it as one would pause a
      // campaign launched at 3am three minutes after it started, and retrying
      // every 60s until then is 400 pointless ticks.
      const openAt = new Date(Date.now() + 6 * 60 * 60 * 1000);
      prisma.campaign.findUnique.mockResolvedValue({ stats: { failStreak: 2 }, abEnabled: false });
      outboundMail.send.mockResolvedValue(refused({ reason: 'QUIET_HOURS', retriable: true, retryAt: openAt }));
      prisma.campaignRecipient.count.mockResolvedValue(1); // one row still PENDING

      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

      expect(prisma.campaign.updateMany).not.toHaveBeenCalled(); // not paused
      expect(revertCalls()).toHaveLength(1);
      const next = scheduledJobs.schedule.mock.calls.find((c: any) => c[0].kind === 'campaign.batch');
      expect(next[0].runAt).toEqual(openAt);
    });

    it('auto-PAUSEs the campaign on the third consecutive tick that sent nothing', async () => {
      // Without a bound, "revert to PENDING" is an infinite 60s loop against a
      // condition that will not clear on its own.
      prisma.campaign.findUnique.mockResolvedValue({ stats: { recipients: 10, failStreak: 2 }, abEnabled: false });
      outboundMail.send.mockResolvedValue(transient());

      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

      const paused = prisma.campaign.updateMany.mock.calls.find((c: any) => c[0].data?.status === 'PAUSED');
      expect(paused).toBeTruthy();
      expect(paused[0].where).toMatchObject({ id: 'c1', workspaceId: WS, status: 'SENDING' });
      expect(paused[0].data.stats).toMatchObject({ recipients: 10, failStreak: 3, pauseReason: 'TRANSIENT' });
      // A paused campaign does not queue another tick.
      expect(scheduledJobs.schedule).not.toHaveBeenCalled();
    });

    it('counts the streak up while it is still under the limit, and keeps sending', async () => {
      prisma.campaign.findUnique.mockResolvedValue({ stats: { failStreak: 0 }, abEnabled: false });
      outboundMail.send.mockResolvedValue(transient());

      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

      expect(prisma.campaign.updateMany).not.toHaveBeenCalled();
      const bumped = prisma.campaign.update.mock.calls.map((c: any) => c[0].data?.stats?.failStreak).filter((v: any) => v !== undefined);
      expect(bumped).toContain(1);
    });

    it('a tick that sent something clears the streak', async () => {
      prisma.campaign.findUnique.mockResolvedValue({ stats: { failStreak: 2 }, abEnabled: false });

      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

      const cleared = prisma.campaign.update.mock.calls.map((c: any) => c[0].data?.stats?.failStreak).filter((v: any) => v !== undefined);
      expect(cleared).toContain(0);
      expect(prisma.campaign.updateMany).not.toHaveBeenCalled();
    });

    it('leaves the stats blob alone when nothing failed and no streak was running', async () => {
      // The common case: no extra write, and no key nobody asked for.
      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });
      const withStreak = prisma.campaign.update.mock.calls.filter((c: any) => c[0].data?.stats?.failStreak !== undefined);
      expect(withStreak).toHaveLength(0);
    });
  });

  /**
   * `merge-tags-literal`. The composer suggests `{{lead.contactPerson}}` and
   * nothing ever substituted it, so two thousand leads received "Merhaba
   * {{lead.contactPerson}}" — and the VOICE path read the braces aloud.
   */
  describe('merge tags', () => {
    beforeEach(() => {
      prisma.campaign.findFirst.mockResolvedValue({
        id: 'c1', workspaceId: WS, status: 'SENDING', channel: 'EMAIL', links: [],
        subject: '{{lead.businessName}} için teklif',
        body: 'Merhaba {{lead.contactPerson}},',
        bodyHtml: '<html><body><p>Merhaba {{lead.contactPerson}}</p></body></html>',
      });
      prisma.campaignRecipient.findMany.mockResolvedValue([{ id: 'r2', leadId: 'l2', token: 't2' }]);
      prisma.lead.findFirst.mockResolvedValue({
        id: 'l2', email: 'ok@lead.com', emailOptOut: false, contactPerson: 'Ayşe', businessName: 'Acme A.Ş.',
      });
    });

    it('substitutes the tokens in the subject AND the body', async () => {
      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });
      const sent = outboundMail.send.mock.calls[0][0];
      expect(sent.subject).toBe('Acme A.Ş. için teklif');
      expect(sent.text).toContain('Merhaba Ayşe,');
      expect(sent.text).not.toContain('{{');
    });

    it('escapes the substituted value in the HTML part, and only there', async () => {
      // renderEmailHtml already escaped every author-written character, so a
      // raw lead value dropped into the compiled document corrupts or injects.
      prisma.lead.findFirst.mockResolvedValue({
        id: 'l2', email: 'ok@lead.com', emailOptOut: false, contactPerson: "Ben & Jerry's", businessName: 'B&J',
      });
      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });
      const sent = outboundMail.send.mock.calls[0][0];
      expect(sent.html).toContain('Merhaba Ben &amp; Jerry&#39;s');
      expect(sent.text).toContain("Merhaba Ben & Jerry's"); // plain-text sink, untouched
    });

    it('falls back rather than mailing "Merhaba ,"', async () => {
      prisma.lead.findFirst.mockResolvedValue({
        id: 'l2', email: 'ok@lead.com', emailOptOut: false, contactPerson: null, businessName: 'Acme A.Ş.',
      });
      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });
      expect(outboundMail.send.mock.calls[0][0].text).toContain('Merhaba Acme A.Ş.,');
    });

    it('honours an author-written default after a pipe', async () => {
      prisma.campaign.findFirst.mockResolvedValue({
        id: 'c1', workspaceId: WS, status: 'SENDING', channel: 'EMAIL', links: [],
        subject: 'S', body: 'Merhaba {{lead.contactPerson|Değerli Müşterimiz}},',
      });
      prisma.lead.findFirst.mockResolvedValue({ id: 'l2', email: 'ok@lead.com', emailOptOut: false });
      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });
      expect(outboundMail.send.mock.calls[0][0].text).toContain('Merhaba Değerli Müşterimiz,');
    });

    it('leaves a token it does not own exactly as the author wrote it', async () => {
      prisma.campaign.findFirst.mockResolvedValue({
        id: 'c1', workspaceId: WS, status: 'SENDING', channel: 'EMAIL', links: [],
        subject: 'S', body: 'Total: {{order.total}}',
      });
      prisma.lead.findFirst.mockResolvedValue({ id: 'l2', email: 'ok@lead.com', emailOptOut: false });
      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });
      expect(outboundMail.send.mock.calls[0][0].text).toContain('Total: {{order.total}}');
    });

    it('substitutes a VARIANT’s own subject and body too', async () => {
      // The A/B variant fields are resolved at the same point, so one insertion
      // point has to cover both — a variant recipient must not be the one who
      // gets the braces.
      prisma.campaign.findFirst.mockResolvedValue({
        id: 'c1', workspaceId: WS, status: 'SENDING', channel: 'EMAIL', links: [], abEnabled: true,
        subject: 'S', body: 'control',
      });
      prisma.campaignVariant.findMany.mockResolvedValue([
        { key: 'B', subject: 'Selam {{lead.contactPerson}}', body: 'Merhaba {{lead.contactPerson}}!' },
      ]);
      prisma.campaignRecipient.findMany.mockResolvedValue([{ id: 'r2', leadId: 'l2', token: 't2', variantKey: 'B' }]);

      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

      const sent = outboundMail.send.mock.calls[0][0];
      expect(sent.subject).toBe('Selam Ayşe');
      expect(sent.text).toContain('Merhaba Ayşe!');
    });

    it('resolves {{workspace.name}} as well', async () => {
      prisma.campaign.findFirst.mockResolvedValue({
        id: 'c1', workspaceId: WS, status: 'SENDING', channel: 'EMAIL', links: [],
        subject: 'S', body: '{{workspace.name}} ekibi',
      });
      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });
      expect(outboundMail.send.mock.calls[0][0].text).toContain('Acme ekibi');
    });
  });

  /**
   * `img-src-click`. The blind document-wide replace rewrote `<img src>` too,
   * so every image load — and every image proxy — counted as a click, and the
   * click-based A/B winner was picked from them.
   */
  describe('renderHtml — only what a human can click', () => {
    it('rewrites the href and leaves the image URL alone', () => {
      const out = (svc as any).renderHtml(
        '<html><body><a href="https://shop.test"><img src="https://shop.test/logo.png"></a></body></html>',
        'tok-4',
        ['https://shop.test'],
      );
      expect(out).toContain('href="https://m.test/api/public/t/c/tok-4?i=0"');
      expect(out).toContain('src="https://shop.test/logo.png"');
    });

    it('still matches an href the compiler entity-escaped', () => {
      const out = (svc as any).renderHtml(
        '<html><body><a href="https://shop.test/x?a=1&amp;b=2">Buy</a></body></html>',
        'tok-5',
        ['https://shop.test/x?a=1&b=2'],
      );
      expect(out).toContain('href="https://m.test/api/public/t/c/tok-5?i=0"');
    });

    it('rewrites an unquoted href too, because the extractor accepts one', () => {
      // The two must agree about what a link is: a URL the extractor put in
      // `links` that this pass cannot find would ship untracked.
      const out = (svc as any).renderHtml(
        '<html><body><a href=https://shop.test/x>Buy</a></body></html>',
        'tok-7',
        ['https://shop.test/x'],
      );
      expect(out).toContain('href="https://m.test/api/public/t/c/tok-7?i=0"');
    });

    it('leaves an href that is not a tracked link untouched', () => {
      const out = (svc as any).renderHtml(
        '<html><body><a href="https://other.test/page">Read</a></body></html>',
        'tok-6',
        ['https://shop.test'],
      );
      expect(out).toContain('href="https://other.test/page"');
    });
  });

  /**
   * `batches-stall-runner`. A tick runs inside the shared job runner's single
   * global advisory lock, so fifty SMTP round-trips in a row are fifty
   * round-trips every other tenant's AI reply and booking reminder waits for.
   * The tick is already built for resumption — rows are claimed one at a time
   * and the tail reschedules whatever is left — so bounding its wall clock
   * costs nothing but the next sixty seconds.
   */
  describe('the per-tick wall clock', () => {
    beforeEach(() => {
      prisma.campaignRecipient.findMany.mockResolvedValue([
        { id: 'r1', leadId: 'l1', token: 't1' },
        { id: 'r2', leadId: 'l2', token: 't2' },
        { id: 'r3', leadId: 'l3', token: 't3' },
      ]);
      prisma.lead.findFirst.mockImplementation(async ({ where }: any) => ({
        id: where.id,
        email: `${where.id}@lead.com`,
        emailOptOut: false,
      }));
      // Whatever this tick does not reach is still PENDING afterwards.
      prisma.campaignRecipient.count.mockResolvedValue(1);
    });

    afterEach(() => jest.restoreAllMocks());

    /** A send that costs `ms` of wall clock, on a clock the test owns. */
    function slowSend(ms: number): void {
      let clock = Date.now();
      jest.spyOn(Date, 'now').mockImplementation(() => clock);
      outboundMail.send.mockImplementation(async () => {
        clock += ms;
        return receipt();
      });
    }

    it('stops sending at the deadline and leaves the rest of the audience PENDING', async () => {
      slowSend(BATCH_BUDGET_MS / 2 + 1);

      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

      expect(outboundMail.send).toHaveBeenCalledTimes(2);
      // The third row was never claimed, so it is still PENDING for next tick —
      // not SENDING, not FAILED.
      expect(prisma.campaignRecipient.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: 'r3' }) }),
      );
    });

    it('breaks rather than returns, so the tail bookkeeping and the reschedule still run', async () => {
      // A `return` here would skip the batched SMS/VOICE settlement, strand the
      // quota those paths already reserved, and skip recomputeStats.
      slowSend(BATCH_BUDGET_MS * 2);

      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

      expect(prisma.campaignRecipient.groupBy).toHaveBeenCalled(); // recomputeStats
      expect(scheduledJobs.schedule).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'campaign.batch', dedupKey: 'c1' }),
      );
    });

    it('always sends to the first recipient, so a tick can never make zero progress', async () => {
      slowSend(BATCH_BUDGET_MS * 10);

      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

      expect(outboundMail.send).toHaveBeenCalledTimes(1);
    });

    it('sends the whole batch when the sends are quick (no behaviour change for a healthy tick)', async () => {
      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

      expect(outboundMail.send).toHaveBeenCalledTimes(3);
    });
  });
});

/**
 * `campaign-dead-letter`. Under sustained load a tick's fifty queries can time
 * out on an exhausted connection pool while the runner's single claim query
 * keeps succeeding; five ticks later the job is FAILED and the campaign sits
 * SENDING forever with its remaining recipients PENDING, its counters frozen
 * mid-send, and nothing anywhere the tenant can read. Pause-then-Resume already
 * recovers it — nobody was ever told to try.
 */
describe('CampaignSenderService — a dead-lettered job settles the campaign', () => {
  const WS = 'ws-1';
  let prisma: any;
  let runner: { registerHandler: jest.Mock };
  let svc: CampaignSenderService;

  /** The exhausted-hook the sender handed the runner for this kind. */
  const hookFor = (kind: string) =>
    runner.registerHandler.mock.calls.find((c: any[]) => c[0] === kind)?.[2] as
      | ((job: any, error: string) => Promise<void>)
      | undefined;

  beforeEach(() => {
    prisma = {
      campaign: {
        // The campaign is still SENDING: the guarded flip claims it.
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue({ stats: { sent: 12, delivered: 9, iysBlocked: 1 } }),
        update: jest.fn().mockResolvedValue({}),
        findFirst: jest.fn(),
      },
      campaignRecipient: { count: jest.fn().mockResolvedValue(0) },
      lead: { findFirst: jest.fn().mockResolvedValue(null) },
      workspaceMembership: { findFirst: jest.fn().mockResolvedValue({ userId: 'owner-1' }) },
      marketingNotification: { create: jest.fn().mockResolvedValue({ id: 'n1' }) },
    };
    runner = { registerHandler: jest.fn() };
    svc = new CampaignSenderService(
      prisma as any, { get: jest.fn() } as any, { send: jest.fn() } as any,
      { schedule: jest.fn() } as any, runner as any,
      { get: jest.fn(), resolveConfig: jest.fn() } as any, { reserve: jest.fn(), refund: jest.fn() } as any,
      { send: jest.fn() } as any, { settleCampaignSms: jest.fn() } as any,
      { search: jest.fn() } as any, { tryTake: jest.fn() } as any, { send: jest.fn() } as any,
    );
    svc.onModuleInit();
  });

  it('registers an exhausted-hook for both the batch and the launch job', () => {
    expect(hookFor('campaign.batch')).toBeInstanceOf(Function);
    expect(hookFor('campaign.launch')).toBeInstanceOf(Function);
  });

  it('pauses a campaign that is still SENDING, with a guarded updateMany', async () => {
    await hookFor('campaign.batch')!({ payload: { workspaceId: WS, campaignId: 'c1' } }, 'P2024 pool timeout');

    expect(prisma.campaign.updateMany).toHaveBeenCalledWith({
      where: { id: 'c1', workspaceId: WS, status: 'SENDING' },
      data: { status: 'PAUSED' },
    });
  });

  it('writes WHY into the stats blob without clobbering what other writers put there', async () => {
    await hookFor('campaign.batch')!({ payload: { workspaceId: WS, campaignId: 'c1' } }, 'P2024 pool timeout');

    const stats = prisma.campaign.update.mock.calls[0][0].data.stats;
    // Spread-first: the DLR poller's rollup merges delivered/iysBlocked into
    // this same blob independently.
    expect(stats).toMatchObject({ sent: 12, delivered: 9, iysBlocked: 1 });
    expect(stats.stalledError).toContain('P2024');
    expect(typeof stats.stalledAt).toBe('string');
  });

  it('tells the workspace owner, because a silently paused campaign is the whole bug', async () => {
    await hookFor('campaign.batch')!({ payload: { workspaceId: WS, campaignId: 'c1' } }, 'P2024 pool timeout');

    expect(prisma.marketingNotification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: WS,
          userId: 'owner-1',
          metadata: expect.objectContaining({ campaignId: 'c1' }),
        }),
      }),
    );
  });

  it('leaves a campaign that moved on alone — no stats write, no bell', async () => {
    // Sent, cancelled or already paused by the tenant meanwhile: the guarded
    // updateMany claims nothing, and a vanished campaign is a no-op rather than
    // a P2025 thrown inside a best-effort hook.
    prisma.campaign.updateMany.mockResolvedValue({ count: 0 });

    await hookFor('campaign.batch')!({ payload: { workspaceId: WS, campaignId: 'c1' } }, 'boom');

    expect(prisma.campaign.update).not.toHaveBeenCalled();
    expect(prisma.marketingNotification.create).not.toHaveBeenCalled();
  });

  it('truncates the recorded error rather than storing an unbounded blob', async () => {
    await hookFor('campaign.batch')!({ payload: { workspaceId: WS, campaignId: 'c1' } }, 'x'.repeat(1000));

    expect(prisma.campaign.update.mock.calls[0][0].data.stats.stalledError.length).toBe(300);
  });

  it('never throws — the DLQ bookkeeping must complete even if this hook cannot', async () => {
    prisma.campaign.updateMany.mockRejectedValue(new Error('db gone'));

    await expect(
      hookFor('campaign.batch')!({ payload: { workspaceId: WS, campaignId: 'c1' } }, 'boom'),
    ).resolves.toBeUndefined();
  });

  it('is a no-op for a job whose payload carries no campaign', async () => {
    await hookFor('campaign.batch')!({ payload: {} }, 'boom');

    expect(prisma.campaign.updateMany).not.toHaveBeenCalled();
  });
});

/**
 * A DRAFT campaign launched with a future scheduledAt queues a `campaign.launch`
 * job (Task 8b) instead of sending immediately; this is the handler that fires
 * at scheduledAt to actually flip SCHEDULED → SENDING and kick the first batch.
 */
describe('CampaignSenderService.launchScheduled', () => {
  const WS = 'ws-1';
  let prisma: any;
  let scheduledJobs: { schedule: jest.Mock };
  let svc: CampaignSenderService;

  beforeEach(() => {
    prisma = {
      campaign: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        // Reflects a freshly-flipped row, as a re-read right after a successful
        // guarded updateMany would see.
        findFirst: jest.fn().mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'SENDING', abMode: null, abDecideAt: null }),
        update: jest.fn().mockResolvedValue({}),
      },
      campaignRecipient: {
        count: jest.fn().mockResolvedValue(0),
      },
    };
    const config = { get: jest.fn() };
    scheduledJobs = { schedule: jest.fn() };
    const runner = { registerHandler: jest.fn() };
    const registry = { get: jest.fn(), resolveConfig: jest.fn() };
    const quota = { reserve: jest.fn(), refund: jest.fn() };
    const outboundMail = { send: jest.fn() };
    const smsV2 = { send: jest.fn() };
    const conversationSpend = { settleCampaignSms: jest.fn().mockResolvedValue({ amount: 1, quantity: 1, unitCost: 1 }) };
    const iysClient = { search: jest.fn() };
    const budgeter = { tryTake: jest.fn().mockReturnValue(true) };
    const voicesmsSend = { send: jest.fn() };
    svc = new CampaignSenderService(
      prisma as any, config as any, outboundMail as any, scheduledJobs as any, runner as any, registry as any, quota as any, smsV2 as any, conversationSpend as any, iysClient as any, budgeter as any, voicesmsSend as any,
    );
  });

  it('flips SCHEDULED → SENDING via a guarded updateMany and kicks the first batch', async () => {
    await (svc as any).launchScheduled({ payload: { workspaceId: WS, campaignId: 'c1' } });

    expect(prisma.campaign.updateMany).toHaveBeenCalledWith({
      where: { id: 'c1', workspaceId: WS, status: 'SCHEDULED' },
      data: { status: 'SENDING', startedAt: expect.any(Date) },
    });
    expect(scheduledJobs.schedule).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'campaign.batch', dedupKey: 'c1', workspaceId: WS }),
    );
  });

  it('no-ops when a guard miss (count 0) re-reads to a status that is neither SCHEDULED nor SENDING (cancelled meanwhile)', async () => {
    prisma.campaign.updateMany.mockResolvedValue({ count: 0 });
    prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'CANCELLED', abMode: null });

    await (svc as any).launchScheduled({ payload: { workspaceId: WS, campaignId: 'c1' } });

    expect(prisma.campaign.findFirst).toHaveBeenCalled();
    expect(scheduledJobs.schedule).not.toHaveBeenCalled();
  });

  it('retry after a crash between the flip and the batch schedule: a second invocation (count 0, already SENDING) still schedules the batch job', async () => {
    // First attempt: the guarded flip succeeds, but the handler crashes before
    // it finishes scheduling the batch job (simulated by making schedule()
    // throw). The runner would mark this job PENDING again for a retry.
    scheduledJobs.schedule.mockRejectedValueOnce(new Error('boom mid-handler'));
    await expect(
      (svc as any).launchScheduled({ payload: { workspaceId: WS, campaignId: 'c1' } }),
    ).rejects.toThrow('boom mid-handler');
    expect(prisma.campaign.updateMany).toHaveBeenCalledTimes(1);

    // Retry: the campaign is now already SENDING (flipped by the first
    // attempt), so the guarded updateMany claims count 0 this time. The
    // handler must still (re-)schedule the batch job rather than no-op.
    prisma.campaign.updateMany.mockResolvedValue({ count: 0 });
    prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'SENDING', abMode: null });
    scheduledJobs.schedule.mockReset().mockResolvedValue('job-2');

    await (svc as any).launchScheduled({ payload: { workspaceId: WS, campaignId: 'c1' } });

    expect(scheduledJobs.schedule).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'campaign.batch', dedupKey: 'c1', workspaceId: WS }),
    );
  });

  it('A/B WINNER: schedules the ab.decide job (test window measured from NOW) when a HELD remainder exists', async () => {
    prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'SENDING', abMode: 'WINNER', abDecideAt: null });
    prisma.campaignRecipient.count.mockResolvedValue(8); // held remainder

    await (svc as any).launchScheduled({ payload: { workspaceId: WS, campaignId: 'c1' } });

    expect(prisma.campaign.update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { abDecideAt: expect.any(Date) } });
    expect(scheduledJobs.schedule).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'campaign.ab.decide', dedupKey: 'ab-decide:c1' }),
    );
    expect(scheduledJobs.schedule).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'campaign.batch', dedupKey: 'c1' }),
    );
  });

  it('A/B WINNER: does NOT recompute abDecideAt on a retry when it is already set (preserves the original fire-time-relative window)', async () => {
    const existingAbDecideAt = new Date(Date.now() + 1234);
    prisma.campaign.findFirst.mockResolvedValue({
      id: 'c1', workspaceId: WS, status: 'SENDING', abMode: 'WINNER', abDecideAt: existingAbDecideAt,
    });
    prisma.campaignRecipient.count.mockResolvedValue(8); // held remainder still not released

    await (svc as any).launchScheduled({ payload: { workspaceId: WS, campaignId: 'c1' } });

    expect(prisma.campaign.update).not.toHaveBeenCalled();
    expect(scheduledJobs.schedule).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'campaign.ab.decide', dedupKey: 'ab-decide:c1', runAt: existingAbDecideAt }),
    );
  });

  it('A/B WINNER mode with no HELD remainder does not schedule ab.decide (nothing to release later)', async () => {
    prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'SENDING', abMode: 'WINNER', abDecideAt: null });
    prisma.campaignRecipient.count.mockResolvedValue(0);

    await (svc as any).launchScheduled({ payload: { workspaceId: WS, campaignId: 'c1' } });

    expect(scheduledJobs.schedule).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'campaign.ab.decide' }));
    expect(scheduledJobs.schedule).toHaveBeenCalledWith(expect.objectContaining({ kind: 'campaign.batch' }));
  });
});

/**
 * True n:n SMS batching (NetGSM REST v2, Task 5): the per-recipient claim +
 * opt-out/render loop is unchanged, but eligible SMS recipients are collected
 * and sent via ONE `SmsV2Client.send` call instead of N adapter round-trips.
 */
describe('CampaignSenderService.batch — SMS v2 batching', () => {
  const WS = 'ws-1';
  let prisma: any;
  let registry: { get: jest.Mock; resolveConfig: jest.Mock };
  let quota: { reserve: jest.Mock; refund: jest.Mock };
  let smsV2: { send: jest.Mock };
  let conversationSpend: { settleCampaignSms: jest.Mock };
  let iysClient: { search: jest.Mock };
  let budgeter: { tryTake: jest.Mock };
  let svc: CampaignSenderService;

  const resolvedConfig = {
    channelId: 'ch1',
    workspaceId: WS,
    type: 'SMS',
    externalId: null,
    secrets: { usercode: 'u1', password: 'p1', msgheader: 'HDR1' },
    public: {} as Record<string, unknown>,
  };

  /** A TİCARİ-ready channel config: same as `resolvedConfig` but with the İYS
   *  brandCode a TİCARİ preflight requires before it will even attempt a
   *  search (its absence is itself a hard fail-closed abort — see the
   *  dedicated 'no brandCode configured' test below). */
  const resolvedConfigWithBrandCode = { ...resolvedConfig, public: { brandCode: 'BR1' } };

  function makeRecipients(n: number) {
    return Array.from({ length: n }, (_, i) => ({ id: `r${i + 1}`, leadId: `l${i + 1}`, token: `t${i + 1}` }));
  }

  /** A revert-to-PENDING updateMany is shaped `{ where: { id: { in: [...] } }, data: { status: 'PENDING' } }`
   *  — distinct from the unconditional SENDING→PENDING reclaim sweep at the top of batch(), which has
   *  no `id.in` filter at all. Matching on `where.id?.in` tells the two apart. */
  function findRevertToPendingCall(calls: any[]): any {
    return calls.find((c: any) => c[0]?.where?.id?.in && c[0]?.data?.status === 'PENDING');
  }

  beforeEach(() => {
    prisma = {
      // Success-path SENT marks are now ONE atomic guarded `$executeRaw` UPDATE
      // instead of N per-recipient `update()` calls (FINDING 2 fix) — default
      // to "all rows matched" so existing tests don't need to know about it.
      $executeRaw: jest.fn().mockResolvedValue(3),
      campaign: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'c1',
          workspaceId: WS,
          status: 'SENDING',
          channel: 'SMS',
          subject: null,
          body: 'Hi there',
          links: [],
          iysMessageType: 'BILGILENDIRME',
          netgsmJobIds: [],
        }),
        findUnique: jest.fn().mockResolvedValue({ stats: {} }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      // ACTIVE and unpaused: what every existing row looks like, so the
      // batch-level kill switch is a no-op for these fixtures.
      workspace: { findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE', settings: {}, name: 'Acme' }) },
      channel: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'ch1', workspaceId: WS, type: 'SMS', status: 'ACTIVE', externalId: null, configSealed: 'sealed', configPublic: {},
        }),
      },
      campaignRecipient: {
        findMany: jest.fn().mockResolvedValue(makeRecipients(3)),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      campaignVariant: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn().mockResolvedValue({}) },
      lead: {
        // A valid, distinct TR-mobile-shaped phone per lead (last digit =
        // the lead's own index) — NOT a real phone, but must reduce to a
        // valid 10-digit domestic mobile so toIysMsisdn() normalizes it
        // (the TİCARİ preflight below blocks anything that doesn't).
        findFirst: jest.fn().mockImplementation(async ({ where }: any) => ({
          id: where.id, phone: `0555${where.id.replace(/\D/g, '').padStart(7, '0')}`, smsOptOut: false,
        })),
      },
    };
    const config = { get: jest.fn().mockReturnValue('https://m.test') };
    const scheduledJobs = { schedule: jest.fn() };
    const runner = { registerHandler: jest.fn() };
    registry = { get: jest.fn(), resolveConfig: jest.fn().mockReturnValue(resolvedConfig) };
    quota = { reserve: jest.fn(), refund: jest.fn() };
    smsV2 = { send: jest.fn() };
    const outboundMail = { send: jest.fn() };
    conversationSpend = { settleCampaignSms: jest.fn().mockResolvedValue({ amount: 1, quantity: 1, unitCost: 1 }) };
    // Unused by the default BİLGİLENDİRME fixtures (the preflight only runs
    // for iysMessageType === 'TICARI' — see the dedicated 'TİCARİ İYS
    // preflight' describe below), but still required by the constructor.
    iysClient = { search: jest.fn() };
    budgeter = { tryTake: jest.fn().mockReturnValue(true) };
    const voicesmsSend = { send: jest.fn() };
    svc = new CampaignSenderService(
      prisma as any, config as any, outboundMail as any, scheduledJobs as any, runner as any, registry as any, quota as any, smsV2 as any, conversationSpend as any, iysClient as any, budgeter as any, voicesmsSend as any,
    );
  });

  it('sends 3 eligible recipients in ONE SmsV2Client.send call, each with its own referansId', async () => {
    smsV2.send.mockResolvedValue({ ok: true, code: '00', jobid: 'job-123', message: null, retriable: false, transport: false });

    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    expect(smsV2.send).toHaveBeenCalledTimes(1);
    const [creds, req] = smsV2.send.mock.calls[0];
    expect(creds).toEqual({ usercode: 'u1', password: 'p1' });
    expect(req.msgheader).toBe('HDR1');
    expect(req.messages).toHaveLength(3);
    expect(req.messages.map((m: any) => m.referansId)).toEqual(['r1', 'r2', 'r3']);
    expect(req.iysfilter).toBe('0'); // BILGILENDIRME
    // Quota is reserved per recipient before the batch call, exactly as the
    // per-recipient path reserves before each adapter.send.
    expect(quota.reserve).toHaveBeenCalledTimes(3);
  });

  it('passes iysfilter "11" for a TICARI campaign (every recipient İYS-cleared ONAY)', async () => {
    prisma.campaign.findFirst.mockResolvedValue({
      id: 'c1', workspaceId: WS, status: 'SENDING', channel: 'SMS', body: 'Hi', links: [], iysMessageType: 'TICARI', netgsmJobIds: [],
    });
    registry.resolveConfig.mockReturnValue(resolvedConfigWithBrandCode);
    iysClient.search.mockResolvedValue({ ok: true, status: 'ONAY', message: null });
    smsV2.send.mockResolvedValue({ ok: true, code: '00', jobid: 'job-1', message: null, retriable: false, transport: false });

    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    expect(smsV2.send.mock.calls[0][1].iysfilter).toBe('11');
  });

  it('on success: marks every recipient SENT via ONE atomic guarded UPDATE (messageId/netgsmJobId/referansId/sentAt) and appends the jobid to Campaign.netgsmJobIds', async () => {
    smsV2.send.mockResolvedValue({ ok: true, code: '00', jobid: 'job-123', message: null, retriable: false, transport: false });

    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    // FINDING 2 fix: a single `$executeRaw` UPDATE for the whole batch, not N
    // per-recipient `update()` calls — a crash mid-marks can no longer strand
    // some rows SENT and others SENDING (the latter get reclaimed to PENDING
    // and RESENT by the next tick, duplicating the SMS).
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const [sql, ...values] = prisma.$executeRaw.mock.calls[0];
    const text = Array.isArray(sql) ? sql.join('?') : String(sql);
    expect(text).toContain(`"status" = 'SENT'`);
    expect(text).toContain('"messageId"');
    expect(text).toContain('"netgsmJobId"');
    expect(text).toContain('"referansId" = "id"');
    expect(text).toContain('"sentAt" = NOW()');
    expect(text).toContain('ANY(');
    // Guarded on status = 'SENDING' so the write is scoped to exactly the rows
    // this batch claimed (never a terminal state set concurrently).
    expect(text).toContain(`"status" = 'SENDING'`);
    // Params, in the order they're interpolated: messageId, netgsmJobId, ids,
    // workspaceId, campaignId.
    expect(values).toEqual(['job-123', 'job-123', ['r1', 'r2', 'r3'], WS, 'c1']);

    const jobIdsUpdate = prisma.campaign.update.mock.calls.find((c: any) => c[0].data.netgsmJobIds !== undefined);
    expect(jobIdsUpdate[0].data.netgsmJobIds).toEqual(['job-123']);
    expect(quota.refund).not.toHaveBeenCalled();
  });

  it('settles the per-segment SMS cost for every SENT recipient, keyed by recipientId + its fully-rendered text', async () => {
    smsV2.send.mockResolvedValue({ ok: true, code: '00', jobid: 'job-123', message: null, retriable: false, transport: false });

    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    expect(conversationSpend.settleCampaignSms).toHaveBeenCalledTimes(3);
    const ids = conversationSpend.settleCampaignSms.mock.calls.map((c: any) => c[1].recipientId).sort();
    expect(ids).toEqual(['r1', 'r2', 'r3']);
    // Every call carries the workspaceId + the recipient's own rendered body
    // (the Stop-footer-appended text actually sent), not the raw campaign body.
    for (const [ws, opts] of conversationSpend.settleCampaignSms.mock.calls) {
      expect(ws).toBe(WS);
      expect(opts.text).toContain('Hi there');
      expect(opts.text).toContain('Stop:');
    }
  });

  it('[P0] a settlement failure for one recipient never blocks settling the others, or the batch itself', async () => {
    smsV2.send.mockResolvedValue({ ok: true, code: '00', jobid: 'job-123', message: null, retriable: false, transport: false });
    conversationSpend.settleCampaignSms.mockImplementation(async (_ws: string, opts: any) => {
      if (opts.recipientId === 'r2') throw new Error('tariff lookup failed');
      return { amount: 1, quantity: 1, unitCost: 1 };
    });

    await expect((svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } })).resolves.toBeUndefined();

    expect(conversationSpend.settleCampaignSms).toHaveBeenCalledTimes(3);
    // The batch itself still completed: every recipient was marked SENT via the
    // one atomic guarded UPDATE, unaffected by the r2 settlement throw.
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('does not duplicate an already-recorded jobid in Campaign.netgsmJobIds', async () => {
    prisma.campaign.findFirst.mockResolvedValue({
      id: 'c1', workspaceId: WS, status: 'SENDING', channel: 'SMS', body: 'Hi', links: [],
      iysMessageType: 'BILGILENDIRME', netgsmJobIds: ['job-123'],
    });
    smsV2.send.mockResolvedValue({ ok: true, code: '00', jobid: 'job-123', message: null, retriable: false, transport: false });

    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    const jobIdsUpdate = prisma.campaign.update.mock.calls.find((c: any) => c[0].data.netgsmJobIds !== undefined);
    expect(jobIdsUpdate).toBeUndefined(); // already present → no-op write
  });

  it('provider code 40 marks every recipient FAILED (mapped message) and refunds the whole batch', async () => {
    smsV2.send.mockResolvedValue({
      ok: false, code: '40', jobid: null, message: 'Gönderici başlık (msgheader) hesapta tanımlı veya İYS onaylı değil (kod 40).', retriable: false, transport: false,
    });

    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    const failed = prisma.campaignRecipient.update.mock.calls.filter((c: any) => c[0].data.status === 'FAILED');
    expect(failed).toHaveLength(3);
    expect(failed[0][0].data.error).toContain('kod 40');
    expect(quota.refund).toHaveBeenCalledTimes(1);
    expect(quota.refund).toHaveBeenCalledWith(WS, 'SMS', 3);
    expect(findRevertToPendingCall(prisma.campaignRecipient.updateMany.mock.calls)).toBeUndefined();
  });

  it('provider code 80 (rate limit) reverts every claimed recipient to PENDING (no FAILED marks) and refunds', async () => {
    smsV2.send.mockResolvedValue({ ok: false, code: '80', jobid: null, message: 'rate limited', retriable: true, transport: false });

    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    expect(quota.refund).toHaveBeenCalledTimes(1);
    expect(quota.refund).toHaveBeenCalledWith(WS, 'SMS', 3);
    const revert = findRevertToPendingCall(prisma.campaignRecipient.updateMany.mock.calls);
    expect(revert).toBeTruthy();
    expect(revert[0].where.id.in.sort()).toEqual(['r1', 'r2', 'r3']);
    // FINDING 1 guard: the revert's WHERE is scoped to status:'SENDING' — see
    // the dedicated test below for why (a concurrently-UNSUBSCRIBED row must
    // not be stomped back to PENDING and re-sent).
    expect(revert[0].where.status).toBe('SENDING');
    const failed = prisma.campaignRecipient.update.mock.calls.filter((c: any) => c[0].data.status === 'FAILED');
    expect(failed).toHaveLength(0);
  });

  it('FINDING 1: the code-80 revert-to-PENDING WHERE is guarded on status:\'SENDING\', so a row that moved to a terminal state (e.g. UNSUBSCRIBED via a concurrent opt-out) between claim and revert is left alone instead of being stomped back to PENDING and re-sent', async () => {
    smsV2.send.mockResolvedValue({ ok: false, code: '80', jobid: null, message: 'rate limited', retriable: true, transport: false });
    // Simulate the DB honoring the guard: r2 was flipped to UNSUBSCRIBED by the
    // tracking service (inbound STOP) between the claim and this revert, so only
    // 2 of the 3 claimed ids actually match `status:'SENDING'` and get reverted.
    prisma.campaignRecipient.updateMany.mockImplementation(async ({ where }: any) => {
      if (where?.id?.in && where?.status === 'SENDING') return { count: 2 }; // r2 excluded — still UNSUBSCRIBED
      return { count: 1 };
    });

    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    const revert = findRevertToPendingCall(prisma.campaignRecipient.updateMany.mock.calls);
    expect(revert).toBeTruthy();
    // The WHERE must carry status:'SENDING' — without it, this updateMany would
    // match on id alone and unconditionally overwrite ANY row's status
    // (including a terminal UNSUBSCRIBED) back to PENDING, causing a re-send to
    // someone who just opted out.
    expect(revert[0].where).toEqual({ id: { in: expect.arrayContaining(['r1', 'r2', 'r3']) }, workspaceId: WS, campaignId: 'c1', status: 'SENDING' });
  });

  it('a transport failure reverts every claimed recipient to PENDING and refunds', async () => {
    smsV2.send.mockResolvedValue({ ok: false, code: '', jobid: null, message: 'NetGSM erişilemedi', retriable: false, transport: true });

    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    expect(quota.refund).toHaveBeenCalledTimes(1);
    expect(quota.refund).toHaveBeenCalledWith(WS, 'SMS', 3);
    const revert = findRevertToPendingCall(prisma.campaignRecipient.updateMany.mock.calls);
    expect(revert).toBeTruthy();
    expect(revert[0].where.id.in.sort()).toEqual(['r1', 'r2', 'r3']);
    expect(revert[0].where.status).toBe('SENDING');
  });

  it('excludes an opted-out recipient before the batch call (mixed opt-out)', async () => {
    prisma.lead.findFirst.mockImplementation(async ({ where }: any) =>
      where.id === 'l2'
        ? { id: 'l2', phone: '05551112233', smsOptOut: true }
        : { id: where.id, phone: `0555000${where.id}`, smsOptOut: false },
    );
    smsV2.send.mockResolvedValue({ ok: true, code: '00', jobid: 'job-x', message: null, retriable: false, transport: false });

    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    expect(smsV2.send).toHaveBeenCalledTimes(1);
    const req = smsV2.send.mock.calls[0][1];
    expect(req.messages).toHaveLength(2);
    expect(req.messages.map((m: any) => m.referansId)).toEqual(['r1', 'r3']);
    const skipped = prisma.campaignRecipient.update.mock.calls.filter((c: any) => c[0].data.status === 'SKIPPED');
    expect(skipped).toHaveLength(1);
    expect(skipped[0][0].where.id).toBe('r2');
    // The opted-out recipient never reserved quota (only the 2 eligible ones did).
    expect(quota.reserve).toHaveBeenCalledTimes(2);
  });

  it('falls back to the legacy per-recipient adapter.send loop when the channel has useLegacySend=true', async () => {
    registry.resolveConfig.mockReturnValue({ ...resolvedConfig, public: { useLegacySend: true } });
    const adapterSend = jest.fn().mockResolvedValue({ externalMessageId: 'leg-1', status: 'SENT' });
    registry.get.mockReturnValue({ send: adapterSend });

    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    expect(smsV2.send).not.toHaveBeenCalled();
    expect(adapterSend).toHaveBeenCalledTimes(3); // one round-trip per recipient — the legacy loop
    const sent = prisma.campaignRecipient.update.mock.calls.filter((c: any) => c[0].data.status === 'SENT');
    expect(sent).toHaveLength(3);
    expect(sent.every((c: any) => c[0].data.messageId === 'leg-1')).toBe(true);
  });

  // Money-path fix: useLegacySend bypasses sendSmsBatch() (the v2 batch path's
  // settlement) entirely — a legacy-configured SMS channel sent real, billed
  // NetGSM messages that never debited the SpendLedger. Each successful legacy
  // send must now settle individually, keyed by the SAME ref (recipientId) the
  // v2 path uses, so a future retry/replay still dedups via debitOnce.
  it('settles the per-segment SMS cost for each SENT recipient on the legacy per-recipient path', async () => {
    registry.resolveConfig.mockReturnValue({ ...resolvedConfig, public: { useLegacySend: true } });
    const adapterSend = jest.fn().mockResolvedValue({ externalMessageId: 'leg-1', status: 'SENT' });
    registry.get.mockReturnValue({ send: adapterSend });

    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    expect(conversationSpend.settleCampaignSms).toHaveBeenCalledTimes(3);
    const ids = conversationSpend.settleCampaignSms.mock.calls.map((c: any) => c[1].recipientId).sort();
    expect(ids).toEqual(['r1', 'r2', 'r3']);
    for (const [ws, opts] of conversationSpend.settleCampaignSms.mock.calls) {
      expect(ws).toBe(WS);
      expect(opts.text).toContain('Hi there');
    }
  });

  it('does NOT settle a recipient the legacy adapter reports FAILED', async () => {
    registry.resolveConfig.mockReturnValue({ ...resolvedConfig, public: { useLegacySend: true } });
    const adapterSend = jest.fn().mockResolvedValue({ externalMessageId: null, status: 'FAILED', error: 'carrier reject' });
    registry.get.mockReturnValue({ send: adapterSend });

    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    expect(conversationSpend.settleCampaignSms).not.toHaveBeenCalled();
  });

  it('a legacy-path settlement failure for one recipient never blocks marking it SENT or settling the others', async () => {
    registry.resolveConfig.mockReturnValue({ ...resolvedConfig, public: { useLegacySend: true } });
    const adapterSend = jest.fn().mockResolvedValue({ externalMessageId: 'leg-1', status: 'SENT' });
    registry.get.mockReturnValue({ send: adapterSend });
    conversationSpend.settleCampaignSms.mockImplementation(async (_ws: string, opts: any) => {
      if (opts.recipientId === 'r2') throw new Error('tariff lookup failed');
      return { amount: 1, quantity: 1, unitCost: 1 };
    });

    await expect((svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } })).resolves.toBeUndefined();

    expect(conversationSpend.settleCampaignSms).toHaveBeenCalledTimes(3);
    const sent = prisma.campaignRecipient.update.mock.calls.filter((c: any) => c[0].data.status === 'SENT');
    expect(sent).toHaveLength(3); // r2's settlement throw didn't stop it (or its siblings) from being marked SENT
  });
});

/**
 * TİCARİ pre-send İYS hard-block (Phase 2 Task 5, owner decision: full-auto +
 * fail-closed). RET/YOK block a recipient permanently; a genuine search
 * failure or a missing brandCode fail the WHOLE tick closed (nothing sent,
 * everyone reverts to PENDING); a budget-exhausted recipient is a softer,
 * per-recipient defer that doesn't hold back recipients already cleared ONAY
 * this same tick.
 */
describe('CampaignSenderService.batch — TİCARİ İYS preflight', () => {
  const WS = 'ws-1';
  let prisma: any;
  let registry: { get: jest.Mock; resolveConfig: jest.Mock };
  let quota: { reserve: jest.Mock; refund: jest.Mock };
  let smsV2: { send: jest.Mock };
  let iysClient: { search: jest.Mock };
  let budgeter: { tryTake: jest.Mock };
  let svc: CampaignSenderService;

  const resolvedConfig = {
    channelId: 'ch1',
    workspaceId: WS,
    type: 'SMS',
    externalId: null,
    secrets: { usercode: 'u1', password: 'p1', msgheader: 'HDR1' },
    public: { brandCode: 'BR1' } as Record<string, unknown>,
  };

  function makeRecipients(n: number) {
    return Array.from({ length: n }, (_, i) => ({ id: `r${i + 1}`, leadId: `l${i + 1}`, token: `t${i + 1}` }));
  }

  /** Same discriminant as the SMS v2 batching describe above: a revert-to-
   *  PENDING updateMany carries `where.id.in` + `data.status: 'PENDING'`,
   *  distinct from the unconditional stranded-SENDING reclaim sweep. */
  function findRevertToPendingCall(calls: any[]): any {
    return calls.find((c: any) => c[0]?.where?.id?.in && c[0]?.data?.status === 'PENDING');
  }

  beforeEach(() => {
    prisma = {
      $executeRaw: jest.fn().mockResolvedValue(3),
      campaign: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'c1', workspaceId: WS, status: 'SENDING', channel: 'SMS', subject: null, body: 'Hi there', links: [],
          iysMessageType: 'TICARI', netgsmJobIds: [],
        }),
        findUnique: jest.fn().mockResolvedValue({ stats: {} }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      // ACTIVE and unpaused: what every existing row looks like, so the
      // batch-level kill switch is a no-op for these fixtures.
      workspace: { findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE', settings: {}, name: 'Acme' }) },
      channel: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'ch1', workspaceId: WS, type: 'SMS', status: 'ACTIVE', externalId: null, configSealed: 'sealed',
          configPublic: { brandCode: 'BR1' },
        }),
      },
      campaignRecipient: {
        findMany: jest.fn().mockResolvedValue(makeRecipients(3)),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      campaignVariant: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn().mockResolvedValue({}) },
      lead: {
        // A valid, distinct TR-mobile-shaped phone per lead (last digit =
        // the lead's own index) — the TİCARİ preflight normalizes/validates
        // this via toIysMsisdn() before ever searching İYS.
        findFirst: jest.fn().mockImplementation(async ({ where }: any) => ({
          id: where.id, phone: `0555${where.id.replace(/\D/g, '').padStart(7, '0')}`, smsOptOut: false,
        })),
      },
    };
    const config = { get: jest.fn().mockReturnValue('https://m.test') };
    const scheduledJobs = { schedule: jest.fn() };
    const runner = { registerHandler: jest.fn() };
    registry = { get: jest.fn(), resolveConfig: jest.fn().mockReturnValue(resolvedConfig) };
    quota = { reserve: jest.fn(), refund: jest.fn() };
    smsV2 = { send: jest.fn().mockResolvedValue({ ok: true, code: '00', jobid: 'job-1', message: null, retriable: false, transport: false }) };
    const outboundMail = { send: jest.fn() };
    const conversationSpend = { settleCampaignSms: jest.fn().mockResolvedValue({ amount: 1, quantity: 1, unitCost: 1 }) };
    // Default: every recipient İYS-cleared ONAY, budget always available —
    // individual tests narrow this to exercise RET/YOK/error/exhaustion.
    iysClient = { search: jest.fn().mockResolvedValue({ ok: true, status: 'ONAY', message: null }) };
    budgeter = { tryTake: jest.fn().mockReturnValue(true) };
    const voicesmsSend = { send: jest.fn() };
    svc = new CampaignSenderService(
      prisma as any, config as any, outboundMail as any, scheduledJobs as any, runner as any, registry as any, quota as any, smsV2 as any, conversationSpend as any, iysClient as any, budgeter as any, voicesmsSend as any,
    );
  });

  it('RET recipient is SKIPPED with the İYS error and counted into stats.iysBlocked; ONAY recipients still send', async () => {
    iysClient.search.mockImplementation(async (_creds: any, phone: string) => (
      // r1/l1's normalized wire phone ends in '1' (see makeRecipients/lead
      // fixture) — distinct from r2/r3's '...2'/'...3'.
      phone.endsWith('1') ? { ok: true, status: 'RET', message: null } : { ok: true, status: 'ONAY', message: null }
    ));

    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    const skipped = prisma.campaignRecipient.update.mock.calls.filter((c: any) => c[0].data.status === 'SKIPPED');
    expect(skipped).toHaveLength(1);
    expect(skipped[0][0].where.id).toBe('r1');
    expect(skipped[0][0].data.error).toContain('İYS');

    // Only the 2 ONAY-cleared recipients ever reach the wire.
    expect(smsV2.send).toHaveBeenCalledTimes(1);
    expect(smsV2.send.mock.calls[0][1].messages.map((m: any) => m.referansId).sort()).toEqual(['r2', 'r3']);

    // stats.iysBlocked bumped by exactly the 1 blocked recipient.
    const statsUpdate = prisma.campaign.update.mock.calls.find((c: any) => c[0].data.stats?.iysBlocked !== undefined);
    expect(statsUpdate[0].data.stats.iysBlocked).toBe(1);

    // The blocked recipient's earlier-reserved quota is refunded (it was never sent).
    expect(quota.refund).toHaveBeenCalledWith(WS, 'SMS', 1);
  });

  it('YOK (İYS holds no record) is treated as blocked exactly like RET', async () => {
    iysClient.search.mockImplementation(async (_creds: any, phone: string) => (
      phone.endsWith('2') ? { ok: true, status: 'YOK', message: null } : { ok: true, status: 'ONAY', message: null }
    ));

    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    const skipped = prisma.campaignRecipient.update.mock.calls.filter((c: any) => c[0].data.status === 'SKIPPED');
    expect(skipped).toHaveLength(1);
    expect(skipped[0][0].where.id).toBe('r2');
    const statsUpdate = prisma.campaign.update.mock.calls.find((c: any) => c[0].data.stats?.iysBlocked !== undefined);
    expect(statsUpdate[0].data.stats.iysBlocked).toBe(1);
  });

  it('every recipient ONAY-cleared sends normally with iysfilter "11"', async () => {
    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    expect(smsV2.send).toHaveBeenCalledTimes(1);
    expect(smsV2.send.mock.calls[0][1].iysfilter).toBe('11');
    expect(smsV2.send.mock.calls[0][1].messages).toHaveLength(3);
    const skipped = prisma.campaignRecipient.update.mock.calls.filter((c: any) => c[0].data.status === 'SKIPPED');
    expect(skipped).toHaveLength(0);
  });

  it('a genuine İYS search error aborts the WHOLE tick: zero sends, every recipient reverts to PENDING, iysUnavailable stamped', async () => {
    iysClient.search.mockImplementation(async (_creds: any, phone: string) => (
      phone.endsWith('2') ? { ok: false, status: null, message: 'NetGSM erişilemedi' } : { ok: true, status: 'ONAY', message: null }
    ));

    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    expect(smsV2.send).not.toHaveBeenCalled();
    // Nothing is ever marked SENT, FAILED, or SKIPPED — only reverted to PENDING.
    const terminalMarks = prisma.campaignRecipient.update.mock.calls.filter((c: any) =>
      ['SENT', 'FAILED', 'SKIPPED'].includes(c[0].data.status),
    );
    expect(terminalMarks).toHaveLength(0);
    const revert = findRevertToPendingCall(prisma.campaignRecipient.updateMany.mock.calls);
    expect(revert).toBeTruthy();
    expect(revert[0].where.id.in.sort()).toEqual(['r1', 'r2', 'r3']);
    // Every reserved quota unit refunded — nothing was sent, including the
    // recipient (r1) that had already cleared ONAY earlier in this same loop.
    expect(quota.refund).toHaveBeenCalledWith(WS, 'SMS', 3);
    const statsUpdate = prisma.campaign.update.mock.calls.find((c: any) => c[0].data.stats?.iysUnavailable !== undefined);
    expect(statsUpdate[0].data.stats.iysUnavailable).toBe(true);
  });

  it('a missing brandCode on the channel aborts the WHOLE tick the same way, before any budget check or search call', async () => {
    registry.resolveConfig.mockReturnValue({ ...resolvedConfig, public: {} });

    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    expect(budgeter.tryTake).not.toHaveBeenCalled();
    expect(iysClient.search).not.toHaveBeenCalled();
    expect(smsV2.send).not.toHaveBeenCalled();
    const revert = findRevertToPendingCall(prisma.campaignRecipient.updateMany.mock.calls);
    expect(revert).toBeTruthy();
    expect(revert[0].where.id.in.sort()).toEqual(['r1', 'r2', 'r3']);
    expect(quota.refund).toHaveBeenCalledWith(WS, 'SMS', 3);
    const statsUpdate = prisma.campaign.update.mock.calls.find((c: any) => c[0].data.stats?.iysUnavailable !== undefined);
    expect(statsUpdate[0].data.stats.iysUnavailable).toBe(true);
  });

  it('a BİLGİLENDİRME campaign skips the preflight entirely — no budget check, no search calls, sends normally with iysfilter "0"', async () => {
    prisma.campaign.findFirst.mockResolvedValue({
      id: 'c1', workspaceId: WS, status: 'SENDING', channel: 'SMS', body: 'Hi there', links: [],
      iysMessageType: 'BILGILENDIRME', netgsmJobIds: [],
    });

    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    expect(budgeter.tryTake).not.toHaveBeenCalled();
    expect(iysClient.search).not.toHaveBeenCalled();
    expect(smsV2.send).toHaveBeenCalledTimes(1);
    expect(smsV2.send.mock.calls[0][1].iysfilter).toBe('0');
    expect(smsV2.send.mock.calls[0][1].messages).toHaveLength(3);
  });

  it('budget exhaustion is a SOFT per-recipient defer: ONAY-cleared recipients still send this tick, the unchecked one just reverts to PENDING (not blocked, not FAILED, not iysUnavailable)', async () => {
    // r1 and r2's search is budgeted through; r3's is denied (account budget
    // exhausted this minute) — never even attempts a search call for it.
    budgeter.tryTake.mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(false);

    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    expect(iysClient.search).toHaveBeenCalledTimes(2); // r3 never attempted
    expect(smsV2.send).toHaveBeenCalledTimes(1);
    expect(smsV2.send.mock.calls[0][1].messages.map((m: any) => m.referansId).sort()).toEqual(['r1', 'r2']);

    const revert = findRevertToPendingCall(prisma.campaignRecipient.updateMany.mock.calls);
    expect(revert).toBeTruthy();
    expect(revert[0].where.id.in).toEqual(['r3']);

    // Not blocked (no SKIPPED mark, no iysBlocked bump) — just deferred.
    const skipped = prisma.campaignRecipient.update.mock.calls.filter((c: any) => c[0].data.status === 'SKIPPED');
    expect(skipped).toHaveLength(0);
    const blockedUpdate = prisma.campaign.update.mock.calls.find((c: any) => c[0].data.stats?.iysBlocked !== undefined);
    expect(blockedUpdate).toBeUndefined();
    // Its earlier-reserved quota is refunded so the next tick's reserve() isn't a double-reserve.
    expect(quota.refund).toHaveBeenCalledWith(WS, 'SMS', 1);
    // A soft per-recipient defer is normal throttling, not a compliance
    // failure — iysUnavailable is reserved for the hard-abort paths only.
    const unavailableUpdate = prisma.campaign.update.mock.calls.find((c: any) => c[0].data.stats?.iysUnavailable !== undefined);
    expect(unavailableUpdate).toBeUndefined();
  });

  // Final-review MUST-FIX H1: the legacy per-recipient send path (this.send()
  // → NetgsmSmsAdapter's legacy /sms/send/get) has NO İYS search and no
  // iysfilter at all — iysPreflight/sendSmsBatch only ever run when
  // `smsV2Config` is set (REST v2). A TİCARİ campaign stuck on a channel that
  // opted back into useLegacySend (or is missing v2 creds) must never fall
  // through to that unchecked legacy loop.
  describe('legacy-send channel (H1: TİCARİ hard-block)', () => {
    it('a TİCARİ campaign on a legacy-send channel sends NOTHING this tick: no v2 batch call, no legacy adapter call, nothing claimed/marked, iysUnavailable stamped', async () => {
      registry.resolveConfig.mockReturnValue({ ...resolvedConfig, public: { ...resolvedConfig.public, useLegacySend: true } });
      const adapterSend = jest.fn();
      registry.get.mockReturnValue({ send: adapterSend });

      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

      // Neither send path is ever reached — the legacy per-recipient adapter
      // (which has no İYS check at all) never gets a chance to run.
      expect(smsV2.send).not.toHaveBeenCalled();
      expect(adapterSend).not.toHaveBeenCalled();
      expect(iysClient.search).not.toHaveBeenCalled();
      // No recipient is claimed (PENDING→SENDING) or marked any terminal
      // state — they stay exactly PENDING as the batch found them.
      const claims = prisma.campaignRecipient.updateMany.mock.calls.filter((c: any) => c[0]?.data?.status === 'SENDING');
      expect(claims).toHaveLength(0);
      const terminalMarks = prisma.campaignRecipient.update.mock.calls.filter((c: any) =>
        ['SENT', 'FAILED', 'SKIPPED'].includes(c[0].data.status),
      );
      expect(terminalMarks).toHaveLength(0);
      const statsUpdate = prisma.campaign.update.mock.calls.find((c: any) => c[0].data.stats?.iysUnavailable !== undefined);
      expect(statsUpdate[0].data.stats.iysUnavailable).toBe(true);
    });

    it('a BİLGİLENDİRME campaign on the SAME legacy-send channel is unaffected — sends normally via the legacy per-recipient loop', async () => {
      prisma.campaign.findFirst.mockResolvedValue({
        id: 'c1', workspaceId: WS, status: 'SENDING', channel: 'SMS', subject: null, body: 'Hi there', links: [],
        iysMessageType: 'BILGILENDIRME', netgsmJobIds: [],
      });
      registry.resolveConfig.mockReturnValue({ ...resolvedConfig, public: { ...resolvedConfig.public, useLegacySend: true } });
      const adapterSend = jest.fn().mockResolvedValue({ externalMessageId: 'leg-1', status: 'SENT' });
      registry.get.mockReturnValue({ send: adapterSend });

      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

      expect(adapterSend).toHaveBeenCalledTimes(3);
      const sent = prisma.campaignRecipient.update.mock.calls.filter((c: any) => c[0].data.status === 'SENT');
      expect(sent).toHaveLength(3);
      expect(iysClient.search).not.toHaveBeenCalled(); // BİLGİLENDİRME never runs the preflight
    });
  });

  // Final-review MUST-FIX H2: İYS's wire format is 90XXXXXXXXXX (no `+`) —
  // `r.phone` is whatever shape the lead's phone was typed in. A phone that
  // can't reduce to a TR mobile at all must be blocked (can't verify), never
  // silently searched/sent as raw input.
  it('H2: a recipient whose phone cannot normalize to a TR mobile is blocked (SKIPPED) without ever calling İYS search for it; the other ONAY-cleared recipients still send', async () => {
    prisma.lead.findFirst.mockImplementation(async ({ where }: any) => (
      where.id === 'l1'
        ? { id: 'l1', phone: '02121234567', smsOptOut: false } // a landline — not a TR mobile
        : { id: where.id, phone: `0555${where.id.replace(/\D/g, '').padStart(7, '0')}`, smsOptOut: false }
    ));

    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    // r1's phone never reaches İYS at all — only r2/r3 (valid mobiles) are searched.
    expect(iysClient.search).toHaveBeenCalledTimes(2);
    const skipped = prisma.campaignRecipient.update.mock.calls.filter((c: any) => c[0].data.status === 'SKIPPED');
    expect(skipped).toHaveLength(1);
    expect(skipped[0][0].where.id).toBe('r1');
    expect(skipped[0][0].data.error).toContain('İYS');
    // Same bucket/side-effects as RET/YOK: counted into iysBlocked, quota refunded.
    const statsUpdate = prisma.campaign.update.mock.calls.find((c: any) => c[0].data.stats?.iysBlocked !== undefined);
    expect(statsUpdate[0].data.stats.iysBlocked).toBe(1);
    expect(smsV2.send).toHaveBeenCalledTimes(1);
    expect(smsV2.send.mock.calls[0][1].messages.map((m: any) => m.referansId).sort()).toEqual(['r2', 'r3']);
  });
});

/**
 * VOICE campaigns (NetGSM Phase 5 Task 2): `voicesms/send` has no batch shape
 * (unlike SmsV2Client.send) — every eligible recipient gets its own
 * VoicesmsSendClient.send round-trip, throttled by the existing
 * BATCH_SIZE/BATCH_INTERVAL_SEC cadence. Creds are resolved from the ACTIVE
 * SMS channel (voicesms/send reuses that same NetGSM account), and a TİCARİ
 * campaign runs an İYS ARAMA preflight (not MESAJ) mirroring the SMS
 * preflight's fail-closed contract.
 */
describe('CampaignSenderService.batch — VOICE campaigns', () => {
  const WS = 'ws-1';
  let prisma: any;
  let registry: { get: jest.Mock; resolveConfig: jest.Mock };
  let quota: { reserve: jest.Mock; refund: jest.Mock };
  let voicesmsSend: { send: jest.Mock };
  let iysClient: { search: jest.Mock };
  let budgeter: { tryTake: jest.Mock };
  let svc: CampaignSenderService;

  const resolvedConfig = {
    channelId: 'ch1',
    workspaceId: WS,
    type: 'SMS',
    externalId: null,
    secrets: { usercode: 'u1', password: 'p1' },
    public: {} as Record<string, unknown>,
  };
  /** A TİCARİ-ready channel config carrying the İYS brandCode voicesms/send's
   *  `brandcode` field + the ARAMA preflight both need. */
  const resolvedConfigWithBrandCode = { ...resolvedConfig, public: { brandCode: 'BR1' } };

  function makeRecipients(n: number) {
    return Array.from({ length: n }, (_, i) => ({ id: `r${i + 1}`, leadId: `l${i + 1}`, token: `t${i + 1}` }));
  }

  /** A per-recipient revert-to-PENDING call: `where.id` is a bare string (one
   *  recipient), distinct from the unconditional top-of-batch stranded-SENDING
   *  sweep (no `id` key at all) and from the SMS batch path's bulk `id.in`
   *  revert (VOICE has no batch shape, so its revert is always singular). */
  function findRevertToPendingCalls(calls: any[]): any[] {
    return calls.filter((c: any) => typeof c[0]?.where?.id === 'string' && c[0]?.data?.status === 'PENDING');
  }

  beforeAll(() => {
    process.env.MARKETING_SECRET_KEY = Buffer.from('k'.repeat(32)).toString('base64');
  });
  afterAll(() => {
    delete process.env.MARKETING_SECRET_KEY;
  });

  beforeEach(() => {
    prisma = {
      campaign: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'c1', workspaceId: WS, status: 'SENDING', channel: 'VOICE', subject: null,
          body: 'Voice campaign', links: [], iysMessageType: 'BILGILENDIRME',
          voiceConfig: { msg: 'Merhaba, bu bir duyurudur.' },
        }),
        findUnique: jest.fn().mockResolvedValue({ stats: {} }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      // ACTIVE and unpaused: what every existing row looks like, so the
      // batch-level kill switch is a no-op for these fixtures.
      workspace: { findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE', settings: {}, name: 'Acme' }) },
      channel: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'ch1', workspaceId: WS, type: 'SMS', status: 'ACTIVE', externalId: null, configSealed: 'sealed', configPublic: {},
        }),
      },
      campaignRecipient: {
        findMany: jest.fn().mockResolvedValue(makeRecipients(3)),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      campaignVariant: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn().mockResolvedValue({}) },
      lead: {
        // A valid, distinct TR-mobile-shaped phone per lead — same fixture
        // shape the SMS describes above use (toIysMsisdn() must normalize it
        // for the ARAMA preflight tests below).
        findFirst: jest.fn().mockImplementation(async ({ where }: any) => ({
          id: where.id, phone: `0555${where.id.replace(/\D/g, '').padStart(7, '0')}`, smsOptOut: false,
        })),
      },
    };
    const config = { get: jest.fn().mockReturnValue('https://m.test') };
    const scheduledJobs = { schedule: jest.fn() };
    const runner = { registerHandler: jest.fn() };
    registry = { get: jest.fn(), resolveConfig: jest.fn().mockReturnValue(resolvedConfig) };
    quota = { reserve: jest.fn(), refund: jest.fn() };
    const smsV2 = { send: jest.fn() };
    const outboundMail = { send: jest.fn() };
    const conversationSpend = { settleCampaignSms: jest.fn() };
    // Default: every recipient İYS-cleared ONAY — individual tests narrow
    // this to exercise RET/YOK/error/exhaustion, same as the SMS preflight
    // describe above.
    iysClient = { search: jest.fn().mockResolvedValue({ ok: true, status: 'ONAY', message: null }) };
    budgeter = { tryTake: jest.fn().mockReturnValue(true) };
    voicesmsSend = { send: jest.fn() };
    svc = new CampaignSenderService(
      prisma as any, config as any, outboundMail as any, scheduledJobs as any, runner as any, registry as any, quota as any, smsV2 as any, conversationSpend as any, iysClient as any, budgeter as any, voicesmsSend as any,
    );
  });

  it('sends every eligible recipient via VoicesmsSendClient.send (msg/no/relationid/iysfilter "0") and includes the voice-report webhook url', async () => {
    voicesmsSend.send.mockResolvedValue({ ok: true, code: '00', jobid: 'call-1', relationid: null, message: null, retriable: false, transport: false });

    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    expect(voicesmsSend.send).toHaveBeenCalledTimes(3);
    const [creds, req] = voicesmsSend.send.mock.calls[0];
    expect(creds).toEqual({ usercode: 'u1', password: 'p1' });
    expect(req.msg).toBe('Merhaba, bu bir duyurudur.');
    expect(req.audioid).toBeUndefined();
    expect(req.iysfilter).toBe('0');
    expect(req.relationid).toBe('r1');
    expect(req.no).toMatch(/^0555/);
    expect(req.brandcode).toBeUndefined(); // BİLGİLENDİRME never sends a brandcode
    expect(req.url).toContain('/api/public/netgsm/');
    expect(req.url).toContain('voice-report');
    // Every recipient's own relationid is distinct.
    expect(voicesmsSend.send.mock.calls.map((c: any) => c[1].relationid).sort()).toEqual(['r1', 'r2', 'r3']);
    expect(quota.reserve).toHaveBeenCalledTimes(3);
  });

  it('uses audioid instead of msg when the campaign voiceConfig carries one', async () => {
    prisma.campaign.findFirst.mockResolvedValue({
      id: 'c1', workspaceId: WS, status: 'SENDING', channel: 'VOICE', body: 'Voice campaign', links: [],
      iysMessageType: 'BILGILENDIRME', voiceConfig: { audioid: 'aud-123' },
    });
    voicesmsSend.send.mockResolvedValue({ ok: true, code: '00', jobid: 'call-1', relationid: null, message: null, retriable: false, transport: false });

    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    const req = voicesmsSend.send.mock.calls[0][1];
    expect(req.audioid).toBe('aud-123');
    expect(req.msg).toBeUndefined();
  });

  it('passes keys[] (DTMF map) through to voicesms/send when configured', async () => {
    prisma.campaign.findFirst.mockResolvedValue({
      id: 'c1', workspaceId: WS, status: 'SENDING', channel: 'VOICE', body: 'Voice campaign', links: [],
      iysMessageType: 'BILGILENDIRME', voiceConfig: { msg: 'Merhaba', keys: ['1', '2'] },
    });
    voicesmsSend.send.mockResolvedValue({ ok: true, code: '00', jobid: 'call-1', relationid: null, message: null, retriable: false, transport: false });

    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    expect(voicesmsSend.send.mock.calls[0][1].keys).toEqual(['1', '2']);
  });

  it('on success: marks the recipient SENT with messageId=jobid, WITHOUT stamping netgsmJobId/referansId (those are the SMS DLR-poll reconciler\'s own signal)', async () => {
    voicesmsSend.send.mockResolvedValue({ ok: true, code: '00', jobid: 'call-xyz', relationid: null, message: null, retriable: false, transport: false });

    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    const sent = prisma.campaignRecipient.update.mock.calls.filter((c: any) => c[0].data.status === 'SENT');
    expect(sent).toHaveLength(3);
    for (const call of sent) {
      expect(call[0].data.messageId).toBe('call-xyz');
      expect(call[0].data.netgsmJobId).toBeUndefined();
      expect(call[0].data.referansId).toBeUndefined();
      expect(call[0].data.sentAt).toBeInstanceOf(Date);
    }
    expect(quota.refund).not.toHaveBeenCalled();
  });

  it('passes iysfilter "11" + brandcode for a TİCARİ campaign (every recipient ARAMA-cleared ONAY)', async () => {
    prisma.campaign.findFirst.mockResolvedValue({
      id: 'c1', workspaceId: WS, status: 'SENDING', channel: 'VOICE', body: 'Voice campaign', links: [],
      iysMessageType: 'TICARI', voiceConfig: { msg: 'Merhaba' },
    });
    registry.resolveConfig.mockReturnValue(resolvedConfigWithBrandCode);
    voicesmsSend.send.mockResolvedValue({ ok: true, code: '00', jobid: 'call-1', relationid: null, message: null, retriable: false, transport: false });

    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    expect(iysClient.search.mock.calls[0][2]).toBe('ARAMA'); // consent type ARAMA, not MESAJ
    expect(voicesmsSend.send).toHaveBeenCalledTimes(3);
    for (const call of voicesmsSend.send.mock.calls) {
      expect(call[1].iysfilter).toBe('11');
      expect(call[1].brandcode).toBe('BR1');
    }
  });

  it('a provider error (non-retriable) marks the recipient FAILED and refunds its quota', async () => {
    voicesmsSend.send.mockResolvedValue({ ok: false, code: '40', jobid: null, relationid: null, message: 'invalid number', retriable: false, transport: false });

    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    const failed = prisma.campaignRecipient.update.mock.calls.filter((c: any) => c[0].data.status === 'FAILED');
    expect(failed).toHaveLength(3);
    expect(failed[0][0].data.error).toContain('invalid number');
    expect(quota.refund).toHaveBeenCalledTimes(3);
    expect(quota.refund).toHaveBeenCalledWith(WS, 'VOICE');
  });

  it('a rate-limit (retriable) response reverts the recipient to PENDING (not FAILED) and refunds', async () => {
    voicesmsSend.send.mockResolvedValue({ ok: false, code: '80', jobid: null, relationid: null, message: 'rate limited', retriable: true, transport: false });

    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    const reverts = findRevertToPendingCalls(prisma.campaignRecipient.updateMany.mock.calls);
    expect(reverts.map((c: any) => c[0].where.id).sort()).toEqual(['r1', 'r2', 'r3']);
    expect(reverts.every((c: any) => c[0].where.status === 'SENDING')).toBe(true);
    const failed = prisma.campaignRecipient.update.mock.calls.filter((c: any) => c[0].data.status === 'FAILED');
    expect(failed).toHaveLength(0);
    expect(quota.refund).toHaveBeenCalledTimes(3);
  });

  it('a transport failure reverts the recipient to PENDING and refunds', async () => {
    voicesmsSend.send.mockResolvedValue({ ok: false, code: '', jobid: null, relationid: null, message: 'NetGSM erişilemedi', retriable: false, transport: true });

    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    const reverts = findRevertToPendingCalls(prisma.campaignRecipient.updateMany.mock.calls);
    expect(reverts).toHaveLength(3);
  });

  it('excludes an opted-out recipient (smsOptOut proxy) before ever reserving quota or calling voicesms/send for it', async () => {
    prisma.lead.findFirst.mockImplementation(async ({ where }: any) =>
      where.id === 'l2'
        ? { id: 'l2', phone: '05551112233', smsOptOut: true }
        : { id: where.id, phone: `0555000${where.id}`, smsOptOut: false },
    );
    voicesmsSend.send.mockResolvedValue({ ok: true, code: '00', jobid: 'call-1', relationid: null, message: null, retriable: false, transport: false });

    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    expect(voicesmsSend.send).toHaveBeenCalledTimes(2);
    const skipped = prisma.campaignRecipient.update.mock.calls.filter((c: any) => c[0].data.status === 'SKIPPED');
    expect(skipped).toHaveLength(1);
    expect(skipped[0][0].where.id).toBe('r2');
    expect(quota.reserve).toHaveBeenCalledTimes(2);
  });

  it('no ACTIVE SMS channel configured (no creds resolvable) — sends nothing this tick and leaves every recipient PENDING', async () => {
    prisma.channel.findFirst.mockResolvedValue(null);

    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    expect(voicesmsSend.send).not.toHaveBeenCalled();
    // Nothing claimed (PENDING→SENDING) or marked any terminal state.
    const claims = prisma.campaignRecipient.updateMany.mock.calls.filter((c: any) => c[0]?.data?.status === 'SENDING');
    expect(claims).toHaveLength(0);
    const terminalMarks = prisma.campaignRecipient.update.mock.calls.filter((c: any) =>
      ['SENT', 'FAILED', 'SKIPPED'].includes(c[0].data.status),
    );
    expect(terminalMarks).toHaveLength(0);
  });

  describe('TİCARİ İYS ARAMA preflight', () => {
    beforeEach(() => {
      prisma.campaign.findFirst.mockResolvedValue({
        id: 'c1', workspaceId: WS, status: 'SENDING', channel: 'VOICE', body: 'Voice campaign', links: [],
        iysMessageType: 'TICARI', voiceConfig: { msg: 'Merhaba' },
      });
      registry.resolveConfig.mockReturnValue(resolvedConfigWithBrandCode);
      voicesmsSend.send.mockResolvedValue({ ok: true, code: '00', jobid: 'call-1', relationid: null, message: null, retriable: false, transport: false });
    });

    it('RET is blocked (SKIPPED) + counted into stats.iysBlocked; ONAY recipients still get called', async () => {
      iysClient.search.mockImplementation(async (_creds: any, phone: string) => (
        phone.endsWith('1') ? { ok: true, status: 'RET', message: null } : { ok: true, status: 'ONAY', message: null }
      ));

      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

      const skipped = prisma.campaignRecipient.update.mock.calls.filter((c: any) => c[0].data.status === 'SKIPPED');
      expect(skipped).toHaveLength(1);
      expect(skipped[0][0].where.id).toBe('r1');
      expect(skipped[0][0].data.error).toContain('İYS');
      expect(voicesmsSend.send).toHaveBeenCalledTimes(2);
      const statsUpdate = prisma.campaign.update.mock.calls.find((c: any) => c[0].data.stats?.iysBlocked !== undefined);
      expect(statsUpdate[0].data.stats.iysBlocked).toBe(1);
      expect(quota.refund).toHaveBeenCalledWith(WS, 'VOICE', 1);
    });

    it('YOK is treated as blocked exactly like RET', async () => {
      iysClient.search.mockImplementation(async (_creds: any, phone: string) => (
        phone.endsWith('2') ? { ok: true, status: 'YOK', message: null } : { ok: true, status: 'ONAY', message: null }
      ));

      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

      const skipped = prisma.campaignRecipient.update.mock.calls.filter((c: any) => c[0].data.status === 'SKIPPED');
      expect(skipped).toHaveLength(1);
      expect(skipped[0][0].where.id).toBe('r2');
    });

    it('a genuine İYS search error aborts the WHOLE tick: zero calls placed, every recipient reverts to PENDING, iysUnavailable stamped', async () => {
      iysClient.search.mockImplementation(async (_creds: any, phone: string) => (
        phone.endsWith('2') ? { ok: false, status: null, message: 'NetGSM erişilemedi' } : { ok: true, status: 'ONAY', message: null }
      ));

      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

      expect(voicesmsSend.send).not.toHaveBeenCalled();
      const terminalMarks = prisma.campaignRecipient.update.mock.calls.filter((c: any) =>
        ['SENT', 'FAILED', 'SKIPPED'].includes(c[0].data.status),
      );
      expect(terminalMarks).toHaveLength(0);
      const revert = prisma.campaignRecipient.updateMany.mock.calls.find(
        (c: any) => c[0]?.where?.id?.in && c[0]?.data?.status === 'PENDING',
      );
      expect(revert).toBeTruthy();
      expect(revert[0].where.id.in.sort()).toEqual(['r1', 'r2', 'r3']);
      expect(quota.refund).toHaveBeenCalledWith(WS, 'VOICE', 3);
      const statsUpdate = prisma.campaign.update.mock.calls.find((c: any) => c[0].data.stats?.iysUnavailable !== undefined);
      expect(statsUpdate[0].data.stats.iysUnavailable).toBe(true);
    });

    it('a missing brandCode aborts the WHOLE tick the same way, before any budget check or search call', async () => {
      registry.resolveConfig.mockReturnValue(resolvedConfig); // no brandCode

      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

      expect(budgeter.tryTake).not.toHaveBeenCalled();
      expect(iysClient.search).not.toHaveBeenCalled();
      expect(voicesmsSend.send).not.toHaveBeenCalled();
      const revert = prisma.campaignRecipient.updateMany.mock.calls.find(
        (c: any) => c[0]?.where?.id?.in && c[0]?.data?.status === 'PENDING',
      );
      expect(revert).toBeTruthy();
      expect(quota.refund).toHaveBeenCalledWith(WS, 'VOICE', 3);
      const statsUpdate = prisma.campaign.update.mock.calls.find((c: any) => c[0].data.stats?.iysUnavailable !== undefined);
      expect(statsUpdate[0].data.stats.iysUnavailable).toBe(true);
    });

    it('budget exhaustion is a SOFT per-recipient defer: ONAY-cleared recipients still get called this tick, the unchecked one just reverts to PENDING', async () => {
      budgeter.tryTake.mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(false);

      await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

      expect(iysClient.search).toHaveBeenCalledTimes(2);
      expect(voicesmsSend.send).toHaveBeenCalledTimes(2);
      const revert = prisma.campaignRecipient.updateMany.mock.calls.find(
        (c: any) => c[0]?.where?.id?.in && c[0]?.data?.status === 'PENDING',
      );
      expect(revert).toBeTruthy();
      expect(revert[0].where.id.in).toEqual(['r3']);
      const skipped = prisma.campaignRecipient.update.mock.calls.filter((c: any) => c[0].data.status === 'SKIPPED');
      expect(skipped).toHaveLength(0);
      expect(quota.refund).toHaveBeenCalledWith(WS, 'VOICE', 1);
    });
  });

  it('a BİLGİLENDİRME campaign skips the ARAMA preflight entirely — no budget check, no search calls, calls placed with iysfilter "0"', async () => {
    voicesmsSend.send.mockResolvedValue({ ok: true, code: '00', jobid: 'call-1', relationid: null, message: null, retriable: false, transport: false });

    await (svc as any).batch({ payload: { workspaceId: WS, campaignId: 'c1' } });

    expect(budgeter.tryTake).not.toHaveBeenCalled();
    expect(iysClient.search).not.toHaveBeenCalled();
    expect(voicesmsSend.send).toHaveBeenCalledTimes(3);
    expect(voicesmsSend.send.mock.calls[0][1].iysfilter).toBe('0');
  });
});

/**
 * `shared-tracking-domain`: every tenant's click, pixel and unsubscribe links
 * sit on the one app domain, so one tenant's listing takes the login and
 * invoice mail down with it. `LINK_BASE_URL` lets an operator point bulk links
 * at a separate host (one DNS record, no per-tenant provisioning).
 *
 * The three places share ONE base or the RFC 8058 header stops matching the
 * body link — the gateway then sees a footer it does not recognise and adds a
 * second one.
 */
describe('CampaignSenderService — the bulk link base', () => {
  const WS = 'ws-1';
  const make = (env: Record<string, string | undefined>) => {
    const config = { get: jest.fn((k: string) => env[k]) };
    const prisma = {
      campaign: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
      campaignRecipient: { findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn(), count: jest.fn(), groupBy: jest.fn() },
      campaignVariant: { findMany: jest.fn(), update: jest.fn() },
      workspace: { findUnique: jest.fn() },
      lead: { findFirst: jest.fn() },
      channel: { findFirst: jest.fn() },
    };
    const outboundMail = { send: jest.fn().mockResolvedValue(receipt()) };
    const quota = { reserve: jest.fn(), refund: jest.fn() };
    const svc = new CampaignSenderService(
      prisma as any, config as any, outboundMail as any,
      { schedule: jest.fn() } as any, { registerHandler: jest.fn() } as any,
      { get: jest.fn(), resolveConfig: jest.fn() } as any, quota as any,
      { send: jest.fn() } as any, { settleCampaignSms: jest.fn() } as any,
      { search: jest.fn() } as any, { tryTake: jest.fn() } as any, { send: jest.fn() } as any,
    );
    return { svc, outboundMail, quota };
  };
  const sendOne = async (svc: any) =>
    svc.sendEmail({
      workspaceId: WS, campaignId: 'c1', recipientId: 'r1', leadId: 'l1',
      to: 'a@b.com', subject: 'S', text: 'Hi', token: 'tok-1', ticari: false,
    });

  describe('when LINK_BASE_URL is set', () => {
    const env = { LINK_BASE_URL: 'https://links.test', PUBLIC_BASE_URL: 'https://app.test' };

    it('rewrites the body links onto it', () => {
      const { svc } = make(env);
      const out = (svc as any).render('EMAIL', 'Go to https://shop.test/x', 'tok-1', ['https://shop.test/x']);
      expect(out).toContain('https://links.test/api/public/t/c/tok-1?i=0');
      expect(out).toContain('https://links.test/api/public/u/tok-1');
      expect(out).not.toContain('https://app.test');
    });

    it('puts the open pixel and the HTML footer on it too', () => {
      const { svc } = make(env);
      const out = (svc as any).renderHtml('<html><body><a href="https://shop.test/x">Go</a></body></html>', 'tok-1', ['https://shop.test/x']);
      expect(out).toContain('src="https://links.test/api/public/t/o/tok-1"');
      expect(out).toContain('https://links.test/api/public/u/tok-1');
      expect(out).not.toContain('https://app.test');
    });

    it('sends the SAME base in the List-Unsubscribe URI the body carries', async () => {
      const { svc, outboundMail } = make(env);
      await sendOne(svc);
      expect(outboundMail.send).toHaveBeenCalledWith(
        expect.objectContaining({ unsubscribe: { token: 'tok-1', url: 'https://links.test/api/public/u/tok-1' } }),
      );
    });
  });

  describe('when it is not set', () => {
    const env = { PUBLIC_BASE_URL: 'https://app.test' };

    it('falls back to PUBLIC_BASE_URL byte-identically', async () => {
      const { svc, outboundMail } = make(env);
      expect((svc as any).render('EMAIL', 'Go to https://shop.test/x', 'tok-1', ['https://shop.test/x'])).toBe(
        'Go to https://app.test/api/public/t/c/tok-1?i=0\n\n—\nUnsubscribe: https://app.test/api/public/u/tok-1',
      );
      expect((svc as any).renderHtml('<html><body>Hi</body></html>', 'tok-1', [])).toContain(
        'src="https://app.test/api/public/t/o/tok-1"',
      );
      await sendOne(svc);
      expect(outboundMail.send).toHaveBeenCalledWith(
        expect.objectContaining({ unsubscribe: { token: 'tok-1', url: 'https://app.test/api/public/u/tok-1' } }),
      );
    });
  });

  it('still fails closed when NEITHER is configured (no opt-out link = non-compliant mail)', async () => {
    const { svc, outboundMail } = make({});
    await expect(sendOne(svc)).resolves.toEqual(
      expect.objectContaining({ disposition: 'RETRY', reason: 'MISSING_PUBLIC_BASE_URL', stopTick: true }),
    );
    expect(outboundMail.send).not.toHaveBeenCalled();
  });

  it('sends when only LINK_BASE_URL is configured — the guard checks the base actually used', async () => {
    const { svc, outboundMail } = make({ LINK_BASE_URL: 'https://links.test' });
    await sendOne(svc);
    expect(outboundMail.send).toHaveBeenCalled();
  });
});
