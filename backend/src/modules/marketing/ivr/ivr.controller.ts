import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { FeatureGuard, RequiresFeature } from '../guards/feature.guard';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { Audit } from '../../audit/audit.decorator';
import { IVR_ACTIONS, IvrService } from './ivr.service';

class CreateMenuDto {
  @IsString() @MinLength(1) @MaxLength(120) name: string;
  @IsString() @MinLength(1) @MaxLength(4000) greeting: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsBoolean() isRoot?: boolean;
}

class UpdateMenuDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(4000) greeting?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsBoolean() isRoot?: boolean;
}

class CreateOptionDto {
  @Matches(/^[0-9*#]$/, { message: 'digit must be one of 0-9, * or #' })
  digit: string;

  @IsString() @MinLength(1) @MaxLength(120) label: string;

  @IsIn(IVR_ACTIONS as unknown as string[])
  action: (typeof IVR_ACTIONS)[number];

  @IsOptional() @IsString() @MaxLength(64) targetMenuId?: string | null;

  @IsOptional()
  @Matches(/^\+[1-9]\d{1,14}$/, { message: 'dialNumber must be E.164' })
  dialNumber?: string | null;
}

/**
 * Admin CRUD for IVR / phone-tree menus + their keypad options. OWNER/MANAGER
 * only, behind the same `voiceAi` entitlement as the rest of the voice module.
 * Mutations are @Audit'd. The TwiML these menus produce is served by the public
 * Twilio webhook (TwilioVoiceController) — this controller is config only.
 */
@MarketingRoute()
@Controller('marketing/ivr')
@UseGuards(MarketingGuard, MarketingRolesGuard, FeatureGuard)
@MarketingRoles('OWNER', 'MANAGER')
@RequiresFeature('voiceAi')
export class IvrController {
  constructor(private readonly ivr: IvrService) {}

  @Get('menus')
  listMenus(@CurrentMarketingUser() u: MarketingUserPayload) {
    return this.ivr.listMenus(u.workspaceId);
  }

  @Get('menus/:id')
  getMenu(@CurrentMarketingUser() u: MarketingUserPayload, @Param('id') id: string) {
    return this.ivr.getMenu(u.workspaceId, id);
  }

  @Post('menus')
  @Audit({ action: 'ivr.menu.create', resourceType: 'ivr-menu', captureBody: ['name', 'isRoot', 'enabled'] })
  createMenu(@CurrentMarketingUser() u: MarketingUserPayload, @Body() dto: CreateMenuDto) {
    return this.ivr.createMenu(u.workspaceId, dto);
  }

  @Patch('menus/:id')
  @Audit({ action: 'ivr.menu.update', resourceType: 'ivr-menu', resourceIdParam: 'id', captureBody: ['name', 'isRoot', 'enabled'] })
  updateMenu(
    @CurrentMarketingUser() u: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: UpdateMenuDto,
  ) {
    return this.ivr.updateMenu(u.workspaceId, id, dto);
  }

  @Delete('menus/:id')
  @Audit({ action: 'ivr.menu.delete', resourceType: 'ivr-menu', resourceIdParam: 'id' })
  deleteMenu(@CurrentMarketingUser() u: MarketingUserPayload, @Param('id') id: string) {
    return this.ivr.deleteMenu(u.workspaceId, id);
  }

  @Post('menus/:id/options')
  @Audit({ action: 'ivr.option.create', resourceType: 'ivr-option', resourceIdParam: 'id', captureBody: ['digit', 'action'] })
  addOption(
    @CurrentMarketingUser() u: MarketingUserPayload,
    @Param('id') menuId: string,
    @Body() dto: CreateOptionDto,
  ) {
    return this.ivr.addOption(u.workspaceId, menuId, dto);
  }

  @Delete('menus/:id/options/:optionId')
  @Audit({ action: 'ivr.option.delete', resourceType: 'ivr-option', resourceIdParam: 'optionId' })
  deleteOption(
    @CurrentMarketingUser() u: MarketingUserPayload,
    @Param('id') menuId: string,
    @Param('optionId') optionId: string,
  ) {
    return this.ivr.deleteOption(u.workspaceId, menuId, optionId);
  }
}
