import {
  Body,
  Controller,
  HttpCode,
  Post,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IngestTokenGuard } from '../guards/ingest-token.guard';
import { IngestLeadsDto } from '../dto/ingest-leads.dto';
import { MarketingLeadsIngestService } from '../services/marketing-leads-ingest.service';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { PrismaService } from '../../../prisma/prisma.service';
import { findCoreIntegratedWorkspaceId } from '../services/core-workspace.helper';

/**
 * Separate controller class — not folded into MarketingLeadsController —
 * so this route bypasses MarketingGuard (JWT) entirely. The daily AI
 * research routine authenticates with a static x-ingest-token header
 * checked by IngestTokenGuard.
 *
 * `@MarketingRoute()` skips the global JwtAuthGuard / TenantGuard /
 * RolesGuard pipeline (which would otherwise 401 before the static
 * token check even runs). Mirrors every other controller in this
 * module.
 *
 * Workspace resolution: the static token carries no workspace claim
 * (that lands with the per-workspace tokens in Phase E), so until then
 * the batch is filed under the single core-integrated workspace —
 * resolved per request so a config change needs no restart. Without
 * one there is nowhere safe to write, so the request is rejected.
 */
@Controller('marketing/leads')
@MarketingRoute()
@UseGuards(IngestTokenGuard)
@Throttle({ long: { limit: 6, ttl: 60_000 } })
export class MarketingLeadsIngestController {
  constructor(
    private readonly svc: MarketingLeadsIngestService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('ingest')
  @HttpCode(200)
  async ingest(@Body() dto: IngestLeadsDto) {
    const workspaceId = await findCoreIntegratedWorkspaceId(this.prisma);
    if (!workspaceId) {
      throw new ServiceUnavailableException('no core-integrated workspace');
    }
    return this.svc.ingest(workspaceId, dto);
  }
}
