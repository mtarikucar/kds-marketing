import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Req,
  Sse,
  Header,
  UseGuards,
  MessageEvent,
} from '@nestjs/common';
import { Observable, interval, merge } from 'rxjs';
import { map } from 'rxjs/operators';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { FeatureGuard, RequiresFeature } from '../guards/feature.guard';
import { SseTokenGuard } from '../guards/sse-token.guard';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { ConversationsService } from '../channels/conversations.service';
import { ConversationStreamService } from '../channels/conversation-stream.service';
import { ReplyDto, AssignConversationDto, SetAiPausedDto } from '../dto/conversation.dto';

const REST_GUARDS = [MarketingGuard, MarketingRolesGuard, FeatureGuard, PermissionsGuard];

/**
 * The agent Inbox. REST endpoints sit behind the usual marketing guards +
 * the `conversationAi` feature; the live `stream` endpoint uses SseTokenGuard
 * (EventSource can't send an Authorization header, so the token rides as
 * `?access_token=`). `stream` is declared before `:id` so the literal wins.
 */
@MarketingRoute()
@Controller('marketing/conversations')
export class MarketingConversationsController {
  constructor(
    private readonly conversations: ConversationsService,
    private readonly stream: ConversationStreamService,
  ) {}

  /** Live inbox stream — every conversation event for the workspace. */
  @Sse('stream')
  @UseGuards(SseTokenGuard)
  @Header('X-Accel-Buffering', 'no')
  streamInbox(@CurrentMarketingUser() actor: MarketingUserPayload): Observable<MessageEvent> {
    return merge(
      this.stream.forWorkspace(actor.workspaceId).pipe(map((e) => ({ data: e }) as MessageEvent)),
      // 25s heartbeat keeps proxies from idling the connection shut.
      interval(25_000).pipe(map(() => ({ data: { kind: 'heartbeat' } }) as MessageEvent)),
    );
  }

  @Get()
  @UseGuards(...REST_GUARDS)
  @RequiresFeature('conversationAi')
  list(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Query('status') status?: string,
    @Query('channelId') channelId?: string,
    @Query('assignedToId') assignedToId?: string,
  ) {
    return this.conversations.list(actor.workspaceId, { status, channelId, assignedToId });
  }

  @Get(':id')
  @UseGuards(...REST_GUARDS)
  @RequiresFeature('conversationAi')
  thread(@CurrentMarketingUser() actor: MarketingUserPayload, @Param('id') id: string) {
    return this.conversations.thread(actor.workspaceId, id);
  }

  @Post(':id/reply')
  @UseGuards(...REST_GUARDS)
  @RequiresFeature('conversationAi')
  @RequirePermission('leads.write')
  reply(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: ReplyDto,
  ) {
    return this.conversations.reply(actor.workspaceId, id, dto.text, actor.id);
  }

  @Post(':id/assign')
  @UseGuards(...REST_GUARDS)
  @RequiresFeature('conversationAi')
  @RequirePermission('leads.write')
  assign(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: AssignConversationDto,
  ) {
    return this.conversations.assign(actor.workspaceId, id, dto.assignedToId ?? null);
  }

  @Post(':id/ai-pause')
  @UseGuards(...REST_GUARDS)
  @RequiresFeature('conversationAi')
  @RequirePermission('leads.write')
  setAiPaused(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: SetAiPausedDto,
  ) {
    return this.conversations.setAiPaused(actor.workspaceId, id, dto.paused);
  }

  @Post(':id/close')
  @UseGuards(...REST_GUARDS)
  @RequiresFeature('conversationAi')
  @RequirePermission('leads.write')
  close(@CurrentMarketingUser() actor: MarketingUserPayload, @Param('id') id: string) {
    return this.conversations.close(actor.workspaceId, id);
  }

  @Post(':id/reopen')
  @UseGuards(...REST_GUARDS)
  @RequiresFeature('conversationAi')
  @RequirePermission('leads.write')
  reopen(@CurrentMarketingUser() actor: MarketingUserPayload, @Param('id') id: string) {
    return this.conversations.reopen(actor.workspaceId, id);
  }

  @Post(':id/read')
  @UseGuards(...REST_GUARDS)
  @RequiresFeature('conversationAi')
  @RequirePermission('leads.write')
  markRead(@CurrentMarketingUser() actor: MarketingUserPayload, @Param('id') id: string) {
    return this.conversations.markRead(actor.workspaceId, id);
  }
}
