import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsOptional, IsIn, IsString, MaxLength } from 'class-validator';
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
import { ContentDistributionService } from '../distribution/content-distribution.service';
import { DistributionSendService } from '../distribution/distribution-send.service';

class SendDraftDto {
  /** The copy as EDITED by the person sending it. Optional — the stored draft
   *  is used when it is absent — and what actually goes out is written back
   *  onto the row, so the record is of what was sent. */
  @IsOptional() @IsString() @MaxLength(4000) text?: string;
}

class ListDraftsDto {
  @IsOptional() @IsString() @MaxLength(64) planId?: string;
  @IsOptional() @IsIn(['DRAFT', 'SENT', 'DISMISSED', 'FAILED']) status?: string;
}

/**
 * İçerik üretim hattı, aşama 4 — the human's door onto the distribution plan.
 *
 * NAMED `content-distribution` and not `distribution`, because
 * `marketing/distribution-config` already exists and means something entirely
 * different: the round-robin rules that assign incoming LEADS to reps. Two
 * things called "distribution" in one API is how somebody eventually wires the
 * wrong one.
 *
 * ## Why the send is a REST route and not an MCP tool
 *
 * Planning and reading ARE tools — they write inert rows a human reviews for
 * free, which is the same reasoning that keeps `jeeta.plan_content_concepts`
 * ungated. Sending is not, and the difference is not one of risk appetite: the
 * owner's decision was that a person sends each message, and an MCP tool with
 * `requiresApproval: true` would still be a verb the model possesses. Here the
 * actor is `@CurrentMarketingUser()` — it comes from the authenticated
 * principal, never from a body or a path param, and `DistributionSendService`
 * verifies it against the database before anything is dispatched.
 *
 * ## The permission split
 *
 * `campaigns.write` produces a plan; `leads.write` sends one of its drafts. The
 * second is the floor `POST marketing/conversations/start` already enforces for
 * exactly the same act — opening a thread with a person who has not written to
 * us — so the two doors onto that act agree.
 */
@MarketingRoute()
@Controller('marketing/content-distribution')
@UseGuards(MarketingGuard, MarketingRolesGuard, FeatureGuard, PermissionsGuard)
@MarketingRoles('MANAGER')
@RequiresFeature('socialCampaigns')
export class MarketingContentDistributionController {
  constructor(
    private readonly distribution: ContentDistributionService,
    private readonly sender: DistributionSendService,
  ) {}

  /** Literal path, declared before `:campaignItemId` so it wins the match. */
  @Get('drafts')
  listDrafts(
    @CurrentMarketingUser() user: MarketingUserPayload,
    @Query() q: ListDraftsDto,
  ) {
    return this.distribution.listDrafts(user.workspaceId, q);
  }

  @Post('drafts/:id/send')
  @RequirePermission('leads.write')
  @Audit({
    action: 'distribution.draft.send',
    resourceType: 'distribution_draft',
    resourceIdParam: 'id',
  })
  send(
    @CurrentMarketingUser() user: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: SendDraftDto,
  ) {
    // `user.id` — the authenticated person, never a body field. This is the
    // whole boundary: see DistributionSendService's docblock.
    return this.sender.send(user.workspaceId, id, user.id, dto.text);
  }

  @Post('drafts/:id/dismiss')
  @RequirePermission('leads.write')
  @Audit({
    action: 'distribution.draft.dismiss',
    resourceType: 'distribution_draft',
    resourceIdParam: 'id',
  })
  dismiss(@CurrentMarketingUser() user: MarketingUserPayload, @Param('id') id: string) {
    return this.distribution.dismissDraft(user.workspaceId, id);
  }

  @Post(':campaignItemId/plan')
  @RequirePermission('campaigns.write')
  @Audit({
    action: 'distribution.plan',
    resourceType: 'social_campaign_item',
    resourceIdParam: 'campaignItemId',
  })
  plan(
    @CurrentMarketingUser() user: MarketingUserPayload,
    @Param('campaignItemId') campaignItemId: string,
  ) {
    return this.distribution.plan(user.workspaceId, campaignItemId, user.id);
  }

  @Get(':campaignItemId')
  get(
    @CurrentMarketingUser() user: MarketingUserPayload,
    @Param('campaignItemId') campaignItemId: string,
  ) {
    return this.distribution.get(user.workspaceId, campaignItemId);
  }
}
