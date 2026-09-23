import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
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
  const iysSync = {
    enqueueConsent: jest.fn().mockResolvedValue(undefined),
    enqueueEmailWithdrawal: jest.fn().mockResolvedValue('not-ready'),
    retryDlq: jest.fn(),
  };
  const suppression = {
    suppress: jest.fn().mockResolvedValue(undefined),
    lift: jest.fn().mockResolvedValue(undefined),
  };
  return {
    prisma,
    outbox,
    iysSync,
    suppression,
    svc: new ComplianceService(prisma as any, outbox as any, iysSync as any, suppression as any),
  };
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
    // The categories the DSAR used to omit (dsar-export-incomplete).
    'workflowRun', 'workflowStepRun', 'distributionDraft', 'importJobRow', 'researchCandidate',
    'campaign', 'lead',
  ] as const) {
    (prisma as any)[t].findMany.mockResolvedValue([]);
  }
  (prisma.leadAttribution.findUnique as jest.Mock).mockResolvedValue(null);
  (prisma.dataRequest.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
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

  it('writes the EMAIL ConsentRecord and flips the flag INSIDE one $transaction (atomic, like SMS)', async () => {
    const { prisma, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as any);
    (prisma.consentRecord.create as jest.Mock).mockResolvedValue({ id: 'cr-e' });
    (prisma.lead.update as jest.Mock).mockResolvedValue({});
    await svc.recordConsent(WS, 'lead-1', 'MARKETING_EMAIL', false, { source: 'form' });
    // The record + flag flip must commit together — a lost flip would leave an
    // on-record opt-out the send path (flag-only) ignores.
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(prisma.consentRecord.create).toHaveBeenCalled();
    expect(prisma.lead.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'lead-1' }, data: { emailOptOut: true } }),
    );
  });

  // R3 — the drift the verifier predicted by name: `recordConsent(granted:true)`
  // clears `emailOptOut`, so a ContactSuppression OPT_OUT row left standing would
  // make a re-consented lead permanently unmailable (SuppressionService.check
  // reads the union of the row AND the flag).
  describe('R3 — re-consent lifts the address suppression', () => {
    it('lifts the EMAIL OPT_OUT suppression for the lead’s address, inside the same transaction', async () => {
      const { prisma, suppression, svc } = makeSvc();
      prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as any);
      (prisma.consentRecord.create as jest.Mock).mockResolvedValue({ id: 'cr-r3' });
      (prisma.lead.update as jest.Mock).mockResolvedValue({});
      (prisma.lead.findUnique as jest.Mock).mockResolvedValue({ emailNormalized: 'ali@acme.com' });

      await svc.recordConsent(WS, 'lead-1', 'MARKETING_EMAIL', true, { source: 'form' });

      expect(suppression.lift).toHaveBeenCalledWith(
        WS,
        'ali@acme.com',
        'EMAIL',
        'OPT_OUT',
        expect.stringContaining('consent'),
        prisma, // the tx client the record + flip + lift all share
      );
    });

    it('flips the lead BEFORE lifting, so the re-consented lead gets one ConsentRecord, not two', async () => {
      const { prisma, suppression, svc } = makeSvc();
      prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as any);
      (prisma.consentRecord.create as jest.Mock).mockResolvedValue({ id: 'cr-r3b' });
      const order: string[] = [];
      (prisma.lead.update as jest.Mock).mockImplementation(async () => {
        order.push('flip');
        return {};
      });
      suppression.lift.mockImplementation(async () => {
        order.push('lift');
      });
      (prisma.lead.findUnique as jest.Mock).mockResolvedValue({ emailNormalized: 'ali@acme.com' });

      await svc.recordConsent(WS, 'lead-1', 'MARKETING_EMAIL', true);

      // SuppressionService.lift writes a granted:true ledger row for every lead
      // that still CARRIES the flag. Clearing this lead first keeps it out of
      // that sweep — its own ConsentRecord was written one line earlier.
      expect(order).toEqual(['flip', 'lift']);
    });

    it('does NOT lift on an opt-OUT (granted:false) — that direction suppresses, it does not restore', async () => {
      const { prisma, suppression, svc } = makeSvc();
      prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as any);
      (prisma.consentRecord.create as jest.Mock).mockResolvedValue({ id: 'cr-r3c' });
      (prisma.lead.update as jest.Mock).mockResolvedValue({});

      await svc.recordConsent(WS, 'lead-1', 'MARKETING_EMAIL', false);

      expect(suppression.lift).not.toHaveBeenCalled();
    });

    it('does not lift when the lead has no address to lift', async () => {
      const { prisma, suppression, svc } = makeSvc();
      prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as any);
      (prisma.consentRecord.create as jest.Mock).mockResolvedValue({ id: 'cr-r3d' });
      (prisma.lead.update as jest.Mock).mockResolvedValue({});
      (prisma.lead.findUnique as jest.Mock).mockResolvedValue({ emailNormalized: null });

      await svc.recordConsent(WS, 'lead-1', 'MARKETING_EMAIL', true);

      expect(suppression.lift).not.toHaveBeenCalled();
    });

    it('leaves the SMS branch alone — an İYS/NetGSM withdrawal owns its own eventing', async () => {
      const { prisma, suppression, svc } = makeSvc();
      prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as any);
      (prisma.consentRecord.create as jest.Mock).mockResolvedValue({ id: 'cr-r3e' });
      (prisma.lead.update as jest.Mock).mockResolvedValue({});
      (prisma.lead.findUnique as jest.Mock).mockResolvedValue({ phone: '05551112233' });

      await svc.recordConsent(WS, 'lead-1', 'MARKETING_SMS', true);

      expect(suppression.lift).not.toHaveBeenCalled();
    });
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

  it('does NOT enqueue an İYS MESAJ job for MARKETING_EMAIL consent', async () => {
    const { prisma, iysSync, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as any);
    (prisma.consentRecord.create as jest.Mock).mockResolvedValue({ id: 'cr-11' });
    (prisma.lead.update as jest.Mock).mockResolvedValue({});

    await svc.recordConsent(WS, 'lead-1', 'MARKETING_EMAIL', false, { source: 'form' });

    expect(iysSync.enqueueConsent).not.toHaveBeenCalled();
  });

  /**
   * The email lane's İYS duty, and the line drawn across it.
   *
   * A withdrawal is a fact about what the recipient asked for, and 6563 says
   * report it. A GRANT recorded here is a staff member ticking a box — nothing
   * on this path can tell that from the recipient's own evidenced act — and
   * pushing it as an İYS `ONAY` would assert a consent the tenant cannot
   * evidence if asked. So: RET goes, ONAY never does.
   */
  it('reports a recorded email withdrawal to İYS, keyed on the address', async () => {
    const { prisma, iysSync, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as any);
    (prisma.consentRecord.create as jest.Mock).mockResolvedValue({ id: 'cr-12' });
    (prisma.lead.update as jest.Mock).mockResolvedValue({});
    (prisma.lead.findUnique as jest.Mock).mockResolvedValue({ email: 'Ali@Acme.test', emailNormalized: 'ali@acme.test' });

    await svc.recordConsent(WS, 'lead-1', 'MARKETING_EMAIL', false, { source: 'crm' });

    expect(iysSync.enqueueEmailWithdrawal).toHaveBeenCalledWith({
      workspaceId: WS,
      leadId: 'lead-1',
      address: 'ali@acme.test',
      source: 'HS_WEB',
    });
  });

  it('never pushes an email ONAY to İYS', async () => {
    const { prisma, iysSync, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as any);
    (prisma.consentRecord.create as jest.Mock).mockResolvedValue({ id: 'cr-13' });
    (prisma.lead.update as jest.Mock).mockResolvedValue({});
    (prisma.lead.findUnique as jest.Mock).mockResolvedValue({ email: 'ali@acme.test', emailNormalized: 'ali@acme.test' });

    await svc.recordConsent(WS, 'lead-1', 'MARKETING_EMAIL', true, { source: 'crm' });

    expect(iysSync.enqueueEmailWithdrawal).not.toHaveBeenCalled();
  });

  it('keeps the consent record when the İYS push cannot be queued', async () => {
    const { prisma, iysSync, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as any);
    (prisma.consentRecord.create as jest.Mock).mockResolvedValue({ id: 'cr-14' });
    (prisma.lead.update as jest.Mock).mockResolvedValue({});
    (prisma.lead.findUnique as jest.Mock).mockResolvedValue({ email: 'ali@acme.test', emailNormalized: 'ali@acme.test' });
    iysSync.enqueueEmailWithdrawal.mockRejectedValue(new Error('iys down'));

    await expect(svc.recordConsent(WS, 'lead-1', 'MARKETING_EMAIL', false)).resolves.toMatchObject({ id: 'cr-14' });
  });

  it('manager retry delegates to IysSyncService.retryDlq for the workspace', async () => {
    const { iysSync, svc } = makeSvc();
    iysSync.retryDlq.mockResolvedValue({ count: 2 });
    await expect(svc.retryIys(WS)).resolves.toEqual({ count: 2 });
    expect(iysSync.retryDlq).toHaveBeenCalledWith(WS);
  });

  it('iysDlqCount delegates to IysSyncService.dlqCount for the workspace', async () => {
    const { iysSync, svc } = makeSvc();
    iysSync.dlqCount = jest.fn().mockResolvedValue({ count: 5 });
    await expect(svc.iysDlqCount(WS)).resolves.toEqual({ count: 5 });
    expect(iysSync.dlqCount).toHaveBeenCalledWith(WS);
  });

  it('does not touch opt-out flags for DATA_PROCESSING consent', async () => {
    const { prisma, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as any);
    (prisma.consentRecord.create as jest.Mock).mockResolvedValue({ id: 'cr1' });
    await svc.recordConsent(WS, 'lead-1', 'DATA_PROCESSING', true);
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });

  it('returns the latest consent per type, and says where it came from', async () => {
    // WHERE matters as much as WHEN. "Withdrawn on 12 March" answers half the
    // question a compliance officer is actually asked; the other half is
    // whether the person unticked a form, replied STOP, or a rep did it for
    // them. `source` is the only column that carries it, and the panel had a
    // key for it with nothing to render.
    const { prisma, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as any);
    prisma.consentRecord.findMany.mockResolvedValue([
      { type: 'MARKETING_EMAIL', granted: true, createdAt: new Date('2026-02-01'), source: 'form:f1 :: Kampanyalardan haberdar olmak istiyorum' },
      { type: 'MARKETING_EMAIL', granted: false, createdAt: new Date('2026-01-01'), source: 'unsubscribe' },
    ] as any);
    const out = await svc.getConsents(WS, 'lead-1');
    expect(out).toEqual([
      {
        type: 'MARKETING_EMAIL',
        granted: true,
        at: new Date('2026-02-01'),
        source: 'form:f1 :: Kampanyalardan haberdar olmak istiyorum',
      },
    ]);
  });

  it('carries an explicit null source rather than dropping the key', async () => {
    // A record written before sources were captured has none. `undefined` would
    // be serialised away, which a reader cannot tell from "not shipped yet".
    const { prisma, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as any);
    prisma.consentRecord.findMany.mockResolvedValue([
      { type: 'MARKETING_SMS', granted: false, createdAt: new Date('2026-02-01'), source: null },
    ] as any);
    expect(await svc.getConsents(WS, 'lead-1')).toEqual([
      { type: 'MARKETING_SMS', granted: false, at: new Date('2026-02-01'), source: null },
    ]);
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

  // dsar-export-incomplete — an Art. 15 / KVKK access request was answered
  // without the automation trail, the drafts written about the subject, the
  // duplicates merged into them, where their data came from, or which campaign
  // mail actually reached them.
  it('exports the automation trail, drafts, data sources and attribution', async () => {
    const { prisma, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1', activities: [], offers: [], tasks: [] } as any);
    mockExportTablesEmpty(prisma);
    prisma.workflowRun.findMany.mockResolvedValue([{ id: 'wr-1' }] as any);
    prisma.workflowStepRun.findMany.mockResolvedValue([{ id: 'ws-1', runId: 'wr-1' }] as any);
    prisma.distributionDraft.findMany.mockResolvedValue([{ id: 'dd-1' }] as any);
    prisma.importJobRow.findMany.mockResolvedValue([{ id: 'ir-1' }] as any);
    prisma.researchCandidate.findMany.mockResolvedValue([{ id: 'rc-1' }] as any);
    (prisma.leadAttribution.findUnique as jest.Mock).mockResolvedValue({ leadId: 'lead-1', utmSource: 'ads' });
    (prisma.dataRequest.create as jest.Mock).mockResolvedValue({});

    const out: any = await svc.requestExport(WS, 'lead-1', 'u1');

    expect(out.workflowRuns).toEqual([{ id: 'wr-1' }]);
    expect(out.workflowStepRuns).toEqual([{ id: 'ws-1', runId: 'wr-1' }]);
    expect(out.distributionDrafts).toEqual([{ id: 'dd-1' }]);
    expect(out.importJobRows).toEqual([{ id: 'ir-1' }]);
    expect(out.researchCandidates).toEqual([{ id: 'rc-1' }]);
    expect(out.attribution).toEqual({ leadId: 'lead-1', utmSource: 'ads' });
    // step runs are id-scoped off the subject's own runs, like messages off
    // conversations
    expect(prisma.workflowStepRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: WS, runId: { in: ['wr-1'] } } }),
    );
    // ImportJobRow has NO workspaceId column — scoped through its job, exactly
    // as CommunityMember is scoped through its community.
    expect(prisma.importJobRow.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { leadId: 'lead-1', job: { workspaceId: WS } } }),
    );
    // LeadAttribution is @unique on leadId — a 1:1 read, not a list.
    expect(prisma.leadAttribution.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { leadId: 'lead-1' } }),
    );
  });

  it('exports the duplicates merged into the subject, following the chain past one level', async () => {
    const { prisma, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1', activities: [], offers: [], tasks: [] } as any);
    mockExportTablesEmpty(prisma);
    // A→B then B→C leaves a depth-2 chain: lead-1 ← dup-1 ← dup-2.
    prisma.lead.findMany.mockImplementation((async (args: any) => {
      const frontier = args?.where?.mergedIntoId?.in ?? [];
      if (frontier.includes('lead-1')) return [{ id: 'dup-1', email: 'dup@acme.com' }];
      if (frontier.includes('dup-1')) return [{ id: 'dup-2', email: 'dup2@acme.com' }];
      return [];
    }) as any);
    (prisma.dataRequest.create as jest.Mock).mockResolvedValue({});

    const out: any = await svc.requestExport(WS, 'lead-1', 'u1');

    expect(out.mergedDuplicates.map((l: any) => l.id)).toEqual(['dup-1', 'dup-2']);
  });

  it('exports the subject line of the campaign mail that reached them', async () => {
    const { prisma, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1', activities: [], offers: [], tasks: [] } as any);
    mockExportTablesEmpty(prisma);
    prisma.campaignRecipient.findMany.mockResolvedValue([{ id: 'cr-1', campaignId: 'cmp-1' }] as any);
    prisma.campaign.findMany.mockResolvedValue([{ id: 'cmp-1', subject: 'Bahar kampanyası' }] as any);
    (prisma.dataRequest.create as jest.Mock).mockResolvedValue({});

    const out: any = await svc.requestExport(WS, 'lead-1', 'u1');

    expect(out.campaigns).toEqual([{ id: 'cmp-1', subject: 'Bahar kampanyası' }]);
    expect(prisma.campaign.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: WS, id: { in: ['cmp-1'] } } }),
    );
  });

  // export-stored-forever — the payload is the Art.15 disclosure record, so it
  // is still persisted; it just stops being kept forever.
  it('retires export payloads older than the TTL when a new export is taken', async () => {
    const { prisma, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1', activities: [], offers: [], tasks: [] } as any);
    mockExportTablesEmpty(prisma);
    (prisma.dataRequest.create as jest.Mock).mockResolvedValue({});

    await svc.requestExport(WS, 'lead-1', 'u1');

    const call = (prisma.dataRequest.updateMany as jest.Mock).mock.calls.find(
      (c) => c[0]?.data?.payload === Prisma.JsonNull,
    );
    expect(call).toBeDefined();
    expect(call[0].where).toMatchObject({ workspaceId: WS, kind: 'EXPORT' });
    expect(call[0].where.requestedAt.lt).toBeInstanceOf(Date);
  });

  it('never fails an export because the TTL sweep did', async () => {
    const { prisma, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1', activities: [], offers: [], tasks: [] } as any);
    mockExportTablesEmpty(prisma);
    (prisma.dataRequest.updateMany as jest.Mock).mockRejectedValue(new Error('db down'));
    (prisma.dataRequest.create as jest.Mock).mockResolvedValue({});

    await expect(svc.requestExport(WS, 'lead-1', 'u1')).resolves.toMatchObject({ lead: { id: 'lead-1' } });
  });

  it('lists data requests WITHOUT their PII payload', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.dataRequest.findMany as jest.Mock).mockResolvedValue([]);
    await svc.listRequests(WS);
    const args = (prisma.dataRequest.findMany as jest.Mock).mock.calls[0][0];
    // An explicit select is the whole fix: the history tab mirrors this shape
    // (frontend .../compliance/types.ts) and never needed the bodies.
    expect(args.select).toBeDefined();
    expect(args.select.payload).toBeUndefined();
    expect(args.select).toMatchObject({ id: true, leadId: true, kind: true, status: true });
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

  describe('fulfillErasure', () => {
    /**
     * @param chain  mergedIntoId edges, parent → children, so a test can build
     *               the A→B→C tombstone chain the erasure has to follow.
     * @param subjects what the pre-scrub address read returns.
     */
    const armPendingErasure = (
      prisma: MockPrismaClient,
      over: any = {},
      chain: Record<string, string[]> = {},
      subjects: any[] = [{ emailNormalized: 'ali@acme.com', phoneNormalized: '05551112233' }],
    ) => {
      (prisma.dataRequest.findFirst as jest.Mock).mockResolvedValue({
        id: 'dr1', workspaceId: WS, leadId: 'lead-1', kind: 'ERASURE', status: 'PENDING', ...over,
      });
      (prisma.conversation.findMany as jest.Mock).mockResolvedValue([{ id: 'c1' }, { id: 'c2' }]);
      (prisma.dataRequest.updateMany as jest.Mock).mockResolvedValue({ count: 1 }); // wins the atomic claim
      (prisma.lead.findMany as jest.Mock).mockImplementation(async (args: any) => {
        const frontier: string[] = args?.where?.mergedIntoId?.in ?? [];
        if (frontier.length) return frontier.flatMap((id) => (chain[id] ?? []).map((c) => ({ id: c })));
        return subjects;
      });
      (prisma.workflowRun.findMany as jest.Mock).mockResolvedValue([{ id: 'wr-1' }]);
    };

    /** Every id the erasure must treat as the same person. */
    const ONE = { in: ['lead-1'] };

    it('anonymises the lead, deletes communication PII, keeps financial rows, and completes the request', async () => {
      const { prisma, svc } = makeSvc();
      armPendingErasure(prisma);

      const out: any = await svc.fulfillErasure(WS, 'dr1', 'mgr-1');
      expect(out).toMatchObject({ id: 'dr1', status: 'COMPLETED', leadId: 'lead-1' });

      // Messages deleted by the lead's conversation ids, then the conversations.
      expect(prisma.message.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { workspaceId: WS, conversationId: { in: ['c1', 'c2'] } } }),
      );
      expect(prisma.conversation.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { workspaceId: WS, leadId: ONE } }),
      );
      // Communication / behavioural / identity PII deleted.
      for (const t of ['voiceCall', 'salesCall', 'contactIdentity', 'leadAttribution', 'triggerLinkClick', 'surveyResponse']) {
        expect((prisma as any)[t].deleteMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: { workspaceId: WS, leadId: ONE } }),
        );
      }
      // LeadActivity has no workspaceId column — scoped by the (workspace-bound) leadId.
      expect(prisma.leadActivity.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { leadId: ONE } }),
      );
      // Booking PII scrubbed (row retained).
      expect(prisma.booking.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { workspaceId: WS, leadId: ONE },
          data: expect.objectContaining({ email: null, phone: null, notes: null }),
        }),
      );
      // Lead anonymised: PII scrubbed, contact suppressed, hidden.
      const leadUpd = (prisma.lead.updateMany as jest.Mock).mock.calls[0][0].data;
      expect(leadUpd).toMatchObject({
        contactPerson: '[Silinmiş]', email: null, phone: null, whatsapp: null,
        emailNormalized: null, phoneNormalized: null,
        emailOptOut: true, smsOptOut: true, waOptOut: true,
      });
      expect(leadUpd.deletedAt).toBeInstanceOf(Date);
      // Financial / membership rows are NEVER deleted (legal retention).
      expect(prisma.invoice.deleteMany).not.toHaveBeenCalled();
      expect(prisma.commission.deleteMany).not.toHaveBeenCalled();
      expect(prisma.customerWallet.deleteMany).not.toHaveBeenCalled();
      expect(prisma.lead.delete).not.toHaveBeenCalled();
      // Request closed via the atomic PENDING→COMPLETED claim (the audit trail).
      expect(prisma.dataRequest.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'dr1', workspaceId: WS, status: 'PENDING' },
          data: expect.objectContaining({ status: 'COMPLETED' }),
        }),
      );
    });

    it('scrubs the PII body of prior EXPORT DataRequests so no plaintext copy survives', async () => {
      const { prisma, svc } = makeSvc();
      armPendingErasure(prisma);
      await svc.fulfillErasure(WS, 'dr1', 'mgr-1');
      // A prior access-export snapshotted the full PII into DataRequest.payload;
      // erasure must null those bodies (keep the audit rows) or a plaintext copy of
      // the "erased" subject survives — and listRequests would re-serve it.
      expect(prisma.dataRequest.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { workspaceId: WS, leadId: ONE, kind: 'EXPORT' },
          data: expect.objectContaining({ payload: Prisma.JsonNull }),
        }),
      );
    });

    // erasure-no-suppression — the lead row is the only place the address was
    // written down, and erasure nulls it. Without a tombstone the same person
    // re-enters through an import, a form or their next inbound mail as a
    // brand-new, mailable lead.
    describe('the tombstone (erasure-no-suppression, R4)', () => {
      it('writes an EMAIL and a PHONE ERASURE tombstone from the values read BEFORE the scrub', async () => {
        const { prisma, suppression, svc } = makeSvc();
        armPendingErasure(prisma);

        await svc.fulfillErasure(WS, 'dr1', 'mgr-1');

        expect(suppression.suppress).toHaveBeenCalledWith(
          WS, 'ali@acme.com', 'EMAIL', 'ERASURE',
          expect.objectContaining({ tx: prisma, source: 'erasure:dr1' }),
        );
        expect(suppression.suppress).toHaveBeenCalledWith(
          WS, '05551112233', 'PHONE', 'ERASURE',
          expect.objectContaining({ tx: prisma, source: 'erasure:dr1' }),
        );
        // The address read has to happen while the values still exist.
        const readAt = (prisma.lead.findMany as jest.Mock).mock.invocationCallOrder.at(-1)!;
        const scrubAt = (prisma.lead.updateMany as jest.Mock).mock.invocationCallOrder[0];
        expect(readAt).toBeLessThan(scrubAt);
      });

      it('tombstones every address in the merge chain, once each', async () => {
        const { prisma, suppression, svc } = makeSvc();
        armPendingErasure(prisma, {}, { 'lead-1': ['dup-1'] }, [
          { emailNormalized: 'ali@acme.com', phoneNormalized: '05551112233' },
          { emailNormalized: 'ali@acme.com', phoneNormalized: null },
          { emailNormalized: 'ali.veli@acme.com', phoneNormalized: null },
        ]);

        await svc.fulfillErasure(WS, 'dr1', 'mgr-1');

        const emails = suppression.suppress.mock.calls.filter((c) => c[2] === 'EMAIL').map((c) => c[1]);
        expect(emails.sort()).toEqual(['ali.veli@acme.com', 'ali@acme.com']);
      });

      it('writes no tombstone for a subject with nothing left to tombstone', async () => {
        const { prisma, suppression, svc } = makeSvc();
        armPendingErasure(prisma, {}, {}, [{ emailNormalized: null, phoneNormalized: null }]);
        await svc.fulfillErasure(WS, 'dr1', 'mgr-1');
        expect(suppression.suppress).not.toHaveBeenCalled();
      });
    });

    // erasure-one-row — `lead-dedupe.service.ts` only refuses a canonical that
    // is CURRENTLY merged, so A→B and later B→C leaves a depth-2 chain whose
    // grandchild kept full PII and stayed mailable.
    it('scrubs a two-level merge chain, not just the row the request names', async () => {
      const { prisma, svc } = makeSvc();
      armPendingErasure(prisma, {}, { 'lead-1': ['dup-1'], 'dup-1': ['dup-2'] });

      await svc.fulfillErasure(WS, 'dr1', 'mgr-1');

      const SUBJECTS = { in: ['lead-1', 'dup-1', 'dup-2'] };
      expect(prisma.lead.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: SUBJECTS, workspaceId: WS } }),
      );
      expect(prisma.conversation.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { workspaceId: WS, leadId: SUBJECTS } }),
      );
      expect(prisma.leadActivity.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { leadId: SUBJECTS } }),
      );
      expect(prisma.booking.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { workspaceId: WS, leadId: SUBJECTS } }),
      );
      expect(prisma.dataRequest.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { workspaceId: WS, leadId: SUBJECTS, kind: 'EXPORT' } }),
      );
    });

    it('stops following the chain at a cycle instead of looping', async () => {
      const { prisma, svc } = makeSvc();
      armPendingErasure(prisma, {}, { 'lead-1': ['dup-1'], 'dup-1': ['lead-1', 'dup-1'] });
      await svc.fulfillErasure(WS, 'dr1', 'mgr-1');
      expect((prisma.lead.updateMany as jest.Mock).mock.calls[0][0].where.id).toEqual({
        in: ['lead-1', 'dup-1'],
      });
    });

    // erasure-residual-pii — every one of these is SCRUBBED, never deleted:
    // each row is load-bearing for a sibling guarantee (a unique key that stops
    // a re-ingest, a progress counter, a CHECK constraint, a campaign report).
    describe('residual PII (erasure-residual-pii)', () => {
      it('scrubs the research candidate that produced the lead without deleting its dedupe key', async () => {
        const { prisma, svc } = makeSvc();
        armPendingErasure(prisma);
        await svc.fulfillErasure(WS, 'dr1', 'mgr-1');
        expect(prisma.researchCandidate.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { workspaceId: WS, leadId: ONE },
            data: expect.objectContaining({ businessName: '[Silinmiş]', email: null, phone: null }),
          }),
        );
        expect(prisma.researchCandidate.deleteMany).not.toHaveBeenCalled();
      });

      it('scrubs the import row that created the lead, scoped through its job', async () => {
        const { prisma, svc } = makeSvc();
        armPendingErasure(prisma);
        await svc.fulfillErasure(WS, 'dr1', 'mgr-1');
        expect(prisma.importJobRow.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { leadId: ONE, job: { workspaceId: WS } },
            data: expect.objectContaining({ error: null }),
          }),
        );
        expect(prisma.importJobRow.deleteMany).not.toHaveBeenCalled();
      });

      it('scrubs distribution drafts and dismisses the ones still inviting a send', async () => {
        const { prisma, svc } = makeSvc();
        armPendingErasure(prisma);
        await svc.fulfillErasure(WS, 'dr1', 'mgr-1');
        expect(prisma.distributionDraft.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { workspaceId: WS, leadId: ONE },
            data: expect.objectContaining({ toAddress: '[Silinmiş]', body: '', error: null }),
          }),
        );
        expect(prisma.distributionDraft.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { workspaceId: WS, leadId: ONE, status: 'DRAFT' },
            data: { status: 'DISMISSED' },
          }),
        );
      });

      it('nulls the provider error line on retained campaign recipients, keeping the stats row', async () => {
        const { prisma, svc } = makeSvc();
        armPendingErasure(prisma);
        await svc.fulfillErasure(WS, 'dr1', 'mgr-1');
        expect(prisma.campaignRecipient.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: { workspaceId: WS, leadId: ONE }, data: { error: null } }),
        );
        expect(prisma.campaignRecipient.deleteMany).not.toHaveBeenCalled();
      });

      it('empties the workflow run context and deletes the step trail, keeping the run row', async () => {
        const { prisma, svc } = makeSvc();
        armPendingErasure(prisma);
        await svc.fulfillErasure(WS, 'dr1', 'mgr-1');
        expect(prisma.workflowRun.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { workspaceId: WS, leadId: ONE },
            data: expect.objectContaining({ lastError: null }),
          }),
        );
        expect(prisma.workflowStepRun.deleteMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: { workspaceId: WS, runId: { in: ['wr-1'] } } }),
        );
        // The run row itself stays: workflow-executor stops a WAITING run of a
        // deleted lead on resume, and it needs the row to do that.
        expect(prisma.workflowRun.deleteMany).not.toHaveBeenCalled();
      });

      it('skips the step-trail delete when the subject has no runs', async () => {
        const { prisma, svc } = makeSvc();
        armPendingErasure(prisma);
        (prisma.workflowRun.findMany as jest.Mock).mockResolvedValue([]);
        await svc.fulfillErasure(WS, 'dr1', 'mgr-1');
        expect(prisma.workflowStepRun.deleteMany).not.toHaveBeenCalled();
      });
    });

    it('is race-safe: a concurrent fulfil that loses the atomic claim (count 0) does no erasure', async () => {
      const { prisma, suppression, svc } = makeSvc();
      armPendingErasure(prisma);
      (prisma.dataRequest.updateMany as jest.Mock).mockResolvedValue({ count: 0 }); // sibling already claimed
      const out: any = await svc.fulfillErasure(WS, 'dr1', 'mgr-2');
      expect(out).toMatchObject({ id: 'dr1', status: 'COMPLETED' });
      // Lost the claim → must NOT re-run the destructive erasure.
      expect(prisma.lead.updateMany).not.toHaveBeenCalled();
      expect(prisma.conversation.deleteMany).not.toHaveBeenCalled();
      expect(prisma.message.deleteMany).not.toHaveBeenCalled();
      // …and must NOT re-tombstone: the sibling already did, and this one no
      // longer has the addresses to do it with.
      expect(suppression.suppress).not.toHaveBeenCalled();
    });

    it('404s when the erasure request does not exist (or is an EXPORT, filtered by kind)', async () => {
      const { prisma, svc } = makeSvc();
      (prisma.dataRequest.findFirst as jest.Mock).mockResolvedValue(null);
      await expect(svc.fulfillErasure(WS, 'nope', 'mgr-1')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.lead.updateMany).not.toHaveBeenCalled();
    });

    it('rejects (and does not re-run) a request that is already COMPLETED', async () => {
      const { prisma, svc } = makeSvc();
      armPendingErasure(prisma, { status: 'COMPLETED' });
      await expect(svc.fulfillErasure(WS, 'dr1', 'mgr-1')).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.lead.updateMany).not.toHaveBeenCalled();
      expect(prisma.conversation.deleteMany).not.toHaveBeenCalled();
    });
  });
});
