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
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { CompaniesService } from '../companies/companies.service';
import { CreateCompanyDto, UpdateCompanyDto } from '../dto/company.dto';

/**
 * Companies / B2B accounts (GoHighLevel parity). Reads require contacts.read,
 * writes contacts.write — the same permissions as the contacts they group.
 * Auth + workspace context come from MarketingGuard.
 */
@Controller('marketing/companies')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
@MarketingRoute()
export class MarketingCompaniesController {
  constructor(private readonly companies: CompaniesService) {}

  @Get()
  @RequirePermission('contacts.read')
  list(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Query('search') search?: string,
    @Query('includeArchived') includeArchived?: string,
  ) {
    return this.companies.list(a.workspaceId, { search, includeArchived: includeArchived === 'true' });
  }

  @Get(':id')
  @RequirePermission('contacts.read')
  get(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.companies.get(a.workspaceId, id);
  }

  @Get(':id/contacts')
  @RequirePermission('contacts.read')
  contacts(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.companies.listContacts(a.workspaceId, id);
  }

  @Post()
  @RequirePermission('contacts.write')
  create(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: CreateCompanyDto) {
    return this.companies.create(a.workspaceId, dto);
  }

  @Patch(':id')
  @RequirePermission('contacts.write')
  update(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: UpdateCompanyDto,
  ) {
    return this.companies.update(a.workspaceId, id, dto);
  }

  @Delete(':id')
  @RequirePermission('contacts.write')
  remove(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.companies.remove(a.workspaceId, id);
  }
}
