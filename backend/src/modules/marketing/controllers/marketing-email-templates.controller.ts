import {
  Controller, Get, Post, Patch, Delete, Body, Param, UseGuards,
} from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { FeatureGuard, RequiresFeature } from '../guards/feature.guard';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { EmailTemplatesService } from '../email-templates/email-templates.service';
import { CreateEmailTemplateDto, UpdateEmailTemplateDto } from '../dto/email-template.dto';

/**
 * Reusable HTML email templates (GHL parity). MANAGER+ behind the `campaigns`
 * feature: campaigns.read to view, campaigns.send to author (the same people who
 * compose + send campaigns). CRUD is workspace-scoped in the service.
 */
@MarketingRoute()
@Controller('marketing/email-templates')
@UseGuards(MarketingGuard, MarketingRolesGuard, FeatureGuard, PermissionsGuard)
@MarketingRoles('MANAGER')
@RequiresFeature('campaigns')
export class MarketingEmailTemplatesController {
  constructor(private readonly templates: EmailTemplatesService) {}

  @Get()
  @RequirePermission('campaigns.read')
  list(@CurrentMarketingUser() a: MarketingUserPayload) {
    return this.templates.list(a.workspaceId);
  }

  @Get(':id')
  @RequirePermission('campaigns.read')
  get(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.templates.get(a.workspaceId, id);
  }

  @Post()
  @RequirePermission('campaigns.send')
  create(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: CreateEmailTemplateDto) {
    return this.templates.create(a.workspaceId, dto);
  }

  @Patch(':id')
  @RequirePermission('campaigns.send')
  update(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string, @Body() dto: UpdateEmailTemplateDto) {
    return this.templates.update(a.workspaceId, id, dto);
  }

  @Delete(':id')
  @RequirePermission('campaigns.send')
  remove(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.templates.remove(a.workspaceId, id);
  }
}
