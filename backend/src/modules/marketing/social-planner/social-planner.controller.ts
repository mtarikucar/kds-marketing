import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
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
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
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

const NETWORKS = ['FACEBOOK', 'INSTAGRAM', 'LINKEDIN', 'TIKTOK', 'TWITTER', 'PINTEREST', 'GMB'] as const;

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

@MarketingRoute()
@Controller('marketing/social-planner')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
@MarketingRoles('MANAGER')
export class SocialPlannerController {
  constructor(private readonly svc: SocialPlannerService) {}

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

  @Get('posts')
  listPosts(@CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.listPosts(u.workspaceId);
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

  @Post('posts/:postId/publish-now')
  @Audit({ action: 'social.post.publish-now', resourceType: 'social-post', resourceIdParam: 'postId' })
  @RequirePermission('campaigns.send')
  publishNow(@Param('postId') postId: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.publishNow(u.workspaceId, postId);
  }
}
