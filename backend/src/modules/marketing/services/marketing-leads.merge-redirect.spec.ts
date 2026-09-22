import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { MarketingLeadsService } from './marketing-leads.service';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';

/**
 * Opening a lead that was merged away.
 *
 * A merge sets `mergedIntoId` and moves every child row — activities, offers,
 * tasks, conversations — onto the canonical lead. It deliberately leaves the
 * old row resolvable so an old link, a bookmark or a notification written
 * before the merge still goes somewhere. But "somewhere" was the tombstone
 * itself: a shell with the person's name on it, no history, and no sign that
 * the real record is one hop away (`erasure-one-row`, part 2).
 *
 * So `findOne` follows the chain and answers with the canonical lead, saying
 * which id it was asked for.
 */
describe('MarketingLeadsService.findOne — merged leads', () => {
  const WS = 'ws-1';
  let prisma: MockPrismaClient;
  let svc: MarketingLeadsService;

  const lead = (over: Record<string, unknown>) =>
    ({
      id: 'lead-1',
      workspaceId: WS,
      businessName: 'Acme',
      assignedToId: 'rep-1',
      mergedIntoId: null,
      ...over,
    }) as any;

  beforeEach(() => {
    prisma = mockPrismaClient();
    svc = new MarketingLeadsService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      { append: jest.fn() } as any,
      { validateAndNormalize: jest.fn().mockResolvedValue({}) } as any,
      { verify: jest.fn().mockResolvedValue('UNKNOWN') } as any,
      {} as any,
    );
  });

  it('answers with the lead itself when nothing was merged', async () => {
    prisma.lead.findFirst.mockResolvedValue(lead({}));
    const out: any = await svc.findOne(WS, 'lead-1', 'rep-1', 'REP');
    expect(out.id).toBe('lead-1');
    expect(out.redirectedFromId).toBeUndefined();
    expect(prisma.lead.findFirst).toHaveBeenCalledTimes(1);
  });

  it('follows a tombstone to the canonical lead and says which id was asked for', async () => {
    prisma.lead.findFirst
      .mockResolvedValueOnce(lead({ id: 'old-1', mergedIntoId: 'lead-1' }))
      .mockResolvedValueOnce(lead({ id: 'lead-1' }));

    const out: any = await svc.findOne(WS, 'old-1', 'rep-1', 'REP');

    expect(out.id).toBe('lead-1');
    expect(out.redirectedFromId).toBe('old-1');
    // The canonical is fetched inside this workspace, never by id alone.
    expect(prisma.lead.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { id: 'lead-1', workspaceId: WS } }),
    );
  });

  it('follows a chain, because A→B then B→C is a real shape', async () => {
    // lead-dedupe only refuses a canonical that is CURRENTLY merged, so depth
    // grows as duplicates are folded in over time.
    prisma.lead.findFirst
      .mockResolvedValueOnce(lead({ id: 'a', mergedIntoId: 'b' }))
      .mockResolvedValueOnce(lead({ id: 'b', mergedIntoId: 'c' }))
      .mockResolvedValueOnce(lead({ id: 'c' }));

    const out: any = await svc.findOne(WS, 'a', 'rep-1', 'REP');
    expect(out.id).toBe('c');
    expect(out.redirectedFromId).toBe('a');
  });

  it('stops on a cycle rather than walking forever, and answers with what it has', async () => {
    prisma.lead.findFirst.mockImplementation((async ({ where }: any) =>
      where.id === 'a' ? lead({ id: 'a', mergedIntoId: 'b' }) : lead({ id: 'b', mergedIntoId: 'a' })) as any);

    const out: any = await svc.findOne(WS, 'a', 'rep-1', 'REP');
    expect(['a', 'b']).toContain(out.id);
  });

  it('keeps the tombstone when the canonical has since been hard-deleted', async () => {
    // An old link must still resolve to something: this is the whole reason a
    // merge leaves the row behind.
    prisma.lead.findFirst
      .mockResolvedValueOnce(lead({ id: 'old-1', mergedIntoId: 'gone' }))
      .mockResolvedValueOnce(null);

    const out: any = await svc.findOne(WS, 'old-1', 'rep-1', 'REP');
    expect(out.id).toBe('old-1');
    expect(out.redirectedFromId).toBeUndefined();
  });

  it('applies the REP ownership rule to the lead it actually returns', async () => {
    // The tombstone's own assignee is not the question — the rep is being shown
    // the canonical record, so it is the canonical record's owner that decides.
    prisma.lead.findFirst
      .mockResolvedValueOnce(lead({ id: 'old-1', assignedToId: 'rep-1', mergedIntoId: 'lead-1' }))
      .mockResolvedValueOnce(lead({ id: 'lead-1', assignedToId: 'rep-9' }));

    await expect(svc.findOne(WS, 'old-1', 'rep-1', 'REP')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('still 404s an id this workspace does not hold', async () => {
    prisma.lead.findFirst.mockResolvedValue(null);
    await expect(svc.findOne(WS, 'nope', 'rep-1', 'REP')).rejects.toBeInstanceOf(NotFoundException);
  });
});
