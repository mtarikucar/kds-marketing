import {
  Body,
  Controller,
  Get,
  Inject,
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
import { IYS_EMAIL_PORT, IysEmailPort } from './iys-email.port';

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
  constructor(
    private readonly svc: ComplianceService,
    @Inject(IYS_EMAIL_PORT) private readonly iysEmail: IysEmailPort,
  ) {}

  /** The workspace-wide data-request history. Gated like every other handler
   *  here (`iys/dlq-count` is the precedent): it is a bulk read of who asked to
   *  be exported or erased, so it belongs to whoever may run those requests —
   *  the same person who can press Export and Erase two handlers down. */
  @Get('requests')
  @RequirePermission('settings.manage')
  requests(@CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.listRequests(u.workspaceId);
  }

  /** Deliberately NOT `settings.manage`, unlike its neighbours: this one is a
   *  single lead's consent state, and the inbox reads it for the person on
   *  screen (pages/marketing/inbox/PersonConsents.tsx, gated on MANAGER
   *  alone). Adding the permission here would blank that panel for a manager
   *  whose custom role omits it, which is a working surface lost for a read
   *  that discloses one contact's own opt-in state. */
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

  /** Approve + execute a PENDING erasure request (KVKK/GDPR right to erasure):
   *  anonymises the lead's PII, deletes its communication/behavioural data, and
   *  keeps legally-retained financial records against the anonymised contact. */
  @Post('requests/:id/fulfill')
  @Audit({ action: 'compliance.erasure.fulfill', resourceType: 'dataRequest', resourceIdParam: 'id' })
  @RequirePermission('settings.manage')
  fulfillErasure(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.fulfillErasure(u.workspaceId, id, u.id);
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

  /**
   * Whether commercial (TİCARİ) EMAIL is armed for this workspace, and what is
   * missing if it is not.
   *
   * The gate itself is silent by design — an unarmed workspace's mail goes out
   * exactly as before — so without a read like this nothing can tell the
   * operator why the campaign composer still refuses to mark a mail TİCARİ.
   * `gap` is a machine code; the surface renders `messageKey`, never the code
   * (G8). Asks İYS nothing, so it is cheap enough for a settings card.
   */
  @Get('iys/eposta/readiness')
  @RequirePermission('settings.manage')
  iysEpostaReadiness(@CurrentMarketingUser() u: MarketingUserPayload) {
    return this.iysEmail.readiness(u.workspaceId);
  }
}
