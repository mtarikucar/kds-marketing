import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { ContentProgramme } from '@prisma/client';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { FeatureGuard, RequiresFeature } from '../guards/feature.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { Audit } from '../../audit/audit.decorator';
import { MarketingUserPayload } from '../types';
import { ContentProgrammeService, PER_WEEK_MAX, PROGRAMME_GOALS, WEEKLY_CREDIT_CAP_MAX } from '../content-programme/content-programme.service';
import { CONTENT_TYPE_NETWORKS, ContentTypesService } from '../content-programme/content-types.service';
import { Dashboard, ProgrammeDashboardService, SlotView, TypeView } from '../content-programme/programme-dashboard.service';
import { SlotEditorService } from '../content-programme/slot-editor.service';

const DAY_MS = 24 * 60 * 60 * 1000;
/** The default slot window for `GET /:id/slots` without `from`/`to`: the dashboard's own. */
const DEFAULT_SLOTS_BACK_DAYS = 1;
/** `GET /:id/events` answers a longer log than the dashboard's 30. */
const EVENT_LIMIT = 100;

class CreateProgrammeDto {
  @IsString()
  @MaxLength(200)
  name!: string;

  @IsString()
  @MaxLength(8000)
  brief!: string;

  @IsArray()
  @IsString({ each: true })
  accountIds!: string[];

  /** One post per weekday at most, so at most seven. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(PER_WEEK_MAX)
  perWeek?: number;

  @IsOptional()
  @IsIn([...PROGRAMME_GOALS])
  goal?: string;

  @IsOptional()
  @IsInt()
  @Min(50)
  @Max(WEEKLY_CREDIT_CAP_MAX)
  weeklyCreditCap?: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  personaId?: string;

  /** 'HH:MM' in TURKEY TIME (Europe/Istanbul); the service converts it to the
   *  UTC cadence the lane runs on. */
  @IsOptional()
  @IsString()
  @MaxLength(5)
  timeOfDay?: string;

  /** 0 = Sunday … 6 = Saturday, Turkey time; must list exactly `perWeek` days. */
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  daysOfWeek?: number[];
}

/**
 * The owner's settings. Bounds are the service's (`BOUNDS` in
 * content-programme.service.ts) — repeated here only loosely so a wildly wrong
 * body is refused at the door; the exact range and the produce < plan rule are
 * the service's to state, in one place.
 */
class UpdateProgrammeDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8000)
  brief?: string;

  @IsOptional()
  @IsIn([...PROGRAMME_GOALS])
  goal?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(PER_WEEK_MAX)
  perWeek?: number;

  /** 0 = Sunday … 6 = Saturday, Turkey time; must list exactly `perWeek` days. */
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  daysOfWeek?: number[];

  @IsOptional()
  @IsInt()
  @Min(50)
  @Max(WEEKLY_CREDIT_CAP_MAX)
  weeklyCreditCap?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  explorationRate?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maturityHours?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  halfLifeDays?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  editWindowHours?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  lookaheadDays?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  planLeadHours?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  produceLeadHours?: number;

  /** `null` clears the persona; `IsOptional` lets null through on purpose. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  personaId?: string | null;
}

class CreateContentTypeDto {
  @IsString()
  @MaxLength(40)
  key!: string;

  @IsString()
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  /** Beats: [{ role, durationSec, guidance }] — shape-checked by the service. */
  @IsOptional()
  @IsArray()
  structure?: Array<{ role: string; durationSec: number; guidance: string }>;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(600)
  defaultDurationSec?: number;

  @IsOptional()
  @IsArray()
  @IsIn([...CONTENT_TYPE_NETWORKS], { each: true })
  networks?: string[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  minShare?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  maxShare?: number;
}

class UpdateContentTypeDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsArray()
  structure?: Array<{ role: string; durationSec: number; guidance: string }>;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(600)
  defaultDurationSec?: number;

  @IsOptional()
  @IsArray()
  @IsIn([...CONTENT_TYPE_NETWORKS], { each: true })
  networks?: string[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  minShare?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  maxShare?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

class SlotsQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

class EditSlotDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  contentTypeKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8000)
  idea?: string;

  @IsOptional()
  @IsDateString()
  scheduledFor?: string;
}

interface ProgrammeEnvelope {
  programme: ContentProgramme | null;
  dashboard: Dashboard | null;
}

/**
 * The programme panel's REST surface — the Studio's single screen and nothing
 * else calls it (the chat goes through the MCP tools, which share the same
 * services and the same read model).
 *
 * Reads take `campaigns.read`; every write takes `campaigns.write` and is
 * audited under `content_programme`, because every write here either spends
 * credits autonomously from then on (create/resume/regenerate), stops that
 * spending (pause/kill), or redirects what the next credits buy (settings,
 * types, slot edits). No new permission is invented: a programme is campaign
 * work — it literally IS a FULL_AUTO campaign with a planner in front of it.
 *
 * Every `/:id/...` route resolves the programme through `getOrThrow`, which is
 * workspace-scoped, so a foreign programme id is a 404 before any sub-resource
 * is touched; slot routes then check the slot belongs to THAT programme.
 *
 * Mutations answer with the same `{ programme, dashboard }` envelope `GET /`
 * returns, so the panel replaces its whole state from one response instead of
 * stitching a partial update onto a stale dashboard.
 */
@MarketingRoute()
@Controller('marketing/content-programme')
@UseGuards(MarketingGuard, MarketingRolesGuard, FeatureGuard, PermissionsGuard)
@MarketingRoles('MANAGER')
@RequiresFeature('socialCampaigns')
export class MarketingContentProgrammeController {
  constructor(
    private readonly programmes: ContentProgrammeService,
    private readonly types: ContentTypesService,
    private readonly dashboard: ProgrammeDashboardService,
    private readonly editor: SlotEditorService,
  ) {}

  // ───────────────────────────────────────────────── the programme itself

  @Get()
  @RequirePermission('campaigns.read')
  async get(@CurrentMarketingUser() user: MarketingUserPayload): Promise<ProgrammeEnvelope> {
    return this.envelope(user.workspaceId, await this.programmes.get(user.workspaceId));
  }

  /** Creates AND activates: from this response on, the programme spends credits on its own. */
  @Post()
  @RequirePermission('campaigns.write')
  @Audit({ action: 'content.programme.create', resourceType: 'content_programme', captureBody: ['name', 'perWeek', 'goal', 'weeklyCreditCap'] })
  async create(@CurrentMarketingUser() user: MarketingUserPayload, @Body() body: CreateProgrammeDto): Promise<ProgrammeEnvelope> {
    const programme = await this.programmes.create(user.workspaceId, { ...body, createdById: user.id });
    return this.envelope(user.workspaceId, programme);
  }

  @Patch(':id')
  @RequirePermission('campaigns.write')
  @Audit({ action: 'content.programme.update', resourceType: 'content_programme', resourceIdParam: 'id' })
  async update(
    @CurrentMarketingUser() user: MarketingUserPayload,
    @Param('id') id: string,
    @Body() body: UpdateProgrammeDto,
  ): Promise<ProgrammeEnvelope> {
    const programme = await this.programmes.update(user.workspaceId, id, body);
    return this.envelope(user.workspaceId, programme);
  }

  @Post(':id/pause')
  @RequirePermission('campaigns.write')
  @Audit({ action: 'content.programme.pause', resourceType: 'content_programme', resourceIdParam: 'id' })
  async pause(@CurrentMarketingUser() user: MarketingUserPayload, @Param('id') id: string): Promise<ProgrammeEnvelope> {
    return this.envelope(user.workspaceId, await this.programmes.pause(user.workspaceId, id));
  }

  @Post(':id/resume')
  @RequirePermission('campaigns.write')
  @Audit({ action: 'content.programme.resume', resourceType: 'content_programme', resourceIdParam: 'id' })
  async resume(@CurrentMarketingUser() user: MarketingUserPayload, @Param('id') id: string): Promise<ProgrammeEnvelope> {
    return this.envelope(user.workspaceId, await this.programmes.resume(user.workspaceId, id));
  }

  /**
   * The kill switch — terminal, hub-only on purpose: no MCP tool reaches it, so
   * an agent can pause a programme but only a person at the panel can end one.
   * The killed row is returned with its dashboard so the panel can show the
   * final state; the next `GET /` will answer `programme: null`.
   */
  @Post(':id/kill')
  @RequirePermission('campaigns.write')
  @Audit({ action: 'content.programme.kill', resourceType: 'content_programme', resourceIdParam: 'id' })
  async kill(@CurrentMarketingUser() user: MarketingUserPayload, @Param('id') id: string): Promise<ProgrammeEnvelope> {
    return this.envelope(user.workspaceId, await this.programmes.kill(user.workspaceId, id));
  }

  // ───────────────────────────────────────────────────────────── types

  @Get(':id/types')
  @RequirePermission('campaigns.read')
  async listTypes(@CurrentMarketingUser() user: MarketingUserPayload, @Param('id') id: string): Promise<TypeView[]> {
    const programme = await this.programmes.getOrThrow(user.workspaceId, id);
    return this.dashboard.typeViews(user.workspaceId, programme.id);
  }

  @Post(':id/types')
  @RequirePermission('campaigns.write')
  @Audit({ action: 'content.programme.type.create', resourceType: 'content_programme', resourceIdParam: 'id', captureBody: ['key', 'name'] })
  async createType(
    @CurrentMarketingUser() user: MarketingUserPayload,
    @Param('id') id: string,
    @Body() body: CreateContentTypeDto,
  ): Promise<TypeView> {
    const programme = await this.programmes.getOrThrow(user.workspaceId, id);
    const created = await this.types.create(user.workspaceId, body);
    return this.typeView(user.workspaceId, programme.id, created.id);
  }

  @Patch(':id/types/:typeId')
  @RequirePermission('campaigns.write')
  @Audit({ action: 'content.programme.type.update', resourceType: 'content_programme', resourceIdParam: 'id' })
  async updateType(
    @CurrentMarketingUser() user: MarketingUserPayload,
    @Param('id') id: string,
    @Param('typeId') typeId: string,
    @Body() body: UpdateContentTypeDto,
  ): Promise<TypeView> {
    const programme = await this.programmes.getOrThrow(user.workspaceId, id);
    const updated = await this.types.update(user.workspaceId, typeId, body);
    return this.typeView(user.workspaceId, programme.id, updated.id);
  }

  // ───────────────────────────────────────────────────────────── slots

  @Get(':id/slots')
  @RequirePermission('campaigns.read')
  async listSlots(
    @CurrentMarketingUser() user: MarketingUserPayload,
    @Param('id') id: string,
    @Query() q: SlotsQueryDto,
  ): Promise<SlotView[]> {
    const programme = await this.programmes.getOrThrow(user.workspaceId, id);
    const now = new Date();
    const from = q.from ? new Date(q.from) : new Date(now.getTime() - DEFAULT_SLOTS_BACK_DAYS * DAY_MS);
    const to = q.to ? new Date(q.to) : new Date(now.getTime() + programme.lookaheadDays * DAY_MS);
    return this.dashboard.slots(user.workspaceId, programme.id, from, to, now);
  }

  /** Redirects what the slot will become; spends nothing until the slot is produced. */
  @Patch(':id/slots/:slotId')
  @RequirePermission('campaigns.write')
  @Audit({ action: 'content.programme.slot.update', resourceType: 'content_programme', resourceIdParam: 'id', captureBody: ['contentTypeKey', 'scheduledFor'] })
  async updateSlot(
    @CurrentMarketingUser() user: MarketingUserPayload,
    @Param('id') id: string,
    @Param('slotId') slotId: string,
    @Body() body: EditSlotDto,
  ): Promise<SlotView> {
    const programme = await this.requireSlot(user.workspaceId, id, slotId);
    await this.editor.updateSlot(
      user.workspaceId,
      slotId,
      {
        ...(body.contentTypeKey !== undefined ? { contentTypeKey: body.contentTypeKey } : {}),
        ...(body.idea !== undefined ? { idea: body.idea } : {}),
        ...(body.scheduledFor !== undefined ? { scheduledFor: new Date(body.scheduledFor) } : {}),
      },
      user.id,
    );
    return this.dashboard.slotView(user.workspaceId, programme.id, slotId);
  }

  @Post(':id/slots/:slotId/skip')
  @RequirePermission('campaigns.write')
  @Audit({ action: 'content.programme.slot.skip', resourceType: 'content_programme', resourceIdParam: 'id' })
  async skipSlot(
    @CurrentMarketingUser() user: MarketingUserPayload,
    @Param('id') id: string,
    @Param('slotId') slotId: string,
  ): Promise<SlotView> {
    const programme = await this.requireSlot(user.workspaceId, id, slotId);
    await this.editor.skipSlot(user.workspaceId, slotId, user.id);
    return this.dashboard.slotView(user.workspaceId, programme.id, slotId);
  }

  /** Re-buys the clips: the one slot write that spends on its own. */
  @Post(':id/slots/:slotId/regenerate')
  @RequirePermission('campaigns.write')
  @Audit({ action: 'content.programme.slot.regenerate', resourceType: 'content_programme', resourceIdParam: 'id' })
  async regenerateSlot(
    @CurrentMarketingUser() user: MarketingUserPayload,
    @Param('id') id: string,
    @Param('slotId') slotId: string,
  ): Promise<SlotView> {
    const programme = await this.requireSlot(user.workspaceId, id, slotId);
    await this.editor.regenerateSlot(user.workspaceId, slotId, user.id);
    return this.dashboard.slotView(user.workspaceId, programme.id, slotId);
  }

  /** A FAILED slot back to PLANNED with its plan job re-armed; spends nothing until it is planned again. */
  @Post(':id/slots/:slotId/retry')
  @RequirePermission('campaigns.write')
  @Audit({ action: 'content.programme.slot.retry', resourceType: 'content_programme', resourceIdParam: 'id' })
  async retrySlot(
    @CurrentMarketingUser() user: MarketingUserPayload,
    @Param('id') id: string,
    @Param('slotId') slotId: string,
  ): Promise<SlotView> {
    const programme = await this.requireSlot(user.workspaceId, id, slotId);
    await this.editor.retrySlot(user.workspaceId, slotId, user.id);
    return this.dashboard.slotView(user.workspaceId, programme.id, slotId);
  }

  @Get(':id/slots/:slotId/metrics')
  @RequirePermission('campaigns.read')
  async slotMetrics(
    @CurrentMarketingUser() user: MarketingUserPayload,
    @Param('id') id: string,
    @Param('slotId') slotId: string,
  ) {
    await this.requireSlot(user.workspaceId, id, slotId);
    return this.editor.slotMetrics(user.workspaceId, slotId);
  }

  // ─────────────────────────────────────────────── learning / trends / log

  @Get(':id/learning')
  @RequirePermission('campaigns.read')
  async learning(@CurrentMarketingUser() user: MarketingUserPayload, @Param('id') id: string) {
    const programme = await this.programmes.getOrThrow(user.workspaceId, id);
    return this.dashboard.learning(user.workspaceId, programme);
  }

  @Get(':id/trends')
  @RequirePermission('campaigns.read')
  async trends(@CurrentMarketingUser() user: MarketingUserPayload, @Param('id') id: string) {
    const programme = await this.programmes.getOrThrow(user.workspaceId, id);
    return this.dashboard.trendViews(user.workspaceId, programme);
  }

  @Get(':id/events')
  @RequirePermission('campaigns.read')
  async events(@CurrentMarketingUser() user: MarketingUserPayload, @Param('id') id: string) {
    const programme = await this.programmes.getOrThrow(user.workspaceId, id);
    return this.dashboard.events(user.workspaceId, programme.id, EVENT_LIMIT);
  }

  // ───────────────────────────────────────────────────────── internals

  /** The one response shape every programme-level route answers with. */
  private async envelope(workspaceId: string, programme: ContentProgramme | null): Promise<ProgrammeEnvelope> {
    return {
      programme,
      dashboard: programme ? await this.dashboard.dashboard(workspaceId, programme) : null,
    };
  }

  /** 404 unless the programme is the workspace's AND the slot is the programme's. */
  private async requireSlot(workspaceId: string, programmeId: string, slotId: string): Promise<ContentProgramme> {
    const programme = await this.programmes.getOrThrow(workspaceId, programmeId);
    await this.dashboard.slotView(workspaceId, programme.id, slotId);
    return programme;
  }

  private async typeView(workspaceId: string, programmeId: string, typeId: string): Promise<TypeView> {
    const views = await this.dashboard.typeViews(workspaceId, programmeId);
    return views.find((v) => v.id === typeId)!;
  }
}
