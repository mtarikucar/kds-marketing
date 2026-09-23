import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MarketingLeadsService } from './marketing-leads.service';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';

/**
 * `POST /marketing/leads/:id/email-suppression` — the tenant-side half of
 * `optout-state-invisible`.
 *
 * The rule under test is that this endpoint OWNS NO POLICY. Every write goes
 * through `SuppressionService.suppress`/`lift`, because those two are what move
 * the `ContactSuppression` row, the denormalised lead columns and the
 * `ConsentRecord` ledger together, for EVERY lead that shares the address.
 * A local `lead.update({ emailOptOut: true })` here would flip one row, leave
 * the ledger empty and re-open `optout-per-lead-row` from the UI side.
 *
 * So these tests assert delegation and the answer, not the projection — the
 * projection has its own tests in `suppression.service.spec.ts`.
 */
describe('MarketingLeadsService — setEmailSuppression', () => {
  let prisma: MockPrismaClient;
  let suppression: { suppress: jest.Mock; lift: jest.Mock; check: jest.Mock };
  let svc: MarketingLeadsService;

  const WS = 'ws-1';
  const LEAD = 'lead-1';
  const ADDRESS = 'ayse@acme.test';
  const ACTOR = 'u-7';

  /** The lead row this endpoint reads — before and, on the second call, after. */
  const row = (over: Record<string, unknown> = {}) => ({
    id: LEAD,
    workspaceId: WS,
    email: ADDRESS,
    emailNormalized: ADDRESS,
    emailOptOut: false,
    emailBouncedAt: null,
    emailVerifiedStatus: 'UNKNOWN',
    ...over,
  });

  function makeSvc() {
    prisma = mockPrismaClient();
    suppression = {
      suppress: jest.fn().mockResolvedValue(undefined),
      lift: jest.fn().mockResolvedValue(undefined),
      check: jest.fn().mockResolvedValue({ suppressed: false }),
    };
    svc = new MarketingLeadsService(
      prisma as any,
      {} as any, // emailService — unused
      {} as any, // autoAssigner — unused
      {} as any, // provisioning — unused
      {} as any, // outbox — unused
      {} as any, // customFields — unused
      {} as any, // hygiene — unused
      {} as any, // smsOtp — unused
      suppression as any,
    );
    return { prisma, suppression, svc };
  }

  it('throws NotFoundException when the lead is not in this workspace', async () => {
    const { prisma, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue(null);

    await expect(svc.setEmailSuppression(WS, LEAD, 'OPT_OUT', ACTOR)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // Suppression is keyed on the ADDRESS, so there is nothing to write for a
  // lead that has none — and `SuppressionService.suppress` would silently
  // no-op. A silent no-op behind a button the rep just pressed to honour
  // "remove me" is the worst of the three possible answers.
  it('refuses a lead with no email on file rather than silently doing nothing', async () => {
    const { prisma, suppression, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue(row({ email: null, emailNormalized: null }) as any);

    await expect(svc.setEmailSuppression(WS, LEAD, 'OPT_OUT', ACTOR)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(suppression.suppress).not.toHaveBeenCalled();
  });

  it('opts the address out through SuppressionService, naming the actor and the clicked lead', async () => {
    const { prisma, suppression, svc } = makeSvc();
    prisma.lead.findFirst
      .mockResolvedValueOnce(row() as any)
      .mockResolvedValueOnce(row({ emailOptOut: true }) as any);
    suppression.check.mockResolvedValue({ suppressed: true, reason: 'OPT_OUT' });

    const out = await svc.setEmailSuppression(WS, LEAD, 'OPT_OUT', ACTOR);

    expect(suppression.suppress).toHaveBeenCalledWith(WS, ADDRESS, 'EMAIL', 'OPT_OUT', {
      source: `manual:${ACTOR}`,
      leadId: LEAD,
    });
    expect(suppression.lift).not.toHaveBeenCalled();
    expect(out).toEqual({
      emailOptOut: true,
      emailBouncedAt: null,
      emailVerifiedStatus: 'UNKNOWN',
      suppressed: true,
      reason: 'OPT_OUT',
    });
  });

  it('re-subscribes by lifting the OPT_OUT, which is what puts the consent back on the ledger', async () => {
    const { prisma, suppression, svc } = makeSvc();
    prisma.lead.findFirst
      .mockResolvedValueOnce(row({ emailOptOut: true }) as any)
      .mockResolvedValueOnce(row() as any);

    const out = await svc.setEmailSuppression(WS, LEAD, 'RESUBSCRIBE', ACTOR);

    expect(suppression.lift).toHaveBeenCalledWith(WS, ADDRESS, 'EMAIL', 'OPT_OUT', `manual:${ACTOR}`);
    expect(suppression.suppress).not.toHaveBeenCalled();
    expect(out.emailOptOut).toBe(false);
    expect(out.suppressed).toBe(false);
  });

  // A re-subscribe that cannot take effect must SAY so rather than report
  // success: `writeLift` deliberately refuses to clear `emailOptOut` while a
  // live COMPLAINT row still demands that column.
  it('answers with the standing reason when a lift does not actually free the address', async () => {
    const { prisma, suppression, svc } = makeSvc();
    prisma.lead.findFirst
      .mockResolvedValueOnce(row({ emailOptOut: true }) as any)
      .mockResolvedValueOnce(row({ emailOptOut: true }) as any);
    suppression.check.mockResolvedValue({ suppressed: true, reason: 'COMPLAINT' });

    const out = await svc.setEmailSuppression(WS, LEAD, 'RESUBSCRIBE', ACTOR);

    expect(out).toMatchObject({ emailOptOut: true, suppressed: true, reason: 'COMPLAINT' });
  });

  // One button, two machine verdicts. `HARD_BOUNCE` and `INVALID` live in
  // different columns but say the same thing to the operator ("this address is
  // dead"), and the correction is the same one act: the address was retyped, or
  // the mailbox is back. Lifting only one of them would leave the other chip on
  // screen with no control that can clear it.
  it('clears BOTH machine verdicts — the hard bounce and the invalid verdict — under one action', async () => {
    const { prisma, suppression, svc } = makeSvc();
    prisma.lead.findFirst
      .mockResolvedValueOnce(
        row({ emailBouncedAt: new Date('2026-09-01T00:00:00Z'), emailVerifiedStatus: 'INVALID' }) as any,
      )
      .mockResolvedValueOnce(row() as any);

    const out = await svc.setEmailSuppression(WS, LEAD, 'CLEAR_BOUNCE', ACTOR);

    expect(suppression.lift).toHaveBeenCalledWith(WS, ADDRESS, 'EMAIL', 'HARD_BOUNCE', `manual:${ACTOR}`);
    expect(suppression.lift).toHaveBeenCalledWith(WS, ADDRESS, 'EMAIL', 'INVALID', `manual:${ACTOR}`);
    // The consent flag is NOT touched: a bounce is not a refusal
    // (`bounce-sets-optout` is the bug that made them share a column).
    expect(suppression.lift).not.toHaveBeenCalledWith(WS, ADDRESS, 'EMAIL', 'OPT_OUT', expect.anything());
    expect(out).toMatchObject({ emailBouncedAt: null, emailVerifiedStatus: 'UNKNOWN' });
  });

  // The button can be double-clicked, and the compliance console and the lead
  // header can both be open on the same person. A repeat must be a no-op that
  // answers the same thing, not a second ledger row.
  it('is idempotent — opting out an already-opted-out address answers the same state', async () => {
    const { prisma, suppression, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue(row({ emailOptOut: true }) as any);
    suppression.check.mockResolvedValue({ suppressed: true, reason: 'OPT_OUT' });

    const first = await svc.setEmailSuppression(WS, LEAD, 'OPT_OUT', ACTOR);
    const second = await svc.setEmailSuppression(WS, LEAD, 'OPT_OUT', ACTOR);

    expect(second).toEqual(first);
    expect(suppression.suppress).toHaveBeenCalledTimes(2);
  });

  it('refuses an action it does not know rather than guessing one', async () => {
    const { prisma, suppression, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue(row() as any);

    await expect(
      svc.setEmailSuppression(WS, LEAD, 'BURN_IT_ALL' as any, ACTOR),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(suppression.suppress).not.toHaveBeenCalled();
    expect(suppression.lift).not.toHaveBeenCalled();
  });

  // The address the write is keyed on must be the NORMALISED one wherever the
  // row carries it — the suppression table is hashed, and hashing two spellings
  // of one address produces two rows that never find each other.
  it('keys the write on the normalised address, not on whatever the rep typed', async () => {
    const { prisma, suppression, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue(
      row({ email: '  Ayse@ACME.test ', emailNormalized: ADDRESS }) as any,
    );

    await svc.setEmailSuppression(WS, LEAD, 'OPT_OUT', ACTOR);

    expect(suppression.suppress).toHaveBeenCalledWith(WS, ADDRESS, 'EMAIL', 'OPT_OUT', {
      source: `manual:${ACTOR}`,
      leadId: LEAD,
    });
  });

  // `emailNormalized` is nullable and older rows predate it, so the raw column
  // is the fallback — `SuppressionService` normalises it itself.
  it('falls back to the raw address when the row predates emailNormalized', async () => {
    const { prisma, suppression, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue(
      row({ email: 'Ayse@ACME.test', emailNormalized: null }) as any,
    );

    await svc.setEmailSuppression(WS, LEAD, 'OPT_OUT', ACTOR);

    expect(suppression.suppress).toHaveBeenCalledWith(
      WS,
      'Ayse@ACME.test',
      'EMAIL',
      'OPT_OUT',
      { source: `manual:${ACTOR}`, leadId: LEAD },
    );
  });

  // Every read is workspace-scoped at the call site, so a lead id from another
  // tenant resolves to nothing rather than to somebody else's contact.
  it('scopes both reads to the caller workspace', async () => {
    const { prisma, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue(row() as any);

    await svc.setEmailSuppression(WS, LEAD, 'OPT_OUT', ACTOR);

    for (const call of prisma.lead.findFirst.mock.calls) {
      expect((call[0] as any).where).toMatchObject({ id: LEAD, workspaceId: WS });
    }
  });
});
