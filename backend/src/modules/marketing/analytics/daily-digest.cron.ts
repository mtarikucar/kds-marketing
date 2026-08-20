import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { EmailService } from '../../../common/services/email.service';
import { withAdvisoryLock } from '../../../common/scheduling/advisory-lock';
import { DailyDigestService } from './daily-digest.service';

/** Local hour each workspace receives its brief. */
const DIGEST_HOUR = Number(process.env.DAILY_DIGEST_HOUR ?? 7);

/** One counter row per workspace per local day — the idempotency key. */
const SENT_METRIC = 'digest.sent';

/**
 * The morning brief, as a product feature rather than a server-time cron.
 *
 * Two things make it multi-tenant rather than "07:00 wherever the server
 * happens to live":
 *
 *  - It ticks HOURLY and sends to each workspace when the clock reads
 *    DIGEST_HOUR in ITS OWN timezone. A brief that lands at 04:00 for an
 *    Istanbul customer because the box runs UTC is not a morning brief.
 *  - Any workspace can switch it off in `settings.dailyDigest.enabled`.
 *    Defaulting to ON is deliberate — a self-running system that never tells
 *    you what it did is the failure mode this exists to prevent — but a daily
 *    email nobody can stop is spam, however well-intentioned.
 *
 * Idempotent by construction: the send is claimed by CREATING a UsageCounter
 * row keyed on the workspace's LOCAL date, so a restart inside the same hour,
 * or a second app instance, finds the row taken and stays quiet. The advisory
 * lock stops the fan-outs overlapping; this stops the same day being sent
 * twice, which the lock alone cannot.
 */
@Injectable()
export class DailyDigestCron {
  private readonly logger = new Logger(DailyDigestCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly digest: DailyDigestService,
    private readonly email: EmailService,
  ) {}

  /** Local wall-clock parts for a workspace, via the Intl database. */
  static localParts(timezone: string, now = new Date()): { hour: number; date: string } {
    try {
      const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone || 'UTC',
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
      });
      const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
      return {
        // 24:00 is a legal formatToParts output for midnight in some locales.
        hour: Number(parts.hour) % 24,
        date: `${parts.year}-${parts.month}-${parts.day}`,
      };
    } catch {
      // An unknown/typo'd timezone must not silence a workspace forever.
      const iso = now.toISOString();
      return { hour: now.getUTCHours(), date: iso.slice(0, 10) };
    }
  }

  private enabled(settings: unknown): boolean {
    const s = settings as { dailyDigest?: { enabled?: boolean } } | null;
    return s?.dailyDigest?.enabled !== false;
  }

  @Cron(CronExpression.EVERY_HOUR, { name: 'daily-digest' })
  async tick(): Promise<{ sent: number; skipped: number }> {
    let outcome = { sent: 0, skipped: 0 };
    await withAdvisoryLock(
      this.prisma,
      'daily-digest',
      async () => {
        const workspaces = await this.prisma.workspace.findMany({
          where: { status: 'ACTIVE' },
          select: { id: true, timezone: true, settings: true },
        });
        let sent = 0;
        let skipped = 0;

        for (const ws of workspaces) {
          try {
            const { hour, date } = DailyDigestCron.localParts(ws.timezone);
            if (hour !== DIGEST_HOUR || !this.enabled(ws.settings)) continue;

            // Claim the day BEFORE building: if the send later fails, the day
            // stays claimed and we do not retry hourly into someone's inbox.
            try {
              await this.prisma.usageCounter.create({
                data: { workspaceId: ws.id, metric: SENT_METRIC, periodKey: date, value: 1 },
              });
            } catch (e) {
              if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue;
              throw e;
            }

            const digest = await this.digest.build(ws.id);
            // Nothing happened and nothing is waiting: staying quiet is the
            // feature. A daily email that is empty most mornings gets filtered,
            // and the mornings that matter get filtered with it.
            if (!digest || digest.empty) {
              skipped++;
              continue;
            }
            const to = await this.digest.recipients(ws.id);
            if (!to.length) {
              skipped++;
              continue;
            }
            const body = this.digest.render(digest);
            const subject = `${digest.workspaceName} — günlük özet (${digest.forDate})`;
            for (const address of to) {
              await this.email.sendPlainEmail(address, subject, body);
            }
            sent++;
          } catch (e) {
            // One workspace's failure must not stop the rest of the morning.
            this.logger.warn(`digest failed for ${ws.id}: ${(e as Error)?.message ?? e}`);
            skipped++;
          }
        }
        outcome = { sent, skipped };
        if (sent || skipped) {
          this.logger.log(`daily-digest sent ${sent} brief(s), skipped ${skipped}`);
        }
      },
      this.logger,
    );
    return outcome;
  }
}
