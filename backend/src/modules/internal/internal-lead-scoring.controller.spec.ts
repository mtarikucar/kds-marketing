import { NotFoundException } from '@nestjs/common';
import { InternalLeadScoringController } from './internal-lead-scoring.controller';

describe('InternalLeadScoringController', () => {
  let prisma: any;
  let config: any;
  let leads: any;
  let ctrl: InternalLeadScoringController;
  const WS = { id: 'ws1', slug: 'a', productName: 'P', productDescription: 'D' };

  beforeEach(() => {
    prisma = {
      workspace: { findMany: jest.fn(), findUnique: jest.fn() },
      lead: { findMany: jest.fn() },
    };
    config = { get: jest.fn().mockReturnValue(undefined) }; // env absent -> default cap
    leads = { applyAiScore: jest.fn() };
    ctrl = new InternalLeadScoringController(prisma as any, config as any, leads as any);
  });

  describe('GET jobs', () => {
    it('returns one job per workspace with unscored active leads', async () => {
      prisma.workspace.findMany.mockResolvedValue([WS]);
      prisma.lead.findMany.mockResolvedValue([
        { id: 'l1', businessName: 'B', businessType: 'CAFE', source: 'INSTAGRAM', city: 'X', region: 'Y', tableCount: 12, branchCount: 1, currentSystem: null, notes: null },
      ]);
      const res = await ctrl.jobs();
      expect(res.jobs).toHaveLength(1);
      expect((res.jobs[0] as any).leads[0]).toMatchObject({ leadId: 'l1', businessType: 'CAFE' });
      const where = prisma.lead.findMany.mock.calls[0][0].where;
      expect(where).toMatchObject({ workspaceId: 'ws1', scoredAt: null });
      expect(where.status).toEqual({ notIn: ['WON', 'LOST'] });
      expect(prisma.lead.findMany.mock.calls[0][0].take).toBe(100);
    });

    it('honors the ROUTINE_LEADSCORE_DAILY_CAP override', async () => {
      config.get.mockReturnValue('25');
      prisma.workspace.findMany.mockResolvedValue([WS]);
      prisma.lead.findMany.mockResolvedValue([{ id: 'l1', businessName: 'B', businessType: 'CAFE', source: 'X', city: null, region: null, tableCount: null, branchCount: null, currentSystem: null, notes: null }]);
      await ctrl.jobs();
      expect(prisma.lead.findMany.mock.calls[0][0].take).toBe(25);
    });

    it('omits workspaces with no unscored leads', async () => {
      prisma.workspace.findMany.mockResolvedValue([WS]);
      prisma.lead.findMany.mockResolvedValue([]);
      const res = await ctrl.jobs();
      expect(res.jobs).toHaveLength(0);
    });
  });

  describe('POST :workspaceId/scores', () => {
    it('404s an unknown / inactive workspace', async () => {
      prisma.workspace.findUnique.mockResolvedValue(null);
      await expect(
        ctrl.submit('wsX', { scores: [{ leadId: 'l1', score: 80, reason: 'hot' }] }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('guarded-updates only still-unscored leads and counts scored/skipped', async () => {
      prisma.workspace.findUnique.mockResolvedValue({ id: 'ws1', status: 'ACTIVE' });
      leads.applyAiScore.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
      const res = await ctrl.submit('ws1', {
        scores: [
          { leadId: 'l1', score: 80, reason: 'hot' },
          { leadId: 'l2', score: 30, reason: 'cold' },
        ],
      });
      expect(res).toEqual({ scored: 1, skipped: 1 });
      expect(leads.applyAiScore).toHaveBeenCalledWith('ws1', 'l1', 80, 'hot');
    });
  });
});
