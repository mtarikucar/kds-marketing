import { NotFoundException } from '@nestjs/common';
import { ComplianceService } from './compliance.service';
import {
  mockPrismaClient,
  MockPrismaClient,
} from '../../../common/test/prisma-mock.service';

const WS = 'ws-1';

function makeSvc() {
  const prisma = mockPrismaClient();
  // emitSmsOptEvent wraps the flip + phone read + outbox append + İYS enqueue
  // in one $transaction; the mock just runs the callback against the same
  // mock client (tx === prisma), matching the established test idiom
  // elsewhere (e.g. review-sync.service.spec.ts).
  (prisma.$transaction as unknown as jest.Mock) = jest.fn((fn: any) => fn(prisma));
  const outbox = { append: jest.fn().mockResolvedValue('evt-1') };
  const iysSync = { enqueueConsent: jest.fn().mockResolvedValue(undefined), retryDlq: jest.fn() };
  return { prisma, outbox, iysSync, svc: new ComplianceService(prisma as any, outbox as any, iysSync as any) };
}

// requestExport now reads every personal-data category in parallel; default them
// all to [] so a happy-path export doesn't choke on an unmocked delegate.
function mockExportTablesEmpty(prisma: MockPrismaClient) {
  for (const t of [
    'consentRecord', 'conversation', 'booking', 'document', 'estimate', 'invoice',
    'review', 'voiceCall', 'salesCall', 'surveyResponse', 'opportunity', 'message',
    'contactIdentity', 'enrollment', 'certificate', 'communityMember', 'earnedBadge',
    'customerSubscription', 'customerWallet', 'pointsLedger', 'customObjectLink',
    'triggerLinkClick', 'couponRedemption',
    'campaignRecipient', 'leadTag', 'communityPost', 'communityComment', 'walletLedgerEntry',
  ] as const) {
    (prisma as any)[t].findMany.mockResolvedValue([]);
  }
}

describe('ComplianceService', () => {
  it('records a marketing consent and syncs the opt-out flag', async () => {
    const { prisma, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as any);
    (prisma.consentRecord.create as jest.Mock).mockResolvedValue({ id: 'cr1' });
    (prisma.lead.update as jest.Mock).mockResolvedValue({});

    await svc.recordConsent(WS, 'lead-1', 'MARKETING_EMAIL', false, { source: 'form' });

    expect(prisma.lead.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'lead-1' }, data: { emailOptOut: true } }),
    );
  });

  it('MARKETING_SMS opt-out enqueues marketing.sms.optout.v1 with the lead phone', async () => {
    const { prisma, outbox, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as any);
    (prisma.consentRecord.create as jest.Mock).mockResolvedValue({ id: 'cr-1' });
    (prisma.lead.update as jest.Mock).mockResolvedValue({});
    (prisma.lead.findUnique as jest.Mock).mockResolvedValue({ phone: '05551112233' });

    await svc.recordConsent(WS, 'lead-1', 'MARKETING_SMS', false, { source: 'form' });

    expect(prisma.lead.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'lead-1' }, data: { smsOptOut: true } }),
    );
    expect(outbox.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'marketing.sms.optout.v1',
        payload: { workspaceId: WS, leadId: 'lead-1', phone: '05551112233' },
        idempotencyKey: 'ws-1:lead-1:marketing.sms.optout.v1:consent:cr-1',
      }),
      prisma, // the tx client (mocked as the same prisma instance) the flip + append share
    );
  });

  it('MARKETING_SMS opt-in (granted=true) enqueues marketing.sms.optin.v1', async () => {
    const { prisma, outbox, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as any);
    (prisma.consentRecord.create as jest.Mock).mockResolvedValue({ id: 'cr-2' });
    (prisma.lead.update as jest.Mock).mockResolvedValue({});
    (prisma.lead.findUnique as jest.Mock).mockResolvedValue({ phone: '05551112233' });

    await svc.recordConsent(WS, 'lead-1', 'MARKETING_SMS', true);

    expect(outbox.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'marketing.sms.optin.v1' }),
      prisma,
    );
  });

  it('does NOT enqueue a blacklist-sync event when the lead has no phone', async () => {
    const { prisma, outbox, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as any);
    (prisma.consentRecord.create as jest.Mock).mockResolvedValue({ id: 'cr-3' });
    (prisma.lead.update as jest.Mock).mockResolvedValue({});
    (prisma.lead.findUnique as jest.Mock).mockResolvedValue({ phone: null });

    await svc.recordConsent(WS, 'lead-1', 'MARKETING_SMS', false);

    expect(outbox.append).not.toHaveBeenCalled();
  });

  it('does not fail the consent write when the outbox append throws', async () => {
    const { prisma, outbox, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as any);
    (prisma.consentRecord.create as jest.Mock).mockResolvedValue({ id: 'cr-4' });
    (prisma.lead.update as jest.Mock).mockResolvedValue({});
    (prisma.lead.findUnique as jest.Mock).mockResolvedValue({ phone: '05551112233' });
    outbox.append.mockRejectedValue(new Error('outbox down'));

    await expect(svc.recordConsent(WS, 'lead-1', 'MARKETING_SMS', false)).resolves.toMatchObject({ id: 'cr-4' });
  });

  it('does not fail the consent write when the phone lookup (findUnique) rejects', async () => {
    const { prisma, outbox, iysSync, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as any);
    (prisma.consentRecord.create as jest.Mock).mockResolvedValue({ id: 'cr-5' });
    (prisma.lead.update as jest.Mock).mockResolvedValue({});
    (prisma.lead.findUnique as jest.Mock).mockRejectedValue(new Error('db down'));

    await expect(svc.recordConsent(WS, 'lead-1', 'MARKETING_SMS', false)).resolves.toMatchObject({ id: 'cr-5' });
    expect(prisma.lead.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'lead-1' }, data: { smsOptOut: true } }),
    );
    expect(outbox.append).not.toHaveBeenCalled();
    expect(iysSync.enqueueConsent).not.toHaveBeenCalled();
  });

  // Phase 2 Task 3 — İYS auto-push: MARKETING_SMS consent enqueues an
  // IysSyncJob (ONAY on grant, RET on revoke) via IysSyncService, inside the
  // SAME transaction as the smsOptOut flip + blacklist-mirror outbox event —
  // its own independent savepoint (see emitSmsOptEvent's docstring).
  it('MARKETING_SMS revoke (granted=false) enqueues an İYS RET job', async () => {
    const { prisma, iysSync, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as any);
    (prisma.consentRecord.create as jest.Mock).mockResolvedValue({ id: 'cr-6' });
    (prisma.lead.update as jest.Mock).mockResolvedValue({});
    (prisma.lead.findUnique as jest.Mock).mockResolvedValue({ phone: '05551112233' });

    await svc.recordConsent(WS, 'lead-1', 'MARKETING_SMS', false, { source: 'form' });

    expect(iysSync.enqueueConsent).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        workspaceId: WS,
        leadId: 'lead-1',
        recipient: '05551112233',
        direction: 'RET',
        source: 'HS_WEB',
      }),
    );
  });

  it('MARKETING_SMS grant (granted=true) enqueues an İYS ONAY job', async () => {
    const { prisma, iysSync, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as any);
    (prisma.consentRecord.create as jest.Mock).mockResolvedValue({ id: 'cr-7' });
    (prisma.lead.update as jest.Mock).mockResolvedValue({});
    (prisma.lead.findUnique as jest.Mock).mockResolvedValue({ phone: '05551112233' });

    await svc.recordConsent(WS, 'lead-1', 'MARKETING_SMS', true);

    expect(iysSync.enqueueConsent).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ direction: 'ONAY', recipient: '05551112233' }),
    );
  });

  // Phase 2 Task 4 — anti-feedback-loop: an İYS-ORIGINATED consent apply
  // (IysWebhookConsumer) tags meta.source `IYS_<originalSource>`. That must
  // flow straight through to IysSyncService.enqueueConsent (which has its
  // own guard to skip enqueueing entirely for such a source) — every OTHER
  // caller's app-level source tag ('form', 'crm', …) must NOT be forwarded
  // as-is (it isn't a valid İYS source code), so it still collapses to the
  // fixed 'HS_WEB' default (asserted above).
  it('passes an IYS_-prefixed meta.source straight through to the İYS enqueue (so its anti-feedback-loop guard can see it)', async () => {
    const { prisma, iysSync, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as any);
    (prisma.consentRecord.create as jest.Mock).mockResolvedValue({ id: 'cr-6b' });
    (prisma.lead.update as jest.Mock).mockResolvedValue({});
    (prisma.lead.findUnique as jest.Mock).mockResolvedValue({ phone: '05551112233' });

    await svc.recordConsent(WS, 'lead-1', 'MARKETING_SMS', true, { source: 'IYS_HS_MESAJ' });

    expect(iysSync.enqueueConsent).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ source: 'IYS_HS_MESAJ' }),
    );
  });

  it('still asks IysSyncService to enqueue (with recipient undefined) when the lead has no phone — enqueueConsent itself is the no-op gate', async () => {
    const { prisma, iysSync, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as any);
    (prisma.consentRecord.create as jest.Mock).mockResolvedValue({ id: 'cr-8' });
    (prisma.lead.update as jest.Mock).mockResolvedValue({});
    (prisma.lead.findUnique as jest.Mock).mockResolvedValue({ phone: null });

    await svc.recordConsent(WS, 'lead-1', 'MARKETING_SMS', false);

    expect(iysSync.enqueueConsent).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ recipient: null }),
    );
  });

  it('does not fail the consent write when the İYS enqueue throws — ConsentRecord + flip still persist', async () => {
    const { prisma, iysSync, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as any);
    (prisma.consentRecord.create as jest.Mock).mockResolvedValue({ id: 'cr-9' });
    (prisma.lead.update as jest.Mock).mockResolvedValue({});
    (prisma.lead.findUnique as jest.Mock).mockResolvedValue({ phone: '05551112233' });
    iysSync.enqueueConsent.mockRejectedValue(new Error('iys down'));

    await expect(svc.recordConsent(WS, 'lead-1', 'MARKETING_SMS', false)).resolves.toMatchObject({ id: 'cr-9' });
    // the İYS enqueue is best-effort WITHIN the committed consent — its
    // failure must never roll back the record write or the flip.
    expect(prisma.consentRecord.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ workspaceId: WS, leadId: 'lead-1', type: 'MARKETING_SMS' }) }),
    );
    expect(prisma.lead.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'lead-1' }, data: { smsOptOut: true } }),
    );
  });

  // Finding: the ConsentRecord write must live INSIDE the same $transaction
  // as the smsOptOut flip (not a separate, earlier top-level create) so a
  // committed ConsentRecord always has its matching flag state.
  it('writes the ConsentRecord INSIDE the same $transaction as the smsOptOut flip, not before it', async () => {
    const { prisma, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as any);
    (prisma.lead.update as jest.Mock).mockResolvedValue({});
    (prisma.lead.findUnique as jest.Mock).mockResolvedValue({ phone: '05551112233' });
    // Simulate the transaction never even opening (e.g. a pool-exhaustion
    // failure) — if the create happened BEFORE $transaction was invoked (the
    // pre-fix structure), it would have already been called regardless.
    (prisma.$transaction as unknown as jest.Mock) = jest.fn().mockRejectedValue(new Error('tx open failed'));

    await expect(svc.recordConsent(WS, 'lead-1', 'MARKETING_SMS', false)).rejects.toThrow('tx open failed');

    expect(prisma.consentRecord.create).not.toHaveBeenCalled();
  });

  it('rolls back the ConsentRecord together with a failed smsOptOut flip — neither persists', async () => {
    const { prisma, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as any);
    (prisma.consentRecord.create as jest.Mock).mockResolvedValue({ id: 'cr-x' });
    (prisma.lead.update as jest.Mock).mockRejectedValue(new Error('flip failed'));

    // Both writes happen inside the SAME $transaction callback (mocked here
    // as a direct passthrough) — a real Postgres transaction rolls back
    // EVERYTHING in that callback, including the just-created ConsentRecord,
    // the instant lead.update throws. The rejection must propagate (not be
    // swallowed) so the caller knows nothing committed.
    await expect(svc.recordConsent(WS, 'lead-1', 'MARKETING_SMS', false)).rejects.toThrow('flip failed');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('does not fail the consent write, and still enqueues nothing, when the İYS enqueue phone lookup rejects', async () => {
    const { prisma, outbox, iysSync, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as any);
    (prisma.consentRecord.create as jest.Mock).mockResolvedValue({ id: 'cr-10' });
    (prisma.lead.update as jest.Mock).mockResolvedValue({});
    (prisma.lead.findUnique as jest.Mock).mockRejectedValue(new Error('db down'));

    await expect(svc.recordConsent(WS, 'lead-1', 'MARKETING_SMS', false)).resolves.toMatchObject({ id: 'cr-10' });
    expect(outbox.append).not.toHaveBeenCalled();
    expect(iysSync.enqueueConsent).not.toHaveBeenCalled();
  });

  it('does NOT enqueue an İYS job for MARKETING_EMAIL consent', async () => {
    const { prisma, iysSync, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as any);
    (prisma.consentRecord.create as jest.Mock).mockResolvedValue({ id: 'cr-11' });
    (prisma.lead.update as jest.Mock).mockResolvedValue({});

    await svc.recordConsent(WS, 'lead-1', 'MARKETING_EMAIL', false, { source: 'form' });

    expect(iysSync.enqueueConsent).not.toHaveBeenCalled();
  });

  it('manager retry delegates to IysSyncService.retryDlq for the workspace', async () => {
    const { iysSync, svc } = makeSvc();
    iysSync.retryDlq.mockResolvedValue({ count: 2 });
    await expect(svc.retryIys(WS)).resolves.toEqual({ count: 2 });
    expect(iysSync.retryDlq).toHaveBeenCalledWith(WS);
  });

  it('does not touch opt-out flags for DATA_PROCESSING consent', async () => {
    const { prisma, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as any);
    (prisma.consentRecord.create as jest.Mock).mockResolvedValue({ id: 'cr1' });
    await svc.recordConsent(WS, 'lead-1', 'DATA_PROCESSING', true);
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });

  it('returns the latest consent per type', async () => {
    const { prisma, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as any);
    prisma.consentRecord.findMany.mockResolvedValue([
      { type: 'MARKETING_EMAIL', granted: true, createdAt: new Date('2026-02-01') },
      { type: 'MARKETING_EMAIL', granted: false, createdAt: new Date('2026-01-01') },
    ] as any);
    const out = await svc.getConsents(WS, 'lead-1');
    expect(out).toEqual([{ type: 'MARKETING_EMAIL', granted: true, at: new Date('2026-02-01') }]);
  });

  it('exports a lead bundle and records a COMPLETED request', async () => {
    const { prisma, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1', activities: [], offers: [], tasks: [] } as any);
    mockExportTablesEmpty(prisma);
    (prisma.dataRequest.create as jest.Mock).mockResolvedValue({});
    const out: any = await svc.requestExport(WS, 'lead-1', 'u1');
    expect(out.lead.id).toBe('lead-1');
    expect((prisma.dataRequest.create as jest.Mock).mock.calls[0][0].data).toMatchObject({ kind: 'EXPORT', status: 'COMPLETED' });
  });

  it('exports ALL the lead’s personal data — communications, appointments, financials, calls', async () => {
    const { prisma, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1', activities: [], offers: [], tasks: [] } as any);
    mockExportTablesEmpty(prisma);
    prisma.conversation.findMany.mockResolvedValue([{ id: 'co-1' }] as any);
    prisma.message.findMany.mockResolvedValue([{ id: 'm-1', conversationId: 'co-1' }] as any);
    prisma.booking.findMany.mockResolvedValue([{ id: 'bk-1' }] as any);
    prisma.document.findMany.mockResolvedValue([{ id: 'doc-1' }] as any);
    prisma.invoice.findMany.mockResolvedValue([{ id: 'inv-1' }] as any);
    (prisma.dataRequest.create as jest.Mock).mockResolvedValue({});

    const out: any = await svc.requestExport(WS, 'lead-1', 'u1');

    // previously-omitted categories are now in the DSAR bundle
    expect(out.conversations).toEqual([{ id: 'co-1' }]);
    expect(out.messages).toEqual([{ id: 'm-1', conversationId: 'co-1' }]);
    expect(out.bookings).toEqual([{ id: 'bk-1' }]);
    expect(out.documents).toEqual([{ id: 'doc-1' }]);
    expect(out.invoices).toEqual([{ id: 'inv-1' }]);
    // each personal-data read is scoped to BOTH the workspace and the subject
    expect(prisma.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: WS, leadId: 'lead-1' } }),
    );
    // messages have no leadId — scoped via the subject's conversation ids
    expect(prisma.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ workspaceId: WS, conversationId: { in: ['co-1'] } }) }),
    );
  });

  it('exports the identity / membership / billing / behavioural categories too', async () => {
    const { prisma, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1', activities: [], offers: [], tasks: [] } as any);
    mockExportTablesEmpty(prisma);
    prisma.contactIdentity.findMany.mockResolvedValue([{ id: 'ci-1', value: '+90555' }] as any);
    prisma.enrollment.findMany.mockResolvedValue([{ id: 'en-1' }] as any);
    prisma.customerWallet.findMany.mockResolvedValue([{ id: 'w-1', balance: 500 }] as any);
    (prisma.dataRequest.create as jest.Mock).mockResolvedValue({});

    const out: any = await svc.requestExport(WS, 'lead-1', 'u1');

    expect(out.contactIdentities).toEqual([{ id: 'ci-1', value: '+90555' }]);
    expect(out.enrollments).toEqual([{ id: 'en-1' }]);
    expect(out.wallets).toEqual([{ id: 'w-1', balance: 500 }]);
    expect(prisma.contactIdentity.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: WS, leadId: 'lead-1' } }),
    );
    // CommunityMember has no workspaceId column — it is scoped through its community.
    expect(prisma.communityMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { leadId: 'lead-1', community: { workspaceId: WS } } }),
    );
  });

  it('exports marketing-send history, tags, community content and the wallet ledger', async () => {
    const { prisma, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1', activities: [], offers: [], tasks: [] } as any);
    mockExportTablesEmpty(prisma);
    prisma.customerWallet.findMany.mockResolvedValue([{ id: 'w-1' }] as any);
    prisma.campaignRecipient.findMany.mockResolvedValue([{ id: 'cr-1' }] as any);
    prisma.leadTag.findMany.mockResolvedValue([{ leadId: 'lead-1', tagId: 't-1' }] as any);
    prisma.communityPost.findMany.mockResolvedValue([{ id: 'cp-1' }] as any);
    prisma.communityComment.findMany.mockResolvedValue([{ id: 'cc-1' }] as any);
    prisma.walletLedgerEntry.findMany.mockResolvedValue([{ id: 'wl-1' }] as any);
    (prisma.dataRequest.create as jest.Mock).mockResolvedValue({});

    const out: any = await svc.requestExport(WS, 'lead-1', 'u1');

    expect(out.campaignRecipients).toEqual([{ id: 'cr-1' }]);
    expect(out.tags).toEqual([{ leadId: 'lead-1', tagId: 't-1' }]);
    expect(out.communityPosts).toEqual([{ id: 'cp-1' }]);
    expect(out.communityComments).toEqual([{ id: 'cc-1' }]);
    expect(out.walletLedgerEntries).toEqual([{ id: 'wl-1' }]);
    // marketing/community reads scope to BOTH the workspace and the subject
    expect(prisma.campaignRecipient.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: WS, leadId: 'lead-1' } }),
    );
    expect(prisma.communityPost.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: WS, authorLeadId: 'lead-1' } }),
    );
    // the wallet ledger has no leadId — scoped via the subject's wallet ids
    expect(prisma.walletLedgerEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ workspaceId: WS, walletId: { in: ['w-1'] } }) }),
    );
  });

  it('records an erasure request as PENDING (no deletion)', async () => {
    const { prisma, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as any);
    (prisma.dataRequest.create as jest.Mock).mockResolvedValue({ id: 'dr1', status: 'PENDING' });
    const out: any = await svc.requestErasure(WS, 'lead-1');
    expect(out.status).toBe('PENDING');
    expect(prisma.lead.delete).not.toHaveBeenCalled();
  });

  it('404s for a lead outside the workspace', async () => {
    const { prisma, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue(null as any);
    await expect(svc.recordConsent(WS, 'ghost', 'MARKETING_EMAIL', true)).rejects.toBeInstanceOf(NotFoundException);
  });
});
