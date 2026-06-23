import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { normalizeEmail } from '../utils/lead-normalize';

/** A provider-agnostic delivery-feedback event after the controller has parsed it. */
export interface FeedbackEvent {
  email: string;
  /** 'bounce' (hard/permanent), 'complaint'/'spam', or 'drop' — all suppress. */
  kind: 'bounce' | 'complaint' | 'drop';
}

/**
 * ESP delivery-feedback suppression (GHL parity — list hygiene write side).
 *
 * The campaign audience filter already EXCLUDES leads with emailBouncedAt set
 * (campaigns.service), but nothing ever WROTE it — so the guard was dead. This
 * stamps emailBouncedAt + emailOptOut when an ESP reports a hard bounce or spam
 * complaint, protecting sender reputation. Suppression is intentionally GLOBAL
 * (by normalized address, across workspaces): a hard-bounced/complained address
 * is undeliverable everywhere, and the ESP event carries no workspace context.
 */
@Injectable()
export class EspFeedbackService {
  private readonly logger = new Logger(EspFeedbackService.name);

  constructor(private readonly prisma: PrismaService) {}

  async suppress(events: FeedbackEvent[]): Promise<number> {
    let suppressed = 0;
    for (const ev of events) {
      const normalized = normalizeEmail(ev.email);
      // normalizeEmail only trims/lowercases — reject non-addresses so a garbage
      // value never becomes a (pointless, potentially over-broad) DB filter.
      if (!normalized || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) continue;
      try {
        // Global by-address suppression — see the class doc (ESP events have no
        // workspace; a dead/complaining address is dead everywhere).
        const res = await this.prisma.lead.updateMany({
          where: { emailNormalized: normalized, emailBouncedAt: null },
          data: { emailBouncedAt: new Date(), emailOptOut: true },
        });
        if (res.count > 0) {
          suppressed += res.count;
          this.logger.warn(`ESP ${ev.kind}: suppressed ${res.count} lead(s) for a bounced/complained address`);
        }
      } catch (e) {
        this.logger.error(`ESP feedback suppression failed: ${(e as Error)?.message}`);
      }
    }
    return suppressed;
  }
}
