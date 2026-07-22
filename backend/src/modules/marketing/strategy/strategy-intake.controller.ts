import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { Audit } from '../../audit/audit.decorator';
import { StrategyIntakeService } from './intake/strategy-intake.service';
import { StrategySynthesisService } from './synthesis/strategy-synthesis.service';

const SOCIAL_NETWORKS = ['INSTAGRAM', 'FACEBOOK', 'LINKEDIN'] as const;

class IntakeSocialDto {
  @IsIn(SOCIAL_NETWORKS)
  network: 'INSTAGRAM' | 'FACEBOOK' | 'LINKEDIN';

  @IsString() @MaxLength(200)
  handle: string;
}

class StartIntakeDto {
  @IsOptional() @IsUrl() @MaxLength(500)
  url?: string;

  @IsOptional() @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => IntakeSocialDto)
  socials?: IntakeSocialDto[];

  @IsOptional() @IsString() @MaxLength(500)
  oneLiner?: string;
}

class AnswerIntakeDto {
  @IsString() @MaxLength(200)
  sessionId: string;

  @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(2000, { each: true })
  answers: string[];
}

class FinishIntakeDto {
  @IsString() @MaxLength(200)
  sessionId: string;
}

/**
 * Strategy Engine — hybrid onboarding surface. `start` opens an adaptive AI
 * interview (auto-analysis + first questions), `answer` advances the bounded
 * loop, `finish` hands the completed session to synthesis to produce the
 * `MarketingStrategy` + ActionPlan. Same guard stack as the other AI-metered
 * governance surfaces (MANAGER + settings.manage + audited) since each call
 * spends credits and (re)writes the workspace's single strategy.
 */
@MarketingRoute()
@Controller('marketing/strategy/intake')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
@MarketingRoles('MANAGER')
export class StrategyIntakeController {
  constructor(
    private readonly intake: StrategyIntakeService,
    private readonly synthesis: StrategySynthesisService,
  ) {}

  @Post('start')
  @RequirePermission('settings.manage')
  @Audit({ action: 'strategy.intake.start', resourceType: 'marketing_strategy', captureBody: ['url', 'oneLiner'] })
  start(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: StartIntakeDto) {
    return this.intake.start(a.workspaceId, dto);
  }

  @Post('answer')
  @RequirePermission('settings.manage')
  @Audit({ action: 'strategy.intake.answer', resourceType: 'marketing_strategy', captureBody: ['sessionId'] })
  answer(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: AnswerIntakeDto) {
    return this.intake.answer(a.workspaceId, dto.sessionId, dto.answers);
  }

  @Post('finish')
  @RequirePermission('settings.manage')
  @Audit({ action: 'strategy.intake.finish', resourceType: 'marketing_strategy', captureBody: ['sessionId'] })
  finish(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: FinishIntakeDto) {
    return this.synthesis.synthesize(a.workspaceId, dto.sessionId);
  }
}
