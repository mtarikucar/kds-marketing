import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IngestTokenGuard } from '../guards/ingest-token.guard';
import { IngestLeadsDto } from '../dto/ingest-leads.dto';
import { MarketingLeadsIngestService } from '../services/marketing-leads-ingest.service';
import { MarketingRoute } from '../decorators/marketing-public.decorator';

/**
 * Separate controller class — not folded into MarketingLeadsController —
 * so this route bypasses MarketingGuard (JWT) entirely. Callers (the
 * research routine via the internal API, or a customer's own integration)
 * authenticate with a per-workspace x-ingest-token; IngestTokenGuard
 * hashes it, resolves the owning workspace and attaches it to the request.
 *
 * `@MarketingRoute()` skips the global JwtAuthGuard / TenantGuard /
 * RolesGuard pipeline (which would otherwise 401 before the token check
 * even runs). Mirrors every other controller in this module.
 */
@Controller('marketing/leads')
@MarketingRoute()
@UseGuards(IngestTokenGuard)
@Throttle({ long: { limit: 6, ttl: 60_000 } })
export class MarketingLeadsIngestController {
  constructor(private readonly svc: MarketingLeadsIngestService) {}

  @Post('ingest')
  @HttpCode(200)
  async ingest(@Req() req: { ingestWorkspaceId?: string }, @Body() dto: IngestLeadsDto) {
    const workspaceId = req.ingestWorkspaceId;
    if (!workspaceId) {
      // Guard always sets it; belt-and-suspenders against a future
      // guard-ordering regression silently writing into nowhere.
      throw new UnauthorizedException('Invalid ingest token');
    }
    return this.svc.ingest(workspaceId, dto);
  }
}
