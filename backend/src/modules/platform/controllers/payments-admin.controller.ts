import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
  NotFoundException,
} from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PlatformGuard, PlatformOperatorPayload } from '../guards/platform.guard';
import { CurrentOperator } from '../decorators/current-operator.decorator';
import { PrismaService } from '../../../prisma/prisma.service';
import { BillingSettlementService } from '../../billing/billing-settlement.service';

class RejectPaymentDto {
  @IsOptional() @IsString() @MaxLength(500)
  reason?: string;
}

/**
 * Manual bank-transfer queue: AWAITING_TRANSFER orders wait here until an
 * operator matches the incoming wire (by the MKT-… reference) and approves.
 * Approval runs through the same idempotent settlement path the PSP
 * webhooks use — operators cannot invent a different activation.
 */
@Controller('platform/payments')
@UseGuards(PlatformGuard)
export class PaymentsAdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settlement: BillingSettlementService,
  ) {}

  @Get()
  async list(@Query('status') status?: string) {
    const orders = await this.prisma.paymentOrder.findMany({
      where: { status: status || 'AWAITING_TRANSFER' },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });

    // Hydrate workspace names in one query (soft refs, no relations).
    const wsIds = [...new Set(orders.map((o) => o.workspaceId))];
    const workspaces = await this.prisma.workspace.findMany({
      where: { id: { in: wsIds } },
      select: { id: true, slug: true, name: true },
    });
    const wsById = new Map(workspaces.map((w) => [w.id, w]));

    const pkgIds = [...new Set(orders.map((o) => o.packageId).filter(Boolean))] as string[];
    const packages = await this.prisma.package.findMany({
      where: { id: { in: pkgIds } },
      select: { id: true, code: true, name: true },
    });
    const pkgById = new Map(packages.map((p) => [p.id, p]));

    return orders.map((o) => ({
      ...o,
      workspace: wsById.get(o.workspaceId) ?? null,
      package: o.packageId ? (pkgById.get(o.packageId) ?? null) : null,
    }));
  }

  @Post(':orderId/approve')
  async approve(
    @CurrentOperator() operator: PlatformOperatorPayload,
    @Param('orderId') orderId: string,
  ) {
    const result = await this.settlement.settleSuccess(orderId, {
      approvedById: operator.id,
      raw: { manualApproval: { by: operator.email, at: new Date().toISOString() } },
    });
    if (!result.settled && result.reason === 'order not found') {
      throw new NotFoundException('Order not found');
    }
    return result;
  }

  @Post(':orderId/reject')
  async reject(
    @CurrentOperator() operator: PlatformOperatorPayload,
    @Param('orderId') orderId: string,
    @Body() dto: RejectPaymentDto,
  ) {
    return this.settlement.settleFailure(
      orderId,
      dto.reason ?? `rejected by ${operator.email}`,
      { manualRejection: { by: operator.email, at: new Date().toISOString() } },
    );
  }
}
