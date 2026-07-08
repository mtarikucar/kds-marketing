import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { FeatureGuard, RequiresFeature } from '../guards/feature.guard';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { SalesCallService } from '../services/sales-call.service';
import { StartCallDto } from '../dto/start-call.dto';
import { LogCallDto } from '../dto/log-call.dto';
import { SalesCallFilterDto } from '../dto/sales-call-filter.dto';
import { MarketingUserPayload } from '../types';
import { PrismaService } from '../../../prisma/prisma.service';
import { CallAnalysisService } from '../voice-ai/call-analysis.service';

/**
 * Sales-call log over the single company Netgsm line (Phase 2). Click-to-dial:
 * `POST start` reserves the line + returns a tel: URI the rep's softphone dials;
 * `POST :id/log` records the outcome. All routes are marketing-authenticated.
 */
@MarketingRoute()
@RequiresFeature('telephony')
@Controller('marketing/calls')
@UseGuards(MarketingGuard, MarketingRolesGuard, FeatureGuard, PermissionsGuard)
export class SalesCallController {
  constructor(
    private readonly calls: SalesCallService,
    private readonly prisma: PrismaService,
    private readonly callAnalysis: CallAnalysisService,
  ) {}

  @Post('start')
  @RequirePermission('leads.write')
  start(
    @Body() dto: StartCallDto,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.calls.startCall(user.workspaceId, user.id, dto);
  }

  @Post(':id/log')
  @RequirePermission('leads.write')
  log(
    @Param('id') id: string,
    @Body() dto: LogCallDto,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.calls.logCall(user.workspaceId, id, user.id, dto);
  }

  @Get()
  list(
    @Query() filter: SalesCallFilterDto,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.calls.list(user.workspaceId, filter, user);
  }

  @Get(':id')
  get(
    @Param('id') id: string,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.calls.get(user.workspaceId, id, user);
  }

  /**
   * The call's recording URL, if one has been retrieved (Epic 13 call-recording —
   * populated from the NetGSM CDR/webhook recording fields, Phase 3/4).
   * Reuses the rep-scoped get, so a REP only sees their own calls' recordings.
   */
  @Get(':id/recording')
  async recording(
    @Param('id') id: string,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    const call = (await this.calls.get(user.workspaceId, id, user)) as { recordingUrl?: string | null };
    return { recordingUrl: call?.recordingUrl ?? null };
  }

  /**
   * Voice-AI Phase 1 — the post-call analysis for this call, or `{status:'NONE'}`
   * when none exists yet. Ownership is enforced by the rep-scoped `get` (a REP
   * only reads their own calls' analyses); the analysis row is keyed by salesCallId.
   */
  @Get(':id/analysis')
  async analysis(
    @Param('id') id: string,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    await this.calls.get(user.workspaceId, id, user);
    const row = await this.prisma.callAnalysis.findUnique({ where: { salesCallId: id } });
    return row ?? { status: 'NONE' };
  }

  /**
   * Manually trigger post-call analysis for this call (diagnostic / on-demand).
   * Manager-tier — runs the same pipeline the cron sweep uses; SKIPPED if already
   * analyzed, FAILED if the recording can't be transcribed.
   */
  @Post(':id/analysis/run')
  @RequirePermission('settings.manage')
  async runAnalysis(
    @Param('id') id: string,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    await this.calls.get(user.workspaceId, id, user);
    return this.callAnalysis.analyzeSalesCall(id);
  }
}
