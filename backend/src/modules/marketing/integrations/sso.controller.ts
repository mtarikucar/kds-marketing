import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import {
  MarketingPublic,
  MarketingRoute,
} from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { Audit } from '../../audit/audit.decorator';
import { SsoService } from '../services/sso.service';

// HTTPS issuers only — an OIDC issuer over http would expose the code exchange.
const HTTPS_ONLY = { protocols: ['https'], require_protocol: true };

class CreateSsoDto {
  @IsUrl(HTTPS_ONLY)
  @MaxLength(500)
  issuer: string;

  @IsString()
  @MaxLength(255)
  clientId: string;

  @IsString()
  @MaxLength(1000)
  clientSecret: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(253, { each: true })
  allowedDomains?: string[];
}

class UpdateSsoDto {
  @IsOptional()
  @IsUrl(HTTPS_ONLY)
  @MaxLength(500)
  issuer?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  clientId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  clientSecret?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(253, { each: true })
  allowedDomains?: string[];
}

/**
 * Epic G — admin CRUD for the workspace's OIDC SSO connection. OWNER/MANAGER
 * only; mutations are audited; the client secret is sealed at rest and NEVER
 * echoed (responses carry only `clientSecretSet: boolean`).
 */
@MarketingRoute()
@Controller('marketing/integrations/sso')
@UseGuards(MarketingGuard, MarketingRolesGuard)
// 'MANAGER' is the floor: the hierarchical guard admits MANAGER and OWNER,
// and rejects REP (co-listing OWNER would raise the bar to OWNER-only).
@MarketingRoles('MANAGER')
export class SsoAdminController {
  constructor(private readonly svc: SsoService) {}

  @Get()
  list(@CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.list(u.workspaceId);
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.get(u.workspaceId, id);
  }

  @Post()
  @Audit({ action: 'sso.create', resourceType: 'sso-connection' })
  create(
    @Body() dto: CreateSsoDto,
    @CurrentMarketingUser() u: MarketingUserPayload,
  ) {
    return this.svc.create(u.workspaceId, dto);
  }

  @Patch(':id')
  @Audit({ action: 'sso.update', resourceType: 'sso-connection', resourceIdParam: 'id' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateSsoDto,
    @CurrentMarketingUser() u: MarketingUserPayload,
  ) {
    return this.svc.update(u.workspaceId, id, dto);
  }

  @Delete(':id')
  @Audit({ action: 'sso.delete', resourceType: 'sso-connection', resourceIdParam: 'id' })
  remove(
    @Param('id') id: string,
    @CurrentMarketingUser() u: MarketingUserPayload,
  ) {
    return this.svc.remove(u.workspaceId, id);
  }
}

const SSO_START_THROTTLE = {
  default: { limit: 20, ttl: 60_000, blockDuration: 60_000 },
};
const SSO_CALLBACK_THROTTLE = {
  default: { limit: 30, ttl: 60_000, blockDuration: 60_000 },
};

/**
 * Epic G — PUBLIC OIDC endpoints (no marketing token; the IdP round-trip IS the
 * authentication). `start` redirects the browser to the IdP authorize URL;
 * `callback` validates the round-trip and returns the app session pair.
 *
 * Inert by design: when the secret-box is unconfigured or the workspace has no
 * enabled connection, `start` answers a clean 404 ("SSO not configured") rather
 * than crashing or leaking whether the workspace exists.
 */
@MarketingRoute()
@Controller('marketing/auth/sso')
@UseGuards(MarketingGuard)
export class SsoPublicController {
  constructor(private readonly svc: SsoService) {}

  @Get('callback')
  @MarketingPublic()
  @Throttle(SSO_CALLBACK_THROTTLE)
  callback(@Query('state') state: string, @Query('code') code: string) {
    return this.svc.handleCallback(state, code);
  }

  @Get(':workspaceSlugOrId/start')
  @MarketingPublic()
  @Throttle(SSO_START_THROTTLE)
  async start(
    @Param('workspaceSlugOrId') slugOrId: string,
    @Query('redirect') redirect: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const workspaceId = await this.svc.resolveWorkspaceId(slugOrId);
    if (!workspaceId) {
      res.status(404).json({ statusCode: 404, message: 'SSO not configured' });
      return;
    }
    // getAuthorizationUrl throws BadRequestException("SSO not configured") when
    // the feature is inert; surface that as a 404 too so the public surface
    // never distinguishes "no IdP" from "no workspace".
    let url: string;
    try {
      ({ url } = await this.svc.getAuthorizationUrl(workspaceId));
    } catch {
      res.status(404).json({ statusCode: 404, message: 'SSO not configured' });
      return;
    }
    // `redirect=0` (or any non-"1") returns the URL as JSON for SPA-driven
    // flows; default behaviour is a 302 to the IdP.
    if (redirect === '0' || redirect === 'false') {
      res.status(200).json({ url });
      return;
    }
    res.redirect(302, url);
  }
}
