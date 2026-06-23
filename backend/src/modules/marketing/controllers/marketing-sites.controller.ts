import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards } from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { FeatureGuard, RequiresFeature } from '../guards/feature.guard';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { SitesService } from '../sites/sites.service';
import { CreateSitePageDto, UpdateSitePageDto, DraftSiteDto, CreateFormDto, UpdateFormDto, FromTemplateDto } from '../dto/site.dto';

/**
 * Funnel pages + forms. MANAGER+ behind the `funnels` feature. Literal routes
 * (draft, forms) are declared before the `:id` routes so they win.
 */
@MarketingRoute()
@Controller('marketing/sites')
@UseGuards(MarketingGuard, MarketingRolesGuard, FeatureGuard, PermissionsGuard)
@MarketingRoles('MANAGER')
@RequiresFeature('funnels')
export class MarketingSitesController {
  constructor(private readonly sites: SitesService) {}

  @Get()
  list(@CurrentMarketingUser() a: MarketingUserPayload) { return this.sites.list(a.workspaceId); }

  @Post()
  @RequirePermission('settings.manage')
  create(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: CreateSitePageDto) { return this.sites.create(a.workspaceId, dto); }

  @Post('draft')
  @RequirePermission('settings.manage')
  draft(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: DraftSiteDto) { return this.sites.draft(a.workspaceId, dto.prompt); }

  @Get('templates')
  templates() { return this.sites.listTemplates(); }

  @Post('from-template')
  @RequirePermission('settings.manage')
  fromTemplate(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: FromTemplateDto) {
    return this.sites.createFromTemplate(a.workspaceId, dto.templateId);
  }

  @Get('forms')
  listForms(@CurrentMarketingUser() a: MarketingUserPayload) { return this.sites.listForms(a.workspaceId); }

  @Post('forms')
  @RequirePermission('settings.manage')
  createForm(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: CreateFormDto) { return this.sites.createForm(a.workspaceId, dto); }

  @Patch('forms/:id')
  @RequirePermission('settings.manage')
  updateForm(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string, @Body() dto: UpdateFormDto) { return this.sites.updateForm(a.workspaceId, id, dto); }

  @Delete('forms/:id')
  @RequirePermission('settings.manage')
  removeForm(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) { return this.sites.removeForm(a.workspaceId, id); }

  @Get(':id')
  get(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) { return this.sites.get(a.workspaceId, id); }

  @Patch(':id')
  @RequirePermission('settings.manage')
  update(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string, @Body() dto: UpdateSitePageDto) { return this.sites.update(a.workspaceId, id, dto); }

  @Post(':id/publish')
  @RequirePermission('settings.manage')
  publish(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string, @Body() dto: { published?: boolean }) {
    return this.sites.setPublished(a.workspaceId, id, dto.published !== false);
  }

  @Delete(':id')
  @RequirePermission('settings.manage')
  remove(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) { return this.sites.remove(a.workspaceId, id); }
}
