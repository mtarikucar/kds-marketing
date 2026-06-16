import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { MarketingUserPayload } from '../types';
import { Audit } from '../../audit/audit.decorator';
import { PrismaService } from '../../../prisma/prisma.service';
import { AgencyService } from '../services/agency.service';

// ─── DTOs ─────────────────────────────────────────────────────────────────────

class CreateLocationDto {
  @IsString()
  @MaxLength(120)
  name: string;

  @IsString()
  @MaxLength(120)
  productName: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  productUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  productDescription?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  language?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  currency?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @IsEmail()
  ownerEmail: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  ownerPassword: string;

  @IsString()
  @MaxLength(80)
  ownerFirstName: string;

  @IsString()
  @MaxLength(80)
  ownerLastName: string;
}

class SuspendLocationDto {
  @IsOptional()
  @IsIn(['SUSPENDED', 'ACTIVE'])
  status?: 'SUSPENDED' | 'ACTIVE';
}

// ─── Controller ───────────────────────────────────────────────────────────────

/**
 * Epic D1 — agency / sub-account management (GoHighLevel parity).
 *
 * Every route is gated to an AGENCY-workspace OWNER: MarketingGuard authenticates
 * (unchanged, still single-workspace), MarketingRolesGuard requires OWNER, and
 * {@link assertAgencyKind} rejects any caller whose workspace.kind !== AGENCY
 * with 403. The agency→child widening lives entirely in AgencyService behind
 * assertAgencyOwns (parent-ownership), so normal tenants are wholly unaffected.
 *
 * Every mutation is @Audit-logged; the agency id is the actor's workspaceId on
 * the audit row and the location id is captured as the resourceId, so each
 * cross-into-child write records BOTH workspace ids.
 */
@Controller('marketing/agency')
@UseGuards(MarketingGuard, MarketingRolesGuard)
@MarketingRoute()
export class AgencyController {
  constructor(
    private readonly agencyService: AgencyService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Reject any caller whose workspace is not an AGENCY. Done as an explicit
   * per-request check (not a loosened guard) so the kind gate is visible and
   * auditable. OWNER-rank is already enforced by MarketingRolesGuard below.
   */
  private async assertAgencyKind(workspaceId: string): Promise<void> {
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { kind: true },
    });
    if (!ws || ws.kind !== 'AGENCY') {
      throw new ForbiddenException('This workspace is not an agency');
    }
  }

  @Get('locations')
  @MarketingRoles('OWNER')
  async listLocations(@CurrentMarketingUser() user: MarketingUserPayload) {
    await this.assertAgencyKind(user.workspaceId);
    return this.agencyService.listLocations(user.workspaceId);
  }

  @Post('locations')
  @MarketingRoles('OWNER')
  @Audit({
    action: 'agency.location.create',
    resourceType: 'workspace',
    captureBody: ['name', 'ownerEmail'],
  })
  async createLocation(
    @Body() dto: CreateLocationDto,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    await this.assertAgencyKind(user.workspaceId);
    return this.agencyService.createLocation(user.workspaceId, dto);
  }

  @Get('dashboard')
  @MarketingRoles('OWNER')
  async dashboard(@CurrentMarketingUser() user: MarketingUserPayload) {
    await this.assertAgencyKind(user.workspaceId);
    return this.agencyService.dashboard(user.workspaceId);
  }

  @Get('locations/:locationId')
  @MarketingRoles('OWNER')
  async getLocation(
    @Param('locationId') locationId: string,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    await this.assertAgencyKind(user.workspaceId);
    return this.agencyService.getLocation(user.workspaceId, locationId);
  }

  @Patch('locations/:locationId/suspend')
  @MarketingRoles('OWNER')
  @Audit({
    action: 'agency.location.suspend',
    resourceType: 'workspace',
    resourceIdParam: 'locationId',
    captureBody: ['status'],
  })
  async suspendLocation(
    @Param('locationId') locationId: string,
    @Body() dto: SuspendLocationDto,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    await this.assertAgencyKind(user.workspaceId);
    return this.agencyService.suspendLocation(
      user.workspaceId,
      locationId,
      dto.status ?? 'SUSPENDED',
    );
  }
}
