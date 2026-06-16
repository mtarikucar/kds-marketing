import {
  Body,
  Controller,
  Get,
  Param,
  Post,
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
import { ImportService } from '../services/import.service';
import { CommitImportDto, UploadImportDto } from '../dto/import.dto';

@MarketingRoute()
@Controller('marketing/imports')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
export class MarketingImportsController {
  constructor(private readonly svc: ImportService) {}

  @Get()
  list(@CurrentMarketingUser() user: MarketingUserPayload) {
    return this.svc.list(user.workspaceId);
  }

  @Post()
  @Audit({ action: 'import.upload', resourceType: 'import' })
  @RequirePermission('contacts.write')
  upload(
    @Body() dto: UploadImportDto,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.svc.upload(user.workspaceId, dto.filename, dto.content, user.id);
  }

  @Get(':id')
  status(
    @Param('id') id: string,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.svc.getStatus(user.workspaceId, id);
  }

  @Post(':id/commit')
  @Audit({ action: 'import.commit', resourceType: 'import', resourceIdParam: 'id' })
  @RequirePermission('contacts.write')
  commit(
    @Param('id') id: string,
    @Body() dto: CommitImportDto,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.svc.commit(user.workspaceId, id, dto.mapping, dto.dedupePolicy);
  }
}
