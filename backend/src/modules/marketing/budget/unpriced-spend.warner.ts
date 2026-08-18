import { Logger } from '@nestjs/common';

/** One warning per (workspace, unit) per hour. */
const WINDOW_MS = 60 * 60 * 1000;

/**
 * Says "we just spent vendor money and could not price it" — loudly enough to
 * be seen, rarely enough to stay readable.
 *
 * Both spend services used to log this at DEBUG, which production does not
 * print, and the reason was sound: an SMS send is high volume, so a warning per
 * message would bury the log. But the consequence was worse than noise — every
 * unpriced crawl, actor run and message since the feature shipped was
 * invisible, and "we could not charge for this" looked exactly like "nothing
 * happened".
 *
 * Throttling per workspace+unit keeps both properties: the first occurrence is
 * seen, and a workspace with no tariff at all costs one line an hour rather
 * than one per send. Deliberately in-memory: this is an operator nudge, not an
 * accounting record, and a restart re-warning is the harmless direction.
 */
export class UnpricedSpendWarner {
  private readonly lastWarned = new Map<string, number>();

  constructor(
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  warn(workspaceId: string, unit: string, detail: string): void {
    const key = `${workspaceId}:${unit}`;
    const at = this.now();
    const previous = this.lastWarned.get(key);
    if (previous !== undefined && at - previous < WINDOW_MS) return;
    this.lastWarned.set(key, at);
    this.logger.warn(
      `UNPRICED SPEND: ${detail} — vendor cost incurred and NOT metered. ` +
        `Add a ChannelTariff row for ${unit}. (further warnings for this ` +
        `workspace+unit are suppressed for an hour)`,
    );
  }
}
