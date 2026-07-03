import { BrandBrainService } from './brand-brain.service';

function makePrisma(candidates: any[] = []) {
  const createMany = jest.fn().mockResolvedValue({ count: candidates.length });
  const findMany = jest.fn().mockResolvedValue(candidates);
  return { prisma: { knowledgeChunk: { createMany, findMany } } as any, createMany, findMany };
}

const chunk = (id: string, docId: string, title: string, content: string, embedding: number[]) => ({
  id, docId, content, embedding, doc: { title },
});

describe('BrandBrainService', () => {
  it('ingests chunks with ord + default empty embedding', async () => {
    const { prisma, createMany } = makePrisma();
    const svc = new BrandBrainService(prisma);
    const n = await svc.ingestChunks('ws1', 'doc1', [{ content: 'a' }, { content: 'b', embedding: [1, 2] }]);
    expect(n).toBe(0); // createMany count mocked to candidates.length (0)
    const rows = createMany.mock.calls[0][0].data;
    expect(rows[0]).toMatchObject({ workspaceId: 'ws1', docId: 'doc1', ord: 0, content: 'a', embedding: [] });
    expect(rows[1]).toMatchObject({ ord: 1, embedding: [1, 2] });
  });

  it('re-ranks candidates by cosine similarity to the query embedding and returns citations', async () => {
    const { prisma } = makePrisma([
      chunk('c1', 'd1', 'Pricing', 'implant fiyat', [1, 0, 0]), // orthogonal to query
      chunk('c2', 'd2', 'Offer', 'ücretsiz muayene', [0, 1, 0]), // aligned with query
    ]);
    const svc = new BrandBrainService(prisma);
    const hits = await svc.search('ws1', { queryEmbedding: [0, 1, 0], k: 2 });
    expect(hits[0].chunkId).toBe('c2'); // best match first
    expect(hits[0]).toMatchObject({ docId: 'd2', docTitle: 'Offer', snippet: 'ücretsiz muayene' });
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it('applies a keyword prefilter when queryText is given', async () => {
    const { prisma, findMany } = makePrisma([]);
    const svc = new BrandBrainService(prisma);
    await svc.search('ws1', { queryText: 'implant', k: 3 });
    const where = findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ workspaceId: 'ws1', doc: { status: 'ACTIVE' }, content: { contains: 'implant', mode: 'insensitive' } });
  });

  it('caps k and returns recency order when no embedding is provided', async () => {
    const { prisma } = makePrisma([
      chunk('c1', 'd1', 'A', 'first', []),
      chunk('c2', 'd2', 'B', 'second', []),
    ]);
    const svc = new BrandBrainService(prisma);
    const hits = await svc.search('ws1', { k: 1 });
    expect(hits).toHaveLength(1);
    expect(hits[0].chunkId).toBe('c1'); // preserves candidate order (recency)
  });
});
