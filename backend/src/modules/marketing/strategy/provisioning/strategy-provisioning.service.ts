import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../../prisma/prisma.service';
import { AgentProfileService } from '../../ai/agent-profile.service';
import { MarketingStrategyBrief } from '../strategy.types';

/**
 * What the strategy builds FOR the user, so the checklist stops demanding it.
 *
 * "Create your first AI agent" was a checklist step — a form the user had to
 * find, understand and fill in before the product's own conversation engine
 * had anything to run on. But by the time a strategy exists, the system knows
 * the product, the voice, the audience and the goals better than a first-run
 * user can type them. So the strategy provisions the default agent itself, and
 * Agent Studio becomes the place to REFINE agents, not a gate to pass.
 *
 * Deliberately narrow: this creates ONE agent, only when the workspace has
 * none. Re-synthesis never touches existing agents — the user may have edited
 * or replaced them, and "the strategy updated so your agent was overwritten"
 * is the kind of surprise that erodes trust in every other automation.
 *
 * Best-effort by contract: a provisioning failure is logged, never thrown.
 * The strategy is the deliverable; the agent is a convenience on top of it.
 */
@Injectable()
export class StrategyProvisioningService {
  private readonly logger = new Logger(StrategyProvisioningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly agents: AgentProfileService,
  ) {}

  /**
   * A SHORT, human label for the provisioned agent.
   *
   * Prefers a real name (brand → workspace product) and only falls back to the
   * brief's product DESCRIPTION, trimmed at a word boundary — never a
   * mid-sentence hard cut. Bounded well under AgentProfile.name's 100-char cap
   * so the "… Asistanı" suffix always survives.
   */
  private agentName(brandName?: string | null, productName?: string | null, description?: string): string {
    const clean = (v?: string | null) => (typeof v === 'string' ? v.trim() : '');
    const base = clean(brandName) || clean(productName) || clean(description) || 'İşletme';
    if (base.length <= 40) return `${base} Asistanı`;
    // Cut at the last word boundary inside the budget rather than mid-word.
    const cut = base.slice(0, 40);
    const trimmed = cut.slice(0, cut.lastIndexOf(' ') > 12 ? cut.lastIndexOf(' ') : 40).replace(/[\s,;:—-]+$/, '');
    return `${trimmed} Asistanı`;
  }

  async ensureDefaultAgent(workspaceId: string, brief: MarketingStrategyBrief): Promise<void> {
    try {
      const count = await this.prisma.agentProfile.count({ where: { workspaceId } });
      if (count > 0) return; // the user (or a previous run) already has agents

      const ws = await this.prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { productName: true, defaultLanguage: true },
      });
      // The brand's own name, when it has one — the best label for an agent.
      const brand = await this.prisma.brandProfile
        .findUnique({ where: { workspaceId }, select: { brandName: true } })
        .catch(() => null);

      const product = brief.identity?.product || ws?.productName || 'işletme';
      const voice = brief.identity?.voice || '';
      const positioning = brief.identity?.positioning || '';
      const usp = brief.identity?.usp || '';
      const audience = brief.audience || '';
      const objective = brief.goals?.objective || '';

      // The persona is grounded in the strategy brief rather than a template:
      // the whole reason the system can build this is that the brief already
      // states who the business is, who it serves and how it should sound.
      const persona = [
        `${product} için müşteri asistanısın.`,
        positioning && `Konumlandırma: ${positioning}`,
        usp && `Öne çıkan değer: ${usp}`,
        audience && `Hedef kitle: ${audience}`,
        'Gelen mesajlara yardımcı, net ve satışa yakın bir dille yanıt ver.',
        'Bilmediğin bir şeyi uydurma — bilgi tabanında yoksa, notunu alıp ekibin döneceğini söyle.',
      ]
        .filter(Boolean)
        .join('\n');

      await this.agents.create(workspaceId, {
        // `brief.identity.product` is a DESCRIPTION, not a name — strategists
        // write it as a full sentence ("Custom, hand-painted resin figurines
        // sculpted from customers' own photos — a keepsake…"), so using it as
        // the label produced an agent named after a truncated paragraph (seen
        // live). Prefer the brand name, then the workspace product name, and
        // only fall back to the description trimmed at a word boundary.
        name: this.agentName(brand?.brandName, ws?.productName, product),
        persona,
        tone: voice || undefined,
        goals: objective || undefined,
        language: ws?.defaultLanguage ?? 'tr',
        // No channels yet — findActiveForChannel matches on the channel id, so
        // the agent activates naturally the moment a channel is connected and
        // attached; nothing starts talking to customers before the user wires
        // a channel up.
        status: 'ACTIVE',
      });
      this.logger.log(`default agent provisioned from strategy for ws ${workspaceId}`);
    } catch (e) {
      this.logger.warn(
        `default-agent provisioning skipped for ws ${workspaceId}: ${(e as Error)?.message ?? e}`,
      );
    }
  }
}
