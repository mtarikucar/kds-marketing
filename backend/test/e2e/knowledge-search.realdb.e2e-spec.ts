import { randomUUID } from 'crypto';
import { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../../src/prisma/prisma.service';
import { KnowledgeService } from '../../src/modules/marketing/ai/knowledge.service';
import { createRealDbTestApp, closeTestApp, realDbEnabled } from '../utils/test-app';

/**
 * KnowledgeService.search against REAL Postgres.
 *
 * The query is hand-written SQL that casts a per-row CASE to `regconfig`:
 *
 *   CASE "language" WHEN 'tr' THEN 'turkish'::regconfig
 *                   WHEN 'en' THEN 'english'::regconfig
 *                   WHEN 'ru' THEN 'russian'::regconfig
 *                   ELSE 'simple'::regconfig END
 *
 * Those are CONSTANT casts, so Postgres resolves them when it plans the
 * statement — not per row. A text search configuration missing from the server
 * therefore throws on every call, including when the table is empty.
 *
 * That matters far beyond this service. ConversationAiEngineService.reply()
 * calls knowledge.search BEFORE it calls the model, so a throw here means the
 * AI never answers a customer and never bills a token. On the live workspace
 * `conversation.reply` has never been recorded once in 30 days while four
 * customers wait since June — and the reply path is observed reaching
 * `ai_typing` (past every gate) and then dying before any Anthropic call.
 *
 * A mocked Prisma cannot see any of this: it returns whatever it was told and
 * the SQL is never parsed. Only a database can say whether these casts resolve.
 *
 * Opt-in via E2E_REAL_DB=1.
 */
const describeRealDb = realDbEnabled() ? describe : describe.skip;

describeRealDb('KnowledgeService.search — real DB (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let knowledge: KnowledgeService;

  const workspaceId = randomUUID();

  beforeAll(async () => {
    ({ app, prisma } = await createRealDbTestApp());
    knowledge = app.get(KnowledgeService);
  });

  afterAll(async () => {
    await prisma.knowledgeDoc.deleteMany({ where: { workspaceId } });
    await closeTestApp(app);
  });

  // Every branch of the CASE, because each names a different configuration and
  // any one of them missing breaks the whole statement for every language.
  it.each(['tr', 'en', 'ru', 'xx'])(
    'resolves the text-search configuration for language %s',
    async (language) => {
      await expect(
        knowledge.search(workspaceId, `merhaba fiyat ${language}`),
      ).resolves.toBeDefined();
    },
  );

  it('returns an empty list rather than throwing when the workspace has no docs', async () => {
    // The live workspace's knowledge base is empty, which is exactly the state
    // the AI reply path hits on every message.
    await expect(knowledge.search(workspaceId, 'fiyat listesi')).resolves.toEqual([]);
  });

  it('finds a Turkish document and returns a snippet', async () => {
    await prisma.knowledgeDoc.create({
      data: {
        workspaceId,
        title: 'Fiyat listesi',
        content:
          'HummyTummy çekirdeği ücretsizdir. Ek şube modülü yıllık 3990 TL, ' +
          'Yemeksepeti entegrasyonu yıllık 2490 TL.',
        language: 'tr',
        status: 'ACTIVE',
      } as never,
    });

    const hits = await knowledge.search(workspaceId, 'ek şube fiyat');

    // Proves the trigger built a tsvector with the Turkish config AND that the
    // query side resolves the same one — the two halves have to agree.
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].title).toBe('Fiyat listesi');
  });

  it('does not return another workspace document', async () => {
    const otherWorkspaceId = randomUUID();
    await prisma.knowledgeDoc.create({
      data: {
        workspaceId: otherWorkspaceId,
        title: 'Baska workspace',
        content: 'ek şube fiyat bilgisi',
        language: 'tr',
        status: 'ACTIVE',
      } as never,
    });

    const hits = await knowledge.search(workspaceId, 'ek şube fiyat');

    expect(hits.map((h) => h.title)).not.toContain('Baska workspace');
    await prisma.knowledgeDoc.deleteMany({ where: { workspaceId: otherWorkspaceId } });
  });
});
