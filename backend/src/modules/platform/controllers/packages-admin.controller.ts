import { Controller, Get, UseGuards } from '@nestjs/common';
import { PlatformGuard } from '../guards/platform.guard';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * The package catalog as the OPERATOR console needs to see it.
 *
 * WHY this exists instead of reusing `GET /marketing/billing/packages`:
 *
 *   1. Different realm. That route is guarded by MarketingGuard/@MarketingPublic
 *      and the SPA reaches it with the marketing access token; the platform
 *      panel only holds a PLATFORM_JWT_SECRET token. Calling it from here would
 *      either 401 or (worse) carry the wrong realm's credential.
 *   2. Different rows. `BillingService.listPackages()` filters `isPublic: true`
 *      because it powers the public pricing table — which hides the one package
 *      this console exists to hand out (OPERATOR, isPublic:false), plus TRIAL.
 *      An operator picker built on it literally could not grant the internal
 *      package.
 *
 * RETIRED packages are excluded: `assignPackageToWorkspace` would happily grant
 * one (it looks up by code only), but a retired plan is deliberately no longer
 * sellable, so it does not belong in a "pick a package" list.
 */
@Controller('platform/packages')
@UseGuards(PlatformGuard)
export class PackagesAdminController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list() {
    const packages = await this.prisma.package.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { sortOrder: 'asc' },
      select: {
        code: true,
        name: true,
        description: true,
        isPublic: true,
        sortOrder: true,
        trialDays: true,
        dailyLeadQuota: true,
        maxUsers: true,
        maxResearchProfiles: true,
        limits: true,
        priceMonthlyTRY: true,
        priceMonthlyUSD: true,
        priceYearlyTRY: true,
        priceYearlyUSD: true,
      },
    });

    return packages.map((p) => ({
      code: p.code,
      name: p.name,
      description: p.description,
      // false = internal grant (OPERATOR, TRIAL), never bought by a customer.
      // The console badges these so an operator can tell an unlimited internal
      // package apart from a paid customer tier.
      isPublic: p.isPublic,
      sortOrder: p.sortOrder,
      trialDays: p.trialDays,
      // Prisma Decimal serialises to a string over JSON; hand the panel numbers.
      prices: {
        monthlyTRY: Number(p.priceMonthlyTRY),
        monthlyUSD: Number(p.priceMonthlyUSD),
        yearlyTRY: p.priceYearlyTRY === null ? null : Number(p.priceYearlyTRY),
        yearlyUSD: p.priceYearlyUSD === null ? null : Number(p.priceYearlyUSD),
      },
      // Folded exactly like PackageAssignmentResult.limits, so the summary the
      // picker previews matches the one the assignment returns (-1 = unlimited).
      limits: {
        dailyLeadQuota: p.dailyLeadQuota,
        maxUsers: p.maxUsers,
        maxResearchProfiles: p.maxResearchProfiles,
        ...((p.limits ?? {}) as Record<string, number>),
      },
    }));
  }
}
