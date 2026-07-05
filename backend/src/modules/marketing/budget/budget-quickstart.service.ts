import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { GrowthWalletService } from '../wallet/growth-wallet.service';
import { growthAutopilotAutonomyEnabled } from './growth-autonomy.flag';

export interface QuickStartInput {
  /** Monthly cap (major units). Defaults to the loaded wallet balance. */
  amount?: number;
  targetRoas?: number;
  targetCac?: number;
  /** Arm the AUTONOMOUS lane (requires the env flag; the user's ONE opt-in). */
  arm?: boolean;
}

export interface QuickStartManifest {
  wallet: { balance: string; currency: string; exists: boolean };
  budget: { id: string; periodKey: string; totalAmount: string; autonomyLevel: string; status: string };
  channels: string[];
  allocations: Array<{ channel: string; plannedAmount: string }>;
  armed: boolean;
  /** Content-arm provisioning lands in a later phase — explicit seam. */
  contentCampaign: null;
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
      contentCampaign: null,
    };
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
