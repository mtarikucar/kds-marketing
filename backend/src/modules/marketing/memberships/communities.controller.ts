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
} from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { Audit } from '../../audit/audit.decorator';
import { CommunitiesService } from './communities.service';
import {
  CommentDto,
  CreateCommunityDto,
  CreatePostDto,
  JoinCommunityDto,
  LeaveCommunityDto,
  PinPostDto,
  UpdateCommunityDto,
} from './community.dto';

@MarketingRoute()
@Controller('marketing/communities')
@UseGuards(MarketingGuard, MarketingRolesGuard)
export class CommunitiesController {
  constructor(private readonly svc: CommunitiesService) {}

  @Get()
  list(@CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.list(u.workspaceId);
  }

  @Post()
  @Audit({ action: 'community.create', resourceType: 'community' })
  create(@Body() dto: CreateCommunityDto, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.create(u.workspaceId, dto);
  }

  // --- post routes (literal-prefixed, before :id) ---

  @Post('posts/:postId/pin')
  @Audit({ action: 'community.post.pin', resourceType: 'community-post', resourceIdParam: 'postId' })
  pin(@Param('postId') postId: string, @Body() dto: PinPostDto, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.pinPost(u.workspaceId, postId, dto.pinned);
  }

  @Delete('posts/:postId')
  @Audit({ action: 'community.post.delete', resourceType: 'community-post', resourceIdParam: 'postId' })
  removePost(@Param('postId') postId: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.removePost(u.workspaceId, postId);
  }

  @Get('posts/:postId/comments')
  listComments(@Param('postId') postId: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.listComments(u.workspaceId, postId);
  }

  @Post('posts/:postId/comments')
  @Audit({ action: 'community.comment.add', resourceType: 'community-post', resourceIdParam: 'postId' })
  addComment(@Param('postId') postId: string, @Body() dto: CommentDto, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.addComment(u.workspaceId, postId, dto.body, u.id);
  }

  // --- community :id routes ---

  @Get(':id')
  get(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.get(u.workspaceId, id);
  }

  @Patch(':id')
  @Audit({ action: 'community.update', resourceType: 'community', resourceIdParam: 'id' })
  update(@Param('id') id: string, @Body() dto: UpdateCommunityDto, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.update(u.workspaceId, id, dto);
  }

  @Delete(':id')
  @Audit({ action: 'community.delete', resourceType: 'community', resourceIdParam: 'id' })
  remove(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.remove(u.workspaceId, id);
  }

  @Post(':id/join')
  @Audit({ action: 'community.join', resourceType: 'community', resourceIdParam: 'id' })
  join(@Param('id') id: string, @Body() dto: JoinCommunityDto, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.join(u.workspaceId, id, dto.leadId, dto.role);
  }

  @Post(':id/leave')
  @Audit({ action: 'community.leave', resourceType: 'community', resourceIdParam: 'id' })
  leave(@Param('id') id: string, @Body() dto: LeaveCommunityDto, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.leave(u.workspaceId, id, dto.leadId);
  }

  @Get(':id/members')
  members(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.members(u.workspaceId, id);
  }

  @Get(':id/posts')
  listPosts(@Param('id') id: string, @Query('page') page: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.listPosts(u.workspaceId, id, page ? parseInt(page, 10) : 1);
  }

  @Post(':id/posts')
  @Audit({ action: 'community.post.create', resourceType: 'community', resourceIdParam: 'id' })
  createPost(@Param('id') id: string, @Body() dto: CreatePostDto, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.createPost(u.workspaceId, id, dto, u.id);
  }
}
