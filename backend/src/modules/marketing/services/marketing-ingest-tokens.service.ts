import { Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  hashIngestToken,
  INGEST_TOKEN_PREFIX,
} from '../guards/ingest-token.guard';

/**
 * Mint/list/revoke per-workspace ingest tokens. The raw token is returned
 * exactly once (at mint) and never stored — only its sha256 lands in the DB.
 */
@Injectable()
export class MarketingIngestTokensService {
  constructor(private readonly prisma: PrismaService) {}

  async mint(workspaceId: string, label: string) {
    const raw = `${INGEST_TOKEN_PREFIX}${randomBytes(24).toString('hex')}`;
    const token = await this.prisma.ingestToken.create({
      data: {
        workspaceId,
        tokenHash: hashIngestToken(raw),
        tokenPrefix: raw.slice(0, INGEST_TOKEN_PREFIX.length + 8),
        label,
      },
      select: { id: true, tokenPrefix: true, label: true, createdAt: true },
    });
    // `token` is the ONLY copy of the secret the caller will ever see.
    return { ...token, token: raw };
  }

  async list(workspaceId: string) {
    return this.prisma.ingestToken.findMany({
      where: { workspaceId },
      select: {
        id: true,
        tokenPrefix: true,
        label: true,
        status: true,
        lastUsedAt: true,
        createdAt: true,
        revokedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async revoke(workspaceId: string, id: string) {
    const result = await this.prisma.ingestToken.updateMany({
      where: { id, workspaceId, status: 'ACTIVE' },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
    if (result.count === 0) {
      throw new NotFoundException('Token not found');
    }
    return { message: 'Token revoked' };
  }
}
