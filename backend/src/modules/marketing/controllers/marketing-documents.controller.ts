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
import { Audit } from '../../audit/audit.decorator';
import { DocumentsService } from '../documents/documents.service';
import { CreateDocumentDto, UpdateDocumentDto } from '../dto/document.dto';

/**
 * E-signature documents / contracts (GoHighLevel parity). Read + draft is
 * leads.write (a rep may draft their lead's agreement); SENDING a binding
 * document and void/delete are leads.manage (manager-gated). The signer flow is
 * the separate public controller.
 */
@Controller('marketing/documents')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
@MarketingRoute()
export class MarketingDocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get()
  @RequirePermission('leads.read')
  list(@CurrentMarketingUser() a: MarketingUserPayload) {
    return this.documents.list(a.workspaceId);
  }

  @Get(':id')
  @RequirePermission('leads.read')
  get(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.documents.detail(a.workspaceId, id);
  }

  @Post()
  @RequirePermission('leads.write')
  @Audit({ action: 'document.create', resourceType: 'document', captureBody: ['title'] })
  create(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: CreateDocumentDto) {
    return this.documents.create(a.workspaceId, dto);
  }

  @Patch(':id')
  @RequirePermission('leads.write')
  update(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: UpdateDocumentDto,
  ) {
    return this.documents.update(a.workspaceId, id, dto);
  }

  @Post(':id/send')
  @RequirePermission('leads.manage')
  @Audit({ action: 'document.send', resourceType: 'document' })
  send(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.documents.send(a.workspaceId, id);
  }

  @Post(':id/void')
  @RequirePermission('leads.manage')
  @Audit({ action: 'document.void', resourceType: 'document' })
  void(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.documents.void(a.workspaceId, id);
  }

  @Delete(':id')
  @RequirePermission('leads.manage')
  @Audit({ action: 'document.delete', resourceType: 'document' })
  remove(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.documents.remove(a.workspaceId, id);
  }
}
