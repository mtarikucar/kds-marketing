import { ConflictException } from '@nestjs/common';
import { MarketingLeadsService } from './marketing-leads.service';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';

/**
 * update() mirrors create()'s "one OPEN lead per email per workspace" rule when
 * the email changes — editing a lead's email to one already held by another
 * open lead must 409, the same way creating a duplicate would. A non-email edit
 * (or an unchanged email) must NOT issue the extra dedup lookup, so ordinary
 * field updates stay a single round-trip.
 */
describe('MarketingLeadsService.update — email-change dedup', () => {
  let prisma: MockPrismaClient;
  let svc: MarketingLeadsService;

  const WS = 'ws-1';

  const EXISTING_LEAD = {
    id: 'lead-1',
    workspaceId: WS,
    email: 'old@biz.com',
    assignedToId: 'rep-1',
  } as any;

  beforeEach(() => {
    prisma = mockPrismaClient();
    svc = new MarketingLeadsService(
      prisma as any,
      {} as any, // emailService — unused by update()
      {} as any, // autoAssigner — unused by update()
      {} as any, // provisioning — unused by update()
      {} as any, // outbox — unused by update()
    );
    prisma.lead.update.mockResolvedValue({ id: 'lead-1' } as any);
  });

  it('throws Conflict when the new email is already held by another OPEN lead in the workspace', async () => {
    // First findFirst → the scoped pre-check (the lead being edited).
    // Second findFirst → the email-clash lookup (an open lead already owning it).
    prisma.lead.findFirst
      .mockResolvedValueOnce(EXISTING_LEAD)
      .mockResolvedValueOnce({
        id: 'lead-2',
        businessName: 'Rival Bistro',
        assignedTo: { firstName: 'Ada', lastName: 'Lovelace' },
      } as any);

    await expect(
      svc.update(WS, 'lead-1', { email: 'taken@biz.com' } as any, 'rep-1', 'REP'),
    ).rejects.toBeInstanceOf(ConflictException);

    // The clash lookup is scoped: same workspace, open statuses only, excluding
    // this same row.
    expect(prisma.lead.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: WS,
          email: 'taken@biz.com',
          status: { notIn: ['WON', 'LOST'] },
          id: { not: 'lead-1' },
        }),
      }),
    );
    // No write when the dedup guard trips.
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });

  it('does NOT issue the dedup query for a non-email update (single findFirst, then update)', async () => {
    prisma.lead.findFirst.mockResolvedValue(EXISTING_LEAD);

    await svc.update(WS, 'lead-1', { notes: 'called twice, no answer' } as any, 'rep-1', 'REP');

    // Only the scoped pre-check ran — no second clash lookup.
    expect(prisma.lead.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.lead.update).toHaveBeenCalledTimes(1);
  });

  it('does NOT issue the dedup query when the email is unchanged', async () => {
    prisma.lead.findFirst.mockResolvedValue(EXISTING_LEAD);

    await svc.update(WS, 'lead-1', { email: EXISTING_LEAD.email } as any, 'rep-1', 'REP');

    expect(prisma.lead.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.lead.update).toHaveBeenCalledTimes(1);
  });
});
