import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { PlatformGuard } from '../guards/platform.guard';
import { AiUsageStatsService } from '../../marketing/ai/ai-usage-stats.service';
import { PlatformAiSpendService } from '../../marketing/ai/platform-ai-spend.service';

/**
 * What Jeeta is spending, across every workspace.
 *
 * The marketing-side report answers "what did THIS workspace cost", which is
 * the tenant's question. Nobody could ask the operator's question — "what is
 * the vendor bill this month, and which workspace and which action is driving
 * it" — without a psql session, which is how the balance emptied unnoticed.
 *
 * Platform-guarded: this aggregates across tenants and must never be reachable
 * with a workspace key.
 */
@Controller('platform/ai-costs')
@UseGuards(PlatformGuard)
export class AiCostsAdminController {
  constructor(
    private readonly usage: AiUsageStatsService,
    private readonly spend: PlatformAiSpendService,
  ) {}

  /** Month-to-date spend against the platform cap, plus the alert state. */
  @Get('status')
  status() {
    return this.spend.status();
  }

  /** Cost per action and model across all workspaces, most expensive first. */
  @Get()
  async breakdown(@Query('days') days?: string, @Query('daily') daily?: string) {
    const window = Number.isFinite(Number(days)) && Number(days) > 0 ? Number(days) : 30;
    const [status, rows] = await Promise.all([
      this.spend.status(),
      this.usage.breakdown(undefined, window),
    ]);
    if (daily !== 'true') return { status, ...rows };
    return { status, ...rows, daily: await this.usage.daily(undefined, window) };
  }
}
