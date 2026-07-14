import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PlatformGuard, PlatformOperatorPayload } from '../guards/platform.guard';
import { CurrentOperator } from '../decorators/current-operator.decorator';
import { PrismaService } from '../../../prisma/prisma.service';
import { BillingSettlementService } from '../../billing/billing-settlement.service';
import { Audit } from '../../audit/audit.decorator';

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

  /** Manual settlement is for bank transfers ONLY. A PENDING order is an
   *  in-flight PSP card checkout that settles via its webhook: an operator
   *  flip there would either provision an unpaid order (approve) or FAIL an
   *  order the customer then completes at the PSP — charged but never
   *  provisioned (reject). Both settle* calls accept PENDING, so the gate
   *  lives here at the manual entrance. */
  private async assertManuallySettleable(orderId: string): Promise<void> {
    const order = await this.prisma.paymentOrder.findUnique({
      where: { id: orderId },
      select: { status: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status !== 'AWAITING_TRANSFER') {
      throw new ConflictException(
        `Only bank-transfer (AWAITING_TRANSFER) orders can be settled manually — this order is ${order.status}`,
      );
    }
  }

  @Post(':orderId/approve')
  @Audit({
    action: 'payment.manual.approve',
    resourceType: 'order',
    resourceIdParam: 'orderId',
  })
  async approve(
    @CurrentOperator() operator: PlatformOperatorPayload,
    @Param('orderId') orderId: string,
  ) {
    await this.assertManuallySettleable(orderId);
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
  @Audit({
    action: 'payment.manual.reject',
    resourceType: 'order',
    resourceIdParam: 'orderId',
    captureBody: ['reason'],
  })
  async reject(
    @CurrentOperator() operator: PlatformOperatorPayload,
    @Param('orderId') orderId: string,
    @Body() dto: RejectPaymentDto,
  ) {
    await this.assertManuallySettleable(orderId);
    return this.settlement.settleFailure(
      orderId,
      dto.reason ?? `rejected by ${operator.email}`,
      { manualRejection: { by: operator.email, at: new Date().toISOString() } },
    );
  }
}
