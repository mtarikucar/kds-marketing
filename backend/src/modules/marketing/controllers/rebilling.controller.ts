import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Query,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import {
  IsBoolean,
  IsISO8601,
  IsNumberString,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { MarketingUserPayload } from '../types';
import { Audit } from '../../audit/audit.decorator';
import { PrismaService } from '../../../prisma/prisma.service';
import { RebillingService } from '../services/rebilling.service';

// ─── DTOs ─────────────────────────────────────────────────────────────────────

/**
 * Money fields arrive as numeric STRINGS so we never lose Decimal precision through
 * JS float — the service coerces them to Decimal(10,2). markupPercent is a percentage
 * (e.g. "20" = 20%).
 */
class UpsertPlanDto {
  @IsNumberString()
  basePrice: string;

  @IsNumberString()
  usageUnitPrice: string;

  @IsNumberString()
  markupPercent: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

class ComputeChargeDto {
  @IsISO8601()
  periodStart: string;

  @IsISO8601()
  periodEnd: string;
}

class ListChargesQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  locationWorkspaceId?: string;
}

// ─── Controller ───────────────────────────────────────────────────────────────

/**
 * Epic D1 — agency REBILLING / SaaS-mode (GoHighLevel parity).
 *
 * Every route is AGENCY-OWNER gated, exactly like AgencyController / SnapshotController:
 * MarketingGuard authenticates (still single-workspace), MarketingRolesGuard requires
 * OWNER, and {@link assertAgencyKind} rejects any caller whose workspace.kind !== AGENCY
 * with 403. The agency→child widening lives in RebillingService behind assertAgencyOwns
 * (the D1 parent-ownership gate), so normal tenants are wholly unaffected.
 *
 * Mutations (plan upsert, compute-charge, charge) are @Audit-logged; each captures the
 * agency as the actor workspace and the LOCATION id as the audited resourceId, so every
 * cross-into-child money action records BOTH ids. The live Stripe-Connect charge is
 * ENV-GATED inside the service (inert + clean when unset) — this controller exposes it
 * unconditionally and lets the service decide.
 */
@Controller('marketing/agency/rebilling')
@UseGuards(MarketingGuard, MarketingRolesGuard)
@MarketingRoute()
export class RebillingController {
  constructor(
    private readonly rebilling: RebillingService,
    private readonly prisma: PrismaService,
  ) {}

  /** Reject any caller whose workspace is not an AGENCY (explicit kind gate). */
  private async assertAgencyKind(workspaceId: string): Promise<void> {
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { kind: true },
    });
    if (!ws || ws.kind !== 'AGENCY') {
      throw new ForbiddenException('This workspace is not an agency');
    }
  }

  // ── Plans ───────────────────────────────────────────────────────────────────

  @Get('plans')
  @MarketingRoles('OWNER')
  async listPlans(@CurrentMarketingUser() user: MarketingUserPayload) {
    await this.assertAgencyKind(user.workspaceId);
    return this.rebilling.listPlans(user.workspaceId);
  }

  @Get('plans/:locationId')
  @MarketingRoles('OWNER')
  async getPlan(
    @Param('locationId') locationId: string,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    await this.assertAgencyKind(user.workspaceId);
    return this.rebilling.getPlan(user.workspaceId, locationId);
  }

  @Put('plans/:locationId')
  @MarketingRoles('OWNER')
  @Audit({
    action: 'agency.rebilling.plan.upsert',
    resourceType: 'workspace',
    resourceIdParam: 'locationId',
    captureBody: ['basePrice', 'usageUnitPrice', 'markupPercent', 'enabled'],
  })
  async upsertPlan(
    @Param('locationId') locationId: string,
    @Body() dto: UpsertPlanDto,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    await this.assertAgencyKind(user.workspaceId);
    return this.rebilling.upsertPlan(user.workspaceId, locationId, dto);
  }

  // ── Charges ─────────────────────────────────────────────────────────────────

  @Get('charges')
  @MarketingRoles('OWNER')
  async listCharges(
    @Query() query: ListChargesQueryDto,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    await this.assertAgencyKind(user.workspaceId);
    return this.rebilling.listCharges(user.workspaceId, query.locationWorkspaceId);
  }

  @Post('charges/:locationId/compute')
  @MarketingRoles('OWNER')
  @Audit({
    action: 'agency.rebilling.charge.compute',
    resourceType: 'workspace',
    resourceIdParam: 'locationId',
    captureBody: ['periodStart', 'periodEnd'],
  })
  async computeCharge(
    @Param('locationId') locationId: string,
    @Body() dto: ComputeChargeDto,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    await this.assertAgencyKind(user.workspaceId);
    return this.rebilling.computeCharge(
      user.workspaceId,
      locationId,
      new Date(dto.periodStart),
      new Date(dto.periodEnd),
    );
  }

  /**
   * Attempt the live (env-gated) outbound charge for a DRAFT settlement line. When
   * Stripe Connect is not configured the service throws a clean 503 and the charge
   * stays DRAFT (internal settlement only). Idempotent at the service.
   */
  @Post('charges/:chargeId/charge')
  @MarketingRoles('OWNER')
  @Audit({
    action: 'agency.rebilling.charge.settle',
    resourceType: 'rebillCharge',
    resourceIdParam: 'chargeId',
    captureBody: [],
  })
  async charge(
    @Param('chargeId') chargeId: string,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    await this.assertAgencyKind(user.workspaceId);
    return this.rebilling.chargeViaStripeConnect(user.workspaceId, chargeId);
  }
}
