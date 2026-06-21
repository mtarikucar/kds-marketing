import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import * as QRCode from 'qrcode';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { TriggerLinksService } from '../trigger-links/trigger-links.service';
import { CreateTriggerLinkDto, UpdateTriggerLinkDto } from '../dto/trigger-link.dto';

/**
 * Trigger links management (GHL parity). MANAGER + campaigns.read to view,
 * settings.manage to mutate — a trigger link is workspace marketing config that
 * drives automation. The QR endpoint streams a PNG of the public click URL.
 */
@MarketingRoute()
@Controller('marketing/trigger-links')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
@MarketingRoles('MANAGER')
export class MarketingTriggerLinksController {
  constructor(private readonly links: TriggerLinksService) {}

  @Get()
  @RequirePermission('campaigns.read')
  list(@CurrentMarketingUser() a: MarketingUserPayload) {
    return this.links.list(a.workspaceId);
  }

  @Get(':id/stats')
  @RequirePermission('campaigns.read')
  stats(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.links.stats(a.workspaceId, id);
  }

  /** PNG QR code of the link's public click URL. */
  @Get(':id/qr.png')
  @RequirePermission('campaigns.read')
  async qr(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    const link = await this.links.stats(a.workspaceId, id); // scoped resolve (404 if foreign)
    const png = await QRCode.toBuffer(link.url, { type: 'png', width: 512, margin: 2 });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `inline; filename="qr-${link.slug}.png"`);
    res.send(png);
  }

  @Post()
  @RequirePermission('settings.manage')
  create(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: CreateTriggerLinkDto) {
    return this.links.create(a.workspaceId, dto);
  }

  @Patch(':id')
  @RequirePermission('settings.manage')
  update(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: UpdateTriggerLinkDto,
  ) {
    return this.links.update(a.workspaceId, id, dto);
  }

  @Delete(':id')
  @RequirePermission('settings.manage')
  remove(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.links.remove(a.workspaceId, id);
  }
}
