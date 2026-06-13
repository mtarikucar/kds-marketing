import {
  Controller,
  Get,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsNumber, Min } from 'class-validator';

class UpdateCommissionAmountDto {
  @IsNumber()
  @Min(0)
  amount: number;
}
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { FeatureGuard, RequiresFeature } from '../guards/feature.guard';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { MarketingCommissionsService } from '../services/marketing-commissions.service';
import { CommissionFilterDto } from '../dto/commission-filter.dto';
import { MarketingUserPayload } from '../types';
import { Audit } from '../../audit/audit.decorator';

@RequiresFeature('commissions')
@Controller('marketing/commissions')
@UseGuards(MarketingGuard, MarketingRolesGuard, FeatureGuard)
@MarketingRoute()
export class MarketingCommissionsController {
  constructor(
    private readonly commissionsService: MarketingCommissionsService,
  ) {}

  @Get()
  findAll(
    @Query() filter: CommissionFilterDto,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.commissionsService.findAll(user.workspaceId, filter, user.id, user.role);
  }

  @Get('summary')
  getSummary(
    @CurrentMarketingUser() user: MarketingUserPayload,
    @Query('period') period?: string,
  ) {
    return this.commissionsService.getSummary(user.workspaceId, user.id, user.role, period);
  }

  @Patch(':id')
  @MarketingRoles('MANAGER')
  updateAmount(
    @Param('id') id: string,
    @Body() dto: UpdateCommissionAmountDto,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.commissionsService.updateAmount(user.workspaceId, id, dto.amount, user.id);
  }

  @Patch(':id/approve')
  @MarketingRoles('MANAGER')
  @Audit({
    action: 'commission.approve',
    resourceType: 'commission',
    resourceIdParam: 'id',
  })
  approve(@Param('id') id: string, @CurrentMarketingUser() user: MarketingUserPayload) {
    return this.commissionsService.approve(user.workspaceId, id, user.id);
  }

  @Patch(':id/pay')
  @MarketingRoles('MANAGER')
  @Audit({
    action: 'commission.pay',
    resourceType: 'commission',
    resourceIdParam: 'id',
  })
  markPaid(@Param('id') id: string, @CurrentMarketingUser() user: MarketingUserPayload) {
    return this.commissionsService.markPaid(user.workspaceId, id, user.id);
  }
}
