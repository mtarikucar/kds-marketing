import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';

/** Raw portal tokens look like `aff_<48 hex>`; only their sha256 is stored. */
export const AFFILIATE_TOKEN_PREFIX = 'aff_';

export function hashAffiliateToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/** The affiliate resolved by the portal guard, attached to the request. */
export interface PortalAffiliate {
  id: string;
  workspaceId: string;
}

/**
 * Bearer-token guard for the public affiliate portal (Epic 11a). The presented
 * token (Authorization: Bearer <token> or x-affiliate-token) is hashed and
 * looked up in `affiliates.portalTokenHash` — the comparison happens inside the
 * unique index, so there's no in-process secret and nothing timing-sensitive (an
 * attacker would have to predict a 192-bit random value to hit a row). Mirrors
 * IngestTokenGuard. Only an ACTIVE affiliate may sign in.
 */
@Injectable()
export class AffiliatePortalGuard implements CanActivate {
  private readonly logger = new Logger(AffiliatePortalGuard.name);

  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const raw = this.extractToken(req);
    if (!raw) throw new UnauthorizedException('Missing affiliate token');

    const affiliate = await this.prisma.affiliate.findUnique({
      where: { portalTokenHash: hashAffiliateToken(raw) },
      select: { id: true, workspaceId: true, status: true },
    });
    if (!affiliate || affiliate.status !== 'ACTIVE') {
      throw new UnauthorizedException('Invalid affiliate token');
    }

    req.affiliate = { id: affiliate.id, workspaceId: affiliate.workspaceId } as PortalAffiliate;

    this.prisma.affiliate
      .update({ where: { id: affiliate.id }, data: { lastLoginAt: new Date() } })
      .catch((e) => this.logger.warn(`lastLoginAt update failed: ${e?.message ?? e}`));

    return true;
  }

  private extractToken(req: any): string | null {
    const header = req.headers?.['x-affiliate-token'];
    if (typeof header === 'string' && header.length > 0) return header;
    const auth = req.headers?.authorization;
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim() || null;
    return null;
  }
}
