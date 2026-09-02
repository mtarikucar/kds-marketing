import { Injectable, Logger } from '@nestjs/common';
import { AnthropicService } from './anthropic.service';
import { AiCreditsService } from './ai-credits.service';
import { creditCost, tierFor } from './ai-credit-costs';

/**
 * What the screen decided about a piece of copy.
 *
 * Three values, not a boolean, because the two ways of NOT getting a BLOCK are
 * completely different facts and the callers answer them differently. A boolean
 * folded "a reviewer read this and it is fine" together with "no reviewer ran",
 * and then every caller inherited whatever fail policy the one implementation
 * happened to pick. The verdict says which happened; the caller owns the policy.
 */
export type BrandSafetyVerdict =
  /** A reviewer read the copy and did not object. */
  | 'SAFE'
  /** A reviewer read the copy and refused it. */
  | 'BLOCK'
  /** No reviewer ran: AI is not configured for this deployment, or the
   *  provider call failed. Nothing was read, so nothing was cleared. */
  | 'UNAVAILABLE';

/**
 * The one brand-safety screen for copy this product publishes on a customer's
 * behalf.
 *
 * WHY IT IS ITS OWN SERVICE. It used to be a private method on
 * `SocialCampaignsService`, which meant the only publish path that had it was
 * the one that happened to live in that file. The COMMUNITY_ENGAGE executor
 * posts machine-written copy into real Discord servers and real subreddits with
 * no human anywhere in the loop, and it had no screen at all — the only thing
 * standing between an unattended LLM and a live community was whether an env
 * var happened to be empty. A check that protects one publish path and not the
 * others is not a safety property, it is a coincidence of file layout. So it
 * moved here, and both callers use THIS one; there is no second implementation
 * to drift.
 *
 * WHAT IT COSTS. One `workflow.ai_classify` credit, reserved BEFORE the call
 * and refunded when the provider throws, plus one small Claude call (4 output
 * tokens, the copy truncated to 2000 chars). Metered per workspace and
 * attributed to `AiUsageLog` through `workspaceId` + `action` — without both of
 * those the credit is charged but the vendor cost is never recorded, and a
 * price can drift from its cost unseen.
 *
 * `reserve` may THROW (credits exhausted / entitlement refused). That throw is
 * deliberately not caught here: it means the workspace cannot pay for the
 * screen, which is not the same as the screen clearing the copy, and each
 * caller's own error path is where that belongs.
 */
@Injectable()
export class BrandSafetyService {
  private readonly logger = new Logger(BrandSafetyService.name);

  constructor(
    private readonly anthropic: AnthropicService,
    private readonly credits: AiCreditsService,
  ) {}

  /** SAFE/BLOCK copy screen via Claude; UNAVAILABLE when no reviewer could run. */
  async screen(workspaceId: string, copy: string): Promise<BrandSafetyVerdict> {
    if (!this.anthropic.isEnabled()) return 'UNAVAILABLE';
    await this.credits.reserve(workspaceId, creditCost('workflow.ai_classify'));
    try {
      const res = await this.anthropic.complete({
        system: 'You are a brand-safety reviewer. Reply with exactly one word: SAFE or BLOCK. '
          + 'BLOCK only for hate, harassment, sexually explicit, illegal, or defamatory content.',
        messages: [{ role: 'user', content: copy.slice(0, 2000) }],
        maxTokens: 4,
        tier: tierFor('workflow.ai_classify'),
        // Measured-usage attribution. Without both of these the call never
        // reaches AiUsageLog: credits are still charged, but nothing records
        // what the vendor billed, so a price can drift from its cost unseen.
        workspaceId: workspaceId,
        action: 'workflow.ai_classify',
      });
      return /BLOCK/i.test(res.text) ? 'BLOCK' : 'SAFE';
    } catch (e) {
      await this.credits.refund(workspaceId, creditCost('workflow.ai_classify'));
      this.logger.warn(
        `brand-safety screen unavailable for ws ${workspaceId}: ${e instanceof Error ? e.message : e}`,
      );
      return 'UNAVAILABLE';
    }
  }
}
