import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../../prisma/prisma.service';
import { AdManagementService } from '../../ads/ad-management.service';
import { Executor } from '../strategy.types';

/** The executor-ready config an AD_CAMPAIGN action carries. `objective` steers
 *  the Meta campaign objective; the rest is advisory context the strategist
 *  captured (audience/angle) + the budget INTENT the autopilot funds later. */
interface AdCampaignPayload {
  objective: string;
  channelKey?: string;
  dailyBudget?: number;
  audience?: string;
  angle?: string;
}

/** Free-form strategist objective → a valid Meta campaign objective. Already-
 *  valid `OUTCOME_*` values pass through; anything unrecognised defaults to
 *  traffic (a safe, cheap objective). */
const META_OBJECTIVES: Record<string, string> = {
  awareness: 'OUTCOME_AWARENESS',
  reach: 'OUTCOME_AWARENESS',
  traffic: 'OUTCOME_TRAFFIC',
  clicks: 'OUTCOME_TRAFFIC',
  engagement: 'OUTCOME_ENGAGEMENT',
  leads: 'OUTCOME_LEADS',
  lead: 'OUTCOME_LEADS',
  sales: 'OUTCOME_SALES',
  conversions: 'OUTCOME_SALES',
  app: 'OUTCOME_APP_PROMOTION',
};

function metaObjective(o: string): string {
  const key = o.trim().toLowerCase();
  if (key.startsWith('outcome_')) return o.trim().toUpperCase();
  return META_OBJECTIVES[key] ?? 'OUTCOME_TRAFFIC';
}

/**
 * AD_CAMPAIGN executor — spend-SAFE by construction. It provisions ONLY a PAUSED
 * campaign SHELL via `AdManagementService.create` (which defaults new campaigns to
 * PAUSED): no ad set, no ad, no budget write, no activation. A bare campaign node
 * cannot spend — only an ACTIVE ad set + ad with a budget can — so this executor
 * never moves money. The `dailyBudget` in the payload is a budget INTENT that is
 * logged, never applied; real budget + activation flow EXCLUSIVELY through the
 * existing Growth Autopilot, which is env-gated (`growthAutopilotAutonomyEnabled`)
 * and guardrailed. When no connected+ACTIVE Meta ad account exists we degrade to
 * `resultRef: undefined` (the orchestrator still marks the action DONE) rather
 * than failing. The `resultRef` is `campaign:<id>`.
 */
@Injectable()
export class AdCampaignExecutor implements Executor {
  readonly kind = 'AD_CAMPAIGN' as const;
  private readonly logger = new Logger(AdCampaignExecutor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ads: AdManagementService,
  ) {}

  async run(workspaceId: string, payload: unknown): Promise<{ resultRef?: string }> {
    const p = this.parse(payload);

    // A campaign shell needs a connected, write-capable Meta ad account.
    // `AdManagementService.create` is Meta-only, so we only look for META here.
    const account = await this.prisma.adAccount.findFirst({
      where: { workspaceId, provider: 'META', status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
    });
    if (!account) {
      this.logger.warn(
        `ad-campaign: no connected Meta ad account for ws ${workspaceId} — skipping shell for "${p.objective}"`,
      );
      return { resultRef: undefined };
    }

    // Create the PAUSED shell ONLY — no status override, no budget, no ad set/ad.
    const res = await this.ads.create(workspaceId, account.id, {
      name: this.campaignName(p),
      objective: metaObjective(p.objective),
    });
    const id = (res as { id?: string }).id;

    if (p.dailyBudget && p.dailyBudget > 0) {
      // Budget INTENT only — never applied here. The env-gated autopilot owns spend.
      this.logger.log(
        `ad-campaign: registered ${p.dailyBudget}/day budget intent for campaign ${id ?? '?'} (ws ${workspaceId}); NOT applied — Growth Autopilot owns spend`,
      );
    }

    return { resultRef: id ? `campaign:${id}` : undefined };
  }

  private campaignName(p: AdCampaignPayload): string {
    const base = p.angle?.trim() || p.objective;
    return `Strategy — ${base}`.slice(0, 200);
  }

  private parse(payload: unknown): AdCampaignPayload {
    if (!payload || typeof payload !== 'object') {
      throw new BadRequestException('AD_CAMPAIGN payload must be an object with an objective');
    }
    const p = payload as Record<string, unknown>;
    const objective = typeof p.objective === 'string' ? p.objective.trim() : '';
    if (!objective) {
      throw new BadRequestException('AD_CAMPAIGN payload requires a non-empty objective');
    }
    const dailyBudget = typeof p.dailyBudget === 'number' && Number.isFinite(p.dailyBudget) ? p.dailyBudget : undefined;
    return {
      objective,
      channelKey: typeof p.channelKey === 'string' && p.channelKey.trim() ? p.channelKey.trim() : undefined,
      dailyBudget,
      audience: typeof p.audience === 'string' && p.audience.trim() ? p.audience.trim() : undefined,
      angle: typeof p.angle === 'string' && p.angle.trim() ? p.angle.trim() : undefined,
    };
  }
}
