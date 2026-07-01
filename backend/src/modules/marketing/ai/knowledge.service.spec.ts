import { BadRequestException, NotFoundException } from '@nestjs/common';
import { KnowledgeService } from './knowledge.service';

/**
 * Knowledge base CRUD + FTS retrieval. The multi-tenant invariant is the
 * point: every search binds the workspaceId (never spans tenants) and an
 * empty query short-circuits before touching the DB. Create enforces the
 * per-plan maxKnowledgeDocs cap.
 */
describe('KnowledgeService', () => {
  const WS = 'ws-1';
  let prisma: any;
  let entitlements: { getEffective: jest.Mock };
  let svc: KnowledgeService;

  function withDocLimit(maxKnowledgeDocs: number) {
    entitlements.getEffective.mockResolvedValue({ limits: { maxKnowledgeDocs } });
  }

  beforeEach(() => {
    prisma = {
      knowledgeDoc: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
        count: jest.fn(),
        create: jest.fn().mockResolvedValue({ id: 'd1' }),
        update: jest.fn().mockResolvedValue({ id: 'd1' }),
        deleteMany: jest.fn(),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ locked: 'x' }]),
      $transaction: jest.fn().mockImplementation(async (fn: any) => fn(prisma)),
    };
    entitlements = { getEffective: jest.fn() };
    svc = new KnowledgeService(prisma as any, entitlements as any);
  });

  // A bare count-then-create lets two concurrent requests at (limit-1) BOTH pass the
  // cap and exceed maxKnowledgeDocs. create() serializes the check under a per-
  // workspace advisory xact-lock (the ai-credits / message-quota / research pattern).
  describe('create — quota-race safety', () => {
    it('serializes the count-check + create under a per-workspace advisory lock', async () => {
      withDocLimit(5);
      prisma.knowledgeDoc.count.mockResolvedValue(4);
      await svc.create(WS, { title: 'T', content: 'C' });
      expect(prisma.$transaction).toHaveBeenCalled();
      const lockSql = prisma.$queryRawUnsafe.mock.calls[0][0] as string;
      expect(lockSql).toContain('pg_advisory_xact_lock');
      expect(lockSql).toContain('knowledge-docs:ws-1');
      expect(prisma.knowledgeDoc.create).toHaveBeenCalled();
    });

    it('rejects at the cap without creating (checked inside the lock)', async () => {
      withDocLimit(5);
      prisma.knowledgeDoc.count.mockResolvedValue(5);
      await expect(svc.create(WS, { title: 'T', content: 'C' })).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.knowledgeDoc.create).not.toHaveBeenCalled();
    });

    it('skips the lock/count on an unlimited (-1) plan', async () => {
      withDocLimit(-1);
      await svc.create(WS, { title: 'T', content: 'C' });
      expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
      expect(prisma.knowledgeDoc.create).toHaveBeenCalled();
    });
  });

  describe('search', () => {
    it('short-circuits an empty/whitespace query without hitting the DB', async () => {
      await expect(svc.search(WS, '   ')).resolves.toEqual([]);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('binds the workspaceId and the query, and maps the rows', async () => {
      prisma.$queryRaw.mockResolvedValue([
        { id: 'd1', title: 'Menu', snippet: '…pizza…', rank: 0.9 },
      ]);
      const res = await svc.search(WS, 'pizza');

      expect(res).toEqual([{ id: 'd1', title: 'Menu', snippet: '…pizza…', rank: 0.9 }]);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      const values = prisma.$queryRaw.mock.calls[0].slice(1);
      expect(values).toContain(WS); // workspace-scoped — never spans tenants
      expect(values).toContain('pizza'); // the query string is bound, not interpolated
    });
  });

  describe('create', () => {
    it('rejects once the per-plan doc cap is reached', async () => {
      withDocLimit(2);
      prisma.knowledgeDoc.count.mockResolvedValue(2);
      await expect(
        svc.create(WS, { title: 't', content: 'c' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.knowledgeDoc.create).not.toHaveBeenCalled();
    });

    it('creates under the cap, workspace-scoped with TR/MANUAL defaults', async () => {
      withDocLimit(5);
      prisma.knowledgeDoc.count.mockResolvedValue(1);
      await svc.create(WS, { title: 't', content: 'c' });
      const data = prisma.knowledgeDoc.create.mock.calls[0][0].data;
      expect(data).toMatchObject({ workspaceId: WS, language: 'tr', source: 'MANUAL' });
    });

    it('skips the count probe entirely on an unlimited plan', async () => {
      withDocLimit(-1);
      await svc.create(WS, { title: 't', content: 'c' });
      expect(prisma.knowledgeDoc.count).not.toHaveBeenCalled();
      expect(prisma.knowledgeDoc.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('get / remove are workspace-scoped', () => {
    it('get throws when the doc is not in this workspace', async () => {
      prisma.knowledgeDoc.findFirst.mockResolvedValue(null);
      await expect(svc.get(WS, 'nope')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.knowledgeDoc.findFirst).toHaveBeenCalledWith({
        where: { id: 'nope', workspaceId: WS },
      });
    });

    it('remove deletes by (id, workspaceId) and 404s a miss', async () => {
      prisma.knowledgeDoc.deleteMany.mockResolvedValue({ count: 0 });
      await expect(svc.remove(WS, 'nope')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.knowledgeDoc.deleteMany).toHaveBeenCalledWith({
        where: { id: 'nope', workspaceId: WS },
      });
    });
  });
});
