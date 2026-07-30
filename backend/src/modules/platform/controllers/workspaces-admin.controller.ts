import {
  Controller,
  Get,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { PlatformGuard } from '../guards/platform.guard';
import { WorkspacesAdminService } from '../services/workspaces-admin.service';
import {
  AssignWorkspacePackageDto,
  UpdateWorkspaceAdminDto,
  UpdateWorkspaceStatusDto,
} from '../dto/platform.dto';
import { Audit } from '../../audit/audit.decorator';

@Controller('platform/workspaces')
@UseGuards(PlatformGuard)
export class WorkspacesAdminController {
  constructor(private readonly workspaces: WorkspacesAdminService) {}

  @Get()
  list(@Query('status') status?: string, @Query('search') search?: string) {
    return this.workspaces.list({ status, search });
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.workspaces.findOne(id);
  }

  @Patch(':id/status')
  @Audit({
    action: 'workspace.status.update',
    resourceType: 'workspace',
    resourceIdParam: 'id',
    captureBody: ['status'],
  })
  updateStatus(@Param('id') id: string, @Body() dto: UpdateWorkspaceStatusDto) {
    return this.workspaces.updateStatus(id, dto.status);
  }

  // Grant a package without a payment (internal OPERATOR plan, comped
  // customer, manual bank-transfer rescue). Money-adjacent and platform-only,
  // so it is audited exactly like the status flip above.
  @Patch(':id/subscription')
  @Audit({
    action: 'workspace.subscription.assign',
    resourceType: 'workspace',
    resourceIdParam: 'id',
    captureBody: ['packageCode'],
  })
  assignSubscription(
    @Param('id') id: string,
    @Body() dto: AssignWorkspacePackageDto,
  ) {
    return this.workspaces.assignPackage(id, dto.packageCode);
  }

  @Patch(':id')
  // The highest-impact operator mutation (tier promote/demote, settings and
  // coreIntegration rewiring) — audited like the adjacent status flip.
  @Audit({
    action: 'workspace.admin.update',
    resourceType: 'workspace',
    resourceIdParam: 'id',
    captureBody: ['name', 'productName', 'kind', 'defaultLanguage', 'defaultCurrency'],
  })
  update(@Param('id') id: string, @Body() dto: UpdateWorkspaceAdminDto) {
    return this.workspaces.update(id, dto);
  }
}
