import { OpportunitiesService } from './opportunities.service';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';
import { assignmentOf } from '../services/lead-stream.service';

/**
 * Sales movement reaching the PERSON's stream.
 *
 * Before this, `opportunities.service.ts` contained no `leadActivity` write at
 * all: a deal could be opened, dragged across four stages and won without one
 * line of it appearing in the person's history. v2.284.0 put messages and
 * activities on one axis and left the sales half of the relationship outside it.
 *
 * Two rules these specs hold, both of which a mocked Prisma is happy to let a
 * careless implementation break:
 *
 * 1. The activity is written INSIDE the deal's own transaction. The `$transaction`
 *    mock below hands the callback a DISTINCT client (`tx`), so a write issued on
 *    `this.prisma` instead of on `tx` lands on the other mock and fails the
 *    assertion — "it was in a transaction" is checked, not assumed.
 * 2. `Opportunity.leadId` is a soft ref with NO foreign key (schema.prisma:3931),
 *    so it may name a lead that is deleted or belongs to a NEIGHBOUR. The lead is
 *    resolved by (id, workspaceId) before anything is written; an unresolvable
 *    ref writes nothing rather than throwing a foreign-key error at the reader
 *    or stamping our deal name onto next door's timeline.
 */
describe('OpportunitiesService — sales movement in the person stream', () => {
  let prisma: MockPrismaClient;
  let tx: MockPrismaClient;
  let pipelines: { get: jest.Mock; ensureDefaultPipeline: jest.Mock };
  let outbox: { append: jest.Mock };
  let svc: OpportunitiesService;

  const WS = 'ws-1';
  const MGR = { id: 'mgr-1', role: 'MANAGER', workspaceId: WS } as any;
  const LEAD = { id: 'lead-1', businessName: 'Happy Day Organizasyon', contactPerson: 'Ayse' };

  const PIPELINE = {
    id: 'p1',
    name: 'Sales Pipeline',
    isDefault: true,
    stages: [
      { id: 's-new', name: 'Yeni', position: 0, probability: 10, isWon: false, isLost: false },
      { id: 's-offer', name: 'Teklif gönderildi', position: 1, probability: 60, isWon: false, isLost: false },
      { id: 's-won', name: 'Kazanıldı', position: 2, probability: 100, isWon: true, isLost: false },
      { id: 's-lost', name: 'Kaybedildi', position: 3, probability: 0, isWon: false, isLost: true },
    ],
  };

  /** The single activity row written by the call under test. */
  const written = () => (tx.leadActivity.create.mock.calls[0]?.[0] as any)?.data;

  beforeEach(() => {
    prisma = mockPrismaClient();
    tx = mockPrismaClient();
    pipelines = {
      get: jest.fn().mockResolvedValue(PIPELINE),
      ensureDefaultPipeline: jest.fn().mockResolvedValue(PIPELINE),
    };
    outbox = { append: jest.fn().mockResolvedValue('ob') };
    svc = new OpportunitiesService(prisma as any, pipelines as any, outbox as any);
    // A DISTINCT client inside the transaction — see the file header.
    (prisma.$transaction as any).mockImplementation(async (arg: any) =>
      typeof arg === 'function' ? arg(tx) : Promise.all(arg),
    );
    prisma.lead.findFirst.mockResolvedValue(LEAD as any);
    tx.opportunity.create.mockResolvedValue({ id: 'o1', leadId: LEAD.id, value: 45000, currency: 'TRY' } as any);
    tx.opportunity.update.mockResolvedValue({ id: 'o1', leadId: LEAD.id, value: 45000, currency: 'TRY' } as any);
    tx.leadActivity.create.mockResolvedValue({ id: 'act-1' } as any);
  });

  describe('a deal opened', () => {
    it("writes the person a 'Deal opened' status line, in the deal's own transaction", async () => {
      await svc.create(
        WS,
        { name: 'Happy Day — masa sistemi', leadId: LEAD.id, value: 45000 } as any,
        MGR,
      );

      expect(prisma.$transaction).toHaveBeenCalled();
      // On `tx`, not on `this.prisma` — the deal and its trace commit together.
      expect(tx.leadActivity.create).toHaveBeenCalledTimes(1);
      expect(prisma.leadActivity.create).not.toHaveBeenCalled();
      expect(written()).toMatchObject({
        type: 'STATUS_CHANGE',
        title: 'Deal opened: Happy Day — masa sistemi',
        description: 'Stage: Yeni · 45000 TRY',
        leadId: LEAD.id,
        createdById: MGR.id,
      });
    });

    it('writes nothing for a deal with no person behind it', async () => {
      await svc.create(WS, { name: 'Walk-in deal' } as any, MGR);
      expect(tx.leadActivity.create).not.toHaveBeenCalled();
    });

    it("does not badge a sales move as an assignment (the stream's other STATUS_CHANGE)", async () => {
      await svc.create(WS, { name: 'Deal', leadId: LEAD.id } as any, MGR);
      // Same discriminator the stream reads: an assignment badge on a stage move
      // would mislabel every deal line in the timeline.
      expect(assignmentOf(written().metadata)).toBeNull();
      expect(written().metadata).toMatchObject({ kind: 'opportunity', event: 'opened', opportunityId: 'o1' });
    });
  });

  describe('a stage change', () => {
    const openDeal = {
      id: 'o1',
      workspaceId: WS,
      pipelineId: 'p1',
      stageId: 's-new',
      leadId: LEAD.id,
      assignedToId: MGR.id,
      name: 'Happy Day — masa sistemi',
      value: 45000,
      currency: 'TRY',
      wonAt: null,
      lostAt: null,
    };

    beforeEach(() => {
      prisma.opportunity.findFirst.mockResolvedValue(openDeal as any);
    });

    it('names both stages, because the stage name is what a human reads', async () => {
      prisma.pipelineStage.findFirst
        .mockResolvedValueOnce({ id: 's-offer', name: 'Teklif gönderildi', isWon: false, isLost: false } as any)
        .mockResolvedValueOnce({ id: 's-new', name: 'Yeni' } as any);

      await svc.move(WS, 'o1', { stageId: 's-offer' } as any, MGR);

      expect(tx.leadActivity.create).toHaveBeenCalledTimes(1);
      expect(prisma.leadActivity.create).not.toHaveBeenCalled();
      expect(written()).toMatchObject({
        type: 'STATUS_CHANGE',
        title: 'Deal stage: Yeni → Teklif gönderildi',
        description: 'Happy Day — masa sistemi · 45000 TRY',
        leadId: LEAD.id,
        createdById: MGR.id,
      });
    });

    it('writes nothing when the card is only reordered within its own stage', async () => {
      prisma.pipelineStage.findFirst.mockResolvedValue({
        id: 's-new',
        name: 'Yeni',
        isWon: false,
        isLost: false,
      } as any);

      await svc.move(WS, 'o1', { stageId: 's-new', position: 3 } as any, MGR);

      expect(tx.leadActivity.create).not.toHaveBeenCalled();
    });

    it('reads as WON, not as a stage move, when the drop lands on the win stage', async () => {
      prisma.pipelineStage.findFirst
        .mockResolvedValueOnce({ id: 's-won', name: 'Kazanıldı', isWon: true, isLost: false } as any)
        .mockResolvedValueOnce({ id: 's-new', name: 'Yeni' } as any);

      await svc.move(WS, 'o1', { stageId: 's-won' } as any, MGR);

      expect(written()).toMatchObject({
        title: 'Deal won: Happy Day — masa sistemi',
        description: 'Stage: Yeni → Kazanıldı · 45000 TRY',
      });
      expect(written().metadata).toMatchObject({ event: 'won' });
    });

    it("writes nothing when the deal's leadId names a person outside this workspace", async () => {
      // No foreign key on `Opportunity.leadId`: the id may belong to a
      // neighbour, or to a person who has since been deleted. Either way the
      // scoped read answers null and the sales move leaves no trace on anyone.
      prisma.lead.findFirst.mockResolvedValue(null);
      prisma.pipelineStage.findFirst
        .mockResolvedValueOnce({ id: 's-offer', name: 'Teklif gönderildi', isWon: false, isLost: false } as any)
        .mockResolvedValueOnce({ id: 's-new', name: 'Yeni' } as any);

      await svc.move(WS, 'o1', { stageId: 's-offer' } as any, MGR);

      expect(tx.leadActivity.create).not.toHaveBeenCalled();
      // The deal itself still moved — the trace is best-effort about WHO, never
      // about WHETHER.
      expect(tx.opportunity.update).toHaveBeenCalled();
      expect(prisma.lead.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: LEAD.id, workspaceId: WS } }),
      );
    });
  });

  describe('won / lost buttons', () => {
    const openDeal = {
      id: 'o1',
      workspaceId: WS,
      pipelineId: 'p1',
      stageId: 's-offer',
      leadId: LEAD.id,
      assignedToId: MGR.id,
      name: 'Happy Day — masa sistemi',
      value: 45000,
      currency: 'TRY',
      wonAt: null,
      lostAt: null,
    };

    beforeEach(() => {
      prisma.opportunity.findFirst.mockResolvedValue(openDeal as any);
    });

    it('win() writes the same line the drag writes', async () => {
      prisma.pipelineStage.findFirst
        .mockResolvedValueOnce({ id: 's-won', name: 'Kazanıldı', isWon: true, isLost: false } as any)
        .mockResolvedValueOnce({ id: 's-offer', name: 'Teklif gönderildi' } as any);

      await svc.win(WS, 'o1', MGR);

      expect(written()).toMatchObject({
        title: 'Deal won: Happy Day — masa sistemi',
        description: 'Stage: Teklif gönderildi → Kazanıldı · 45000 TRY',
      });
      expect(prisma.leadActivity.create).not.toHaveBeenCalled();
    });

    it('lose() carries the reason, which is the only part anyone re-reads later', async () => {
      prisma.pipelineStage.findFirst
        .mockResolvedValueOnce({ id: 's-lost', name: 'Kaybedildi', isWon: false, isLost: true } as any)
        .mockResolvedValueOnce({ id: 's-offer', name: 'Teklif gönderildi' } as any);

      await svc.lose(WS, 'o1', { reason: 'Bütçe yetmedi' } as any, MGR);

      expect(written()).toMatchObject({
        title: 'Deal lost: Happy Day — masa sistemi',
        description: 'Stage: Teklif gönderildi → Kaybedildi · Reason: Bütçe yetmedi',
      });
      expect(written().metadata).toMatchObject({ event: 'lost' });
    });

    it('a pipeline with no terminal stage still records the win against the current stage', async () => {
      // `winStage` is nullable in win(): a pipeline may have no isWon column.
      prisma.pipelineStage.findFirst.mockResolvedValue(null);

      await svc.win(WS, 'o1', MGR);

      expect(written()).toMatchObject({ title: 'Deal won: Happy Day — masa sistemi' });
      expect(written().description).toBe('45000 TRY');
    });
  });
});
