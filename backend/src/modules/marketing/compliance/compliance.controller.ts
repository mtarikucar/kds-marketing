import {
  Body,
  Controller,
  Get,
  Ip,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { Audit } from '../../audit/audit.decorator';
import { ComplianceService } from './compliance.service';

class RecordConsentDto {
  @IsIn(['MARKETING_EMAIL', 'MARKETING_SMS', 'MARKETING_WHATSAPP', 'DATA_PROCESSING'])
  type: string;

  @IsBoolean()
  granted: boolean;

  @IsOptional() @IsString() @MaxLength(120)
  source?: string;
}

@MarketingRoute()
@Controller('marketing/compliance')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
@MarketingRoles('MANAGER')
export class ComplianceController {
  constructor(private readonly svc: ComplianceService) {}

  @Get('requests')
  requests(@CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.listRequests(u.workspaceId);
  }

  @Get('leads/:leadId/consent')
  consents(@Param('leadId') leadId: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.getConsents(u.workspaceId, leadId);
  }

  @Post('leads/:leadId/consent')
  @Audit({ action: 'compliance.consent.record', resourceType: 'lead', resourceIdParam: 'leadId', captureBody: ['type', 'granted'] })
  @RequirePermission('settings.manage')
  record(
    @Param('leadId') leadId: string,
    @Body() dto: RecordConsentDto,
    @Ip() ip: string,
    @CurrentMarketingUser() u: MarketingUserPayload,
  ) {
    return this.svc.recordConsent(u.workspaceId, leadId, dto.type, dto.granted, { source: dto.source, ipAddress: ip });
  }

  @Post('leads/:leadId/export')
  @Audit({ action: 'compliance.export', resourceType: 'lead', resourceIdParam: 'leadId' })
  @RequirePermission('settings.manage')
  exportData(@Param('leadId') leadId: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.requestExport(u.workspaceId, leadId, u.id);
  }

  @Post('leads/:leadId/erasure')
  @Audit({ action: 'compliance.erasure.request', resourceType: 'lead', resourceIdParam: 'leadId' })
  @RequirePermission('settings.manage')
  erasure(@Param('leadId') leadId: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.requestErasure(u.workspaceId, leadId, u.id);
  }

  /** Phase 2 Task 3 (İYS auto-push) — manager retry: flips this workspace's
   *  DLQ IysSyncJob rows back to PENDING (attempts=0) so the next worker
   *  tick retries them. */
  @Post('iys/retry')
  @Audit({ action: 'compliance.iys.retry', resourceType: 'workspace' })
  @RequirePermission('settings.manage')
  retryIys(@CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.retryIys(u.workspaceId);
  }

  /** Phase 2 Task 6 — read-only count of DLQ İYS auto-push jobs, so the SMS
   *  channel card knows whether to show the warning badge + retry action.
   *  Guarded the same as `iys/retry` (MANAGER + settings.manage) since it's
   *  the same DLQ this workspace's manager can already act on. */
  @Get('iys/dlq-count')
  @RequirePermission('settings.manage')
  iysDlqCount(@CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.iysDlqCount(u.workspaceId);
  }
}
