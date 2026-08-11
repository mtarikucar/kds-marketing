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

  async ensureDefaultAgent(workspaceId: string, brief: MarketingStrategyBrief): Promise<void> {
    try {
      const count = await this.prisma.agentProfile.count({ where: { workspaceId } });
      if (count > 0) return; // the user (or a previous run) already has agents

      const ws = await this.prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { productName: true, defaultLanguage: true },
      });

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
        name: `${product} Asistanı`.slice(0, 100),
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
