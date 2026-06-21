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
import { Audit } from '../../audit/audit.decorator';
import { CustomObjectsService } from '../custom-objects/custom-objects.service';
import {
  CreateCustomObjectDto,
  UpdateCustomObjectDto,
  UpsertRecordDto,
  LinkContactDto,
  RecordQueryDto,
} from '../dto/custom-object.dto';
import {
  CreateCustomFieldDefDto,
  UpdateCustomFieldDefDto,
  ReorderCustomFieldsDto,
} from '../dto/custom-field.dto';

/**
 * Custom Objects (GoHighLevel parity). Defining objects + their fields is
 * workspace config → `settings.manage` (MANAGER+). Reading objects/records is
 * `leads.read` (REP-capable, like contacts); creating/editing records and
 * linking contacts is `leads.write`. Workspace context via MarketingGuard.
 *
 * Route order: literal `records/…` and `contacts/…` paths are declared before
 * the `:key/…` paths so a record/contact id is never captured as an object key.
 */
@MarketingRoute()
@Controller('marketing/custom-objects')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
export class MarketingCustomObjectsController {
  constructor(private readonly objects: CustomObjectsService) {}

  // ── Records (literal-prefixed, declared first) ──────────────────────────────

  @Get('records/:id')
  @RequirePermission('leads.read')
  getRecord(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.objects.getRecord(a.workspaceId, id);
  }

  @Patch('records/:id')
  @RequirePermission('leads.write')
  updateRecord(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: UpsertRecordDto,
  ) {
    return this.objects.updateRecord(a.workspaceId, id, dto);
  }

  @Delete('records/:id')
  @RequirePermission('leads.write')
  @Audit({ action: 'custom_object.record.delete', resourceType: 'custom_object_record' })
  deleteRecord(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.objects.deleteRecord(a.workspaceId, id);
  }

  @Get('records/:id/contacts')
  @RequirePermission('leads.read')
  listRecordContacts(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.objects.listRecordContacts(a.workspaceId, id);
  }

  @Post('records/:id/contacts')
  @RequirePermission('leads.write')
  linkContact(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: LinkContactDto,
  ) {
    return this.objects.linkContact(a.workspaceId, id, dto);
  }

  @Delete('records/:id/contacts/:linkId')
  @RequirePermission('leads.write')
  unlinkContact(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('id') id: string,
    @Param('linkId') linkId: string,
  ) {
    return this.objects.unlinkContact(a.workspaceId, id, linkId);
  }

  /** Custom-object records linked to a given Contact (for the lead detail view). */
  @Get('contacts/:leadId/records')
  @RequirePermission('leads.read')
  listContactRecords(@CurrentMarketingUser() a: MarketingUserPayload, @Param('leadId') leadId: string) {
    return this.objects.listContactRecords(a.workspaceId, leadId);
  }

  // ── Object definitions ──────────────────────────────────────────────────────

  @Get()
  @RequirePermission('leads.read')
  list(@CurrentMarketingUser() a: MarketingUserPayload) {
    return this.objects.listObjects(a.workspaceId);
  }

  @Post()
  @RequirePermission('settings.manage')
  @Audit({ action: 'custom_object.create', resourceType: 'custom_object' })
  create(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: CreateCustomObjectDto) {
    return this.objects.createObject(a.workspaceId, dto);
  }

  @Get(':key')
  @RequirePermission('leads.read')
  get(@CurrentMarketingUser() a: MarketingUserPayload, @Param('key') key: string) {
    return this.objects.getObject(a.workspaceId, key);
  }

  @Patch(':key')
  @RequirePermission('settings.manage')
  update(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('key') key: string,
    @Body() dto: UpdateCustomObjectDto,
  ) {
    return this.objects.updateObject(a.workspaceId, key, dto);
  }

  @Delete(':key')
  @RequirePermission('settings.manage')
  @Audit({ action: 'custom_object.archive', resourceType: 'custom_object' })
  archive(@CurrentMarketingUser() a: MarketingUserPayload, @Param('key') key: string) {
    return this.objects.archiveObject(a.workspaceId, key);
  }

  @Post(':key/restore')
  @RequirePermission('settings.manage')
  restore(@CurrentMarketingUser() a: MarketingUserPayload, @Param('key') key: string) {
    return this.objects.restoreObject(a.workspaceId, key);
  }

  // ── Fields (per object) ─────────────────────────────────────────────────────

  @Get(':key/fields')
  @RequirePermission('leads.read')
  listFields(@CurrentMarketingUser() a: MarketingUserPayload, @Param('key') key: string) {
    return this.objects.listFields(a.workspaceId, key);
  }

  @Post(':key/fields')
  @RequirePermission('settings.manage')
  createField(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('key') key: string,
    @Body() dto: CreateCustomFieldDefDto,
  ) {
    return this.objects.createField(a.workspaceId, key, dto);
  }

  @Post(':key/fields/reorder')
  @RequirePermission('settings.manage')
  reorderFields(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('key') key: string,
    @Body() dto: ReorderCustomFieldsDto,
  ) {
    return this.objects.reorderFields(a.workspaceId, key, dto.ids);
  }

  @Patch(':key/fields/:id')
  @RequirePermission('settings.manage')
  updateField(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('key') key: string,
    @Param('id') id: string,
    @Body() dto: UpdateCustomFieldDefDto,
  ) {
    return this.objects.updateField(a.workspaceId, key, id, dto);
  }

  @Delete(':key/fields/:id')
  @RequirePermission('settings.manage')
  archiveField(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('key') key: string,
    @Param('id') id: string,
  ) {
    return this.objects.archiveField(a.workspaceId, key, id);
  }

  // ── Records list/create (scoped under an object) ────────────────────────────

  @Get(':key/records')
  @RequirePermission('leads.read')
  listRecords(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('key') key: string,
    @Query() q: RecordQueryDto,
  ) {
    return this.objects.listRecords(a.workspaceId, key, q);
  }

  @Post(':key/records')
  @RequirePermission('leads.write')
  @Audit({ action: 'custom_object.record.create', resourceType: 'custom_object_record' })
  createRecord(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('key') key: string,
    @Body() dto: UpsertRecordDto,
  ) {
    return this.objects.createRecord(a.workspaceId, key, dto);
  }
}
