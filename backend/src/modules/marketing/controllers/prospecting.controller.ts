import { Controller, Get, Post, Body, Param, UseGuards } from '@nestjs/common';
import { IsString, IsNotEmpty, IsOptional, MaxLength } from 'class-validator';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { AuditService } from '../prospecting/audit.service';

class RequestAuditDto {
  @IsString() @IsNotEmpty() @MaxLength(2048) targetUrl: string;
  @IsOptional() @IsString() @MaxLength(255) businessName?: string;
}

/**
 * Prospecting audit — any authenticated workspace user can audit a prospect's
 * site and convert it to a lead. Inert until PAGESPEED_API_KEY is set (request()
 * returns 503), so this surface is dormant by default.
 */
@MarketingRoute()
@Controller('marketing/prospecting')
@UseGuards(MarketingGuard)
export class ProspectingController {
  constructor(private readonly audits: AuditService) {}

  @Get('audits')
  list(@CurrentMarketingUser() a: MarketingUserPayload) {
    return this.audits.list(a.workspaceId);
  }

  @Post('audits')
  request(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: RequestAuditDto) {
    return this.audits.request(a.workspaceId, dto);
  }

  @Get('audits/:id')
  get(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.audits.get(a.workspaceId, id);
  }

  @Post('audits/:id/convert')
  convert(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.audits.convertToLead(a.workspaceId, id, a.id, a.role);
  }
}
