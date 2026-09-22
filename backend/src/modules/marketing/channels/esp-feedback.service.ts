import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { normalizeEmail } from '../utils/lead-normalize';

/** A provider-agnostic delivery-feedback event after the controller has parsed it. */
export interface FeedbackEvent {
  email: string;
  /** 'bounce' (hard/permanent), 'complaint'/'spam', or 'drop' — all suppress. */
  kind: 'bounce' | 'complaint' | 'drop';
}

/** What one batch did. `failed` is what tells a webhook to ask for a redelivery. */
export interface FeedbackOutcome {
  /** Lead rows whose flags actually changed. */
  suppressed: number;
  /** Events whose write threw — nothing was recorded for them. */
  failed: number;
}

/**
 * ESP delivery-feedback suppression (GHL parity — list hygiene write side).
 *
 * The campaign audience filter already EXCLUDES leads with emailBouncedAt set
 * (campaigns.service), but nothing ever WROTE it — so the guard was dead. This
 * stamps the right flag when an ESP reports a hard bounce or a spam complaint,
 * protecting sender reputation. Suppression is intentionally GLOBAL (by
 * normalized address, across workspaces): the ESP event carries no workspace
 * context at all, so there is nothing to scope it by. That is what this file's
 * written exemption in `workspace-scoping.arch.spec.ts` covers, and the
 * exemption is pinned to ONE call site — hence the single `updateMany` below.
 *
 * ## A bounce and a complaint are not the same fact
 *
 * They used to share one write, and that was a cross-tenant bug
 * (`esp-complaint-crosstenant`): somebody pressing "spam" on tenant A's
 * campaign got `emailBouncedAt` stamped, which is the flag tenant B's INVOICES
 * and quotes refuse to send against (`document-email.service.ts` reads
 * `emailBouncedAt` and never reads `emailOptOut`). One tenant's marketing
 * mistake silenced another tenant's billing.
 *
 * So:
 * - **bounce** — the address does not exist. Unchanged, both flags, guarded on
 *   `emailBouncedAt: null` so a re-read of the same report is idempotent. It is
 *   the only guard the four `emailOptOut`-only call sites have (`bounce-sets-optout`).
 * - **complaint / drop** — the PERSON refused marketing. `emailOptOut` only,
 *   never `emailBouncedAt`: campaigns, workflows, content distribution and
 *   ad-audience sync all honour it, while the tenant's transactional mail to
 *   its own customer keeps working. Guarded on `emailOptOut: false` and not on
 *   `emailBouncedAt`, or a complaint from an already-bounced address would be a
 *   silent no-op that also mis-reports its count.
 *
 * What is deliberately NOT here: per-workspace scoping (the payloads carry no
 * tenant), an `emailComplainedAt` column (every reader is keyed on
 * `emailBouncedAt` and would ship inert), and a `ConsentRecord` for a complaint
 * — that needs a lead read this file is not allowed to make globally; see the
 * package handoff.
 */
@Injectable()
export class EspFeedbackService {
  private readonly logger = new Logger(EspFeedbackService.name);

  constructor(private readonly prisma: PrismaService) {}

  async suppress(events: FeedbackEvent[]): Promise<FeedbackOutcome> {
    let suppressed = 0;
    let failed = 0;
    for (const ev of events) {
      const normalized = normalizeEmail(ev.email);
      // normalizeEmail only trims/lowercases — reject non-addresses so a garbage
      // value never becomes a (pointless, potentially over-broad) DB filter.
      if (!normalized || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) continue;

      // One statement, two shapes. Kept as a single `updateMany` call on purpose:
      // the arch-spec exemption for this global write is pinned to exactly one
      // call site, and a second one would need a second exemption (PLAN G5).
      const write: Prisma.LeadUpdateManyArgs =
        ev.kind === 'bounce'
          ? {
              where: { emailNormalized: normalized, emailBouncedAt: null },
              data: { emailBouncedAt: new Date(), emailOptOut: true },
            }
          : {
              where: { emailNormalized: normalized, emailOptOut: false },
              data: { emailOptOut: true },
            };

      try {
        // Global by-address suppression — see the class doc (ESP events have no
        // workspace; a dead/complaining address is dead everywhere).
        const res = await this.prisma.lead.updateMany(write);
        if (res.count > 0) {
          suppressed += res.count;
          const what = ev.kind === 'bounce' ? 'bounced address' : 'marketing opt-out';
          this.logger.warn(`ESP ${ev.kind}: suppressed ${res.count} lead(s) — ${what}`);
        }
      } catch (e) {
        // One unwritable event never costs the rest of the batch; the count is
        // what the caller turns into a retryable answer for the provider.
        failed += 1;
        this.logger.error(`ESP feedback suppression failed: ${(e as Error)?.message}`);
      }
    }
    return { suppressed, failed };
  }
}
