import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  IsEmail,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { FeatureGuard, RequiresFeature } from '../guards/feature.guard';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { MarketingUserPayload } from '../types';
import { Audit } from '../../audit/audit.decorator';
import { AffiliateService } from '../services/affiliate.service';

// ─── DTOs ─────────────────────────────────────────────────────────────────────

class CreateAffiliateDto {
  @IsString()
  name: string;

  @IsEmail()
  email: string;

  @IsString()
  @MaxLength(32)
  code: string;

  @IsIn(['PERCENT', 'FLAT'])
  commissionType: 'PERCENT' | 'FLAT';

  @IsNumber()
  @Min(0)
  commissionValue: number;
}

class UpdateAffiliateDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  code?: string;

  @IsOptional()
  @IsIn(['PERCENT', 'FLAT'])
  commissionType?: 'PERCENT' | 'FLAT';

  @IsOptional()
  @IsNumber()
  @Min(0)
  commissionValue?: number;

  @IsOptional()
  @IsIn(['ACTIVE', 'PAUSED', 'DISABLED'])
  status?: 'ACTIVE' | 'PAUSED' | 'DISABLED';
}

class RecordReferralDto {
  @IsOptional()
  @IsString()
  referredLeadId?: string;
}

class ConvertReferralDto {
  @IsNumber()
  @Min(0)
  conversionValue: number;
}

// ─── Controller ───────────────────────────────────────────────────────────────

@RequiresFeature('commissions')
@Controller('marketing/affiliates')
@UseGuards(MarketingGuard, MarketingRolesGuard, FeatureGuard, PermissionsGuard)
@MarketingRoute()
export class AffiliateController {
  constructor(private readonly affiliateService: AffiliateService) {}

  // ── Affiliates ─────────────────────────────────────────────────────────────

  @Post()
  @MarketingRoles('MANAGER')
  @Audit({ action: 'affiliate.create', resourceType: 'affiliate' })
  @RequirePermission('settings.manage')
  create(
    @Body() dto: CreateAffiliateDto,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.affiliateService.createAffiliate(user.workspaceId, dto);
  }

  @Get()
  list(
    @CurrentMarketingUser() user: MarketingUserPayload,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.affiliateService.listAffiliates(user.workspaceId, {
      status,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  // ── Commissions (literal routes — must appear before /:id) ────────────────

  @Get('commissions')
  listCommissions(
    @CurrentMarketingUser() user: MarketingUserPayload,
    @Query('affiliateId') affiliateId?: string,
    @Query('status') status?: string,
  ) {
    return this.affiliateService.listCommissions(user.workspaceId, affiliateId, status);
  }

  @Patch('commissions/:commissionId/approve')
  @MarketingRoles('MANAGER')
  @Audit({
    action: 'affiliate.commission.approve',
    resourceType: 'affiliateCommission',
    resourceIdParam: 'commissionId',
  })
  @RequirePermission('settings.manage')
  approveCommission(
    @Param('commissionId') commissionId: string,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.affiliateService.approveCommission(user.workspaceId, commissionId);
  }

  @Patch('commissions/:commissionId/pay')
  @MarketingRoles('MANAGER')
  @Audit({
    action: 'affiliate.commission.pay',
    resourceType: 'affiliateCommission',
    resourceIdParam: 'commissionId',
  })
  @RequirePermission('settings.manage')
  payCommission(
    @Param('commissionId') commissionId: string,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.affiliateService.payCommission(user.workspaceId, commissionId);
  }

  // ── Referral convert (literal route — must appear before /:id) ────────────

  @Post('referrals/:referralId/convert')
  @MarketingRoles('MANAGER')
  @Audit({
    action: 'affiliate.referral.convert',
    resourceType: 'affiliateReferral',
    resourceIdParam: 'referralId',
  })
  @RequirePermission('settings.manage')
  convertReferral(
    @Param('referralId') referralId: string,
    @Body() dto: ConvertReferralDto,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.affiliateService.convertReferral(
      user.workspaceId,
      referralId,
      dto.conversionValue,
    );
  }

  // ── Affiliate by id ────────────────────────────────────────────────────────

  @Get(':id')
  getOne(
    @Param('id') id: string,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.affiliateService.getAffiliate(user.workspaceId, id);
  }

  @Patch(':id')
  @MarketingRoles('MANAGER')
  @Audit({
    action: 'affiliate.update',
    resourceType: 'affiliate',
    resourceIdParam: 'id',
  })
  @RequirePermission('settings.manage')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateAffiliateDto,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.affiliateService.updateAffiliate(user.workspaceId, id, dto);
  }

  @Delete(':id')
  @MarketingRoles('MANAGER')
  @Audit({
    action: 'affiliate.delete',
    resourceType: 'affiliate',
    resourceIdParam: 'id',
  })
  @RequirePermission('settings.manage')
  remove(
    @Param('id') id: string,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.affiliateService.deleteAffiliate(user.workspaceId, id);
  }

  // ── Per-affiliate referrals ────────────────────────────────────────────────

  @Post(':id/referrals')
  @MarketingRoles('MANAGER')
  @Audit({
    action: 'affiliate.referral.record',
    resourceType: 'affiliate',
    resourceIdParam: 'id',
  })
  @RequirePermission('settings.manage')
  async recordReferral(
    @Param('id') id: string,
    @Body() dto: RecordReferralDto,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    // Resolve affiliate to get its code, then record referral by code.
    const affiliate = await this.affiliateService.getAffiliate(user.workspaceId, id);
    return this.affiliateService.recordReferral(
      user.workspaceId,
      affiliate.code,
      dto.referredLeadId,
    );
  }

  @Get(':id/referrals')
  listReferrals(
    @Param('id') id: string,
    @CurrentMarketingUser() user: MarketingUserPayload,
    @Query('status') status?: string,
  ) {
    return this.affiliateService.listReferrals(user.workspaceId, id, status);
  }
}
