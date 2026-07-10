import { Body, Controller, Post, UseGuards, UseInterceptors, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { FeatureGuard, RequiresFeature } from '../guards/feature.guard';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { FaxSendService, UploadedPdfFile } from '../campaigns/fax-send.service';

class SendFaxDto {
  @IsString() @MinLength(3) @MaxLength(32) to: string;
  @IsOptional() @IsString() @MaxLength(50) header?: string;
}

/**
 * NetGSM Phase 6 Task 1 — the send-fax action surfaced from a lead/
 * conversation view. One multipart endpoint: a PDF document + recipient fax
 * number (+ optional cover header) → `FaxSendService` (magic-byte + size
 * guard, BEFORE NetGSM is ever called) → `FaxClient.send`.
 *
 * Gated on the `fax` feature specifically (a paid OPERATOR-plan/add-on
 * capability, see `FEATURE_KEYS`'s `fax` docstring in entitlements.service.ts)
 * and the `leads.write` permission — the SAME permission
 * `MarketingConversationsController` uses for its own single-target "send"
 * actions (`reply`/`assign`/`close`) and `AutocallDialerController` uses for
 * `start`/`stop`, since this is a per-lead/-conversation send, not a bulk
 * campaign blast (which is gated `campaigns.send` instead, see
 * `MarketingCampaignsController`). No `@MarketingRoles(...)` restriction —
 * any authenticated rep working a lead can fax from it, mirroring
 * `MarketingConversationsController`'s own unrestricted-role REST guards.
 */
@MarketingRoute()
@Controller('marketing/fax')
@UseGuards(MarketingGuard, MarketingRolesGuard, FeatureGuard, PermissionsGuard)
@RequiresFeature('fax')
export class FaxController {
  constructor(private readonly faxSend: FaxSendService) {}

  @Post('send')
  @RequirePermission('leads.write')
  @UseInterceptors(FileInterceptor('file'))
  send(
    @UploadedFile() file: UploadedPdfFile,
    @Body() dto: SendFaxDto,
    @CurrentMarketingUser() a: MarketingUserPayload,
  ) {
    return this.faxSend.send(a.workspaceId, file, { to: dto.to, header: dto.header });
  }
}
