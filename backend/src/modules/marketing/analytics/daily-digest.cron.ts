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
    // Caught here, NOT inside the lock. withAdvisoryLock records the failure on
    // the job's heartbeat before rethrowing, so the error still reaches the one
    // surface that can report it; swallowing it here only stops a cron tick
    // from ending in an unhandled rejection.
    try {
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
        const undelivered: string[] = [];

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
            // No mailer configured at all. sendPlainEmail would log an
            // [EMAIL MOCK] line and return true, so without this the brief would
            // be recorded as sent every morning forever on a deploy that cannot
            // send anything.
            if (!this.email.isConfigured()) {
              undelivered.push('(mailer not configured)');
              skipped++;
              continue;
            }
            const body = this.digest.render(digest);
            const subject = `${digest.workspaceName} — günlük özet (${digest.forDate})`;
            for (const address of to) {
              // The return value was ignored, so `sent++` ran whether or not
              // anything left the building. A brief that fails to send is the
              // one failure that cannot report itself by email, which is
              // exactly why it has to surface somewhere else.
              const ok = await this.email.sendPlainEmail(address, subject, body);
              if (!ok) {
                // Carry the SMTP reason, not just the fact. "Undelivered" tells
                // the owner to look; "535 authentication failed" tells them what
                // to fix.
                // The REASON only. Not the address, and not the workspace id:
                // this string ends up on the cron heartbeat, which is a
                // PLATFORM-level row that every tenant can read through
                // jeeta.list_scheduled_runs. Naming the recipient there put one
                // workspace's owner/manager email addresses in front of every
                // other workspace's agent. The SMTP reason is the actionable
                // half and carries nobody's identity; which mailbox bounced is
                // in the operator's own logs (logger.warn above), where it
                // belongs.
                const why = this.email.consumeLastPlainSendError();
                undelivered.push(why || '(no reason reported)');
              }
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

        // Thrown AFTER the loop, deliberately: one workspace's mail failure must
        // not cost the others their morning, but the run itself is not a success
        // and must not read as one. withAdvisoryLock records the error on the
        // job's heartbeat, which is readable — so the brief that could not
        // announce its own failure announces it there instead.
        if (undelivered.length) {
          // Distinct reasons, not one line per recipient: five bounces from one
          // dead mailbox are one problem, and de-duplicating keeps the count
          // honest while the text stays short enough to survive truncation.
          const reasons = [...new Set(undelivered)];
          throw new Error(
            `digest undelivered for ${undelivered.length} recipient(s): ${reasons.slice(0, 3).join(' | ')}`,
          );
        }
        },
        this.logger,
      );
    } catch (e) {
      this.logger.error(`daily-digest: ${(e as Error)?.message ?? e}`);
    }
    return outcome;
  }
}
