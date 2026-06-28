import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Header,
  UseGuards,
} from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { MarketingLeadsService } from '../services/marketing-leads.service';
import { TagsService } from '../services/tags.service';
import { LeadDedupeService } from '../services/lead-dedupe.service';
import { AssignTagsDto } from '../dto/tag.dto';
import { MergeLeadsDto } from '../dto/merge-leads.dto';
import { CreateLeadDto } from '../dto/create-lead.dto';
import { UpdateLeadDto } from '../dto/update-lead.dto';
import { LeadFilterDto } from '../dto/lead-filter.dto';
import { ConvertLeadDto } from '../dto/convert-lead.dto';
import { UpdateLeadStatusDto } from '../dto/update-lead-status.dto';
import { AssignLeadDto } from '../dto/assign-lead.dto';
import { BulkAssignLeadDto } from '../dto/bulk-assign-lead.dto';
import { BulkLeadIdsDto, BulkEnrollLeadsDto, EnrollByFilterDto } from '../dto/lead-bulk.dto';
import { LeadBulkService } from '../inbox/lead-bulk.service';
import { MarketingUserPayload } from '../types';
import { Audit } from '../../audit/audit.decorator';

@Controller('marketing/leads')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
@MarketingRoute()
export class MarketingLeadsController {
  constructor(
    private readonly leadsService: MarketingLeadsService,
    private readonly tagsService: TagsService,
    private readonly dedupeService: LeadDedupeService,
    private readonly leadBulk: LeadBulkService,
  ) {}

  // Declared before the `:id` routes so "duplicates"/"merge"/"export.csv" are
  // not captured as a lead id.
  @Get('duplicates')
  duplicates(@CurrentMarketingUser() actor: MarketingUserPayload) {
    return this.dedupeService.findDuplicates(actor.workspaceId);
  }

  /** CSV export of the (filtered) lead list. REPs export only their own leads. */
  @Get('export.csv')
  @RequirePermission('leads.read')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="leads.csv"')
  exportCsv(@CurrentMarketingUser() actor: MarketingUserPayload, @Query() q: LeadFilterDto) {
    // Forward the SAME filter surface the list uses (source/businessType/
    // assignmentStatus were silently dropped before, so the CSV didn't match
    // the on-screen list). REP-scoping + assignmentStatus resolution live in
    // the service now, mirroring findAll.
    return this.leadBulk.exportCsv(
      actor.workspaceId,
      {
        status: q.status,
        source: q.source,
        businessType: q.businessType,
        assignedToId: q.assignedToId,
        assignmentStatus: q.assignmentStatus,
        search: q.search,
      },
      actor.id,
      actor.role,
    );
  }

  @Post('merge')
  @RequirePermission('leads.write')
  @Audit({ action: 'lead.merge', resourceType: 'lead', captureBody: ['canonicalId'] })
  merge(
    @Body() dto: MergeLeadsDto,
    @CurrentMarketingUser() actor: MarketingUserPayload,
  ) {
    return this.dedupeService.merge(actor.workspaceId, dto.canonicalId, dto.duplicateIds);
  }

  @Get(':id/tags')
  listTags(
    @Param('id') id: string,
    @CurrentMarketingUser() actor: MarketingUserPayload,
  ) {
    return this.tagsService.getLeadTags(actor.workspaceId, id);
  }

  @Post(':id/tags')
  @RequirePermission('leads.write')
  @Audit({ action: 'lead.tag.assign', resourceType: 'lead', resourceIdParam: 'id' })
  assignTags(
    @Param('id') id: string,
    @Body() dto: AssignTagsDto,
    @CurrentMarketingUser() actor: MarketingUserPayload,
  ) {
    return this.tagsService.assignToLead(actor.workspaceId, id, dto.tags, actor.id);
  }

  @Delete(':id/tags/:tagId')
  @RequirePermission('leads.write')
  @Audit({ action: 'lead.tag.unassign', resourceType: 'lead', resourceIdParam: 'id' })
  unassignTag(
    @Param('id') id: string,
    @Param('tagId') tagId: string,
    @CurrentMarketingUser() actor: MarketingUserPayload,
  ) {
    return this.tagsService.unassignFromLead(actor.workspaceId, id, [tagId]);
  }

  @Post()
  @RequirePermission('leads.write')
  create(@Body() dto: CreateLeadDto, @CurrentMarketingUser() actor: MarketingUserPayload) {
    return this.leadsService.create(actor.workspaceId, dto, actor.id, actor.role);
  }

  @Get()
  findAll(@Query() filter: LeadFilterDto, @CurrentMarketingUser() actor: MarketingUserPayload) {
    return this.leadsService.findAll(actor.workspaceId, filter, actor.id, actor.role);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentMarketingUser() actor: MarketingUserPayload) {
    return this.leadsService.findOne(actor.workspaceId, id, actor.id, actor.role);
  }

  @Patch(':id')
  @RequirePermission('leads.write')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateLeadDto,
    @CurrentMarketingUser() actor: MarketingUserPayload,
  ) {
    return this.leadsService.update(actor.workspaceId, id, dto, actor.id, actor.role);
  }

  @Patch(':id/status')
  @Audit({
    action: 'lead.status.update',
    resourceType: 'lead',
    resourceIdParam: 'id',
    captureBody: ['status', 'lostReason'],
  })
  @RequirePermission('leads.write')
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateLeadStatusDto,
    @CurrentMarketingUser() actor: MarketingUserPayload,
  ) {
    return this.leadsService.updateStatus(
      actor.workspaceId,
      id,
      dto.status,
      dto.lostReason,
      actor.id,
      actor.role,
    );
  }

  @Patch(':id/assign')
  @MarketingRoles('MANAGER')
  @RequirePermission('leads.manage')
  assign(
    @Param('id') id: string,
    @Body() dto: AssignLeadDto,
    @CurrentMarketingUser() actor: MarketingUserPayload,
  ) {
    return this.leadsService.assign(actor.workspaceId, id, dto.assignedToId, actor.id);
  }

  // Listed BEFORE the generic Patch routes above is unnecessary — Nest
  // matches static paths before params anyway — but bulk-assign is a
  // POST so there's no ambiguity. Manager-only at the decorator layer.
  @Post('bulk-assign')
  @MarketingRoles('MANAGER')
  @RequirePermission('leads.manage')
  bulkAssign(
    @Body() dto: BulkAssignLeadDto,
    @CurrentMarketingUser() actor: MarketingUserPayload,
  ) {
    return this.leadsService.bulkAssign(
      actor.workspaceId,
      dto.leadIds,
      dto.assignedToId,
      actor.id,
    );
  }

  /** Soft-delete a set of leads (hidden from the pipeline; kept for audit). */
  @Post('bulk-delete')
  @MarketingRoles('MANAGER')
  @RequirePermission('leads.manage')
  @Audit({ action: 'lead.bulk_delete', resourceType: 'lead' })
  bulkDelete(@Body() dto: BulkLeadIdsDto, @CurrentMarketingUser() actor: MarketingUserPayload) {
    return this.leadBulk.bulkDelete(actor.workspaceId, dto.leadIds);
  }

  /** Manually enroll a set of leads into a workflow. */
  @Post('bulk-enroll')
  @MarketingRoles('MANAGER')
  @RequirePermission('leads.manage')
  @Audit({ action: 'lead.bulk_enroll', resourceType: 'lead', captureBody: ['workflowId'] })
  bulkEnroll(@Body() dto: BulkEnrollLeadsDto, @CurrentMarketingUser() actor: MarketingUserPayload) {
    return this.leadBulk.bulkEnroll(actor.workspaceId, dto.leadIds, dto.workflowId, actor.id);
  }

  /** Bulk-enroll every lead matching an audience filter into a workflow (drip). */
  @Post('enroll-by-filter')
  @MarketingRoles('MANAGER')
  @RequirePermission('leads.manage')
  // workflowId lives in the body (no route param), so it's captured via
  // captureBody into metadata rather than resourceIdParam; the filter fields go
  // alongside it so a mass-enroll is fully attributable in the audit log.
  @Audit({
    action: 'lead.enroll_by_filter',
    resourceType: 'workflow',
    captureBody: ['workflowId', 'status', 'assignedToId', 'businessType', 'source', 'city', 'search', 'enrollAll'],
  })
  enrollByFilter(@Body() dto: EnrollByFilterDto, @CurrentMarketingUser() actor: MarketingUserPayload) {
    const { workflowId, enrollAll, ...filter } = dto;
    return this.leadBulk.bulkEnrollByFilter(actor.workspaceId, filter, workflowId, actor.id, enrollAll);
  }


  @Post(':id/convert')
  @MarketingRoles('MANAGER')
  @Audit({ action: 'lead.convert', resourceType: 'lead', resourceIdParam: 'id' })
  @RequirePermission('leads.manage')
  convert(
    @Param('id') id: string,
    @Body() dto: ConvertLeadDto,
    @CurrentMarketingUser() actor: MarketingUserPayload,
  ) {
    return this.leadsService.convert(actor.workspaceId, id, dto, actor.id);
  }

  @Delete(':id')
  @MarketingRoles('MANAGER')
  @RequirePermission('leads.manage')
  delete(@Param('id') id: string, @CurrentMarketingUser() actor: MarketingUserPayload) {
    return this.leadsService.delete(actor.workspaceId, id);
  }
}
