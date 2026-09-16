import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
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
import { EstimatesService } from '../estimates/estimates.service';
import { DocumentEmailService } from '../invoicing/document-email.service';
import { CreateEstimateDto, ListEstimatesQueryDto, UpdateEstimateDto } from '../dto/estimate.dto';

/**
 * Estimates / quotes (GoHighLevel parity). Reads leads.read; create/edit/send/
 * accept/decline/convert/delete require leads.write (REP-capable — reps quote
 * their own leads). Backend enforces both; workspace context via MarketingGuard.
 */
@Controller('marketing/estimates')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
@MarketingRoute()
export class MarketingEstimatesController {
  constructor(
    private readonly estimates: EstimatesService,
    private readonly documentEmail: DocumentEmailService,
  ) {}

  /** `?leadId=` narrows to one contact — the person record card's read. */
  @Get()
  @RequirePermission('leads.read')
  list(@CurrentMarketingUser() a: MarketingUserPayload, @Query() q: ListEstimatesQueryDto) {
    return this.estimates.list(a.workspaceId, q.leadId);
  }

  @Get(':id')
  @RequirePermission('leads.read')
  get(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.estimates.get(a.workspaceId, id);
  }

  @Post()
  @RequirePermission('leads.write')
  @Audit({ action: 'estimate.create', resourceType: 'estimate' })
  create(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: CreateEstimateDto) {
    return this.estimates.create(a.workspaceId, dto);
  }

  @Patch(':id')
  @RequirePermission('leads.write')
  update(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: UpdateEstimateDto,
  ) {
    return this.estimates.update(a.workspaceId, id, dto);
  }

  @Post(':id/send')
  @RequirePermission('leads.write')
  send(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.estimates.send(a.workspaceId, id);
  }

  /** Email the quote's public accept/decline page to the contact. */
  @Post(':id/email')
  @RequirePermission('leads.write')
  @Audit({ action: 'estimate.email', resourceType: 'estimate' })
  email(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.documentEmail.sendEstimate(a.workspaceId, id, a.id);
  }

  @Post(':id/accept')
  @RequirePermission('leads.write')
  @Audit({ action: 'estimate.accept', resourceType: 'estimate' })
  accept(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.estimates.accept(a.workspaceId, id);
  }

  @Post(':id/decline')
  @RequirePermission('leads.write')
  decline(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.estimates.decline(a.workspaceId, id);
  }

  @Post(':id/convert')
  @RequirePermission('leads.write')
  @Audit({ action: 'estimate.convert', resourceType: 'estimate' })
  convert(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.estimates.convertToInvoice(a.workspaceId, id);
  }

  @Delete(':id')
  @RequirePermission('leads.write')
  @Audit({ action: 'estimate.delete', resourceType: 'estimate' })
  remove(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.estimates.remove(a.workspaceId, id);
  }
}
