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
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { SalesCallService } from '../services/sales-call.service';
import { StartCallDto } from '../dto/start-call.dto';
import { LogCallDto } from '../dto/log-call.dto';
import { SalesCallFilterDto } from '../dto/sales-call-filter.dto';
import { MarketingUserPayload } from '../types';

/**
 * Sales-call log over the single company Netgsm line (Phase 2). Click-to-dial:
 * `POST start` reserves the line + returns a tel: URI the rep's softphone dials;
 * `POST :id/log` records the outcome. All routes are marketing-authenticated.
 */
@MarketingRoute()
@Controller('marketing/calls')
@UseGuards(MarketingGuard, MarketingRolesGuard)
export class SalesCallController {
  constructor(private readonly calls: SalesCallService) {}

  @Post('start')
  start(
    @Body() dto: StartCallDto,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.calls.startCall(user.workspaceId, user.id, dto);
  }

  @Post(':id/log')
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
}
