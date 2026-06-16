import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { MarketingUserPayload } from '../types';
import { Audit } from '../../audit/audit.decorator';
import { PrismaService } from '../../../prisma/prisma.service';
import { SnapshotService } from '../services/snapshot.service';

// ─── DTOs ─────────────────────────────────────────────────────────────────────

class CreateSnapshotDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  /**
   * Source workspace to capture. Optional — defaults to the agency workspace
   * itself. If provided it must be one of the agency's own LOCATION children
   * (enforced in the service via assertAgencyOwns).
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  sourceWorkspaceId?: string;
}

// ─── Controller ───────────────────────────────────────────────────────────────

/**
 * Epic D1 — agency config SNAPSHOTS (GoHighLevel parity).
 *
 * Every route is AGENCY-OWNER gated, exactly like AgencyController: MarketingGuard
 * authenticates (still single-workspace), MarketingRolesGuard requires OWNER, and
 * {@link assertAgencyKind} rejects any caller whose workspace.kind !== AGENCY with
 * 403. The agency→child widening lives in SnapshotService behind assertAgencyOwns
 * (the D1 parent-ownership gate), so normal tenants are wholly unaffected.
 *
 * Mutations (capture, apply) are @Audit-logged. capture records the agency as the
 * actor workspace; apply additionally captures the TARGET location id as the
 * audited resourceId, so each cross-into-child clone records BOTH ids.
 */
@Controller('marketing/agency/snapshots')
@UseGuards(MarketingGuard, MarketingRolesGuard)
@MarketingRoute()
export class SnapshotController {
  constructor(
    private readonly snapshots: SnapshotService,
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

  @Get()
  @MarketingRoles('OWNER')
  async list(@CurrentMarketingUser() user: MarketingUserPayload) {
    await this.assertAgencyKind(user.workspaceId);
    return this.snapshots.list(user.workspaceId);
  }

  @Post()
  @MarketingRoles('OWNER')
  @Audit({
    action: 'agency.snapshot.capture',
    resourceType: 'snapshot',
    captureBody: ['name', 'sourceWorkspaceId'],
  })
  async capture(
    @Body() dto: CreateSnapshotDto,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    await this.assertAgencyKind(user.workspaceId);
    return this.snapshots.capture(user.workspaceId, dto);
  }

  @Get(':snapshotId')
  @MarketingRoles('OWNER')
  async get(
    @Param('snapshotId') snapshotId: string,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    await this.assertAgencyKind(user.workspaceId);
    return this.snapshots.get(user.workspaceId, snapshotId);
  }

  @Post(':snapshotId/apply/:locationId')
  @MarketingRoles('OWNER')
  @Audit({
    action: 'agency.snapshot.apply',
    resourceType: 'workspace',
    resourceIdParam: 'locationId',
    captureBody: [],
  })
  async apply(
    @Param('snapshotId') snapshotId: string,
    @Param('locationId') locationId: string,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    await this.assertAgencyKind(user.workspaceId);
    return this.snapshots.apply(snapshotId, locationId, user.workspaceId);
  }
}
