import { randomUUID } from 'crypto';
import { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../../src/prisma/prisma.service';
import { EntitlementsService } from '../../src/modules/billing/entitlements.service';
import { McpBrokerService } from '../../src/modules/marketing/mcp/mcp-broker.service';
import { createRealDbTestApp, closeTestApp, realDbEnabled } from '../utils/test-app';

/**
 * Brand knowledge over MCP, end to end against a REAL database: the doc an
 * agent adds with `jeeta.add_brand_knowledge` must come back from
 * `jeeta.search_brand_knowledge` in the same session — the property the unit
 * tests can only assert by mocking `indexDoc` — and must stay invisible to
 * every other workspace. Only the package lookup is faked (a bare test
 * workspace has no plan), set to a limit of 2 so the real advisory-locked cap
 * is exercised too.
 *
 * Opt-in via E2E_REAL_DB=1.
 */
const describeRealDb = realDbEnabled() ? describe : describe.skip;

describeRealDb('brand knowledge MCP tools — real DB (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let broker: McpBrokerService;

  const wsA = randomUUID();
  const wsB = randomUUID();
  const runs: Record<string, string> = { [wsA]: randomUUID(), [wsB]: randomUUID() };
  const ctx = (workspaceId: string) => ({
    workspaceId,
    grantedScopes: ['reports.read', 'settings.manage'],
    agentRunId: runs[workspaceId],
    requireAudit: true,
    writeMode: 'AUTONOMOUS' as const,
  });

  beforeAll(async () => {
    ({ app, prisma } = await createRealDbTestApp((builder) => {
      builder.overrideProvider(EntitlementsService).useValue({
        getEffective: async () => ({ limits: { maxKnowledgeDocs: 2 }, features: {} }),
      });
    }));
    broker = app.get(McpBrokerService);
    for (const id of [wsA, wsB]) {
      await prisma.workspace.create({
        data: { id, slug: `bk-${id.slice(0, 8)}`, name: 'BK', productName: 'BK' } as never,
      });
      // A real run, so the broker's audit row (tool_call_logs.runId FK) lands.
      await prisma.agentRun.create({ data: { id: runs[id], workspaceId: id, agent: 'mcp' } });
    }
  });

  afterAll(async () => {
    await prisma?.toolCallLog.deleteMany({ where: { runId: { in: Object.values(runs) } } });
    await prisma?.agentRun.deleteMany({ where: { id: { in: Object.values(runs) } } });
    await prisma?.knowledgeDoc.deleteMany({ where: { workspaceId: { in: [wsA, wsB] } } });
    await prisma?.approvalRequest.deleteMany({ where: { workspaceId: { in: [wsA, wsB] } } });
    await prisma?.workspace.deleteMany({ where: { id: { in: [wsA, wsB] } } });
    await closeTestApp(app);
  });

  it('add → search finds it → list shows it; another workspace sees nothing', async () => {
    const added = (await broker.invoke(ctx(wsA), 'jeeta.add_brand_knowledge', {
      title: 'İade politikası',
      content: '# İade\n\nTeslimattan sonra 14 gün içinde koşulsuz iade.',
      tags: ['politika'],
    })) as any;
    // eslint-disable-next-line no-console
    console.log('add_brand_knowledge →', JSON.stringify(added));
    expect(added.status).toBe('OK');
    expect(added.result.searchable).toBe(true);
    expect(added.result.chunks).toBeGreaterThan(0);
    const docId = added.result.doc.id;

    // Multi-word, out of order, and one word only in the title.
    const found = (await broker.invoke(ctx(wsA), 'jeeta.search_brand_knowledge', {
      query: 'koşulsuz İade politikası',
    })) as any;
    // eslint-disable-next-line no-console
    console.log('search_brand_knowledge →', JSON.stringify(found));
    expect(found.result.map((c: any) => c.docId)).toContain(docId);
    expect(found.result[0].docTitle).toBe('İade politikası');

    const byTag = (await broker.invoke(ctx(wsA), 'jeeta.search_brand_knowledge', { query: 'politika' })) as any;
    expect(byTag.result.map((c: any) => c.docId)).toContain(docId);

    const listed = (await broker.invoke(ctx(wsA), 'jeeta.list_brand_knowledge', {})) as any;
    // eslint-disable-next-line no-console
    console.log('list_brand_knowledge →', JSON.stringify(listed));
    expect(listed.result.docs.map((d: any) => d.id)).toEqual([docId]);

    // Cross-tenant: B searches the same words, lists, and tries to delete A's doc.
    const other = (await broker.invoke(ctx(wsB), 'jeeta.search_brand_knowledge', {
      query: 'koşulsuz İade politikası',
    })) as any;
    expect(other.result).toEqual([]);
    const otherList = (await broker.invoke(ctx(wsB), 'jeeta.list_brand_knowledge', {})) as any;
    expect(otherList.result.count).toBe(0);
    await expect(
      broker.invoke({ ...ctx(wsB), approvedBy: 'someone' }, 'jeeta.delete_brand_knowledge', { docId }),
    ).rejects.toThrow(/not found/i);
    expect(await prisma.knowledgeDoc.count({ where: { id: docId } })).toBe(1);
  });

  it('enforces the package limit for real', async () => {
    const second = (await broker.invoke(ctx(wsA), 'jeeta.add_brand_knowledge', { title: 'İki', content: 'iki' })) as any;
    expect(second.status).toBe('OK');
    await expect(
      broker.invoke(ctx(wsA), 'jeeta.add_brand_knowledge', { title: 'Üç', content: 'üç' }),
    ).rejects.toThrow(/limit reached \(2\)/);
    expect(await prisma.knowledgeDoc.count({ where: { workspaceId: wsA } })).toBe(2);
  });

  it('queues delete even in AUTONOMOUS, and deletes doc + chunks only once approved', async () => {
    const doc = await prisma.knowledgeDoc.findFirstOrThrow({ where: { workspaceId: wsA, title: 'İade politikası' } });
    const queued = (await broker.invoke(ctx(wsA), 'jeeta.delete_brand_knowledge', { docId: doc.id })) as any;
    // eslint-disable-next-line no-console
    console.log('delete_brand_knowledge (AUTONOMOUS) →', JSON.stringify(queued));
    expect(queued.status).toBe('PENDING_APPROVAL');
    const req = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: queued.approvalId } });
    expect(req).toMatchObject({ workspaceId: wsA, kind: 'DESTRUCTIVE', status: 'PENDING' });
    expect(await prisma.knowledgeDoc.count({ where: { id: doc.id } })).toBe(1);

    const done = (await broker.invoke({ ...ctx(wsA), approvedBy: 'owner' }, 'jeeta.delete_brand_knowledge', {
      docId: doc.id,
    })) as any;
    expect(done.status).toBe('OK');
    expect(await prisma.knowledgeDoc.count({ where: { id: doc.id } })).toBe(0);
    expect(await prisma.knowledgeChunk.count({ where: { docId: doc.id } })).toBe(0);
  });

  it('audits every executed call against the caller run', async () => {
    const logged = await prisma.toolCallLog.findMany({ where: { runId: runs[wsA] }, select: { tool: true } });
    const tools = new Set(logged.map((l) => l.tool));
    for (const t of ['jeeta.add_brand_knowledge', 'jeeta.search_brand_knowledge', 'jeeta.list_brand_knowledge', 'jeeta.delete_brand_knowledge']) {
      expect(tools).toContain(t);
    }
  });
});
