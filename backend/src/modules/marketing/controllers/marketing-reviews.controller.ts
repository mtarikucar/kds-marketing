import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards } from '@nestjs/common';
import { IsString, IsNotEmpty, IsOptional, MaxLength } from 'class-validator';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { FeatureGuard, RequiresFeature } from '../guards/feature.guard';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { ReviewsService } from '../reviews/reviews.service';

class ReviewSourceDto {
  @IsString() @IsNotEmpty() @MaxLength(120) name: string;
  @IsString() @IsNotEmpty() @MaxLength(1000) placeUrl: string;
  @IsOptional() @IsString() @MaxLength(40) type?: string;
}
class ReviewReplyDto {
  @IsString() @IsNotEmpty() @MaxLength(4000) text: string;
}

/** Reviews / reputation. MANAGER+ behind the `reviews` feature. */
@MarketingRoute()
@Controller('marketing/reviews')
@UseGuards(MarketingGuard, MarketingRolesGuard, FeatureGuard, PermissionsGuard)
@MarketingRoles('MANAGER')
@RequiresFeature('reviews')
export class MarketingReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get('sources')
  listSources(@CurrentMarketingUser() a: MarketingUserPayload) { return this.reviews.listSources(a.workspaceId); }
  @Post('sources')
  @RequirePermission('settings.manage')
  createSource(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: ReviewSourceDto) { return this.reviews.createSource(a.workspaceId, dto); }
  @Patch('sources/:id')
  @RequirePermission('settings.manage')
  updateSource(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string, @Body() dto: ReviewSourceDto) { return this.reviews.updateSource(a.workspaceId, id, dto); }
  @Delete('sources/:id')
  @RequirePermission('settings.manage')
  removeSource(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) { return this.reviews.removeSource(a.workspaceId, id); }

  @Get()
  list(@CurrentMarketingUser() a: MarketingUserPayload) { return this.reviews.list(a.workspaceId); }
  @Post(':id/draft')
  @RequirePermission('settings.manage')
  draft(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) { return this.reviews.draftReply(a.workspaceId, id); }
  @Post(':id/reply')
  @RequirePermission('settings.manage')
  reply(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string, @Body() dto: ReviewReplyDto) { return this.reviews.saveReply(a.workspaceId, id, dto.text); }
}
