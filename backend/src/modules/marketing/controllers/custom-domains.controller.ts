import { Controller, Get, Post, Delete, Body, Param, UseGuards } from '@nestjs/common';
import { IsString, IsNotEmpty, IsOptional, MaxLength } from 'class-validator';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { CustomDomainsService } from '../custom-domains/custom-domains.service';

class RegisterCustomDomainDto {
  @IsString() @IsNotEmpty() @MaxLength(253) hostname: string;
  @IsOptional() @IsString() @MaxLength(120) homeSlug?: string;
}

/**
 * Custom domains — MANAGER+ white-labels a workspace's public site onto its own
 * hostname. Inert until CUSTOM_DOMAINS_ENABLED (register returns 503).
 */
@MarketingRoute()
@Controller('marketing/custom-domains')
@UseGuards(MarketingGuard, MarketingRolesGuard)
@MarketingRoles('MANAGER')
export class CustomDomainsController {
  constructor(private readonly domains: CustomDomainsService) {}

  @Get()
  list(@CurrentMarketingUser() a: MarketingUserPayload) {
    return this.domains.list(a.workspaceId);
  }

  @Post()
  register(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: RegisterCustomDomainDto) {
    return this.domains.request(a.workspaceId, dto);
  }

  @Get(':id')
  get(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.domains.get(a.workspaceId, id);
  }

  @Post(':id/verify')
  verify(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.domains.verifyNow(a.workspaceId, id);
  }

  @Delete(':id')
  remove(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.domains.remove(a.workspaceId, id);
  }
}
