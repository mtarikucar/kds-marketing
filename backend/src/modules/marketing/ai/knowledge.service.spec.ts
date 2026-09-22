import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  KnowledgeService,
  sanitizeSearchQuery,
  MAX_QUERY_CHARS,
  MAX_QUERY_TERMS,
} from './knowledge.service';

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

  /**
   * `search()` is called with whatever a stranger typed — an inbound email body,
   * a webchat line, an IVR prompt (conversation-ai-engine.service.ts:558,
   * voice-ai.service.ts:174, netgsm-ivr.service.ts:295, voice-ai-bridge.service.ts:97,
   * copilot.service.ts:46). Handing that text to `websearch_to_tsquery` verbatim
   * hands the SENDER its operator language and an unbounded amount of work.
   */
  describe('search — the query is never taken verbatim from sender-controlled text', () => {
    /** The bound query value, as it actually reaches Postgres. */
    function boundQuery(): string {
      const values = prisma.$queryRaw.mock.calls[0].slice(1);
      // The query is bound four times (headline, rank, match); they are all the
      // same string, and none of them may be the raw sender text.
      const strings = values.filter((v: unknown) => typeof v === 'string' && v !== WS);
      expect(new Set(strings).size).toBe(1);
      return strings[0] as string;
    }

    it('caps a runaway body instead of building a tsquery out of a whole email', async () => {
      await svc.search(WS, 'pizza '.repeat(5000));
      const q = boundQuery();
      expect(q.split(' ')).toHaveLength(MAX_QUERY_TERMS);
      expect(q.length).toBeLessThanOrEqual(MAX_QUERY_CHARS);
    });

    it('strips the websearch operator alphabet so the sender cannot steer retrieval', async () => {
      await svc.search(WS, '"indirim tabanı" -menü or marj');
      const q = boundQuery();
      expect(q).not.toContain('"');
      expect(q).not.toMatch(/(^|\s)-/); // negation sign gone, the word kept
      expect(q).not.toMatch(/(^|\s)or(\s|$)/i); // the one operator that WIDENS a match
      expect(q).toBe('indirim tabanı menü marj');
    });

    it('returns nothing, and touches no DB, when only operators survive', async () => {
      await expect(svc.search(WS, '  "" -- or  ')).resolves.toEqual([]);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('leaves ordinary Turkish words exactly as typed', () => {
      expect(sanitizeSearchQuery('çalışma saatleri ve fiyat listesi')).toBe(
        'çalışma saatleri ve fiyat listesi',
      );
    });

    it('drops control characters rather than binding them', () => {
      expect(sanitizeSearchQuery('fiyat\u0000\u001blistesi')).toBe('fiyat listesi');
    });

    it('survives a non-string query without throwing', () => {
      expect(sanitizeSearchQuery(undefined as never)).toBe('');
      expect(sanitizeSearchQuery(null as never)).toBe('');
    });
  });

  /**
   * The doc-scope contract, pinned so a refactor cannot flip it silently.
   *
   * Empty selection = every ACTIVE doc. It is the maximal default and it looks
   * wrong at first glance, but every agent saved through the Agent Studio posts
   * `kbDocIds: []` (AgentStudioPage.tsx:85/153) — including the live one — so
   * "empty means nothing" would un-ground every deployed agent at once.
   * Restricting what a customer-facing agent may quote needs a per-doc audience
   * flag, not a re-reading of this argument (see the handoff).
   */
  describe('search — doc scoping', () => {
    /** The embedded `Prisma.sql` fragment carrying the id filter, if any. */
    function idFilterSql(): string {
      const values = prisma.$queryRaw.mock.calls[0].slice(1);
      const frag = values.find(
        (v: unknown) => v && typeof v === 'object' && typeof (v as { sql?: unknown }).sql === 'string',
      );
      return frag ? ((frag as { sql: string }).sql as string) : '';
    }

    it('searches every ACTIVE doc when no selection is given', async () => {
      await svc.search(WS, 'pizza', []);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(idFilterSql()).toBe('');
    });

    it('restricts to the selected docs when the agent named some', async () => {
      await svc.search(WS, 'pizza', ['d1', 'd2']);
      expect(idFilterSql()).toContain('"id" = ANY(');
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
