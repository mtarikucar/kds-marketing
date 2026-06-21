import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { SnippetsService } from '../inbox/snippets.service';
import { CreateSnippetDto, UpdateSnippetDto } from '../dto/snippet.dto';

/**
 * Canned-response snippets. Any agent (leads.read) can list + create their own;
 * editing/deleting is guarded in the service (shared or own only). No special
 * role — snippets are an inbox-productivity tool every rep uses.
 */
@MarketingRoute()
@Controller('marketing/snippets')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
export class MarketingSnippetsController {
  constructor(private readonly snippets: SnippetsService) {}

  @Get()
  @RequirePermission('leads.read')
  list(@CurrentMarketingUser() a: MarketingUserPayload) {
    return this.snippets.list(a.workspaceId, a.id);
  }

  @Post()
  @RequirePermission('leads.write')
  create(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: CreateSnippetDto) {
    return this.snippets.create(a.workspaceId, a.id, dto);
  }

  @Patch(':id')
  @RequirePermission('leads.write')
  update(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: UpdateSnippetDto,
  ) {
    return this.snippets.update(a.workspaceId, a.id, id, dto);
  }

  @Delete(':id')
  @RequirePermission('leads.write')
  remove(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.snippets.remove(a.workspaceId, a.id, id);
  }
}
