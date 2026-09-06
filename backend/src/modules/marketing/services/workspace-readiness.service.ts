import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { EntitlementsService } from '../../billing/entitlements.service';
import { AI_CREDITS_METRIC, monthKey } from '../ai/ai-credits.service';

/**
 * How far ahead a token expiry is worth complaining about — and why there are
 * TWO answers rather than one.
 *
 * The first version of this line used seven days, copied from
 * `DailyDigestService`. Seven days is also, exactly,
 * `SocialTokenRefreshService.REFRESH_WINDOW_MS`: that cron's due query is
 *
 *     { connectedVia: 'OAUTH', enabled: true, refreshToken: { not: null },
 *       tokenExpiresAt: { not: null, lt: now + 7d } }
 *
 * run EVERY HOUR, and on failure it deliberately leaves the row untouched so
 * the next tick tries again. So a seven-day warning on a refreshable account
 * fired at the exact instant the repair began. Every short-lived-token account
 * would sit in ATTENTION for its whole last week, every cycle, while the
 * machinery was working — and a warning that is always on is one a person
 * learns to scroll past, which costs more than having no warning at all.
 *
 * Hence two windows, chosen by whether anything is in fact repairing the
 * account:
 *
 *   SELF_HEALING_EXPIRY_WARNING_MS (48h) — the refresher HAS this account.
 *     Worth reporting only once auto-refresh has demonstrably had its chances
 *     and not taken them: the account entered the refresher's queue five days
 *     earlier, so by the time this fires the hourly cron has had ~120 turns
 *     without moving `tokenExpiresAt`. "Had its chances" assumes the cron can
 *     actually act — `SocialTokenRefreshService` returns early when
 *     MARKETING_SECRET_KEY is unset, and skips any network whose provider
 *     exposes no `refresh`. In those cases nothing was ever repairing the
 *     account and 48h of notice is all it gets, which is the trade this
 *     window accepts.
 *
 *   UNATTENDED_EXPIRY_WARNING_MS (7d) — nothing is repairing this account.
 *     The due query above filters `connectedVia: 'OAUTH'` and
 *     `refreshToken: { not: null }`, so an account connected by hand, or one
 *     whose provider handed back no refresh token, is never picked up at all.
 *     Only a human reconnect saves it, and a human needs the week of notice
 *     `DailyDigestService` already mails.
 *
 * INVARIANT: the self-healing window must stay STRICTLY INSIDE the
 * refresher's, with days of retries to spare. The spec reads
 * `REFRESH_WINDOW_MS` out of the refresher's own source and asserts that gap,
 * so it fails when the two are brought together — the refresher NARROWED
 * towards 48h, or this window widened towards the refresher's. It does not
 * fail when the refresher is widened, because that only buys more retries
 * before this fires, which is the safe direction.
 */
const SELF_HEALING_EXPIRY_WARNING_MS = 48 * 60 * 60 * 1000;
const UNATTENDED_EXPIRY_WARNING_MS = 7 * 24 * 60 * 60 * 1000;

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
  constructor(
    private readonly prisma: PrismaService,
    // Not every gap on this list is a row somewhere. The AI-credit line is
    // answered by the PLAN before it is answered by a wallet, and reading the
    // wallet alone got the answer backwards on the plan that needs no wallet.
    private readonly entitlements: EntitlementsService,
  ) {}

  async get(workspaceId: string): Promise<WorkspaceReadiness> {
    // Every `where` below spells `workspaceId` out rather than spreading a
    // shared `{ workspaceId }`. The tenancy fitness test reads the SOURCE, and
    // it is right to: a scope hidden behind a one-letter variable is a scope
    // the next person editing this list cannot see either, and this list is
    // exactly the kind of file people add a line to in a hurry.

    // One clock reading for the whole snapshot, because two of the counts below
    // are now COMPLEMENTS of each other around this instant: `unhealthySocial`
    // takes `tokenExpiresAt < now` and `expiringSocial` takes `> now`. Read the
    // clock twice and a token that expires between the two readings satisfies
    // NEITHER predicate — it is not yet dead to the first and already too old
    // for the second — so the account that just died is the one the list stops
    // mentioning. The month key below is derived from the same instant for the
    // same reason: at a month boundary the allowance period must belong to the
    // snapshot it is reported in.
    //
    // (Before the expiry count existed the two readings were on DIFFERENT
    // entities — an MCP token's `expiresAt` and a social token's — so they
    // could not contradict each other about one row. That is no longer true.)
    const now = new Date();
    const soonSelfHealing = new Date(now.getTime() + SELF_HEALING_EXPIRY_WARNING_MS);
    const soonUnattended = new Date(now.getTime() + UNATTENDED_EXPIRY_WARNING_MS);
    /** UTC month key, exactly as `AiCreditsService` writes it. */
    const period = monthKey(now);

    const [
      liveMcpTokens,
      mcpApiKeys,
      workspaceRow,
      brandProfile,
      knowledgeDocs,
      strategy,
      workflows,
      workflowsAnyStatus,
      researchProfiles,
      socialAccounts,
      unhealthySocial,
      expiringSocial,
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
      aiCreditsUsedRow,
      aiCreditsMonthly,
      growthWallet,
    ] = await Promise.all([
      // "Connected" as the console itself defines it: a token that is neither
      // revoked nor expired. A client whose every token is dead is disconnected,
      // however many rows it left behind.
      this.prisma.mcpOAuthToken.count({
        where: { workspaceId, revokedAt: null, expiresAt: { gt: now } },
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
      // Drafts count SEPARATELY, because "you have none" and "you have one and
      // never armed it" need opposite advice. Telling an owner to create an
      // automation when a finished one is sitting in DRAFT is how a checklist
      // sends someone to build a second copy of what they already have.
      this.prisma.workflow.count({ where: { workspaceId } }),
      this.prisma.researchProfile.count({ where: { workspaceId, status: 'ACTIVE' } }),
      this.prisma.socialAccount.count({ where: { workspaceId, enabled: true } }),
      // ALREADY BROKEN — "something the owner switched ON has stopped working".
      //
      // What it must not do is what this line used to do: filter on
      // `enabled: true, lastError: { not: null }`. That misses the failure that
      // actually happens. A token simply RUNS OUT: `tokenExpiresAt` passes,
      // nothing writes `lastError`, the row stays enabled — and the old
      // predicate reported it as a healthy connection while every publish
      // through it failed. It also swept up benign strings: `disconnected` on
      // an account the owner retired, and `mistagged_page_superseded` from the
      // Page repair, are both deliberate and neither is a problem to report
      // forever.
      this.prisma.socialAccount.count({
        where: {
          workspaceId,
          OR: [
            { lastError: 'reauth_required' },
            { enabled: true, tokenExpiresAt: { lt: now } },
          ],
        },
      }),
      // ABOUT TO BREAK, AND NOTHING IS FIXING IT — which is the moment worth
      // reporting, and is narrower than "about to break".
      //
      // This count exists because an expiry used to be invisible here until the
      // day it stopped working, and nobody can reconnect an account
      // retroactively: by then the posts that did not go out have not gone out.
      //
      // But the first cut of it warned at seven days, which is the refresher's
      // OWN window (see the constants at the top of this file, and read
      // social-token-refresh.service.ts before touching either) — so it lit up
      // at the exact moment auto-refresh started retrying hourly and stayed lit
      // for the whole week it worked. The split below is what makes the signal
      // mean something:
      //
      //   arm 1 — the refresher's due predicate verbatim (OAUTH + a refresh
      //           token to spend), on a 48h window instead of its 7d, so it
      //           only fires after ~120 hourly attempts have failed to move
      //           `tokenExpiresAt`;
      //   arms 2-3 — the accounts that due predicate SKIPS: no refresh token,
      //           or connected by hand. The cron never looks at these, so
      //           nothing is retrying and the full week of human notice is the
      //           correct amount.
      //
      // `enabled: true` so a connection the owner retired is not resurrected as
      // a warning; `gt: now` and the `lastError` exclusion keep this count
      // DISJOINT from `unhealthySocial` above, so one row can never be printed
      // as two separate problems in `detail`. The `lastError` exclusion is
      // written as an OR over null on purpose: a NULL `lastError` is the normal
      // case and must stay counted, which a bare `{ not: 'reauth_required' }`
      // cannot be relied on to do.
      this.prisma.socialAccount.count({
        where: {
          workspaceId,
          enabled: true,
          AND: [
            { OR: [{ lastError: null }, { lastError: { not: 'reauth_required' } }] },
            {
              OR: [
                {
                  connectedVia: 'OAUTH',
                  refreshToken: { not: null },
                  tokenExpiresAt: { gt: now, lte: soonSelfHealing },
                },
                { refreshToken: null, tokenExpiresAt: { gt: now, lte: soonUnattended } },
                {
                  connectedVia: { not: 'OAUTH' },
                  tokenExpiresAt: { gt: now, lte: soonUnattended },
                },
              ],
            },
          ],
        },
      }),
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
      // `AiCreditWallet`, whose `workspaceId` is @unique and whose balance is
      // whole credits — NOT `CustomerWallet`, which this line used to read.
      // That is the per-LEAD store-credit wallet: `leadId` is REQUIRED and the
      // key is `[workspaceId, leadId]`, so a `findFirst` with no `leadId`
      // handed back an ARBITRARY customer's store credit, in TRY minor units.
      // Any one customer holding store credit made this line read READY, and a
      // workspace with real AI credits and no such customer read MISSING — and
      // the number itself was published verbatim as `detail` to the MCP agent
      // through `jeeta.get_setup_readiness`, which returns the items untouched.
      // (The panel is not where it showed: SetupReadinessButton.tsx declares
      // `detail` on the item type and renders none of it.)
      this.prisma.aiCreditWallet.findUnique({
        where: { workspaceId },
        select: { balance: true },
      }),
      // How much of this month's allowance is already spent.
      //
      // The SAME ledger `AiCreditsService` charges against — a `UsageCounter`
      // row under `AI_CREDITS_METRIC`, keyed by the UTC month `monthKey()`
      // builds — deliberately imported rather than re-derived. A readiness list
      // that keeps its own tally of consumption would disagree with the meter
      // that actually refuses the work, and the disagreement would be silent.
      //
      // `findFirst` rather than the compound `findUnique`: the
      // `[workspaceId, metric, periodKey]` unique key makes them equivalent,
      // and the flat `workspaceId` is what the tenancy fitness test — and the
      // spec's own scoping sweep — read this source for.
      this.prisma.usageCounter.findFirst({
        where: { workspaceId, metric: AI_CREDITS_METRIC, periodKey: period },
        select: { value: true },
      }),
      // The plan's own allowance, because the wallet is only part of the answer.
      //
      // `null` — never 0 — when billing cannot be reached. 0 is a REAL answer
      // here (the plans that include no AI credits at all and run on prepaid
      // alone), and this value is published verbatim to the MCP agent. Reporting
      // `monthlyAllowance: 0` when the truth was "we could not ask" told the
      // agent the plan grants nothing, which is a different instruction from
      // "unknown" and one it would act on.
      this.entitlements
        .getEffective(workspaceId)
        .then((e) =>
          typeof e?.limits?.aiCreditsMonthly === 'number' ? e.limits.aiCreditsMonthly : null,
        )
        .catch(() => null),
      this.prisma.growthWallet.findUnique({ where: { workspaceId }, select: { balance: true } }),
    ]);

    const yes = (ok: boolean): ReadinessState => (ok ? 'READY' : 'MISSING');

    const connected = liveMcpTokens > 0 || mcpApiKeys > 0;
    // Fails towards APPROVAL, the same direction `McpInvokerService` does:
    // showing a warning that might not apply costs a sentence, hiding one that
    // does is indistinguishable from a lane working properly.
    const autonomous = workspaceRow?.mcpWriteMode === 'AUTONOMOUS';

    // ── Can an AI action actually run right now? ────────────────────────────
    //
    // Three funding routes, in the order `AiCreditsService.reserve` consults
    // them, so this line and the code that does the refusing agree:
    //
    //   -1 allowance     → reserve() bumps the counter and returns without ever
    //                      looking at a wallet. Unlimited cannot run out.
    //   allowance left   → the month's included credits are spent down FIRST
    //                      ("nobody should burn credits they paid for while
    //                      free ones are still sitting unused"), so a workspace
    //                      with 1500 granted and 40 used has fuel on day 1 with
    //                      an empty wallet — which the previous version of this
    //                      line called MISSING on every paying plan.
    //   prepaid wallet   → the overage path, and the only route left once the
    //                      allowance is exhausted.
    //
    // `null` allowance means billing could not be reached: unknown, not zero.
    const aiUsedThisPeriod = aiCreditsUsedRow?.value ?? 0;
    const aiUnlimited = aiCreditsMonthly === -1;
    const aiAllowanceLeft =
      aiCreditsMonthly === null || aiUnlimited
        ? null
        : Math.max(0, aiCreditsMonthly - aiUsedThisPeriod);
    const aiPrepaid = aiWallet?.balance ?? 0;
    /** WHICH of the routes is true, so a reader is not left to infer it. */
    const aiFuel = aiUnlimited
      ? 'unlimited'
      : (aiAllowanceLeft ?? 0) > 0
        ? 'monthly-allowance'
        : aiPrepaid > 0
          ? 'prepaid-wallet'
          : aiCreditsMonthly === null
            ? 'unknown-plan-unreadable'
            : 'none';

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
        // NOT `jeeta.synthesize_strategy`, though the name reads like the one.
        // That tool is `StrategyFeedbackService.refresh`: it RE-synthesizes an
        // existing ACTIVE strategy from the workspace's intake session, and
        // returns `{ skipped: 'no-active-strategy' }` when there is none —
        // precisely the MISSING case this line describes. The first strategy
        // used to come only out of the intake interview, whose session id an
        // agent has no way to obtain, and whose own gate is the platform's
        // Anthropic key: naming it here promised a fix that silently no-ops.
        //
        // `jeeta.submit_strategy` is the tool that does close this line. It
        // takes a brief the connected Claude wrote itself and runs it through
        // the same writer synthesis uses, so the row this item then reads is
        // ACTIVE and this state turns READY on the next call — with no model
        // call and no credit, which matters because the platform key being dry
        // is how a workspace ends up here.
        //
        // PROMISED IN THE MISSING STATE ONLY, which is why this field is a
        // conditional where every other one on this list is a constant. The
        // item has three states and `submit_strategy` serves exactly one of
        // them: it refuses ANY existing row (`This workspace already has a
        // strategy…`), so on the ATTENTION branch — a row that exists with a
        // non-ACTIVE status — naming it would send an agent to a tool that
        // cannot help, which is the failure this whole field was audited for.
        // That branch needs a human either way, and nothing in the backend
        // writes a status other than ACTIVE today, so it is reachable only by a
        // hand-edited row. READY needs no tool at all.
        mcpTool: !strategy ? 'jeeta.submit_strategy' : null,
        detail: strategy ? { status: strategy.status } : undefined,
      },
      {
        id: 'automations',
        group: 'plan',
        // A workspace with drafts is NOT a workspace with no automations. The
        // live one here had a finished lead-routing workflow sitting in DRAFT
        // — its own description recording that 299 leads had piled up untouched
        // because the step was still manual — and this line said MISSING, which
        // reads as "build one".
        state: workflows > 0 ? 'READY' : workflowsAnyStatus > 0 ? 'ATTENTION' : 'MISSING',
        to: '/studio/strategy?tab=automations',
        mcpTool: 'jeeta.create_workflow',
        detail: { active: workflows, total: workflowsAnyStatus },
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
        // the product: everything published through it is dropped, quietly. An
        // account near expiry that NOTHING is repairing is the same state with
        // a date on it, and the only one on this list that can still be fixed
        // for free — "nothing is repairing it" being the whole difficulty, and
        // what the two windows at the top of this file are for.
        state:
          socialAccounts === 0
            ? 'MISSING'
            : unhealthySocial > 0 || expiringSocial > 0
              ? 'ATTENTION'
              : 'READY',
        to: '/accounts',
        mcpTool: null,
        // Counted apart, because they are different sentences to a reader: one
        // account has stopped working, the other is still working today. The
        // two predicates are disjoint by construction (see the queries), so a
        // single row cannot appear in both numbers and be read as two problems.
        detail: {
          connected: socialAccounts,
          broken: unhealthySocial,
          expiringSoon: expiringSocial,
        },
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
        // `jeeta.create_social_campaign` creates a DRAFT, and this line counts
        // ACTIVE. Activation is withheld from MCP on purpose — "restarting an
        // unattended publisher stays a panel decision" — so no tool in the
        // catalogue can move this to READY. An agent can still prepare the
        // draft; a person arms it, which is the design and not a gap.
        mcpTool: null,
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
        // "Does this workspace have AI fuel left?" — not "is there money in a
        // wallet?". Note the weaker verb: this cannot promise that a PARTICULAR
        // action will run, because it does not know what that action costs.
        // `reserve()` still throws AI_CREDITS_EXHAUSTED when the remainder is
        // smaller than the call being made, so READY here means "there is some
        // fuel", not "the next thing you try will succeed".
        //
        // Two smaller questions this must NOT be narrowed back to, both of
        // which get the common case wrong:
        //   - wallet only: tells an UNLIMITED workspace to buy credits it can
        //     never need, because `reserve()` returns at `limit === -1`
        //     without consulting a wallet at all.
        //   - wallet + the -1 case: still wrong for every PAYING plan. The
        //     allowance is what `reserve()` spends FIRST, so a plan on day 1
        //     of the month with its allowance untouched and an empty prepaid
        //     wallet reads MISSING while AI work would in fact succeed.
        //     (prisma/seed-packages.ts grants 300, 1500, 2000, 6000 and -1.)
        //
        // The honest answer needs the meter as well as the plan, which is why
        // this reads the same `UsageCounter` row `reserve()` increments rather
        // than guessing from the wallet. See the derivation above.
        state: yes(aiFuel !== 'none' && aiFuel !== 'unknown-plan-unreadable'),
        to: '/billing',
        mcpTool: null,
        // Every input to the answer, plus WHICH route is carrying it, so a
        // human (and the MCP agent, which gets this verbatim) can see why the
        // state is what it is. `monthlyAllowance` is omitted rather than
        // faked when the plan could not be read — see the entitlements read.
        detail: {
          fuel: aiFuel,
          period,
          balance: aiPrepaid,
          usedThisPeriod: aiUsedThisPeriod,
          ...(aiCreditsMonthly === null
            ? { planUnreadable: true }
            : {
                monthlyAllowance: aiCreditsMonthly,
                allowanceRemaining: aiUnlimited ? -1 : (aiAllowanceLeft ?? 0),
              }),
        },
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
        // `jeeta.set_strategy_autonomy` exists, and REFUSES the only value that
        // would satisfy this line: `SETTABLE_AUTONOMY` is SHADOW and ASSISTED,
        // because "AUTONOMOUS removes the human approval gate from the strategy
        // lane, which an agent must not grant itself". Naming it here asked an
        // agent to grant itself exactly that, and the refusal it would hit is
        // the product working correctly.
        mcpTool: null,
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
