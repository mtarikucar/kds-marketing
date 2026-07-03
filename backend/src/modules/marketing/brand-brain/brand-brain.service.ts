import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { cosineSimilarity } from './cosine.util';

export interface ChunkInput {
  content: string;
  embedding?: number[];
  ord?: number;
  tokens?: number;
}

/** A grounded citation back to a source doc — the NotebookLM-style contract. */
export interface Citation {
  chunkId: string;
  docId: string;
  docTitle: string;
  snippet: string;
  score: number;
}

export interface SearchOptions {
  queryEmbedding?: number[];
  queryText?: string;
  k?: number;
  /** How many chunks to pull before re-ranking. */
  candidateLimit?: number;
}

const SNIPPET_LEN = 280;

/**
 * Brand Brain retrieval (Faz 1) — a source-grounded, CITED knowledge layer over
 * a workspace's docs. Hybrid: a full-text/keyword prefilter narrows candidate
 * chunks, then (when a query embedding is available) cosine similarity re-ranks
 * them semantically. Every hit carries a citation back to its source doc, so an
 * AI answer built on this can show "why". Extension-free (embeddings are plain
 * float arrays); pgvector is the scale-up path with no API change.
 */
@Injectable()
export class BrandBrainService {
  constructor(private readonly prisma: PrismaService) {}

  /** Store pre-computed chunks for a doc (embeddings filled by the caller). */
  async ingestChunks(workspaceId: string, docId: string, chunks: ChunkInput[]): Promise<number> {
    if (chunks.length === 0) return 0;
    const rows = chunks.map((c, i) => ({
      workspaceId,
      docId,
      ord: c.ord ?? i,
      content: c.content,
      embedding: c.embedding ?? [],
      tokens: c.tokens ?? null,
    }));
    const res = await this.prisma.knowledgeChunk.createMany({ data: rows });
    return res.count;
  }

  /**
   * Retrieve the top-k grounded citations for a query. `queryText` prefilters
   * (keyword), `queryEmbedding` re-ranks (semantic). At least one should be
   * provided; with neither, returns the most recent chunks.
   */
  async search(workspaceId: string, opts: SearchOptions): Promise<Citation[]> {
    const k = clampInt(opts.k ?? 5, 1, 50);
    const candidateLimit = clampInt(opts.candidateLimit ?? 60, k, 300);

    const where: Prisma.KnowledgeChunkWhereInput = {
      workspaceId,
      doc: { status: 'ACTIVE' },
    };
    if (opts.queryText && opts.queryText.trim()) {
      where.content = { contains: opts.queryText.trim().slice(0, 200), mode: 'insensitive' };
    }

    const candidates = await this.prisma.knowledgeChunk.findMany({
      where,
      take: candidateLimit,
      orderBy: { createdAt: 'desc' },
      include: { doc: { select: { title: true } } },
    });

    const ranked = candidates
      .map((c) => ({
        c,
        score: opts.queryEmbedding ? cosineSimilarity(opts.queryEmbedding, c.embedding ?? []) : 0,
      }))
      // With an embedding, sort by similarity; without, keep recency order.
      .sort((a, b) => b.score - a.score)
      .slice(0, k);

    return ranked.map(({ c, score }) => ({
      chunkId: c.id,
      docId: c.docId,
      docTitle: c.doc?.title ?? '',
      snippet: c.content.slice(0, SNIPPET_LEN),
      score: Math.round(score * 1e4) / 1e4,
    }));
  }
}

function clampInt(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}
