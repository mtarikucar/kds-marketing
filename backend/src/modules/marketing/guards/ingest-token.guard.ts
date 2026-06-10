import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';

/** Raw tokens look like `mkt_live_<48 hex>`; only their sha256 is stored. */
export const INGEST_TOKEN_PREFIX = 'mkt_live_';

export function hashIngestToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * Per-workspace bearer-token guard for the lead ingest endpoint. The
 * presented token is hashed and looked up in `ingest_tokens` — the hash
 * comparison happens inside the unique index, so there is no in-process
 * secret to compare (and nothing timing-sensitive: the attacker would have
 * to predict a 192-bit random value to even hit a row).
 *
 * Replaces the global MARKETING_INGEST_TOKEN env: tokens are minted per
 * workspace, shown once, revocable, and carry the workspace context the
 * multi-tenant ingest path needs.
 */
@Injectable()
export class IngestTokenGuard implements CanActivate {
  private readonly logger = new Logger(IngestTokenGuard.name);

  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const header = request.headers['x-ingest-token'];
    if (!header || typeof header !== 'string') {
      throw new UnauthorizedException('Missing ingest token');
    }

    const token = await this.prisma.ingestToken.findUnique({
      where: { tokenHash: hashIngestToken(header) },
      select: { id: true, workspaceId: true, status: true },
    });

    if (!token || token.status !== 'ACTIVE') {
      throw new UnauthorizedException('Invalid ingest token');
    }

    // Attach the workspace context for the controller/service.
    request.ingestWorkspaceId = token.workspaceId;

    // Telemetry, not authorization: don't fail the request over it.
    this.prisma.ingestToken
      .update({ where: { id: token.id }, data: { lastUsedAt: new Date() } })
      .catch((e) =>
        this.logger.warn(`lastUsedAt update failed: ${e?.message ?? e}`),
      );

    return true;
  }
}
