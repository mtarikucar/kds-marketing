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

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateWorkspaceAdminDto) {
    return this.workspaces.update(id, dto);
  }
}
