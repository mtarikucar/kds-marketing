import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard } from '../guards/api-key.guard';
import { CurrentApiAuth } from '../decorators/current-api-auth.decorator';
import { ApiAuth } from '../services/api-keys.service';
import { MarketingLeadsService } from '../services/marketing-leads.service';
import { TagsService } from '../services/tags.service';
import { CustomFieldsService } from '../services/custom-fields.service';
import { SegmentsService } from '../services/segments.service';
import { CreateLeadDto } from '../dto/create-lead.dto';
import { UpdateLeadDto } from '../dto/update-lead.dto';
import { LeadFilterDto } from '../dto/lead-filter.dto';

// Machine principal for API-key calls — the leads service only special-cases
// the 'REP' role (own-leads scoping), so any non-REP role grants full
// workspace access; the API key's read/write scope is enforced by ApiKeyGuard.
const API_ACTOR = { id: 'api', role: 'API' } as const;

/**
 * Epic B3 — versioned public REST API (`/api/v1`), authenticated by an API key.
 * A thin auth+shape layer over the Epic-A services — never a second copy of
 * business logic. The workspace comes from the key, never the request body.
 */
@Controller('v1')
@UseGuards(ApiKeyGuard)
export class PublicApiV1Controller {
  constructor(
    private readonly leads: MarketingLeadsService,
    private readonly tags: TagsService,
    private readonly customFields: CustomFieldsService,
    private readonly segments: SegmentsService,
  ) {}

  @Get('leads')
  listLeads(@Query() filter: LeadFilterDto, @CurrentApiAuth() auth: ApiAuth) {
    return this.leads.findAll(auth.workspaceId, filter, API_ACTOR.id, API_ACTOR.role);
  }

  @Post('leads')
  createLead(@Body() dto: CreateLeadDto, @CurrentApiAuth() auth: ApiAuth) {
    return this.leads.create(auth.workspaceId, dto, API_ACTOR.id, API_ACTOR.role);
  }

  @Get('leads/:id')
  getLead(@Param('id') id: string, @CurrentApiAuth() auth: ApiAuth) {
    return this.leads.findOne(auth.workspaceId, id, API_ACTOR.id, API_ACTOR.role);
  }

  @Patch('leads/:id')
  updateLead(
    @Param('id') id: string,
    @Body() dto: UpdateLeadDto,
    @CurrentApiAuth() auth: ApiAuth,
  ) {
    return this.leads.update(auth.workspaceId, id, dto, API_ACTOR.id, API_ACTOR.role);
  }

  @Get('tags')
  listTags(@CurrentApiAuth() auth: ApiAuth) {
    return this.tags.list(auth.workspaceId);
  }

  @Get('custom-fields')
  listCustomFields(@CurrentApiAuth() auth: ApiAuth) {
    return this.customFields.list(auth.workspaceId);
  }

  @Get('segments/:id/members')
  segmentMembers(
    @Param('id') id: string,
    @Query('page') page: string,
    @CurrentApiAuth() auth: ApiAuth,
  ) {
    return this.segments.members(auth.workspaceId, id, page ? parseInt(page, 10) : 1);
  }
}
