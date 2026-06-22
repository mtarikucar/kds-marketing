import { Controller, Get, Post, Delete, Body, Param, UseGuards } from '@nestjs/common';
import { IsString, IsNotEmpty, IsOptional, MaxLength } from 'class-validator';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { SendingDomainsService } from '../sending-domains/sending-domains.service';

class RegisterDomainDto {
  @IsString() @IsNotEmpty() @MaxLength(253) domain: string;
  @IsOptional() @IsString() @MaxLength(120) fromName?: string;
}

/**
 * Custom sending domains — MANAGER+ configures a workspace's own email domain.
 * Inert until SENDING_DOMAIN_ESP is set (register returns 503).
 */
@MarketingRoute()
@Controller('marketing/sending-domains')
@UseGuards(MarketingGuard, MarketingRolesGuard)
@MarketingRoles('MANAGER')
export class SendingDomainsController {
  constructor(private readonly domains: SendingDomainsService) {}

  @Get()
  list(@CurrentMarketingUser() a: MarketingUserPayload) {
    return this.domains.list(a.workspaceId);
  }

  @Post()
  register(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: RegisterDomainDto) {
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
