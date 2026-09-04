import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * What this workspace still needs before the engine runs at full strength.
 *
 * ── WHY THIS IS NOT THE ONBOARDING CHECKLIST ────────────────────────────────
 *
 * `OnboardingService` answers a narrow, deliberate question: the four things
 * only a HUMAN can do to start. It stays four on purpose — everything else is a
 * byproduct of the strategy, and listing byproducts as chores asks the customer
 * to do the system's job.
 *
 * This answers a different one, and the difference is the point: WHAT IS THIS
 * ENGINE STILL MISSING. It includes the things the system can do for itself,
 * because the owner needs to see that they are done — and because most of them
 * can be done unattended, by the connected Claude, from this same list. A gap
 * here is not a chore somebody forgot; it is a capability that is off.
 *
 * ── WHY EVERY ITEM IS HERE ──────────────────────────────────────────────────
 *
 * Not "things that would be nice". Each one is something measured, in this
 * codebase, to stop something else working:
 *
 *   - no ACTIVE social campaign  → the content line produces nothing at all,
 *     because a campaign item is what a concept is promoted INTO
 *   - an empty growth wallet     → autopilot refuses on its first line
 *   - no tax rate                → every invoice bills net, silently
 *   - no payment provider        → an order form mints an invoice nobody can pay
 *   - no verified sending domain → campaign mail lands in spam, which is worse
 *     than not sending it
 *   - no product                 → an order form cannot be authored at all
 *
 * The states are honest about a third possibility. READY and MISSING are not
 * enough for a thing that exists but is not working — a social account whose
 * token has expired is not "connected", and a strategy that exists in DRAFT is
 * not a plan the machinery can serve.
 */

export type ReadinessState = 'READY' | 'MISSING' | 'ATTENTION';

export type ReadinessGroup =
  /** The connector itself. First, because every other line depends on it. */
  | 'connector'
  | 'identity'
  | 'plan'
  | 'reach'
  | 'selling'
  | 'pages'
  | 'content'
  | 'fuel';

export interface ReadinessItem {
  /** Stable id; the UI holds the copy, this holds the facts. */
  id: string;
  group: ReadinessGroup;
  state: ReadinessState;
  /** Where a person fixes it. */
  to: string;
  /**
   * The MCP tool that can do this unattended, when one exists.
   *
   * Null is meaningful and is not always a gap to close: a payment provider's
   * secret key must be typed by the person who holds it, and handing an agent
   * a tool to write it would be handing it the ability to redirect money.
   */
  mcpTool: string | null;
  /** Whatever was actually counted, so the UI can say "2 of 3" honestly. */
  detail?: Record<string, number | string | boolean>;
}

export interface WorkspaceReadiness {
  items: ReadinessItem[];
  ready: number;
  total: number;
  /** Items that exist but are not working — the ones costing something now. */
  attention: number;
}

@Injectable()
export class WorkspaceReadinessService {
  constructor(private readonly prisma: PrismaService) {}

  async get(workspaceId: string): Promise<WorkspaceReadiness> {
    // Every `where` below spells `workspaceId` out rather than spreading a
    // shared `{ workspaceId }`. The tenancy fitness test reads the SOURCE, and
    // it is right to: a scope hidden behind a one-letter variable is a scope
    // the next person editing this list cannot see either, and this list is
    // exactly the kind of file people add a line to in a hurry.

    const [
      liveMcpTokens,
      mcpApiKeys,
      workspaceRow,
      brandProfile,
      knowledgeDocs,
      strategy,
      workflows,
      researchProfiles,
      socialAccounts,
      unhealthySocial,
      sendingDomains,
      mailboxChannels,
      smsChannels,
      products,
      taxRates,
      orderForms,
      psp,
      pipelines,
      publishedPages,
      emailTemplates,
      activeCampaigns,
      concepts,
      aiWallet,
      growthWallet,
    ] = await Promise.all([
      // "Connected" as the console itself defines it: a token that is neither
      // revoked nor expired. A client whose every token is dead is disconnected,
      // however many rows it left behind.
      this.prisma.mcpOAuthToken.count({
        where: { workspaceId, revokedAt: null, expiresAt: { gt: new Date() } },
      }),
      this.prisma.apiKey.count({ where: { workspaceId, status: 'ACTIVE' } }),
      this.prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { mcpWriteMode: true },
      }),
      this.prisma.brandProfile.findFirst({
        where: { workspaceId },
        select: { id: true, description: true, voiceGuide: true, icpDescription: true },
      }),
      this.prisma.knowledgeDoc.count({ where: { workspaceId } }),
      this.prisma.marketingStrategy.findFirst({
        where: { workspaceId },
        orderBy: { createdAt: 'desc' },
        select: { id: true, status: true, autonomyLevel: true },
      }),
      this.prisma.workflow.count({ where: { workspaceId, status: 'ACTIVE' } }),
      this.prisma.researchProfile.count({ where: { workspaceId, status: 'ACTIVE' } }),
      this.prisma.socialAccount.count({ where: { workspaceId, enabled: true } }),
      this.prisma.socialAccount.count({ where: { workspaceId, enabled: true, lastError: { not: null } } }),
      this.prisma.sendingDomain.count({ where: { workspaceId, status: 'VERIFIED' } }),
      this.prisma.channel.count({ where: { workspaceId, type: 'EMAIL', status: 'ACTIVE' } }),
      this.prisma.channel.count({ where: { workspaceId, type: 'SMS', status: 'ACTIVE' } }),
      this.prisma.product.count({ where: { workspaceId } }),
      this.prisma.taxRate.count({ where: { workspaceId } }),
      this.prisma.orderForm.count({ where: { workspaceId } }),
      this.prisma.workspacePspConfig.findUnique({ where: { workspaceId }, select: { provider: true } }),
      this.prisma.pipeline.count({ where: { workspaceId } }),
      this.prisma.sitePage.count({ where: { workspaceId, published: true } }),
      this.prisma.emailTemplate.count({ where: { workspaceId } }),
      this.prisma.socialCampaign.count({ where: { workspaceId, status: 'ACTIVE' } }),
      this.prisma.contentConcept.count({ where: { workspaceId } }),
      this.prisma.customerWallet.findFirst({ where: { workspaceId }, select: { balance: true } }),
      this.prisma.growthWallet.findUnique({ where: { workspaceId }, select: { balance: true } }),
    ]);

    const yes = (ok: boolean): ReadinessState => (ok ? 'READY' : 'MISSING');

    const connected = liveMcpTokens > 0 || mcpApiKeys > 0;
    // Fails towards APPROVAL, the same direction `McpInvokerService` does:
    // showing a warning that might not apply costs a sentence, hiding one that
    // does is indistinguishable from a lane working properly.
    const autonomous = workspaceRow?.mcpWriteMode === 'AUTONOMOUS';

    const items: ReadinessItem[] = [
      // ── connector ───────────────────────────────────────────────────────
      {
        id: 'claude-connector',
        group: 'connector',
        /**
         * FIRST, and the only item that is a precondition for the rest of the
         * list rather than for the product. Every gap below names a tool that
         * can close it — a promise that is empty until something is connected
         * to call those tools.
         *
         * ATTENTION rather than READY under APPROVAL, and this is not
         * pedantry: measured in v2.286.0, the Jeeta-keyed data tools do not
         * merely QUEUE under approval, they are unusable — the approval
         * executor returns the tool result to the approving human's HTTP
         * response and never to the agent's turn, so the agent receives
         * PENDING_APPROVAL and can never obtain the record inside its own
         * session, however fast anyone clicks. The connector still runs and
         * silently does less, which is exactly the state this whole list
         * exists to make visible.
         */
        state: !connected ? 'MISSING' : autonomous ? 'READY' : 'ATTENTION',
        to: '/settings/api-keys?tab=connector',
        // Nothing can connect itself. The address, the key and the scheduled-
        // task prompt are all on that page.
        mcpTool: null,
        detail: {
          connectors: liveMcpTokens,
          apiKeys: mcpApiKeys,
          writeMode: autonomous ? 'AUTONOMOUS' : 'APPROVAL',
        },
      },

      // ── identity ────────────────────────────────────────────────────────
      {
        id: 'brand-profile',
        group: 'identity',
        // Not "a row exists". Intake writes the row first and fills it in as
        // it learns, so a profile with only a name is the shape an abandoned
        // intake leaves — present, and useless to anything that has to write
        // in this voice. What a writer cannot work without is what the business
        // DOES, who it is for, and how it sounds.
        state: yes(
          !!brandProfile?.description &&
            !!brandProfile?.icpDescription &&
            !!brandProfile?.voiceGuide,
        ),
        to: '/branding',
        mcpTool: 'jeeta.update_brand_profile',
      },
      {
        id: 'brand-knowledge',
        group: 'identity',
        state: yes(knowledgeDocs > 0),
        to: '/branding?tab=brain',
        mcpTool: null,
        detail: { docs: knowledgeDocs },
      },

      // ── plan ────────────────────────────────────────────────────────────
      {
        id: 'strategy',
        group: 'plan',
        // DRAFT is the ATTENTION case, not the missing one: the work was done
        // and never activated, which reads as "I have a strategy" from
        // everywhere except the machinery that will not run on it.
        state: !strategy ? 'MISSING' : strategy.status === 'ACTIVE' ? 'READY' : 'ATTENTION',
        to: '/studio/strategy',
        mcpTool: 'jeeta.synthesize_strategy',
        detail: strategy ? { status: strategy.status } : undefined,
      },
      {
        id: 'automations',
        group: 'plan',
        state: yes(workflows > 0),
        to: '/studio/strategy?tab=automations',
        mcpTool: 'jeeta.create_workflow',
        detail: { active: workflows },
      },
      {
        id: 'research',
        group: 'plan',
        state: yes(researchProfiles > 0),
        to: '/studio/strategy?tab=research',
        mcpTool: 'jeeta.create_research_profile',
        detail: { active: researchProfiles },
      },

      // ── reach ───────────────────────────────────────────────────────────
      {
        id: 'social-accounts',
        group: 'reach',
        // A connected account with a live error is the most expensive state in
        // the product: everything published through it is dropped, quietly.
        state: socialAccounts === 0 ? 'MISSING' : unhealthySocial > 0 ? 'ATTENTION' : 'READY',
        to: '/accounts',
        mcpTool: null,
        detail: { connected: socialAccounts, broken: unhealthySocial },
      },
      {
        id: 'email-sending',
        group: 'reach',
        // Either route works: your own mailbox for one-to-one replies, or a
        // verified domain for campaign volume. Neither means campaign mail
        // arrives in spam, which is worse than not sending it.
        state: yes(sendingDomains > 0 || mailboxChannels > 0),
        to: '/settings/domains',
        mcpTool: null,
        detail: { verifiedDomains: sendingDomains, mailboxes: mailboxChannels },
      },
      {
        id: 'sms',
        group: 'reach',
        state: yes(smsChannels > 0),
        to: '/inbox?tab=channels',
        mcpTool: null,
      },

      // ── selling ─────────────────────────────────────────────────────────
      {
        id: 'products',
        group: 'selling',
        state: yes(products > 0),
        to: '/products',
        mcpTool: 'jeeta.create_product',
        detail: { count: products },
      },
      {
        id: 'tax-rates',
        group: 'selling',
        // No rate does not fail — it bills NET, on every invoice, silently.
        state: yes(taxRates > 0),
        to: '/products?sub=tax-rates',
        mcpTool: 'jeeta.create_tax_rate',
        detail: { count: taxRates },
      },
      {
        id: 'payment-provider',
        group: 'selling',
        // MANUAL is a real choice (bank transfer), so it counts as ready. What
        // is not ready is having none at all, which mints invoices nobody can
        // pay. No MCP tool by design: the secret key must be typed by the
        // person who holds it.
        state: yes(!!psp?.provider),
        to: '/products?tab=invoices',
        mcpTool: null,
        detail: psp?.provider ? { provider: psp.provider } : undefined,
      },
      {
        id: 'order-form',
        group: 'selling',
        state: yes(orderForms > 0),
        to: '/products?tab=order-forms',
        mcpTool: 'jeeta.create_order_form',
        detail: { count: orderForms },
      },
      {
        id: 'pipeline',
        group: 'selling',
        state: yes(pipelines > 0),
        to: '/branding?tab=pipelines',
        mcpTool: null,
      },

      // ── pages ───────────────────────────────────────────────────────────
      {
        id: 'landing-page',
        group: 'pages',
        // Somewhere for the traffic to land. Ads and posts that point at
        // nothing are the most expensive kind of nothing.
        state: yes(publishedPages > 0),
        to: '/sites',
        mcpTool: null,
        detail: { published: publishedPages },
      },

      // ── content ─────────────────────────────────────────────────────────
      {
        id: 'email-templates',
        group: 'content',
        state: yes(emailTemplates > 0),
        to: '/email-templates',
        mcpTool: 'jeeta.create_email_template',
        detail: { count: emailTemplates },
      },
      {
        id: 'active-campaign',
        group: 'content',
        // The one most likely to be missed, and the one that stops the most:
        // a content concept is promoted INTO a campaign item, so with no ACTIVE
        // campaign the whole production line produces nothing and says nothing.
        state: yes(activeCampaigns > 0),
        to: '/studio',
        mcpTool: 'jeeta.create_social_campaign',
        detail: { active: activeCampaigns },
      },
      {
        id: 'content-concepts',
        group: 'content',
        state: yes(concepts > 0),
        to: '/studio',
        mcpTool: 'jeeta.plan_content_concepts',
        detail: { count: concepts },
      },

      // ── fuel ────────────────────────────────────────────────────────────
      {
        id: 'ai-credits',
        group: 'fuel',
        state: yes((aiWallet?.balance ?? 0) > 0),
        to: '/billing',
        mcpTool: null,
        detail: { balance: aiWallet?.balance ?? 0 },
      },
      {
        id: 'growth-wallet',
        group: 'fuel',
        // Autopilot refuses on its first line with an empty wallet. Nothing
        // else on this list stops as much for as small a reason.
        state: yes(Number(growthWallet?.balance ?? 0) > 0),
        to: '/billing',
        mcpTool: null,
        detail: { balance: Number(growthWallet?.balance ?? 0) },
      },
      {
        id: 'autonomy',
        group: 'fuel',
        // LAST on purpose. Arming a machine that is missing its inputs is how
        // an autopilot spends money on work nobody can use — every item above
        // is a precondition for this one being a good idea.
        state: yes(strategy?.autonomyLevel === 'AUTONOMOUS'),
        to: '/studio/strategy',
        mcpTool: 'jeeta.set_strategy_autonomy',
        detail: strategy ? { level: strategy.autonomyLevel } : undefined,
      },
    ];

    return {
      items,
      ready: items.filter((i) => i.state === 'READY').length,
      attention: items.filter((i) => i.state === 'ATTENTION').length,
      total: items.length,
    };
  }
}
