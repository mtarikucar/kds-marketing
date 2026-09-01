import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  ArrayMaxSize,
  ValidateNested,
} from 'class-validator';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { Audit } from '../../audit/audit.decorator';
import { SocialPlannerService } from './social-planner.service';
import { SocialInsightsService } from './social-insights.service';

const NETWORKS = ['FACEBOOK', 'INSTAGRAM', 'LINKEDIN', 'TIKTOK', 'TWITTER', 'PINTEREST', 'GMB'] as const;
/** Mirrors the `status` values SocialPost.status is documented to carry. */
const POST_STATUSES = ['DRAFT', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'FAILED'] as const;

class ConnectAccountDto {
  @IsIn(NETWORKS)
  network: string;

  @IsString() @MaxLength(200)
  externalId: string;

  @IsString() @MaxLength(200)
  displayName: string;

  @IsString() @MaxLength(2000)
  accessToken: string;

  @IsOptional() @IsDateString()
  tokenExpiresAt?: string;
}

/** An uploaded (or pasted) media asset. `key` is empty for pasted URLs. */
class MediaItemDto {
  @IsUrl() @MaxLength(1000)
  url: string;

  @IsOptional() @IsString() @MaxLength(400)
  key?: string;

  @IsOptional() @IsString() @MaxLength(100)
  mime?: string;
}

class CreatePostDto {
  @IsString() @MaxLength(5000)
  content: string;

  @IsOptional() @IsArray() @IsUrl({}, { each: true }) @ArrayMaxSize(10)
  mediaUrls?: string[];

  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => MediaItemDto) @ArrayMaxSize(10)
  media?: MediaItemDto[];

  /** Per-account format map: { [socialAccountId]: 'FEED'|'REEL'|'STORY' }. */
  @IsOptional() @IsObject()
  formats?: Record<string, string>;

  @IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(20)
  targetAccountIds?: string[];

  /** Per-network publish options (e.g. { linkedin: { visibility } }, { tiktok: {...} }). */
  @IsOptional() @IsObject()
  options?: Record<string, unknown>;
}

class UpdatePostDto {
  @IsOptional() @IsString() @MaxLength(5000)
  content?: string;

  @IsOptional() @IsArray() @IsUrl({}, { each: true }) @ArrayMaxSize(10)
  mediaUrls?: string[];

  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => MediaItemDto) @ArrayMaxSize(10)
  media?: MediaItemDto[];

  @IsOptional() @IsObject()
  formats?: Record<string, string>;

  /** Editable publish targets for a DRAFT — replaces the post's PENDING targets.
   *  Without this a draft's target edits were silently dropped unless the user
   *  also scheduled (only schedule re-attached targets). */
  @IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(20)
  targetAccountIds?: string[];

  /** Per-network publish options (e.g. { linkedin: { visibility } }, { tiktok: {...} }). */
  @IsOptional() @IsObject()
  options?: Record<string, unknown>;
}

class SchedulePostDto {
  @IsDateString()
  scheduledAt: string;

  @IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(20)
  targetAccountIds?: string[];

  @IsOptional() @IsObject()
  formats?: Record<string, string>;
}

/**
 * Optional narrowing for `GET posts`. Every field is optional: an empty query
 * is the request this endpoint has always served, so the planner screen and the
 * MCP tool keep working untouched.
 *
 * `limit` needs `@Type(() => Number)` even though the global ValidationPipe runs
 * `enableImplicitConversion` — implicit conversion coerces against the declared
 * TYPE, and without the explicit transform an `@IsInt()` on a query string is a
 * coin flip across class-transformer versions. Note what is NOT here: a boolean.
 * Query booleans in this codebase carry a documented bug class — implicit
 * conversion turns `?flag=false` into `true` and `@IsBoolean()` never notices —
 * so a boolean added later must read the RAW value with `@Transform`, not lean
 * on the pipe. There is no reason to filter posts by a boolean today.
 */
class ListPostsQueryDto {
  /** Inclusive lower bound on `scheduledAt` (ISO 8601). */
  @IsOptional() @IsDateString()
  from?: string;

  /** Inclusive upper bound on `scheduledAt` (ISO 8601). */
  @IsOptional() @IsDateString()
  to?: string;

  @IsOptional() @IsIn(POST_STATUSES)
  status?: (typeof POST_STATUSES)[number];

  /** Page size. The service clamps harder still (SOCIAL_POSTS_MAX_PAGE). */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit?: number;
}

@MarketingRoute()
@Controller('marketing/social-planner')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
@MarketingRoles('MANAGER')
export class SocialPlannerController {
  constructor(
    private readonly svc: SocialPlannerService,
    private readonly insights: SocialInsightsService,
  ) {}

  // ── Network status ──────────────────────────────────────────────────────

  @Get('status')
  status(@CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.networkStatus(u.workspaceId);
  }

  // ── Accounts ────────────────────────────────────────────────────────────

  @Get('accounts')
  listAccounts(@CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.listAccounts(u.workspaceId);
  }

  @Post('accounts')
  @Audit({ action: 'social.account.connect', resourceType: 'social-account', captureBody: ['network', 'displayName', 'externalId'] })
  @RequirePermission('campaigns.send')
  connectAccount(@Body() dto: ConnectAccountDto, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.connectAccount(u.workspaceId, {
      ...dto,
      tokenExpiresAt: dto.tokenExpiresAt ? new Date(dto.tokenExpiresAt) : undefined,
    });
  }

  @Delete('accounts/:accountId')
  @Audit({ action: 'social.account.disconnect', resourceType: 'social-account', resourceIdParam: 'accountId' })
  @RequirePermission('campaigns.send')
  disconnectAccount(@Param('accountId') accountId: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.disconnectAccount(u.workspaceId, accountId);
  }

  @Get('accounts/:id/tiktok/creator-info')
  tiktokCreatorInfo(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.tiktokCreatorInfo(u.workspaceId, id);
  }

  // ── Media upload ──────────────────────────────────────────────────────────

  /** Upload an image/video to R2 and return its public URL (for pull-from-URL
   *  publishing). Returns { url, key, mime }; attach it to a post's `media`. */
  @Post('media')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
      fileFilter: (_req, file, cb) => {
        const ok = [
          'image/png',
          'image/jpeg',
          'image/webp',
          'image/gif',
          'video/mp4',
          'video/quicktime',
          'video/webm',
        ].includes(file.mimetype);
        cb(ok ? null : new BadRequestException('Unsupported media type'), ok);
      },
    }),
  )
  @RequirePermission('campaigns.send')
  uploadMedia(@UploadedFile() file: any, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.uploadMedia(u.workspaceId, file);
  }

  // ── Posts CRUD ──────────────────────────────────────────────────────────

  /** List posts, newest first. Pass `from`/`to` to read a scheduling window
   *  instead (ordered by send time, ascending) — that is the shape the calendar
   *  and the Growth Studio one-screen need, and without it every caller had to
   *  download the workspace's entire posting history to find today's. */
  @Get('posts')
  listPosts(@CurrentMarketingUser() u: MarketingUserPayload, @Query() q: ListPostsQueryDto) {
    return this.svc.listPosts(u.workspaceId, {
      // The DTO guarantees a parseable ISO string, so `new Date` cannot produce
      // an Invalid Date here; the service re-checks anyway because it is also
      // reachable from MCP and from other services.
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
      status: q.status,
      limit: q.limit,
    });
  }

  @Post('posts')
  @Audit({ action: 'social.post.create', resourceType: 'social-post', captureBody: ['mediaUrls'] })
  @RequirePermission('campaigns.send')
  createPost(@Body() dto: CreatePostDto, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.createPost(u.workspaceId, dto);
  }

  @Get('posts/:postId')
  getPost(@Param('postId') postId: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.getPost(u.workspaceId, postId);
  }

  @Patch('posts/:postId')
  @Audit({ action: 'social.post.update', resourceType: 'social-post', resourceIdParam: 'postId' })
  @RequirePermission('campaigns.send')
  updatePost(
    @Param('postId') postId: string,
    @Body() dto: UpdatePostDto,
    @CurrentMarketingUser() u: MarketingUserPayload,
  ) {
    return this.svc.updatePost(u.workspaceId, postId, dto);
  }

  @Delete('posts/:postId')
  @Audit({ action: 'social.post.delete', resourceType: 'social-post', resourceIdParam: 'postId' })
  @RequirePermission('campaigns.send')
  deletePost(@Param('postId') postId: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.deletePost(u.workspaceId, postId);
  }

  // ── Schedule / Publish ──────────────────────────────────────────────────

  @Post('posts/:postId/schedule')
  @Audit({ action: 'social.post.schedule', resourceType: 'social-post', resourceIdParam: 'postId', captureBody: ['scheduledAt'] })
  @RequirePermission('campaigns.send')
  schedulePost(
    @Param('postId') postId: string,
    @Body() dto: SchedulePostDto,
    @CurrentMarketingUser() u: MarketingUserPayload,
  ) {
    return this.svc.schedulePost(
      u.workspaceId,
      postId,
      new Date(dto.scheduledAt),
      dto.targetAccountIds,
      dto.formats,
    );
  }

  /** Pull a post back to DRAFT so it can be corrected and re-sent. The reverse
   *  of `schedule`, and the only non-destructive way to fix a post that is
   *  already out of the editor: SCHEDULED (the original case), FAILED (the
   *  retry path — a transient token/network failure must not cost the operator
   *  the caption and the media), and a PUBLISHING post whose run died. Targets
   *  that already PUBLISHED are left alone, so a retry never double-posts. */
  @Post('posts/:postId/unschedule')
  @Audit({ action: 'social.post.unschedule', resourceType: 'social-post', resourceIdParam: 'postId' })
  @RequirePermission('campaigns.send')
  unschedulePost(@Param('postId') postId: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.unschedulePost(u.workspaceId, postId);
  }

  @Post('posts/:postId/publish-now')
  @Audit({ action: 'social.post.publish-now', resourceType: 'social-post', resourceIdParam: 'postId' })
  @RequirePermission('campaigns.send')
  publishNow(@Param('postId') postId: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.publishNow(u.workspaceId, postId);
  }

  // ── Organic insights ────────────────────────────────────────────────────

  /**
   * Organic performance of published posts + connected profiles over a window.
   *
   * Range handling is deliberately identical to the unified content calendar
   * (marketing-content-calendar.controller.ts): defaults applied here rather
   * than in the service, an explicit NaN check because `new Date('nonsense')`
   * is a Date and would otherwise reach Prisma as an invalid parameter, and a
   * hard 180-day ceiling so one URL cannot ask the database to reduce a year of
   * rows synchronously.
   *
   * `reports.read` rather than the `campaigns.send` every write route on this
   * controller uses: reading what happened is not permission to publish, and a
   * custom role granted only reporting access should reach this. The
   * class-level @MarketingRoles('MANAGER') still applies on top — this narrows
   * the permission, it does not widen the role.
   */
  @Get('insights')
  @RequirePermission('reports.read')
  insightsSummary(
    @CurrentMarketingUser() u: MarketingUserPayload,
    @Query('from') fromRaw?: string,
    @Query('to') toRaw?: string,
  ) {
    const now = Date.now();
    const from = fromRaw ? new Date(fromRaw) : new Date(now - 30 * 86_400_000);
    const to = toRaw ? new Date(toRaw) : new Date(now);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException('invalid date range');
    }
    if (to <= from) throw new BadRequestException('`to` must be after `from`');
    if (to.getTime() - from.getTime() > 180 * 86_400_000) {
      throw new BadRequestException('range too wide (max 180 days)');
    }
    return this.insights.summary(u.workspaceId, from, to);
  }

  /**
   * Manual refresh behind the "Refresh" button. `pullNow` forces past the
   * every-6h staleness gate the cron applies — that gate exists to protect
   * provider rate limits on an unattended hourly sweep, and a human who has just
   * published something and wants to see numbers is a different situation. It is
   * gated on settings.manage (not reports.read) precisely because it spends the
   * workspace's provider quota, and audited for the same reason.
   *
   * It is also EXCLUSIVE per workspace and answers 409 when a pull is already in
   * flight. Two managers on the same workspace, or one manager clicking twice
   * because the first click had not visibly finished, used to mean two full
   * sweeps against the provider for identical rows — and the hourly cron could
   * be the second party without either knowing. The lock lives in the service
   * (pullWorkspaceExclusive) rather than here, because the cron takes the same
   * one; a guard on the HTTP route alone would only ever have covered half the
   * callers. The route stays thin: policy in the service, wiring here.
   */
  @Post('insights/pull')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  @Audit({ action: 'social.insights.pull', resourceType: 'social-insights' })
  pullInsights(@CurrentMarketingUser() u: MarketingUserPayload) {
    return this.insights.pullNow(u.workspaceId);
  }
}
