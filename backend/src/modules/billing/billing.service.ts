import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
  Inject,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EntitlementsService } from './entitlements.service';
import {
  BillingPaymentProvider,
  BILLING_PAYMENT_PROVIDERS,
  CheckoutHandle,
} from './payments/payment-provider.port';
import { ADDON_GRANTS } from './billing-settlement.service';

export interface CheckoutInput {
  packageCode?: string;
  addOnCode?: string;
  billingCycle?: 'MONTHLY' | 'YEARLY';
  provider: 'paytr' | 'stripe' | 'manual';
}

/** Add-on price anchors (per unit, per current period). */
const ADDON_PRICES: Record<string, { TRY: number; USD: number; name: string }> = {
  quota_boost_10: { TRY: 2690, USD: 79, name: '+10 leads/day boost' },
  extra_profile: { TRY: 1690, USD: 49, name: 'Extra research profile' },
  // Phase F P1 — AI metering boosts (monthly recurring; fold via ADDON_GRANTS).
  ai_credit_boost_500: { TRY: 290, USD: 9, name: '+500 AI credits / month' },
  messages_boost_1000: { TRY: 190, USD: 6, name: '+1000 messages / month' },
};

/**
 * Checkout orchestration + the billing summary the panel renders. Providers
 * only mint checkout handles; activation always flows through
 * BillingSettlementService (webhooks / operator approval).
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly configService: ConfigService,
    @Inject(BILLING_PAYMENT_PROVIDERS)
    private readonly providers: BillingPaymentProvider[],
  ) {}

  /** Public pricing table (also used by the marketing site later). */
  async listPackages() {
    return this.prisma.package.findMany({
      where: { isPublic: true, status: 'ACTIVE' },
      orderBy: { sortOrder: 'asc' },
      select: {
        code: true,
        name: true,
        description: true,
        dailyLeadQuota: true,
        maxUsers: true,
        maxResearchProfiles: true,
        features: true,
        priceMonthlyTRY: true,
        priceMonthlyUSD: true,
        priceYearlyTRY: true,
        priceYearlyUSD: true,
        trialDays: true,
      },
    });
  }

  async summary(workspaceId: string) {
    const [entitlements, sub, workspace] = await Promise.all([
      this.entitlements.getEffective(workspaceId),
      this.prisma.workspaceSubscription.findUnique({ where: { workspaceId } }),
      this.prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { defaultCurrency: true },
      }),
    ]);

    const pkg = sub
      ? await this.prisma.package.findUnique({
          where: { id: sub.packageId },
          select: { code: true, name: true },
        })
      : null;

    const addons = await this.prisma.workspaceAddOn.findMany({
      where: {
        workspaceId,
        status: 'ACTIVE',
        OR: [{ currentPeriodEnd: null }, { currentPeriodEnd: { gt: new Date() } }],
      },
      select: { code: true, quantity: true, currentPeriodEnd: true },
    });

    return {
      currency: workspace?.defaultCurrency ?? 'USD',
      subscription: sub
        ? {
            status: sub.status,
            packageCode: pkg?.code ?? null,
            packageName: pkg?.name ?? null,
            billingCycle: sub.billingCycle,
            currentPeriodEnd: sub.currentPeriodEnd,
            trialEndsAt: sub.trialEndsAt,
            cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
          }
        : null,
      entitlements,
      addons,
      providers: this.providers
        .filter((p) => p.isConfigured())
        .map((p) => p.id),
    };
  }

  async orders(workspaceId: string) {
    return this.prisma.paymentOrder.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        type: true,
        packageId: true,
        addOnCode: true,
        billingCycle: true,
        amount: true,
        currency: true,
        provider: true,
        providerRef: true,
        status: true,
        createdAt: true,
        succeededAt: true,
        failureReason: true,
      },
    });
  }

  async checkout(
    workspaceId: string,
    input: CheckoutInput,
    ctx: { buyerEmail: string; buyerIp: string },
  ): Promise<{ orderId: string; handle: CheckoutHandle }> {
    if (Boolean(input.packageCode) === Boolean(input.addOnCode)) {
      throw new BadRequestException(
        'Exactly one of packageCode or addOnCode is required',
      );
    }

    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { defaultCurrency: true, status: true },
    });
    if (!workspace || workspace.status !== 'ACTIVE') {
      throw new NotFoundException('Workspace not found');
    }
    const currency = workspace.defaultCurrency === 'TRY' ? 'TRY' : 'USD';

    const provider = this.providers.find((p) => p.id === input.provider);
    if (!provider || !provider.isConfigured()) {
      throw new ServiceUnavailableException(
        `Payment provider ${input.provider} is not available`,
      );
    }
    if (!provider.supports(currency)) {
      throw new BadRequestException(
        `${input.provider} does not support ${currency} — use ${
          currency === 'TRY' ? 'paytr or manual' : 'stripe or manual'
        }`,
      );
    }

    let order;
    if (input.packageCode) {
      const pkg = await this.prisma.package.findUnique({
        where: { code: input.packageCode },
      });
      if (!pkg || !pkg.isPublic || pkg.status !== 'ACTIVE') {
        throw new NotFoundException('Package not found');
      }
      const cycle = input.billingCycle === 'YEARLY' ? 'YEARLY' : 'MONTHLY';
      const amount =
        cycle === 'YEARLY'
          ? currency === 'TRY'
            ? pkg.priceYearlyTRY
            : pkg.priceYearlyUSD
          : currency === 'TRY'
            ? pkg.priceMonthlyTRY
            : pkg.priceMonthlyUSD;
      if (amount === null || amount === undefined) {
        throw new BadRequestException(`No ${cycle} price for ${pkg.code}`);
      }
      if (Number(amount) <= 0) {
        throw new BadRequestException(
          'Free packages are not purchasable — they are granted at signup',
        );
      }

      const existing = await this.prisma.workspaceSubscription.findUnique({
        where: { workspaceId },
        select: { packageId: true },
      });
      order = await this.prisma.paymentOrder.create({
        data: {
          workspaceId,
          type: existing && existing.packageId !== pkg.id ? 'UPGRADE' : 'SUBSCRIPTION',
          packageId: pkg.id,
          billingCycle: cycle,
          amount,
          currency,
          provider: provider.id,
          idempotencyKey: randomUUID(),
        },
      });
    } else {
      const code = input.addOnCode!;
      const price = ADDON_PRICES[code];
      if (!price || !ADDON_GRANTS[code]) {
        throw new NotFoundException('Add-on not found');
      }
      // Boosts extend a live subscription — there must be one to extend.
      const ent = await this.entitlements.getEffective(workspaceId);
      if (!ent.packageCode) {
        throw new BadRequestException(
          'An active subscription is required before buying add-ons',
        );
      }
      order = await this.prisma.paymentOrder.create({
        data: {
          workspaceId,
          type: 'ADDON',
          addOnCode: code,
          amount: new Prisma.Decimal(currency === 'TRY' ? price.TRY : price.USD),
          currency,
          provider: provider.id,
          idempotencyKey: randomUUID(),
        },
      });
    }

    const returnUrl =
      this.configService.get<string>('FRONTEND_URL') ?? 'http://localhost:5173';
    const handle = await provider.createCheckout(order, {
      buyerEmail: ctx.buyerEmail,
      buyerIp: ctx.buyerIp,
      returnUrl: `${returnUrl.replace(/\/+$/, '')}/billing`,
    });

    return { orderId: order.id, handle };
  }
}

export { ADDON_PRICES };
