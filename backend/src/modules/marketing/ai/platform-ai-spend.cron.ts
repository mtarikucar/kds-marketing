import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PlatformAiSpendService, WARN_AT, CRITICAL_AT } from './platform-ai-spend.service';

/**
 * Says something BEFORE the money is gone.
 *
 * Cost was previously discoverable only by going to look, and nothing pointed
 * anyone at it — so the first signal that the vendor balance was emptying was
 * the balance being empty. This runs hourly and escalates as the month's spend
 * climbs toward the platform cap.
 *
 * It deliberately re-announces at CRITICAL and above rather than firing once:
 * a single line at 3am in a log nobody tails is the same as no alert, and
 * hourly is quiet enough at OK/WARN (which say nothing at all) to stay
 * readable.
 */
@Injectable()
export class PlatformAiSpendCron {
  private readonly logger = new Logger(PlatformAiSpendCron.name);
  /** Highest state already announced this period, so WARN is not repeated hourly. */
  private announced = new Map<string, string>();

  constructor(private readonly spend: PlatformAiSpendService) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'platform-ai-spend-watch' })
  async watch(): Promise<void> {
    try {
      const s = await this.spend.status();
      if (s.state === 'DISABLED') return;

      const line =
        `platform AI spend ${s.period}: $${s.spentUsd} of $${s.capUsd} ` +
        `(${Math.round((s.ratio ?? 0) * 100)}%)`;

      if (s.state === 'EXCEEDED') {
        // Every hour: unattended work is currently suspended, and that is a
        // state someone has to decide about.
        this.logger.error(`${line} — CAP EXCEEDED, unattended AI suspended`);
        return;
      }
      if (s.state === 'CRITICAL') {
        this.logger.error(`${line} — past ${Math.round(CRITICAL_AT * 100)}%`);
        return;
      }
      if (s.state === 'WARN' && this.announced.get(s.period) !== 'WARN') {
        this.announced.set(s.period, 'WARN');
        this.logger.warn(`${line} — past ${Math.round(WARN_AT * 100)}%`);
      }
    } catch (e) {
      this.logger.warn(`platform AI spend watch failed: ${(e as Error)?.message ?? e}`);
    }
  }
}
