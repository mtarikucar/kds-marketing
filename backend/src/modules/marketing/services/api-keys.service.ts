import { Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

export interface ApiAuth {
  apiKeyId: string;
  workspaceId: string;
  scopes: string[];
}

/**
 * Epic B1 — programmatic API keys. The raw key (`mk_live_…`) is generated and
 * returned ONCE on create; only its SHA-256 hash is stored. `authenticate`
 * resolves a raw key back to its workspace + scopes for the public REST API.
 */
@Injectable()
export class ApiKeysService {
  constructor(private prisma: PrismaService) {}

  private hash(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  async create(
    workspaceId: string,
    name: string,
    scopes: string[] = ['read', 'write'],
    createdById?: string,
  ) {
    const raw = `mk_live_${randomBytes(24).toString('base64url')}`;
    const row = await this.prisma.apiKey.create({
      data: {
        workspaceId,
        name,
        keyHash: this.hash(raw),
        prefix: raw.slice(0, 16),
        scopes: scopes as Prisma.InputJsonValue,
        createdById: createdById ?? null,
      },
    });
    // The raw key is returned exactly once here and never persisted.
    return {
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      scopes: row.scopes,
      status: row.status,
      createdAt: row.createdAt,
      key: raw,
    };
  }

  list(workspaceId: string) {
    return this.prisma.apiKey.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        prefix: true,
        scopes: true,
        status: true,
        lastUsedAt: true,
        createdAt: true,
        revokedAt: true,
      },
    });
  }

  async revoke(workspaceId: string, id: string) {
    const row = await this.prisma.apiKey.findFirst({ where: { id, workspaceId } });
    if (!row) throw new NotFoundException('API key not found');
    await this.prisma.apiKey.update({
      where: { id },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
    return { id, status: 'REVOKED' };
  }

  async authenticate(raw: string | null | undefined): Promise<ApiAuth | null> {
    if (!raw || !raw.startsWith('mk_live_')) return null;
    const row = await this.prisma.apiKey.findUnique({
      where: { keyHash: this.hash(raw) },
    });
    if (!row || row.status !== 'ACTIVE') return null;
    // Best-effort usage stamp; never block (or fail) the request on it.
    void Promise.resolve(
      this.prisma.apiKey.update({
        where: { id: row.id },
        data: { lastUsedAt: new Date() },
      }),
    ).catch(() => undefined);
    return {
      apiKeyId: row.id,
      workspaceId: row.workspaceId,
      scopes: (row.scopes as string[]) ?? [],
    };
  }
}
