import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { GrowthWalletService } from '../wallet/growth-wallet.service';
import { SocialCampaignsService } from '../social-campaigns/social-campaigns.service';
import { growthAutopilotAutonomyEnabled } from './growth-autonomy.flag';

export interface QuickStartInput {
  /** Monthly cap (major units). Defaults to the loaded wallet balance. */
  amount?: number;
  targetRoas?: number;
  targetCac?: number;
  /** Arm the AUTONOMOUS lane (requires the env flag; the user's ONE opt-in). */
  arm?: boolean;
  /** The acting user — required to provision engine-owned content campaigns. */
  createdById?: string;
}

/** What the content arm set up (autonomous social campaigns), or null if it didn't run. */
export interface ContentCampaignSummary {
  campaignIds: string[];
  count: number;
}

export interface QuickStartManifest {
  wallet: { balance: string; currency: string; exists: boolean };
  budget: { id: string; periodKey: string; totalAmount: string; autonomyLevel: string; status: string };
  channels: string[];
  allocations: Array<{ channel: string; plannedAmount: string }>;
  armed: boolean;
  /** The autonomous content campaigns the same click set up, or null when it didn't run. */
  contentCampaign: ContentCampaignSummary | null;
}

/** AdAccount.provider → growth channel (identity mapping today). */
const PROVIDER_CHANNELS: Record<string, string> = {
  META: 'META',
  TIKTOK: 'TIKTOK',
  GOOGLE: 'GOOGLE',
  LINKEDIN: 'LINKEDIN',
};

/**
 * One-click Autopilot provisioning (Growth Autopilot spec D12) — the "one
 * click → dozens of operations" surface. A single call: reads the wallet,
 * upserts the CURRENT-period GrowthBudget (HOLISTIC, funded by the wallet or
 * an explicit cap), seeds channel-level allocations for every channel the
 * workspace has ACTUALLY connected (ad accounts → META/TIKTOK/…; social
 * accounts → CONTENT; messaging channels → SMS/WHATSAPP), optionally arms the
 * AUTONOMOUS lane (env-flag-gated — this is the user's single explicit
 * opt-in), and returns a manifest of everything it did so the wizard can show
 * the user exactly what was set up. Fail-closed: no funding or no connected
 * channels → nothing is provisioned.
 */
@Injectable()
export class BudgetQuickstartService {
  private readonly logger = new Logger(BudgetQuickstartService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: GrowthWalletService,
    private readonly socialCampaigns: SocialCampaignsService,
  ) {}

  async quickStart(workspaceId: string, input: QuickStartInput, now: Date = new Date()): Promise<QuickStartManifest> {
    const wallet = await this.wallet.get(workspaceId);

    const cap = input.amount ?? wallet.balance.toNumber();
    if (!Number.isFinite(cap) || cap <= 0) {
      throw new BadRequestException('Load growth credit (or pass an amount) before starting Autopilot');
    }

    const channels = await this.detectChannels(workspaceId);
    if (channels.length === 0) {
      throw new BadRequestException('Connect at least one channel (ads, social or messaging) before starting Autopilot');
    }

    const armed = Boolean(input.arm) && growthAutopilotAutonomyEnabled();
    const autonomyLevel = armed ? 'AUTONOMOUS' : 'ASSISTED';
    const periodKey = now.toISOString().slice(0, 7); // YYYY-MM (UTC month)

    const total = new Prisma.Decimal(cap).toDecimalPlaces(2);
    const shared = {
      totalAmount: total,
      scope: 'HOLISTIC',
      status: 'ACTIVE',
      killSwitch: false,
      autonomyLevel,
      targetRoas: input.targetRoas != null ? new Prisma.Decimal(input.targetRoas) : null,
      targetCac: input.targetCac != null ? new Prisma.Decimal(input.targetCac) : null,
    };
    const budget = await this.prisma.growthBudget.upsert({
      where: { workspaceId_periodKey: { workspaceId, periodKey } },
      create: { workspaceId, periodKey, currency: wallet.currency, ...shared },
      update: shared,
    });

    // Equal split across the connected channels (channel-level rollups; the
    // allocator re-balances from here on every tick).
    const per = total.div(channels.length).toDecimalPlaces(2);
    const allocations: Array<{ channel: string; plannedAmount: string }> = [];
    for (const channel of channels) {
      const alloc = await this.prisma.budgetAllocation.upsert({
        where: { budgetId_channel_campaignRef: { budgetId: budget.id, channel, campaignRef: '' } },
        create: { workspaceId, budgetId: budget.id, channel, campaignRef: '', plannedAmount: per },
        update: { plannedAmount: per },
      });
      allocations.push({ channel, plannedAmount: String(alloc.plannedAmount ?? per) });
    }

    // Content arm: the SAME click that funds the budget also sets the engine
    // loose on content — one fully-autonomous social campaign per connected
    // account (FULL_AUTO + AI_FULL: plan → generate → auto-publish, no human
    // gate). Only when armed, with an actor, and only for accounts not already
    // backed by an active engine campaign this period (idempotent re-runs).
    const contentCampaign = await this.provisionContentCampaigns(
      workspaceId,
      budget.id,
      armed,
      input.createdById,
      { goal: input.targetRoas, now, currency: wallet.currency },
    );

    this.logger.log(`quick-start provisioned budget ${budget.id} (${periodKey}, ${channels.join(',')}, ${autonomyLevel}) for ${workspaceId}`);

    return {
      wallet: { balance: wallet.balance.toString(), currency: wallet.currency, exists: wallet.exists },
      budget: {
        id: budget.id,
        periodKey,
        totalAmount: total.toString(),
        autonomyLevel,
        status: 'ACTIVE',
      },
      channels,
      allocations,
      armed,
      contentCampaign,
    };
  }

  /**
   * Provision one fully-autonomous content campaign per connected social
   * account (the "grow my sales, never ask" arm). FULL_AUTO + AI_FULL removes
   * every human gate; the engine plans topics, generates copy+media and
   * auto-publishes under the existing dailyPublishCap + brand-safety rails.
   * Runs ONLY when the budget is armed AUTONOMOUS (so it shares the exact
   * env-flag + opt-in gate as ad autonomy) and an actor is known. Idempotent:
   * an account already backing an active engine campaign for this budget is
   * skipped, so re-running quick-start never duplicates campaigns.
   */
  private async provisionContentCampaigns(
    workspaceId: string,
    budgetId: string,
    armed: boolean,
    createdById: string | undefined,
    ctx: { goal?: number; now: Date; currency: string },
  ): Promise<ContentCampaignSummary | null> {
    if (!armed || !createdById) return null;

    const accounts = await this.prisma.socialAccount.findMany({
      where: { workspaceId },
      select: { id: true, network: true },
    });
    if (accounts.length === 0) return null;

    const start = new Date(ctx.now);
    const end = new Date(start.getTime() + 30 * 24 * 60 * 60 * 1000); // one month
    const brief = {
      goal: ctx.goal != null ? `Grow sales — target ROAS ${ctx.goal}x` : 'Grow sales',
      languages: [] as string[],
    };
    const cadence = {
      perWeek: 5,
      daysOfWeek: [1, 2, 3, 4, 5],
      timeOfDay: '09:00',
      timezone: 'UTC',
    };

    const campaignIds: string[] = [];
    for (const account of accounts) {
      const existing = await this.prisma.socialCampaign.findFirst({
        where: {
          workspaceId,
          engineBudgetId: budgetId,
          status: { in: ['DRAFT', 'ACTIVE'] },
          targetAccountIds: { has: account.id },
        },
        select: { id: true },
      });
      if (existing) continue; // already set up for this account — never duplicate

      try {
        const campaign = await this.socialCampaigns.create(workspaceId, {
          name: `Autopilot content — ${account.network}`,
          goal: brief.goal,
          brief,
          automationMode: 'FULL_AUTO',
          planningMode: 'AI_FULL',
          cadence,
          startDate: start,
          endDate: end,
          targetAccountIds: [account.id],
          mediaKinds: ['IMAGE'],
          engineBudgetId: budgetId,
          createdById,
        });
        await this.socialCampaigns.activate(workspaceId, campaign.id);
        campaignIds.push(campaign.id);
      } catch (e) {
        // One account's provisioning must not abort the rest (or the whole
        // quick-start). The engine re-attempts on the next arm/run.
        this.logger.warn(`content-arm provisioning failed for account ${account.id}: ${(e as Error)?.message ?? e}`);
      }
    }

    return { campaignIds, count: campaignIds.length };
  }

  /** Channels backed by a REAL connection — never seed a channel with nothing behind it. */
  private async detectChannels(workspaceId: string): Promise<string[]> {
    const [adAccounts, socialCount, messagingChannels] = await Promise.all([
      this.prisma.adAccount.findMany({ where: { workspaceId }, select: { provider: true } }),
      this.prisma.socialAccount.count({ where: { workspaceId } }),
      this.prisma.channel.findMany({
        where: { workspaceId, status: 'ACTIVE', type: { in: ['SMS', 'WHATSAPP'] } },
        select: { type: true },
      }),
    ]);

    const channels = new Set<string>();
    for (const a of adAccounts) {
      const ch = PROVIDER_CHANNELS[a.provider];
      if (ch) channels.add(ch);
    }
    if (socialCount > 0) channels.add('CONTENT');
    for (const c of messagingChannels) channels.add(c.type);
    return [...channels];
  }
}
